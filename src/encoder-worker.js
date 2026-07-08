/* global AuvQuantizerModule */
'use strict';

importScripts('../wasm/auv_quantizer.js');

let modulePromise = null;
let moduleInstance = null;
let mediabunnyPromise = null;

const PIXELS = 240 * 160;
const FRAME_TYPE_INDEX_RUNS = 0;
const PALETTE_BYTES = 256 * 2;
const INDEX_BYTES = PIXELS;
const FRAME_STATE_BYTES = PIXELS * 2;
const HOLD_AGE_BYTES = PIXELS * 2;
const ENCODE_STATS_WORDS = 3;
const MAX_INDEX_RUN_FRAME_BYTES = 256 * 1024;

function getModule() {
  if (!modulePromise) {
    modulePromise = AuvQuantizerModule({
      locateFile(path) {
        return `../wasm/${path}`;
      },
    }).then((mod) => {
      moduleInstance = mod;
      return mod;
    });
  }
  return modulePromise;
}

function getMediabunny() {
  if (!mediabunnyPromise) {
    mediabunnyPromise = import('../vendor/mediabunny/mediabunny.min.mjs');
  }
  return mediabunnyPromise;
}

function heapSlice(heap, ptr, bytes) {
  return heap.slice(ptr, ptr + bytes).buffer;
}

function floatToPcm8(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  const signed = Math.max(-128, Math.min(127, Math.round(clamped * 127)));
  return signed & 0xff;
}

function makeWorkerCanvas(width, height) {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('当前浏览器不支持 worker OffscreenCanvas，无法并行抽帧');
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法在 worker 中创建 Canvas 2D context');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return { canvas, context };
}

