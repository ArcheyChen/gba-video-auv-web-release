import {
  AuvFileWriter,
  H,
  MAX_PLAYABLE_AUV_BYTES,
  W,
  defaultEncodeOptions,
  estimatePackedAuvBytes,
  makePreviewRgb555,
  packAuv,
} from './auv-pack.js';

const $ = (id) => document.getElementById(id);

const elements = {
  file: $('video-file'),
  title: $('title'),
  start: $('start-time'),
  duration: $('duration'),
  fpsPreset: $('fps-preset'),
  fpsCustom: $('fps-custom'),
  audioRate: $('audio-rate'),
  audioChannels: $('audio-channels'),
  audioGain: $('audio-gain'),
  outputMode: $('output-mode'),
  workers: $('workers'),
  encode: $('encode'),
  cancel: $('cancel'),
  progress: $('progress'),
  workerProgress: $('worker-progress'),
  stage: $('stage'),
  log: $('log'),
  download: $('download'),
  preview: $('preview'),
};

let activeJob = null;
let customPreviewImage = null; // 用户上传的自定义预览图数据 (80x60 RGB Uint8Array)
let currentVideo = null;       // 全局缓存的 Video 元素，导入视频后创建，防止重复加载
let currentVideoUrl = null;    // 全局缓存的 Object URL
let selectedPreviewTime = 0;   // 选取的视频预览图提取时间戳（秒）

const UINT32_MAX = 0xffffffffn;
const GBA_DISPLAY_RATE_NUM = 597275n;
const GBA_DISPLAY_RATE_DEN = 10000n;

function log(message) {
  const time = new Date().toLocaleTimeString();
  elements.log.textContent += `[${time}] ${message}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return '?ms';
  return `${ms.toFixed(ms >= 100 ? 0 : 1)}ms`;
}

function memorySummary() {
  const memory = performance?.memory;
  if (!memory) return '';
  return ` heap=${formatBytes(memory.usedJSHeapSize)}/${formatBytes(memory.jsHeapSizeLimit)}`;
}

function setStage(message, value = null) {
  elements.stage.textContent = message;
  if (value !== null) {
    elements.progress.value = value;
    const percentEl = document.getElementById('progress-percent');
    if (percentEl) {
      percentEl.textContent = `${Math.round(value * 100)}%`;
    }
  }
}

function gcdBigInt(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a || 1n;
}

function parseUnsignedBigInt(text, label) {
  const raw = String(text || '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} 必须是非负整数`);
  return BigInt(raw);
}

function normalizeFpsFraction(num, den) {
  if (num <= 0n || den <= 0n) throw new Error('FPS 必须大于 0');
  const divisor = gcdBigInt(num, den);
  num /= divisor;
  den /= divisor;

  if (num > UINT32_MAX || den > UINT32_MAX) {
    throw new Error('FPS 分子/分母超过 AUV 32-bit 字段限制');
  }

  let schedulerStep = num * GBA_DISPLAY_RATE_DEN;
  let schedulerThreshold = GBA_DISPLAY_RATE_NUM * den;
  const schedulerDivisor = gcdBigInt(schedulerStep, schedulerThreshold);
  schedulerStep /= schedulerDivisor;
  schedulerThreshold /= schedulerDivisor;
  if (schedulerStep > UINT32_MAX || schedulerThreshold > UINT32_MAX) {
    throw new Error('FPS 分数会导致 GBA 播放调度器 32-bit 溢出，请使用更简单的等价分数或预设');
  }

  return { num: Number(num), den: Number(den) };
}

function parseFps(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('FPS 不能为空');
  if (raw.includes('/')) {
    const parts = raw.split('/');
    if (parts.length !== 2) throw new Error('FPS 分数格式无效');
    return normalizeFpsFraction(
      parseUnsignedBigInt(parts[0], 'FPS 分子'),
      parseUnsignedBigInt(parts[1], 'FPS 分母'),
    );
  }
  const decimal = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!decimal) throw new Error('FPS 数值无效');
  const integerPart = decimal[1];
  const fractionPart = decimal[2] || '';
  if (fractionPart.length > 9) {
    throw new Error('FPS 小数位过多，请改用简单分数或预设');
  }
  const den = 10n ** BigInt(fractionPart.length);
  const num = parseUnsignedBigInt(integerPart + fractionPart, 'FPS 数值');
  return normalizeFpsFraction(num, den);
}

function selectedFps() {
  const preset = elements.fpsPreset.value;
  if (preset !== 'custom') return parseFps(preset);

  const parsed = parseFps(elements.fpsCustom.value);
  const val = parsed.num / parsed.den;
  if (val < 0.5 || val > 30) {
    throw new Error('自定义 FPS 的实际值必须在 0.5 到 30 之间');
  }
  return parsed;
}

function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit + 1 < units.length) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function waitEvent(target, event) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(target.error || new Error(`${event} failed`));
    };
    const cleanup = () => {
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
    };
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

async function seekVideo(video, time) {
  if (Math.abs(video.currentTime - time) < 0.0005) return;
  const done = waitEvent(video, 'seeked');
  video.currentTime = Math.max(0, Math.min(time, video.duration || time));
  await done;
}

function getRgbFromCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

async function updatePreviewFromTime(time) {
  if (!currentVideo) return;
  try {
    selectedPreviewTime = time;

    const previewCanvas = makeCanvas(80, 60);
    const previewRgb = await captureRgb(currentVideo, time, 80, 60, previewCanvas);
    const previewCtx = elements.preview.getContext('2d');
    previewCtx.imageSmoothingEnabled = false;
    previewCtx.putImageData(previewCanvas.context.getImageData(0, 0, 80, 60), 0, 0);

    // 格式化展示时间为分:秒.毫秒
    const timeDisplay = document.getElementById('preview-time-display');
    if (timeDisplay) {
      const minutes = Math.floor(time / 60);
      const seconds = Math.floor(time % 60);
      const ms = Math.floor((time % 1) * 100);
      timeDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    }
  } catch (err) {
    console.error('更新预览画面帧失败:', err);
  }
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法创建 Canvas 2D context');
  return { canvas, context };
}