function rgbaToRgbBuffer(rgba) {
  const rgb = new Uint8Array(PIXELS * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb.buffer;
}

function concatFloat32(chunks, total) {
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function mixMonoSample(planes, index) {
  const channelCount = planes.length;
  if (channelCount === 0) return 0;
  if (channelCount === 1) return planes[0][index] || 0;
  return (mixStereoLeftSample(planes, index) + mixStereoRightSample(planes, index)) * 0.5;
}

function mixStereoLeftSample(planes, index) {
  const channelCount = planes.length;
  if (channelCount === 0) return 0;
  if (channelCount === 1) return planes[0][index] || 0;
  if (channelCount === 2) return planes[0][index] || 0;

  let sample = planes[0][index] || 0;
  let weight = 1.0;
  if (channelCount >= 3) {
    sample += (planes[2][index] || 0) * 0.707;
    weight += 0.707;
  }
  if (channelCount >= 6) {
    sample += (planes[4][index] || 0) * 0.5;
    weight += 0.5;
  }
  for (let ch = 6; ch < channelCount; ch++) {
    sample += (planes[ch][index] || 0) * 0.125;
    weight += 0.125;
  }
  return sample / weight;
}

function mixStereoRightSample(planes, index) {
  const channelCount = planes.length;
  if (channelCount === 0) return 0;
  if (channelCount === 1) return planes[0][index] || 0;
  if (channelCount === 2) return planes[1][index] || 0;

  let sample = planes[1][index] || 0;
  let weight = 1.0;
  if (channelCount >= 3) {
    sample += (planes[2][index] || 0) * 0.707;
    weight += 0.707;
  }
  if (channelCount >= 6) {
    sample += (planes[5][index] || 0) * 0.5;
    weight += 0.5;
  }
  for (let ch = 6; ch < channelCount; ch++) {
    sample += (planes[ch][index] || 0) * 0.125;
    weight += 0.125;
  }
  return sample / weight;
}

function resampleChannelsToPcm8(sourceChannels, sourceRate, targetRate, targetFrames, outputChannels, audioGain = 1.75) {
  const out = new Uint8Array(targetFrames * outputChannels);
  if (targetFrames <= 0 || sourceRate <= 0 || sourceChannels.length === 0 || sourceChannels[0].length === 0) {
    return out;
  }

  const gain = Number.isFinite(audioGain) && audioGain >= 0 ? audioGain : 1.75;
  const scale = sourceRate / targetRate;
  const last = sourceChannels[0].length - 1;
  for (let i = 0; i < targetFrames; i++) {
    const pos = Math.min(last, i * scale);
    const base = Math.floor(pos);
    const frac = pos - base;
    for (let ch = 0; ch < outputChannels; ch++) {
      const src = sourceChannels[ch];
      const a = src[Math.min(base, src.length - 1)] || 0;
      const b = src[Math.min(base + 1, src.length - 1)] || a;
      out[i * outputChannels + ch] = floatToPcm8((a + (b - a) * frac) * gain);
    }
  }
  return out;
}

async function encodeGopAudio(input, AudioSampleSink, message) {
  const startSample = message.audioStartSample | 0;
  const endSample = message.audioEndSample | 0;
  const targetFrames = Math.max(0, endSample - startSample);
  if (targetFrames === 0) {
    return { startSample, endSample, payload: new Uint8Array() };
  }

  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) throw new Error('没有找到音轨，无法生成 AUV');
  if (!(await audioTrack.canDecode())) throw new Error('当前浏览器不能解码此音轨');

  if (message.gopIndex === 0) {
    const audioTracks = await input.getAudioTracks();
    const [codec, sourceChannels, declaredRate, langCode, trackName] = await Promise.all([
      audioTrack.getCodec(),
      audioTrack.getNumberOfChannels(),
      audioTrack.getSampleRate(),
      audioTrack.getLanguageCode(),
      audioTrack.getName(),
    ]);
    self.postMessage({
      type: 'log',
      text: `音频轨 ${audioTracks.length} 条，使用 ${codec || 'unknown'}，${sourceChannels || '?'}ch ${declaredRate || '?'}Hz，语言 ${langCode || 'und'}，名称 ${trackName || '-'}`,
    });
  }

  const trackStartValue = await audioTrack.getFirstTimestamp();
  const trackStart = Number.isFinite(trackStartValue) ? trackStartValue : 0;
  const queryStart = trackStart + message.startTime + startSample / message.audioRate;
  const queryEnd = trackStart + message.startTime + endSample / message.audioRate;
  const outputChunks = Array.from({ length: message.audioChannels }, () => []);
  const totals = new Array(message.audioChannels).fill(0);
  const sink = new AudioSampleSink(audioTrack);
  let sourceRate = await audioTrack.getSampleRate() || message.audioRate;
  let decodedFrames = 0;
  let loggedSampleInfo = false;

  for await (const sample of sink.samples(queryStart, queryEnd)) {
    sourceRate = sample.sampleRate || sourceRate;
    const frames = sample.numberOfFrames | 0;
    const planes = Array.from({ length: sample.numberOfChannels }, () => new Float32Array(frames));
    for (let ch = 0; ch < sample.numberOfChannels; ch++) {
      sample.copyTo(planes[ch], { planeIndex: ch, format: 'f32-planar' });
    }
    if (message.gopIndex === 0 && !loggedSampleInfo) {
      const gainPercent = Math.round((Number(message.encodeOptions?.audioGain) || 1.75) * 100);
      self.postMessage({
        type: 'log',
        text: `音频解码：源 ${sample.numberOfChannels}ch ${sample.sampleRate}Hz，下混为 ${message.audioChannels === 2 ? 'stereo' : 'mono'} ${message.audioRate}Hz PCM8，音量调整 ${gainPercent}%`,
      });
      loggedSampleInfo = true;
    }

    if (message.audioChannels === 1) {
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) mono[i] = mixMonoSample(planes, i);
      outputChunks[0].push(mono);
      totals[0] += frames;
    } else {
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = mixStereoLeftSample(planes, i);
        right[i] = mixStereoRightSample(planes, i);
      }
      outputChunks[0].push(left);
      outputChunks[1].push(right);
      totals[0] += frames;
      totals[1] += frames;
    }

    decodedFrames += frames;
    sample.close();
    self.postMessage({
      type: 'progress',
      phase: 'audio',
      gopIndex: message.gopIndex,
      done: Math.min(targetFrames, Math.round(decodedFrames * message.audioRate / sourceRate)),
      total: targetFrames,
    });
  }

  const planes = outputChunks.map((chunksForChannel, ch) => concatFloat32(chunksForChannel, totals[ch]));
  const payload = resampleChannelsToPcm8(
    planes,
    sourceRate,
    message.audioRate,
    targetFrames,
    message.audioChannels,
    message.encodeOptions?.audioGain,
  );
  self.postMessage({
    type: 'progress',
    phase: 'audio',
    gopIndex: message.gopIndex,
    done: targetFrames,
    total: targetFrames,
  });
  return { startSample, endSample, payload };
}

async function decodeGopFrames(input, VideoSampleSink, message) {
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('没有找到视频轨');
  if (!(await videoTrack.canDecode())) throw new Error('当前浏览器不能解码此视频轨');

  const sink = new VideoSampleSink(videoTrack);
  const trackStartValue = await videoTrack.getFirstTimestamp();
  const trackStart = Number.isFinite(trackStartValue) ? trackStartValue : 0;

  const timestamps = Array.from(
    { length: message.frameCount },
    (_, i) => trackStart + message.startTime + (message.startFrame + i) * message.fpsDen / message.fpsNum,
  );
  const { context } = makeWorkerCanvas(message.width, message.height);
  const rgbs = [];
  let decoded = 0;
  for await (const sample of sink.samplesAtTimestamps(timestamps)) {
    if (!sample) {
      throw new Error(`抽帧失败: GOP ${message.gopIndex} frame ${decoded} ts=${timestamps[decoded].toFixed(6)}`);
    }
    try {
      context.clearRect(0, 0, message.width, message.height);
      sample.drawWithFit(context, { fit: 'fill' });
      const rgba = context.getImageData(0, 0, message.width, message.height).data;
      rgbs.push(rgbaToRgbBuffer(rgba));
    } finally {
      sample.close();
    }
    decoded++;
    if ((decoded % 16) === 0) {
      self.postMessage({
        type: 'progress',
        phase: 'decode',
        gopIndex: message.gopIndex,
        done: decoded,
        total: message.frameCount,
      });
    }
  }
  if (rgbs.length !== message.frameCount) {
    throw new Error(`抽帧数量不匹配: ${rgbs.length}/${message.frameCount}`);
  }
  return rgbs;
}

async function quantizeFrame(message, rgbBuffer) {
  const mod = await getModule();
  const width = message.width | 0;
  const height = message.height | 0;
  const pixels = width * height;
  const rgbBytes = pixels * 3;
  const paletteBytes = 256 * 2;
  const indexBytes = pixels;

  const rgbPtr = mod._malloc(rgbBytes);
  const palettePtr = mod._malloc(paletteBytes);
  const indexesPtr = mod._malloc(indexBytes);
  if (!rgbPtr || !palettePtr || !indexesPtr) {
    if (rgbPtr) mod._free(rgbPtr);
    if (palettePtr) mod._free(palettePtr);
    if (indexesPtr) mod._free(indexesPtr);
    throw new Error('quantizer wasm memory allocation failed');
  }
  try {
    mod.HEAPU8.set(new Uint8Array(rgbBuffer), rgbPtr);
    const rc = mod._auv_quantize_rgb888_wasm(
      rgbPtr,
      width,
      height,
      message.ditherMode | 0,
      message.refineIterations | 0,
      message.saturationBoost ? 1 : 0,
      Number(message.ditherStrength),
      palettePtr,
      indexesPtr,
    );
    if (rc !== 0) {
      throw new Error(`quantizer failed rc=${rc}`);
    }
    return {
      palette: heapSlice(mod.HEAPU8, palettePtr, paletteBytes),
      indexes: heapSlice(mod.HEAPU8, indexesPtr, indexBytes),
    };
  } finally {
    mod._free(rgbPtr);
    mod._free(palettePtr);
    mod._free(indexesPtr);
  }
}

function ensureEncoderState(mod, state) {
  if (state.wasmEncoder) return state.wasmEncoder;
  const previousPtr = mod._malloc(FRAME_STATE_BYTES);
  const holdPtr = mod._malloc(HOLD_AGE_BYTES);
  const statsPtr = mod._malloc(ENCODE_STATS_WORDS * 4);
  const outputPtr = mod._malloc(MAX_INDEX_RUN_FRAME_BYTES);
  const thresholdsPtr = mod._malloc(3 * 4);
  const framesPtr = mod._malloc(3 * 4);
  if (!previousPtr || !holdPtr || !statsPtr || !outputPtr || !thresholdsPtr || !framesPtr) {
    for (const ptr of [previousPtr, holdPtr, statsPtr, outputPtr, thresholdsPtr, framesPtr]) {
      if (ptr) mod._free(ptr);
    }
    throw new Error('index-runs wasm memory allocation failed');
  }
  state.wasmEncoder = {
    previousPtr,
    holdPtr,
    statsPtr,
    outputPtr,
    thresholdsPtr,
    framesPtr,
    hasPrevious: false,
  };
  return state.wasmEncoder;
}