async function captureRgb(video, time, width, height, canvasState) {
  await seekVideo(video, time);
  const { context } = canvasState;
  context.drawImage(video, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  video.playsInline = true;
  await waitEvent(video, 'loadedmetadata');
  if (video.readyState < 2) {
    await waitEvent(video, 'loadeddata');
  }
  return { video, url };
}

// Estimate the video frame rate (FPS) using requestVideoFrameCallback
async function estimateFps(video) {
  if (!video.requestVideoFrameCallback) {
    return 30; // 浏览器不支持时的降级默认值
  }
  return new Promise((resolve) => {
    const originalTime = video.currentTime;
    video.muted = true;

    video.play().then(() => {
      let frameCount = 0;
      let firstFrameTime = null;
      let lastFrameTime = null;
      let timer = null;

      const cleanUp = () => {
        if (timer) clearTimeout(timer);
        video.pause();
        video.currentTime = originalTime;
      };

      const callback = (now, metadata) => {
        frameCount++;
        if (firstFrameTime === null) {
          firstFrameTime = metadata.mediaTime;
        }
        lastFrameTime = metadata.mediaTime;

        // 采集 8 帧或播放时长超过 0.25 秒时进行估算
        if (frameCount >= 8 || (lastFrameTime - firstFrameTime) > 0.25) {
          cleanUp();
          const duration = lastFrameTime - firstFrameTime;
          if (duration > 0 && frameCount > 1) {
            const calculatedFps = (frameCount - 1) / duration;
            // 匹配常见的视频帧率预设
            const commonFps = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
            let closest = calculatedFps;
            let minDiff = Infinity;
            for (const c of commonFps) {
              const diff = Math.abs(calculatedFps - c);
              if (diff < minDiff && diff < 1.5) {
                minDiff = diff;
                closest = c;
              }
            }
            resolve(closest);
          } else {
            resolve(30);
          }
        } else {
          video.requestVideoFrameCallback(callback);
        }
      };

      // 安全超时，以防 requestVideoFrameCallback 未触发
      timer = setTimeout(() => {
        cleanUp();
        resolve(30);
      }, 400);

      video.requestVideoFrameCallback(callback);
    }).catch(() => {
      resolve(30);
    });
  });
}

class GopWorkerPool {
  constructor(count, quantOptions, onProgress = null, onLog = null) {
    this.count = Math.max(1, count | 0);
    this.quantOptions = quantOptions;
    this.onProgress = onProgress;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.jobs = new Map();
    this.closed = false;
    this.onLog = onLog;
  }

  async init() {
    const ready = [];
    for (let i = 0; i < this.count; i++) {
      const worker = new Worker(new URL('./encoder-worker.js', import.meta.url));
      worker.__workerIndex = i;
      worker.onmessage = (event) => this.onMessage(worker, event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        this.failAll(new Error(`Worker #${worker.__workerIndex + 1} runtime error: ${event.message || 'worker error'}`));
      };
      this.workers.push(worker);
      ready.push(new Promise((resolve, reject) => {
        worker.__readyResolve = resolve;
        worker.__readyReject = reject;
      }));
      worker.postMessage({ type: 'init' });
    }
    await Promise.all(ready);
  }

  onMessage(worker, message) {
    if (message.type === 'ready') {
      this.idle.push(worker);
      worker.__readyResolve?.();
      this.dispatch();
      return;
    }
    if (message.type === 'error') {
      const job = this.jobs.get(message.gopIndex);
      const detail = `Worker #${worker.__workerIndex + 1}${job ? ` GOP ${message.gopIndex}` : ''}: ${message.message}`;
      if (job) {
        this.jobs.delete(message.gopIndex);
        job.reject(new Error(detail));
      } else {
        worker.__readyReject?.(new Error(detail));
      }
      this.idle.push(worker);
      this.dispatch();
      return;
    }
    if (message.type === 'probe') {
      const job = this.jobs.get(message.gopIndex);
      if (job) {
        this.jobs.delete(message.gopIndex);
        job.resolve({ gopIndex: message.gopIndex, workerIndex: worker.__workerIndex });
      }
      this.idle.push(worker);
      this.dispatch();
      return;
    }
    if (message.type === 'progress') {
      const job = this.jobs.get(message.gopIndex);
      if (job && this.onProgress) {
        this.onProgress({
          workerIndex: worker.__workerIndex,
          gopIndex: message.gopIndex,
          phase: message.phase || 'encode',
          startFrame: job.startFrame,
          done: message.done | 0,
          total: message.total | 0,
        });
      }
      return;
    }
    if (message.type === 'log') {
      log(message.text);
      this.onLog?.(message.text);
      return;
    }
    if (message.type === 'gop') {
      const job = this.jobs.get(message.gopIndex);
      if (job) {
        this.jobs.delete(message.gopIndex);
        job.resolve({
          gopIndex: message.gopIndex,
          startFrame: message.startFrame,
          workerIndex: worker.__workerIndex,
          frames: message.frames.map((frame) => ({
            type: frame.type,
            payload: new Uint8Array(frame.payload),
            changedPixels: frame.changedPixels,
            chunks: frame.chunks,
          })),
          audio: message.audio ? {
            startSample: message.audio.startSample | 0,
            endSample: message.audio.endSample | 0,
            payload: new Uint8Array(message.audio.payload),
          } : null,
          changedPixels: message.changedPixels,
        });
      }
      this.idle.push(worker);
      this.dispatch();
    }
  }

  runGop(gopIndex, file, startFrame, frameCount, startTime, fps, encodeOptions, audioRange) {
    if (this.closed) return Promise.reject(new Error('worker pool closed'));
    return new Promise((resolve, reject) => {
      this.queue.push({
        gopIndex,
        file,
        startFrame,
        frameCount,
        startTime,
        fps,
        encodeOptions,
        audioRange,
        resolve,
        reject,
      });
      this.dispatch();
    });
  }

  runProbe(gopIndex, file, startFrame, frameCount, startTime, fps) {
    if (this.closed) return Promise.reject(new Error('worker pool closed'));
    return new Promise((resolve, reject) => {
      this.queue.push({
        probe: true,
        gopIndex,
        file,
        startFrame,
        frameCount: Math.max(1, frameCount | 0),
        startTime,
        fps,
        resolve,
        reject,
      });
      this.dispatch();
    });
  }

  dispatch() {
    while (!this.closed && this.idle.length && this.queue.length) {
      const worker = this.idle.pop();
      const job = this.queue.shift();
      this.jobs.set(job.gopIndex, job);
      if (job.probe) {
        worker.postMessage({
          type: 'probe-decode',
          gopIndex: job.gopIndex,
          file: job.file,
          startFrame: job.startFrame,
          startTime: job.startTime,
          fpsNum: job.fps.num,
          fpsDen: job.fps.den,
          width: 16,
          height: 16,
        });
        continue;
      }
      worker.postMessage({
        type: 'encode-gop',
        gopIndex: job.gopIndex,
        file: job.file,
        startFrame: job.startFrame,
        frameCount: job.frameCount,
        startTime: job.startTime,
        fpsNum: job.fps.num,
        fpsDen: job.fps.den,
        width: W,
        height: H,
        encodeOptions: job.encodeOptions,
        audioRate: job.encodeOptions.audioRate,
        audioChannels: job.encodeOptions.audioChannels,
        audioStartSample: job.audioRange.startSample,
        audioEndSample: job.audioRange.endSample,
        audioTotalSamples: job.audioRange.totalSamples,
        sourceReadRetryAttempts: 30,
        ditherMode: this.quantOptions.ditherMode,
        refineIterations: this.quantOptions.refineIterations,
        saturationBoost: this.quantOptions.saturationBoost,
        ditherStrength: this.quantOptions.ditherStrength,
      });
    }
  }

  failAll(error) {
    for (const job of this.queue) job.reject(error);
    for (const job of this.jobs.values()) job.reject(error);
    this.queue.length = 0;
    this.jobs.clear();
  }

  terminate() {
    this.closed = true;
    this.failAll(new Error('已取消'));
    for (const worker of this.workers) worker.terminate();
  }
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function calibrateSourceConcurrency(pool, {
  file,
  maxConcurrency,
  totalFrames,
  startTime,
  fps,
  logger = log,
}) {
  const max = Math.max(1, maxConcurrency | 0);
  if (max === 1) return 1;

  const tested = new Map();
  let probeSerial = 0;
  const probeFrames = Math.max(1, Math.min(16, totalFrames));
  async function test(count) {
    if (tested.has(count)) return tested.get(count);
    logger(`校准 decoder 并发 ${count}...`);
    const step = Math.max(1, Math.floor(Math.max(1, totalFrames - 1) / Math.max(1, count)));
    const probes = [];
    for (let i = 0; i < count; i++) {
      const frame = Math.min(Math.max(0, totalFrames - probeFrames), i * step);
      probes.push(pool.runProbe(-1000000 - probeSerial++, file, frame, probeFrames, startTime, fps));
    }
    try {
      const results = await withTimeout(Promise.allSettled(probes), Math.max(8000, 2500 * count), `decoder probe x${count}`);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      logger(`校准 decoder 并发 ${count}: OK`);
      tested.set(count, true);
      return true;
    } catch (error) {
      logger(`校准 decoder 并发 ${count}: FAIL (${error?.message || error})`);
      tested.set(count, false);
      return false;
    }
  }

  if (!(await test(1))) {
    throw new Error('单路视频 decoder 校准失败，当前浏览器不能稳定解码该视频');
  }

  let low = 1;
  let high = max;
  for (let candidate = 2; candidate <= max; candidate *= 2) {
    if (await test(candidate)) {
      low = candidate;
      if (candidate === max) return max;
    } else {
      high = candidate - 1;
      break;
    }
    if (candidate * 2 > max && candidate !== max) {
      if (await test(max)) return max;
      high = max - 1;
      break;
    }
  }

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (await test(mid)) low = mid;
    else high = mid - 1;
  }
  logger(`decoder 并发校准结果：${low}/${max}`);
  return low;
}

function makeOutputName(file, title) {
  const base = (title || file.name || 'movie').replace(/\.[^.]+$/, '').trim() || 'movie';
  return `${base}.auv`;
}

function updateDownload(blob, name) {
  const old = elements.download.dataset.url;
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  elements.download.href = url;
  elements.download.download = name;
  elements.download.dataset.url = url;
  elements.download.textContent = `下载 ${name} (${formatBytes(blob.size)})`;
  elements.download.hidden = false;
}

async function createSaveWritable(name) {
  if (!window.showSaveFilePicker) {
    throw new Error('当前浏览器不支持直接写入文件，请改用“浏览器下载”输出方式');
  }
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: name,
      types: [{
        description: 'AUV video',
        accept: { 'application/octet-stream': ['.auv'] },
      }],
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('已取消选择保存文件');
    throw err;
  }
  return handle.createWritable();
}