function freeEncoderState(mod, state) {
  const encoder = state.wasmEncoder;
  if (!encoder) return;
  for (const ptr of [
    encoder.previousPtr,
    encoder.holdPtr,
    encoder.statsPtr,
    encoder.outputPtr,
    encoder.thresholdsPtr,
    encoder.framesPtr,
  ]) {
    if (ptr) mod._free(ptr);
  }
  state.wasmEncoder = null;
}

async function encodeIndexRunFrameWasm(quant, state, options) {
  const mod = await getModule();
  const encoder = ensureEncoderState(mod, state);
  const palette = new Uint8Array(quant.palette);
  const indexes = new Uint8Array(quant.indexes);
  const palettePtr = mod._malloc(PALETTE_BYTES);
  const indexesPtr = mod._malloc(INDEX_BYTES);
  if (!palettePtr || !indexesPtr) {
    if (palettePtr) mod._free(palettePtr);
    if (indexesPtr) mod._free(indexesPtr);
    throw new Error('index-runs input wasm memory allocation failed');
  }
  try {
    mod.HEAPU8.set(palette, palettePtr);
    mod.HEAPU8.set(indexes, indexesPtr);
    const tiers = Array.isArray(options.holdTiers) ? options.holdTiers.slice(0, 3) : [];
    const thresholdView = new Uint32Array(mod.HEAPU8.buffer, encoder.thresholdsPtr, 3);
    const frameView = new Uint32Array(mod.HEAPU8.buffer, encoder.framesPtr, 3);
    thresholdView.fill(0);
    frameView.fill(0);
    for (let i = 0; i < tiers.length; i++) {
      thresholdView[i] = tiers[i].threshold >>> 0;
      frameView[i] = tiers[i].frames >>> 0;
    }
    const rc = mod._auv_encode_index_runs_wasm(
      palettePtr,
      indexesPtr,
      encoder.previousPtr,
      encoder.holdPtr,
      encoder.hasPrevious ? 1 : 0,
      options.forceKeyframe ? 1 : 0,
      options.deadbandThreshold | 0,
      options.holdCleanupMinThreshold | 0,
      encoder.thresholdsPtr,
      encoder.framesPtr,
      tiers.length | 0,
      options.runGapMerge | 0,
      options.scatterThreshold | 0,
      encoder.outputPtr,
      MAX_INDEX_RUN_FRAME_BYTES,
      encoder.statsPtr,
    );
    if (rc < 0) {
      throw new Error(`index-runs wasm encoder failed rc=${rc}`);
    }
    encoder.hasPrevious = true;
    const stats = new Uint32Array(mod.HEAPU8.buffer, encoder.statsPtr, ENCODE_STATS_WORDS);
    return {
      type: FRAME_TYPE_INDEX_RUNS,
      payload: new Uint8Array(mod.HEAPU8.slice(encoder.outputPtr, encoder.outputPtr + rc)),
      changedPixels: stats[0],
      chunks: stats[1],
    };
  } finally {
    mod._free(palettePtr);
    mod._free(indexesPtr);
  }
}

async function encodeGop(message) {
  const { ALL_FORMATS, AudioSampleSink, BlobSource, Input, UrlSource, VideoSampleSink } = await getMediabunny();
  const source = message.sourceUrl
    ? new UrlSource(message.sourceUrl, {
        parallelism: Math.max(1, Math.min(4, message.sourceUrlParallelism | 0 || 2)),
        maxCacheSize: 128 * 1024 * 1024,
      })
    : new BlobSource(message.file);
  let input = new Input({
    source,
    formats: ALL_FORMATS,
  });
  const state = {};
  const frames = [];
  const transfers = [];
  let changedPixels = 0;
  let phase = 'audio';
  try {
    const audio = await encodeGopAudio(input, AudioSampleSink, message);
    phase = 'decode';
    const rgbs = await decodeGopFrames(input, VideoSampleSink, message);
    input.dispose?.();
    input = null;
    const total = rgbs.length | 0;
    phase = 'encode';
    for (let i = 0; i < rgbs.length; i++) {
      const quant = await quantizeFrame(message, rgbs[i]);
      const frame = await encodeIndexRunFrameWasm(quant, state, {
        ...message.encodeOptions,
        forceKeyframe: i === 0,
      });
      frames.push({
        type: frame.type,
        payload: frame.payload.buffer,
        changedPixels: frame.changedPixels,
        chunks: frame.chunks,
      });
      transfers.push(frame.payload.buffer);
      changedPixels += frame.changedPixels;
      if (((i + 1) % 8) === 0 || i + 1 === total) {
        self.postMessage({
          type: 'progress',
          phase: 'encode',
          gopIndex: message.gopIndex,
          done: i + 1,
          total,
        });
      }
    }
    transfers.push(audio.payload.buffer);
    self.postMessage({
      type: 'gop',
      gopIndex: message.gopIndex,
      startFrame: message.startFrame,
      frames,
      audio: {
        startSample: audio.startSample,
        endSample: audio.endSample,
        payload: audio.payload.buffer,
      },
      changedPixels,
    }, transfers);
  } catch (error) {
    error.auvPhase = phase;
    throw error;
  } finally {
    if (moduleInstance) {
      freeEncoderState(moduleInstance, state);
    }
    input?.dispose?.();
  }
}