function renderWorkerProgress(states, audioProgress = null) {
  if (!elements.workerProgress) return;
  const active = states
    .map((state, index) => ({ state, index }));
  const hasActive = active.some(entry => entry.state && entry.state.total > 0) || (audioProgress !== null);
  const card = document.getElementById('workers-status-card');

  if (!hasActive) {
    if (card) card.style.display = 'none';
    elements.workerProgress.innerHTML = '';
    return;
  }

  if (card) card.style.display = 'block';

  let html = '';
  // 渲染音频提取线程
  if (audioProgress !== null) {
    const audioPercent = Math.min(100, Math.floor(audioProgress * 100));
    const isDone = audioPercent >= 100;
    const phaseText = isDone ? '转换完成' : '音频解码与 PCM8 转换';
    const barColor = isDone ? '#10b981' : '#ec4899';
    html += `
      <div class="worker-row busy">
        <div class="worker-header">
          <span class="worker-name" style="color: ${barColor};">音频提取线程</span>
          <span class="worker-phase">${phaseText}</span>
        </div>
        <div class="worker-progress-box">
          <div class="worker-bar-bg"><div class="worker-bar" style="width: ${audioPercent}%; background-color: ${barColor};"></div></div>
          <span class="worker-percent">${audioPercent}%</span>
        </div>
      </div>
    `;
  }

  // 渲染视频 GOP 量化线程
  html += active
    .map(({ state, index }) => {
      if (!state || state.total === 0) {
        return `
          <div class="worker-row idle">
            <div class="worker-header">
              <span class="worker-name">视频线程 #${String(index + 1).padStart(2, '0')}</span>
              <span class="worker-phase">空闲</span>
            </div>
            <div class="worker-progress-box">
              <div class="worker-bar-bg"><div class="worker-bar" style="width: 0%; background-color: #94a3b8;"></div></div>
              <span class="worker-percent">0%</span>
            </div>
          </div>
        `;
      }
      const percent = Math.floor(state.done * 100 / Math.max(1, state.total));
      const phaseText = state.phase === 'audio' ? '步骤 1/3: 音频中'
        : state.phase === 'decode' ? '步骤 2/3: 解帧中'
          : '步骤 3/3: 编码中';
      const rangeText = state.phase === 'audio'
        ? `GOP ${state.gopIndex}, audio ${state.done}/${state.total}`
        : `GOP ${state.gopIndex}, 帧 ${state.startFrame + 1}-${state.startFrame + state.total}`;
      return `
        <div class="worker-row busy">
          <div class="worker-header">
            <span class="worker-name">视频线程 #${String(index + 1).padStart(2, '0')}</span>
            <span class="worker-phase">${phaseText} (${rangeText})</span>
          </div>
          <div class="worker-progress-box">
            <div class="worker-bar-bg"><div class="worker-bar" style="width: ${percent}%;"></div></div>
            <span class="worker-percent">${percent}%</span>
          </div>
        </div>
      `;
    })
    .join('');

  elements.workerProgress.innerHTML = html;
}

async function encode() {
  const file = elements.file.files?.[0];
  if (!file) throw new Error('请先选择视频文件');
  elements.log.textContent = '';
  elements.download.hidden = true;
  elements.progress.value = 0;
  renderWorkerProgress([]);
  elements.encode.disabled = true;
  elements.cancel.disabled = false;

  // 更新 LED 状态为工作忙碌
  const led = document.getElementById('power-led');
  if (led) led.className = 'power-led busy';

  const fpsText = document.getElementById('live-fps');
  if (fpsText) fpsText.textContent = '0.00 FPS';

  const abort = { cancelled: false };
  activeJob = abort;
  let pool = null;
  let fileWriter = null;
  let directWritable = null;

  try {
    if (!currentVideo) throw new Error('请先导入视频文件');
    const video = currentVideo;

    const fps = selectedFps();
    const startTime = Math.max(0, Number(elements.start.value) || 0);
    const sourceDuration = Math.max(0, (video.duration || 0) - startTime);
    const requestedDuration = Number(elements.duration.value) || sourceDuration;
    const duration = Math.max(0, Math.min(sourceDuration, requestedDuration));
    const totalFrames = Math.max(1, Math.floor(duration * fps.num / fps.den));
    const audioRate = Number(elements.audioRate.value) || 16384;
    const audioChannels = Number(elements.audioChannels.value) || 2;
    const audioGainPercent = Math.max(0, Math.min(400, Number(elements.audioGain?.value) || 175));
    const audioGain = audioGainPercent / 100;
    const title = (elements.title.value || file.name.replace(/\.[^.]+$/, '') || 'movie').trim();
    const outputName = makeOutputName(file, title);
    const outputMode = elements.outputMode?.value || 'blob';
    const keyframeIntervalSeconds = 20;
    const keyframeInterval = Math.max(1, Math.round(keyframeIntervalSeconds * fps.num / fps.den));
    const totalGops = Math.ceil(totalFrames / keyframeInterval);
    const userSelectedWorkers = Math.max(1, Number(elements.workers.value) || 1);
    const workerCount = Math.min(Math.max(1, Math.min(32, userSelectedWorkers)), totalGops);
    const sourceConcurrencyMax = Math.min(workerCount, totalGops, 16);

    log(`源视频 ${video.videoWidth}x${video.videoHeight}, 时长 ${video.duration.toFixed(2)}s`);
    log(`输出 ${W}x${H}, ${fps.num}/${fps.den} fps, ${totalFrames} 帧, workers=${workerCount}, decoderProbeMax=${sourceConcurrencyMax}`);
    log(`音频 ${audioRate}Hz ${audioChannels}ch，音量调整 ${audioGainPercent}%`);
    log(`输出方式：${outputMode === 'file' ? '直接写入文件' : '浏览器下载'}`);
    if (outputMode === 'file') {
      setStage('选择保存位置...', 0.02);
      directWritable = await createSaveWritable(outputName);
    }

    setStage('抽取预览...');
    let preview;
    if (customPreviewImage) {
      preview = makePreviewRgb555(customPreviewImage, 80, 60);
      log(`使用上传的自定义图片作为 AUV 预览图`);
    } else {
      const previewCanvas = makeCanvas(80, 60);
      const previewScrubber = document.getElementById('preview-scrubber');
      const scrubberTime = previewScrubber && !previewScrubber.disabled ? Number(previewScrubber.value) : NaN;
      const previewTime = Number.isFinite(scrubberTime) && scrubberTime >= 0
        ? Math.min(video.duration, scrubberTime)
        : Math.min(video.duration, startTime + duration * 0.30);

      log(`从视频 ${previewTime.toFixed(2)}s 处提取预览图`);
      const previewRgb = await captureRgb(video, previewTime, 80, 60, previewCanvas);
      preview = makePreviewRgb555(previewRgb, 80, 60);
      const previewCtx = elements.preview.getContext('2d');
      previewCtx.imageSmoothingEnabled = false;
      previewCtx.putImageData(previewCanvas.context.getImageData(0, 0, 80, 60), 0, 0);
    }

    const workerStates = Array.from({ length: workerCount }, () => null);
    let nextCapture = 0;
    let nextSubmitGop = 0;
    let nextCollectGop = 0;
    let completedFrames = 0;
    let changedPixels = 0;
    const audioTotalSamples = Math.max(0, Math.round(totalFrames * audioRate * fps.den / fps.num));
    const audioByteLength = audioTotalSamples * audioChannels;
    const audio = outputMode === 'blob' ? new Uint8Array(audioByteLength) : null;
    const started = performance.now();
    const progressSamples = [{ time: started, frames: 0 }];

    // 共享的进度更新逻辑
    function updateProgressState() {
      renderWorkerProgress(workerStates, null);

      const activeDone = workerStates.reduce((sum, ws) => {
        if (!ws || ws.total === 0 || ws.phase !== 'encode') return sum;
        return sum + ws.done;
      }, 0);
      const currentProgressFrames = Math.min(totalFrames, completedFrames + activeDone);
      const videoProgressFraction = currentProgressFrames / totalFrames;

      const overallProgress = videoProgressFraction;

      const elapsed = (performance.now() - started) / 1000;
      const now = performance.now();
      progressSamples.push({ time: now, frames: currentProgressFrames });
      while (progressSamples.length > 2 && now - progressSamples[1].time > 10000) {
        progressSamples.shift();
      }
      const oldest = progressSamples[0];
      const windowSeconds = Math.max(0.001, (now - oldest.time) / 1000);
      const fpsDone = (currentProgressFrames - oldest.frames) / windowSeconds;

      let stageText = `并行转码中 (${currentProgressFrames}/${totalFrames} 帧)`;
      if (videoProgressFraction >= 1.0) {
        stageText = "转码完毕，打包中...";
      }
      setStage(stageText, overallProgress);
      if (fpsText) fpsText.textContent = `${fpsDone.toFixed(2)} FPS`;
    }

    setStage('初始化 GOP 并行编码器...', 0.05);
    let sourceConcurrency = 1;
    let lastDecoderPressureAt = 0;
    pool = new GopWorkerPool(workerCount, {
      ditherMode: 1,
      refineIterations: 4,
      saturationBoost: true,
      ditherStrength: 1.0,
    }, (progress) => {
      workerStates[progress.workerIndex] = progress;
      updateProgressState();
    }, (text) => {
      if (!/too many decoders|decoder initialization failed|quotaexceeded/i.test(text)) return;
      const now = performance.now();
      if (sourceConcurrency <= 1 || now - lastDecoderPressureAt < 2000) return;
      const old = sourceConcurrency;
      sourceConcurrency = Math.max(1, Math.floor(sourceConcurrency / 2));
      lastDecoderPressureAt = now;
      log(`decoder pressure: sourceConcurrency ${old}->${sourceConcurrency}`);
    });
    await pool.init();

    setStage('校准浏览器 decoder 并发...', 0.06);
    sourceConcurrency = await calibrateSourceConcurrency(pool, {
      file,
      maxConcurrency: sourceConcurrencyMax,
      totalFrames,
      startTime,
      fps,
    });
    log(`正式编码 decoder 并发=${sourceConcurrency}，CPU workers=${workerCount}`);

    const pendingGops = new Map();
    const encodedFrames = outputMode === 'blob' ? [] : null;
    let cachedVideoBytes = 0;
    let truncatedAt = null;
    const encodeOptions = defaultEncodeOptions({
      title,
      fpsNum: fps.num,
      fpsDen: fps.den,
      audioRate,
      audioChannels,
      audioGain,
      keyframeIntervalSeconds,
    });
    if (outputMode === 'file') {
      fileWriter = new AuvFileWriter(directWritable, {
        frameCount: totalFrames,
        audioByteLength,
        preview,
        options: encodeOptions,
      });
      directWritable = null;
      await fileWriter.init();
      log(`将逐段写入 ${outputName}，不会生成内存中的完整 AUV`);
    }

    while (completedFrames < totalFrames) {
      if (abort.cancelled) throw new Error('已取消');
      while (nextCapture < totalFrames && pendingGops.size < Math.max(1, sourceConcurrency)) {
        const gopStart = nextCapture;
        const gopEnd = Math.min(totalFrames, gopStart + keyframeInterval);
        const frameCount = gopEnd - gopStart;
        const audioRange = {
          startSample: Math.round(gopStart * audioRate * fps.den / fps.num),
          endSample: Math.min(audioTotalSamples, Math.round(gopEnd * audioRate * fps.den / fps.num)),
          totalSamples: audioTotalSamples,
        };
        pendingGops.set(
          nextSubmitGop,
          pool.runGop(nextSubmitGop, file, gopStart, frameCount, startTime, fps, encodeOptions, audioRange),
        );
        log(`提交 GOP ${nextSubmitGop}: frame ${gopStart + 1}-${gopEnd}, audio ${audioRange.startSample}-${audioRange.endSample}`);
        nextSubmitGop++;
        nextCapture = gopEnd;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const promise = pendingGops.get(nextCollectGop);
      if (!promise) continue;
      const gop = await promise;
      pendingGops.delete(nextCollectGop);
      for (let i = 0; i < workerStates.length; i++) {
        if (workerStates[i]?.gopIndex === gop.gopIndex) workerStates[i] = null;
      }
      const gopAudioBytes = gop.audio?.payload?.byteLength || 0;
      const gopFrameBytes = gop.frames.reduce((sum, frame) => sum + frame.payload.byteLength + 8, 0);
      const writeStart = performance.now();
      if (outputMode === 'file') {
        log(`GOP ${gop.gopIndex} 收到自 Worker #${gop.workerIndex + 1}: frames=${gop.frames.length}, audio=${formatBytes(gopAudioBytes)}, video=${formatBytes(gopFrameBytes)}，开始写入`);
        const estimate = fileWriter.estimateAppendGop(gop);
        if (estimate.wouldExceedPlayableLimit) {
          const cutSeconds = startTime + completedFrames * fps.den / fps.num;
          truncatedAt = {
            frame: completedFrames,
            seconds: cutSeconds,
            estimatedBytes: estimate.estimatedFileBytes,
          };
          log(
            `达到当前 GBA 播放器 4GB 可寻址上限，停止追加 GOP ${gop.gopIndex}。` +
            `截断点：frame=${completedFrames}, source=${cutSeconds.toFixed(2)}s，` +
            `若继续写入预计 ${formatBytes(estimate.estimatedFileBytes)} > ${formatBytes(MAX_PLAYABLE_AUV_BYTES)}。`,
          );
          for (const pending of pendingGops.values()) pending.catch(() => {});
          break;
        }
        const stats = await fileWriter.appendGop(gop);
        if (stats.truncated) {
          const cutSeconds = startTime + completedFrames * fps.den / fps.num;
          truncatedAt = { frame: completedFrames, seconds: cutSeconds, estimatedBytes: stats.estimatedFileBytes };
          log(`达到当前 GBA 播放器 4GB 可寻址上限，截断点：frame=${completedFrames}, source=${cutSeconds.toFixed(2)}s。`);
          for (const pending of pendingGops.values()) pending.catch(() => {});
          break;
        }
        const writeMs = performance.now() - writeStart;
        log(
          `GOP ${gop.gopIndex} 写入完成: fileOff=${stats.fileOffset}, vdatOff=${stats.videoOffset}, ` +
          `audio=${formatBytes(stats.audioBytes)}, video=${formatBytes(stats.videoBytes)}, ` +
          `write=${formatMs(writeMs)}, total≈${formatBytes(stats.estimatedFileBytes)}${memorySummary()}`,
        );
      } else {
        const nextFrameCount = completedFrames + gop.frames.length;
        const nextAudioSamples = Math.min(audioTotalSamples, Math.round(nextFrameCount * audioRate * fps.den / fps.num));
        const nextAudioBytes = nextAudioSamples * audioChannels;
        const estimatedBlobBytes = estimatePackedAuvBytes({
          frameCount: nextFrameCount,
          audioByteLength: nextAudioBytes,
          preview,
          videoByteLength: cachedVideoBytes + gopFrameBytes,
          options: encodeOptions,
        });
        if (estimatedBlobBytes > MAX_PLAYABLE_AUV_BYTES) {
          const cutSeconds = startTime + completedFrames * fps.den / fps.num;
          truncatedAt = {
            frame: completedFrames,
            seconds: cutSeconds,
            estimatedBytes: estimatedBlobBytes,
          };
          log(
            `达到当前 GBA 播放器 4GB 可寻址上限，停止缓存 GOP ${gop.gopIndex}。` +
            `截断点：frame=${completedFrames}, source=${cutSeconds.toFixed(2)}s，` +
            `若继续写入预计 ${formatBytes(estimatedBlobBytes)} > ${formatBytes(MAX_PLAYABLE_AUV_BYTES)}。`,
          );
          for (const pending of pendingGops.values()) pending.catch(() => {});
          break;
        }
        for (const frame of gop.frames) encodedFrames.push(frame);
        cachedVideoBytes += gopFrameBytes;
        log(
          `GOP ${gop.gopIndex} 缓存完成: worker #${gop.workerIndex + 1}, frames=${gop.frames.length}, ` +
          `audio=${formatBytes(gopAudioBytes)}, video=${formatBytes(gopFrameBytes)}, ` +
          `cachedVideo≈${formatBytes(cachedVideoBytes)}${memorySummary()}`,
        );
      }
      if (outputMode === 'blob' && gop.audio) {
        audio.set(gop.audio.payload, gop.audio.startSample * audioChannels);
      }
      changedPixels += gop.changedPixels;
      completedFrames += gop.frames.length;
      nextCollectGop++;

      updateProgressState();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    pool.terminate();
    pool = null;

    setStage('打包 AUV...', 0.98);
    let outputBytes = 0;
    if (outputMode === 'file') {
      const result = await fileWriter.finalize();
      fileWriter = null;
      outputBytes = result.byteLength;
      elements.download.hidden = true;
      if (truncatedAt) {
        log(`完成：已写入可播放分段 ${outputName} (${formatBytes(outputBytes)})`);
        log(`视频已在源时间 ${truncatedAt.seconds.toFixed(2)}s 截断；继续转下一段时请从这个时间点之后开始。`);
      } else {
        log(`完成：已写入 ${outputName} (${formatBytes(outputBytes)})`);
      }
    } else {
      const outputAudioSamples = Math.min(
        audioTotalSamples,
        Math.round(completedFrames * audioRate * fps.den / fps.num),
      );
      const outputAudioBytes = outputAudioSamples * audioChannels;
      const outputAudio = audio.subarray(0, outputAudioBytes);
      const auv = packAuv({ encodedFrames, audio: outputAudio, preview, options: encodeOptions });
      outputBytes = auv.byteLength;
      const blob = new Blob([auv], { type: 'application/octet-stream' });
      updateDownload(blob, outputName);
      if (truncatedAt) {
        log(`完成：已生成可播放分段 ${formatBytes(outputBytes)}`);
        log(`视频已在源时间 ${truncatedAt.seconds.toFixed(2)}s 截断；继续转下一段时请从这个时间点之后开始。`);
      } else {
        log(`完成：${formatBytes(outputBytes)}`);
      }
    }
    const avgChanged = Math.round(changedPixels / Math.max(1, completedFrames));
    log(`平均更新 ${avgChanged}/${W * H} px/frame`);
    setStage(truncatedAt ? `已截断到 ${truncatedAt.seconds.toFixed(2)}s` : '完成', 1);
  } finally {
    if (pool) pool.terminate();
    // 如果直接写入模式中途失败或取消，尽量关闭文件句柄，留下的半成品由用户删除。
    if (fileWriter) await fileWriter.abort();
    else if (directWritable) {
      try {
        await directWritable.close();
      } catch {
        // Keep the original encode error visible.
      }
    }
    elements.encode.disabled = false;
    elements.cancel.disabled = true;
    activeJob = null;

    // 完成后更新 LED 为常亮绿色或已完成蓝色
    if (led) {
      if (elements.progress.value >= 1) {
        led.className = 'power-led complete';
      } else {
        led.className = 'power-led';
      }
    }
  }
}

let wasmAssetsReady = false;

async function drainAsset(url, onProgress) {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`${url} HTTP ${response.status}`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body) {
    await response.arrayBuffer();
    onProgress?.(total, total);
    return;
  }

  const reader = response.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
}

async function preloadWasmAssets() {
  const statusEl = document.getElementById('system-status');
  const encodeBtn = elements.encode;

  if (encodeBtn) {
    encodeBtn.disabled = true;
    encodeBtn.title = "正在下载 WASM 编码内核，请稍候...";
  }
  if (statusEl) {
    statusEl.textContent = "● SYSTEM LOADING";
    statusEl.className = "connection-status loading";
  }

  try {
    const assets = [
      { label: 'JS', url: new URL('../wasm/auv_quantizer.js', import.meta.url).href },
      { label: 'WASM', url: new URL('../wasm/auv_quantizer.wasm', import.meta.url).href },
    ];
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      if (statusEl) {
        statusEl.textContent = `● CORE ${i + 1}/${assets.length} ${asset.label}`;
      }
      let lastPercent = -1;
      await drainAsset(asset.url, (loaded, total) => {
        if (!statusEl || !total) return;
        const percent = Math.floor(loaded * 100 / total);
        if (percent !== lastPercent) {
          lastPercent = percent;
          statusEl.textContent = `● CORE ${i + 1}/${assets.length} ${asset.label} ${percent}%`;
        }
      });
    }
    onPreloadSuccess();
  } catch (err) {
    onPreloadError(err.message || err);
  }

  function onPreloadSuccess() {
    wasmAssetsReady = true;
    if (statusEl) {
      statusEl.textContent = "● SYSTEM ONLINE";
      statusEl.className = "connection-status online";
    }
    if (encodeBtn) {
      encodeBtn.disabled = false;
      encodeBtn.removeAttribute('title');
    }
  }

  function onPreloadError(detail) {
    console.error("WASM asset preload failed:", detail);
    if (statusEl) {
      statusEl.textContent = "● SYSTEM ERROR";
      statusEl.className = "connection-status error";
    }
    if (encodeBtn) {
      encodeBtn.disabled = true;
      encodeBtn.title = `WASM 编码内核下载失败：${detail}`;
    }
  }
}