async function probeDecode(message) {
  const { ALL_FORMATS, BlobSource, Input, UrlSource, VideoSampleSink } = await getMediabunny();
  const source = message.sourceUrl
    ? new UrlSource(message.sourceUrl, {
        parallelism: Math.max(1, Math.min(4, message.sourceUrlParallelism | 0 || 2)),
        maxCacheSize: 64 * 1024 * 1024,
      })
    : new BlobSource(message.file);
  const input = new Input({
    source,
    formats: ALL_FORMATS,
  });
  let phase = 'decode';
  try {
    await decodeGopFrames(input, VideoSampleSink, {
      ...message,
      frameCount: Math.max(1, message.frameCount | 0 || 1),
      width: message.width || 16,
      height: message.height || 16,
    });
    self.postMessage({
      type: 'probe',
      gopIndex: message.gopIndex,
    });
  } catch (error) {
    error.auvPhase = phase;
    throw error;
  } finally {
    input.dispose?.();
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSourceError(error) {
  const phase = error?.auvPhase || '';
  if (phase !== 'audio' && phase !== 'decode') return false;
  const text = `${error?.name || ''} ${error?.message || error}`.toLowerCase();
  return text.includes('network error') ||
    text.includes('failed to fetch') ||
    text.includes('quotaexceeded') ||
    text.includes('too many decoders') ||
    text.includes('decoder initialization failed') ||
    text.includes('source') ||
    text.includes('blob');
}

async function encodeGopWithRetry(message) {
  const maxAttempts = Math.max(1, message.sourceReadRetryAttempts | 0);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        self.postMessage({
          type: 'log',
          text: `GOP ${message.gopIndex} 源读取重试 ${attempt}/${maxAttempts}`,
        });
      }
      await encodeGop(message);
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableSourceError(error)) break;
      self.postMessage({
        type: 'log',
        text: `GOP ${message.gopIndex} 源读取失败 phase=${error?.auvPhase || '?'} attempt=${attempt}/${maxAttempts}: ${error?.message || error}`,
      });
      const text = `${error?.name || ''} ${error?.message || error}`.toLowerCase();
      const decoderBusy = text.includes('quotaexceeded') ||
        text.includes('too many decoders') ||
        text.includes('decoder initialization failed');
      const jitter = ((message.gopIndex * 97 + attempt * 53) % 211);
      await sleepMs(decoderBusy ? 1500 + attempt * 1000 + jitter : 300 + attempt * 450 + jitter);
    }
  }
  throw lastError;
}

self.onmessage = (event) => {
  const message = event.data;
  const errorMessage = (error, prefix) => {
    const name = error?.name ? `${error.name}: ` : '';
    const phase = error?.auvPhase ? ` phase=${error.auvPhase}` : '';
    const stack = error?.stack ? ` stack=${String(error.stack).split('\n').slice(0, 3).join(' | ')}` : '';
    return `${prefix}${phase}: ${name}${error?.message || error}${stack}`;
  };
  if (message.type === 'init') {
    getModule()
      .then(() => self.postMessage({ type: 'ready' }))
      .catch((error) => self.postMessage({ type: 'error', message: errorMessage(error, 'worker init failed') }));
    return;
  }
  if (message.type === 'encode-gop') {
    encodeGopWithRetry(message)
      .catch((error) => self.postMessage({
        type: 'error',
        gopIndex: message.gopIndex,
        message: errorMessage(error, `GOP ${message.gopIndex} failed`),
      }));
    return;
  }
  if (message.type === 'probe-decode') {
    probeDecode(message)
      .catch((error) => self.postMessage({
        type: 'error',
        gopIndex: message.gopIndex,
        message: errorMessage(error, `probe ${message.gopIndex} failed`),
      }));
  }
};