function initializeForm() {
  // 设置并发线程数默认值
  elements.workers.value = String(Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)));
  const workersCountBadge = document.getElementById('workers-count-badge');
  if (workersCountBadge) {
    workersCountBadge.textContent = elements.workers.value;
  }

  // 绑定并行 Worker 滑块事件
  elements.workers.addEventListener('input', () => {
    if (workersCountBadge) {
      workersCountBadge.textContent = elements.workers.value;
    }
  });

  // 日志折叠面板展开/收起
  const logsToggle = document.getElementById('logs-toggle');
  const logsCard = document.getElementById('logs-panel-card');
  if (logsToggle && logsCard) {
    logsToggle.addEventListener('click', () => {
      logsCard.classList.toggle('collapsed');
    });
  }

  // 虚拟掌机实体按键绑定
  const btnA = document.getElementById('gba-btn-a');
  const btnB = document.getElementById('gba-btn-b');
  const btnStart = document.getElementById('gba-btn-start');
  const btnSelect = document.getElementById('gba-btn-select');

  if (btnA) {
    btnA.addEventListener('click', () => {
      if (!elements.encode.disabled) {
        elements.encode.click();
      }
    });
  }
  if (btnB) {
    btnB.addEventListener('click', () => {
      if (!elements.cancel.disabled) {
        elements.cancel.click();
      }
    });
  }
  if (btnStart) {
    btnStart.addEventListener('click', () => {
      if (!elements.encode.disabled) {
        elements.encode.click();
      }
    });
  }
  if (btnSelect) {
    btnSelect.addEventListener('click', () => {
      elements.log.textContent = '';
      log('日志系统已重置');
    });
  }

  // 绑定右侧备用导入按钮的事件委托
  const metaContainer = document.getElementById('source-metadata-box');
  if (metaContainer) {
    metaContainer.addEventListener('click', (e) => {
      const target = e.target.closest('#btn-import-right');
      if (target) {
        elements.file.click();
      }
    });
  }

  // 预览模式 Tab 切换与互斥显示逻辑
  const tabVideo = document.getElementById('tab-mode-video');
  const tabImage = document.getElementById('tab-mode-image');
  const containerVideo = document.getElementById('container-mode-video');
  const containerImage = document.getElementById('container-mode-image');
  const uploadStatus = document.getElementById('upload-status-text');

  function setPreviewMode(mode) {
    if (mode === 'video') {
      if (tabVideo) tabVideo.classList.add('active');
      if (tabImage) tabImage.classList.remove('active');
      if (containerVideo) containerVideo.style.display = 'block';
      if (containerImage) containerImage.style.display = 'none';

      // 切回视频帧提取时，清空已经上传的本地图片数据，恢复当前的视频帧
      customPreviewImage = null;
      const customImageInput = document.getElementById('preview-image-file');
      if (customImageInput) customImageInput.value = '';
      if (uploadStatus) {
        uploadStatus.textContent = '自动等比缩放为 80×60 像素，支持 JPG/PNG 格式';
        uploadStatus.style.color = '';
      }

      const scrubber = document.getElementById('preview-scrubber');
      if (scrubber) {
        updatePreviewFromTime(Number(scrubber.value));
      }
    } else {
      if (tabVideo) tabVideo.classList.remove('active');
      if (tabImage) tabImage.classList.add('active');
      if (containerVideo) containerVideo.style.display = 'none';
      if (containerImage) containerImage.style.display = 'block';
      log('已切换至自定义预览图模式。请上传图片文件以替换预览。');
    }
  }

  if (tabVideo && tabImage) {
    tabVideo.addEventListener('click', () => setPreviewMode('video'));
    tabImage.addEventListener('click', () => setPreviewMode('image'));
  }

  // 预览滑块拖拽监听
  const previewScrubber = document.getElementById('preview-scrubber');
  if (previewScrubber) {
    previewScrubber.addEventListener('input', () => {
      updatePreviewFromTime(Number(previewScrubber.value));
    });
  }

  // 自定义预览图上传处理
  const previewImageInput = document.getElementById('preview-image-file');
  if (previewImageInput) {
    previewImageInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          // 创建临时 80x60 画布来缩放和抓取 RGB 数据
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = 80;
          tempCanvas.height = 60;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.drawImage(img, 0, 0, 80, 60);

          // 获取 RGB 数据
          customPreviewImage = getRgbFromCanvas(tempCanvas);

          // 在屏幕预览 Canvas 上绘制以实时反馈
          const previewCtx = elements.preview.getContext('2d');
          previewCtx.imageSmoothingEnabled = false;
          previewCtx.drawImage(img, 0, 0, 80, 60);

          // 隐藏 LCD 帮助信息，显示屏幕
          const helpOverlay = document.getElementById('screen-help-overlay');
          if (helpOverlay) helpOverlay.style.display = 'none';
          elements.preview.style.display = 'block';

          if (uploadStatus) {
            uploadStatus.textContent = `🟢 已加载图片: ${file.name} (${formatBytes(file.size)})`;
            uploadStatus.style.color = '#10b981';
          }
          log(`成功加载自定义预览图：${file.name}`);
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // D-Pad 物理按键点击装饰反馈
  document.querySelectorAll('.dpad-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key || 'unknown';
      log(`方向键按下: ${key.toUpperCase()}`);
    });
  });

  // 拖拽视频文件支持
  const dropZone = document.getElementById('drop-zone');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = e.dataTransfer?.files;
      if (files && files.length) {
        elements.file.files = files;
        elements.file.dispatchEvent(new Event('change'));
      }
    });
  }

  // 烧录卡带插入动画与数据更新
  elements.file.addEventListener('change', async () => {
    const file = elements.file.files?.[0];
    if (!file) return;
    elements.title.value = file.name.replace(/\.[^.]+$/, '');
    elements.download.hidden = true;

    // 复位预览图设置至“截取视频帧”模式
    if (tabVideo && tabImage) {
      setPreviewMode('video');
    } else {
      customPreviewImage = null;
      const customImageInput = document.getElementById('preview-image-file');
      if (customImageInput) {
        customImageInput.value = '';
      }
    }

    // 清理老视频缓存
    if (currentVideo) {
      currentVideo = null;
    }
    if (currentVideoUrl) {
      URL.revokeObjectURL(currentVideoUrl);
      currentVideoUrl = null;
    }

    // 禁用进度条
    const previewScrubber = document.getElementById('preview-scrubber');
    if (previewScrubber) {
      previewScrubber.disabled = true;
    }

    // 触发卡带滑入动画
    if (dropZone) {
      dropZone.classList.add('has-cartridge');
    }

    const nameEl = document.getElementById('sticker-file-name');
    const sizeEl = document.getElementById('sticker-file-size');
    if (nameEl) nameEl.textContent = file.name;
    if (sizeEl) sizeEl.textContent = formatBytes(file.size);

    const metaInfo = document.getElementById('source-meta-info');
    if (metaInfo) {
      metaInfo.innerHTML = '<span class="loading-pulse">正在解析卡带元数据...</span>';
    }

    // 隐藏按键提示遮罩层，展示预览 Canvas
    const helpOverlay = document.getElementById('screen-help-overlay');
    if (helpOverlay) helpOverlay.style.display = 'none';
    elements.preview.style.display = 'block';

    log(`成功载入视频卡带：${file.name} (${formatBytes(file.size)})`);
    log(`正在分析视频轨道与参数...`);

    try {
      const loaded = await loadVideo(file);
      currentVideo = loaded.video;
      currentVideoUrl = loaded.url;

      const w = currentVideo.videoWidth;
      const h = currentVideo.videoHeight;
      const durationSec = currentVideo.duration;

      // 估算原始帧率 (FPS)
      const originalFps = await estimateFps(currentVideo);
      const estimatedTotalFrames = Math.max(1, Math.round(durationSec * originalFps));

      // 转换为 HMS 格式
      const hours = Math.floor(durationSec / 3600);
      const minutes = Math.floor((durationSec % 3600) / 60);
      const seconds = Math.floor(durationSec % 60);
      const ms = Math.floor((durationSec % 1) * 1000);

      let hmsStr = "";
      if (hours > 0) {
        hmsStr += `${hours}小时`;
      }
      if (minutes > 0 || hours > 0) {
        hmsStr += `${minutes}分`;
      }
      hmsStr += `${seconds}.${ms.toString().padStart(3, '0')}秒`;

      if (metaInfo) {
        metaInfo.innerHTML = `
          <div class="meta-item"><span>视频分辨率:</span> <strong>${w} × ${h}</strong></div>
          <div class="meta-item"><span>原始帧率:</span> <strong>${originalFps.toFixed(3)} FPS</strong></div>
          <div class="meta-item"><span>预估总帧数:</span> <strong>${estimatedTotalFrames} 帧</strong></div>
          <div class="meta-item"><span>总时长 (HMS):</span> <strong>${hmsStr}</strong></div>
          <div class="meta-item"><span>总时长 (秒):</span> <strong>${durationSec.toFixed(3)} 秒</strong></div>
          <div class="meta-item"><span>容器格式:</span> <strong>${file.type || 'video/unknown'}</strong></div>
          <div style="margin-top: 12px; display: flex; justify-content: flex-end;">
            <button type="button" class="btn-import-right" id="btn-import-right">🔄 重新选择视频文件...</button>
          </div>
        `;
      }

      // 设置默认截取时间为视频实际时间
      elements.duration.value = durationSec.toFixed(3);
      elements.start.value = "0";

      // 配置进度条滑块参数与可用状态
      if (previewScrubber) {
        previewScrubber.min = "0";
        previewScrubber.max = durationSec.toFixed(3);
        previewScrubber.step = "0.01";
        previewScrubber.value = (durationSec * 0.3).toFixed(3);
        previewScrubber.disabled = false;
      }

      // 生成默认 30% 时长处的初始画面
      await updatePreviewFromTime(durationSec * 0.3);

      log(`元数据解析完毕: 分辨率 ${w}x${h}, 帧率 ${originalFps.toFixed(3)} FPS, 长度 ${durationSec.toFixed(3)}秒`);
    } catch (err) {
      log(`解析卡带视频信息失败: ${err.message || err}`);
      if (metaInfo) {
        metaInfo.innerHTML = `
          <span style="color: #ef4444;">解析视频轨道元数据失败。您可以手动填写参数。</span>
          <div style="margin-top: 12px; display: flex; justify-content: flex-end;">
            <button type="button" class="btn-import-right" id="btn-import-right">🔄 重新选择视频文件...</button>
          </div>
        `;
      }
    }
  });

  const fpsCustomGroup = document.getElementById('fps-custom-group');
  elements.fpsPreset.addEventListener('change', () => {
    const isCustom = elements.fpsPreset.value === 'custom';
    elements.fpsCustom.disabled = !isCustom;
    if (fpsCustomGroup) {
      fpsCustomGroup.style.display = isCustom ? 'flex' : 'none';
    }
  });

  elements.encode.addEventListener('click', () => {
    encode().catch((error) => {
      const led = document.getElementById('power-led');
      if (String(error?.message || error) !== '已取消') {
        log(`错误：${error.message || error}`);
        if (led) led.className = 'power-led error';
      } else {
        if (led) led.className = 'power-led';
      }
      setStage(String(error?.message || error), elements.progress.value);
      elements.encode.disabled = false;
      elements.cancel.disabled = true;
      activeJob = null;
    });
  });

  elements.cancel.addEventListener('click', () => {
    if (activeJob) activeJob.cancelled = true;
  });

  // 绑定赞赏支持模态框事件
  const sponsorBtn = document.getElementById('btn-sponsor');
  const sponsorModal = document.getElementById('sponsor-modal');
  const sponsorClose = document.getElementById('sponsor-modal-close');

  if (sponsorBtn && sponsorModal) {
    sponsorBtn.addEventListener('click', () => {
      sponsorModal.hidden = false;
    });
  }

  if (sponsorClose && sponsorModal) {
    sponsorClose.addEventListener('click', () => {
      sponsorModal.hidden = true;
    });
  }

  if (sponsorModal) {
    sponsorModal.addEventListener('click', (e) => {
      if (e.target === sponsorModal) {
        sponsorModal.hidden = true;
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !sponsorModal.hidden) {
        sponsorModal.hidden = true;
      }
    });
  }

  // 页面初始化时只预下载 WASM 静态资源；真正的 Worker/WASM 实例在编码时再创建。
  preloadWasmAssets();
}

initializeForm();
