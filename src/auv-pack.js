export const W = 240;
export const H = 160;
export const PIXELS = W * H;
export const RAW_FRAME_BYTES = PIXELS * 2;
export const FRAME_TYPE_INDEX_RUNS = 0;
export const FRAME_TYPE_RAW_FULL = 1;
export const FRAME_TYPE_SHIFT = 30;
export const FRAME_OFFSET_MASK = 0x3fffffff;
export const STREAM_CHUNK_MAX_BYTES = 2048;
export const AUV_ALIGN = 512;
const FILE_WRITE_CHUNK_BYTES = 512 * 1024;

const encoderName = 'Ausar AUV Web Encoder';
const UINT32_MAX = 0xffffffff;
export const MAX_PLAYABLE_AUV_BYTES = Math.floor(UINT32_MAX / AUV_ALIGN) * AUV_ALIGN;
const GBA_DISPLAY_RATE_NUM = 597275n;
const GBA_DISPLAY_RATE_DEN = 10000n;

export function defaultEncodeOptions(overrides = {}) {
  return {
    title: 'movie.auv',
    fpsNum: 24000,
    fpsDen: 1001,
    audioRate: 16384,
    audioChannels: 2,
    audioGain: 1.75,
    keyframeIntervalSeconds: 20,
    deadbandThreshold: 10,
    holdCleanupMinThreshold: 2,
    holdTiers: [
      { threshold: 4, frames: 24 },
      { threshold: 6, frames: 12 },
      { threshold: 10, frames: 6 },
    ],
    runGapMerge: 0,
    scatterThreshold: 0,
    ...overrides,
  };
}

export function alignUp(value, align = AUV_ALIGN) {
  if (!Number.isFinite(value) || !Number.isFinite(align) || align <= 0) {
    throw new Error(`invalid alignment value=${value} align=${align}`);
  }
  return Math.ceil(value / align) * align;
}

export function fourcc(text) {
  return text.charCodeAt(0) | (text.charCodeAt(1) << 8) | (text.charCodeAt(2) << 16) | (text.charCodeAt(3) << 24);
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

function validateFps(num, den) {
  if (!Number.isInteger(num) || !Number.isInteger(den) ||
      num <= 0 || den <= 0 || num > UINT32_MAX || den > UINT32_MAX) {
    throw new Error('invalid AUV FPS fraction');
  }
  let step = BigInt(num) * GBA_DISPLAY_RATE_DEN;
  let threshold = GBA_DISPLAY_RATE_NUM * BigInt(den);
  const divisor = gcdBigInt(step, threshold);
  step /= divisor;
  threshold /= divisor;
  if (step > 0xffffffffn || threshold > 0xffffffffn) {
    throw new Error('AUV FPS fraction overflows the GBA frame scheduler');
  }
}

function writeU16(out, value) {
  out.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeU32(out, value) {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function pushBytes(out, bytes) {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

export function rgb888ToRgb555Rounded(rgb) {
  const out = new Uint16Array(PIXELS);
  for (let i = 0, p = 0; i < PIXELS; i++, p += 3) {
    const r = Math.floor((rgb[p] * 31 + 127) / 255);
    const g = Math.floor((rgb[p + 1] * 31 + 127) / 255);
    const b = Math.floor((rgb[p + 2] * 31 + 127) / 255);
    out[i] = r | (g << 5) | (b << 10);
  }
  return out;
}

export function encodeRawFullFrame(rgb, recordOffset) {
  const pixels = rgb888ToRgb555Rounded(rgb);
  const headerSize = 8;
  const rawHeader = 4;
  const pad = alignUp(recordOffset + headerSize + rawHeader) - (recordOffset + headerSize + rawHeader);
  const payload = new Uint8Array(rawHeader + pad + RAW_FRAME_BYTES);
  payload[0] = 0x52;
  payload[1] = 0x35;
  payload[2] = 0x35;
  payload[3] = 0x35;
  payload.set(new Uint8Array(pixels.buffer), rawHeader + pad);
  return { type: FRAME_TYPE_RAW_FULL, payload, changedPixels: PIXELS, chunks: Math.ceil(RAW_FRAME_BYTES / STREAM_CHUNK_MAX_BYTES) };
}

export function buildFramedVideo(encodedFrames) {
  let total = 0;
  for (const frame of encodedFrames) total += 8 + frame.payload.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const entries = [];
  let cursor = 0;
  for (let i = 0; i < encodedFrames.length; i++) {
    const frame = encodedFrames[i];
    const recordOffset = cursor;
    out[cursor] = frame.type & 0xff;
    out[cursor + 1] = 0;
    out[cursor + 2] = 0;
    out[cursor + 3] = 0;
    view.setUint32(cursor + 4, frame.payload.byteLength >>> 0, true);
    cursor += 8;
    out.set(frame.payload, cursor);
    cursor += frame.payload.byteLength;
    entries.push({ frameIndex: i, offset: recordOffset, type: frame.type });
  }
  return { video: out, entries };
}

function writeAsciiAt(out, offset, text) {
  for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i) & 0xff;
}

function writeU64(out, value) {
  const lo = value >>> 0;
  const hi = Math.floor(value / 0x100000000) >>> 0;
  writeU32(out, lo);
  writeU32(out, hi);
}

function setSectionEntry(bytes, offset, section) {
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) bytes[offset + i] = section.type.charCodeAt(i);
  view.setUint16(offset + 4, 1, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint32(offset + 8, section.offset >>> 0, true);
  view.setUint32(offset + 12, Math.floor(section.offset / 0x100000000), true);
  const byteLength = section.payload ? section.payload.byteLength : section.byteLength;
  view.setUint32(offset + 16, byteLength >>> 0, true);
  view.setUint32(offset + 20, Math.floor(byteLength / 0x100000000), true);
  view.setUint32(offset + 24, section.format >>> 0, true);
  view.setUint32(offset + 28, section.codec >>> 0, true);
  view.setUint32(offset + 32, section.aux0 >>> 0, true);
  view.setUint32(offset + 36, section.aux1 >>> 0, true);
}

function tlv(tag, type, payload) {
  const out = [];
  writeU16(out, tag);
  writeU16(out, type);
  writeU32(out, payload.byteLength);
  pushBytes(out, payload);
  while (out.length & 3) out.push(0);
  return new Uint8Array(out);
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

function buildMeta(options, frameCount, audioSamples, videoCodec, audioCodec) {
  const parts = [];
  const title = options.title || 'movie.auv';
  parts.push(tlv(1, 1, utf8(title)));
  const durationMs = Math.round(frameCount * options.fpsDen * 1000 / options.fpsNum);
  const d = new Uint8Array(8);
  new DataView(d.buffer).setUint32(0, durationMs >>> 0, true);
  parts.push(tlv(2, 2, d));
  const fps = new Uint8Array(8);
  const fpsView = new DataView(fps.buffer);
  fpsView.setUint32(0, options.fpsNum >>> 0, true);
  fpsView.setUint32(4, options.fpsDen >>> 0, true);
  parts.push(tlv(3, 3, fps));
  for (const [tag, value] of [
    [4, videoCodec],
    [5, audioCodec],
    [6, audioSamples ? options.audioRate : 0],
    [7, audioSamples ? options.audioChannels : 0],
  ]) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    parts.push(tlv(tag, 3, b));
  }
  parts.push(tlv(8, 1, utf8(encoderName)));
  const size = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(size);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.byteLength;
  }
  return out;
}

function buildKeyframes(entries, frameCount, options) {
  const interval = Math.max(1, Math.round((options.keyframeIntervalSeconds || 20) * options.fpsNum / options.fpsDen));
  const rows = [];
  const add = (frameIndex) => {
    if (frameIndex < 0 || frameIndex >= frameCount) return;
    if (rows.some((r) => r.frameIndex === frameIndex)) return;
    const entry = entries[frameIndex];
    const audioSample = options.audioRate && options.audioChannels ?
      Math.round(frameIndex * options.audioRate * options.fpsDen / options.fpsNum) : 0;
    rows.push({ frameIndex, videoOffset: entry.offset, audioSample });
  };
  add(0);
  for (let i = 0; i < frameCount; i += interval) add(i);
  rows.sort((a, b) => a.frameIndex - b.frameIndex);
  const out = new Uint8Array(rows.length * 16);
  const view = new DataView(out.buffer);
  for (let i = 0; i < rows.length; i++) {
    view.setUint32(i * 16, rows[i].frameIndex >>> 0, true);
    view.setUint32(i * 16 + 4, rows[i].videoOffset >>> 0, true);
    view.setUint32(i * 16 + 8, rows[i].audioSample >>> 0, true);
    view.setUint32(i * 16 + 12, 0, true);
  }
  return { payload: out, interval };
}

function countKeyframes(frameCount, interval) {
  let count = 0;
  const seen = new Set();
  const add = (frameIndex) => {
    if (frameIndex < 0 || frameIndex >= frameCount || seen.has(frameIndex)) return;
    seen.add(frameIndex);
    count++;
  };
  add(0);
  for (let i = 0; i < frameCount; i += interval) add(i);
  return count;
}

function buildKeyframePayloadFromRows(rows, expectedCount) {
  const out = new Uint8Array(expectedCount * 16);
  const view = new DataView(out.buffer);
  rows.sort((a, b) => a.frameIndex - b.frameIndex);
  for (let i = 0; i < rows.length && i < expectedCount; i++) {
    view.setUint32(i * 16, rows[i].frameIndex >>> 0, true);
    view.setUint32(i * 16 + 4, rows[i].videoOffset >>> 0, true);
    view.setUint32(i * 16 + 8, rows[i].audioSample >>> 0, true);
    view.setUint32(i * 16 + 12, 0, true);
  }
  return out;
}

function encodedGopVideoBytes(gop) {
  let videoBytes = 0;
  for (const frame of gop.frames) videoBytes += 8 + frame.payload.byteLength;
  return videoBytes;
}

function buildHeaderAndTable(sections) {
  const headerSize = 32;
  const tableOffset = 512;
  const entrySize = 40;
  const out = new Uint8Array(alignUp(tableOffset + sections.length * entrySize));
  const view = new DataView(out.buffer);
  writeAsciiAt(out, 0, 'AUV2');
  view.setUint16(4, headerSize, true);
  view.setUint16(6, 2, true);
  view.setUint16(8, 2, true);
  view.setUint32(16, tableOffset, true);
  view.setUint16(24, entrySize, true);
  view.setUint16(26, sections.length, true);
  for (let i = 0; i < sections.length; i++) {
    setSectionEntry(out, tableOffset + i * entrySize, sections[i]);
  }
  return out;
}

export function makePreviewRgb555(rgb, width, height) {
  const out = new Uint8Array(width * height * 2);
  const view = new DataView(out.buffer);
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    const r = Math.floor((rgb[p] * 31 + 127) / 255);
    const g = Math.floor((rgb[p + 1] * 31 + 127) / 255);
    const b = Math.floor((rgb[p + 2] * 31 + 127) / 255);
    view.setUint16(i * 2, r | (g << 5) | (b << 10), true);
  }
  return out;
}

export function estimatePackedAuvBytes({ frameCount, audioByteLength, preview, videoByteLength, options }) {
  options = defaultEncodeOptions(options);
  validateFps(options.fpsNum, options.fpsDen);
  const videoCodec = 1;
  const audioCodec = audioByteLength ? 1 : 0;
  const audioSamples = audioByteLength ? Math.floor(audioByteLength / options.audioChannels) : 0;
  const meta = buildMeta(options, frameCount, audioSamples, videoCodec, audioCodec);
  const keyframeInterval = Math.max(1, Math.round((options.keyframeIntervalSeconds || 20) * options.fpsNum / options.fpsDen));
  const keyframeBytes = countKeyframes(frameCount, keyframeInterval) * 16;
  const sections = [
    { byteLength: meta.byteLength },
  ];
  if (preview && preview.byteLength) sections.push({ byteLength: preview.byteLength });
  sections.push(
    { byteLength: keyframeBytes },
    { byteLength: videoByteLength || 0 },
    { byteLength: audioByteLength || 0 },
  );
  let cursor = alignUp(512 + sections.length * 40);
  for (const section of sections) {
    cursor = alignUp(cursor + section.byteLength);
  }
  return cursor;
}

export function packAuv({ encodedFrames, audio, preview, options }) {
  options = defaultEncodeOptions(options);
  validateFps(options.fpsNum, options.fpsDen);
  const { video, entries } = buildFramedVideo(encodedFrames);
  const frameCount = encodedFrames.length;
  const keyframes = buildKeyframes(entries, frameCount, options);
  const videoCodec = 1;
  const audioCodec = audio && audio.byteLength ? 1 : 0;
  const meta = buildMeta(options, frameCount, audio?.byteLength ? Math.floor(audio.byteLength / options.audioChannels) : 0, videoCodec, audioCodec);
  const sections = [
    { type: 'META', payload: meta, format: 0, codec: 0, aux0: 0, aux1: 0 },
  ];
  if (preview && preview.byteLength) {
    sections.push({
      type: 'PREV',
      payload: preview,
      format: 1,
      codec: 0,
      aux0: 80 | (60 << 16),
      aux1: 80 * 2,
    });
  }
  sections.push(
    { type: 'KIDX', payload: keyframes.payload, format: 16, codec: 0, aux0: frameCount, aux1: keyframes.interval },
    { type: 'VDAT', payload: video, format: 1, codec: videoCodec, aux0: options.fpsNum, aux1: options.fpsDen },
    { type: 'AUDI', payload: audio || new Uint8Array(), format: audioCodec ? options.audioRate : 0, codec: audioCodec, aux0: audioCodec ? options.audioChannels : 0, aux1: audioCodec ? Math.floor(audio.byteLength / options.audioChannels) : 0 },
  );

  let cursor = alignUp(512 + sections.length * 40);
  for (const section of sections) {
    section.offset = cursor;
    cursor = alignUp(cursor + section.payload.byteLength);
  }
  const total = cursor;
  if (total > MAX_PLAYABLE_AUV_BYTES) {
    throw new Error(`AUV exceeds current GBA player limit (${total} > ${MAX_PLAYABLE_AUV_BYTES} bytes). Use direct file output so the encoder can stop at a playable boundary.`);
  }
  const out = new Uint8Array(total);
  out.set(buildHeaderAndTable(sections), 0);
  for (const section of sections) {
    out.set(section.payload, section.offset);
  }
  return out;
}

export class AuvFileWriter {
  constructor(writable, { frameCount, audioByteLength, preview, options }) {
    this.writable = writable;
    this.options = defaultEncodeOptions(options);
    validateFps(this.options.fpsNum, this.options.fpsDen);
    this.frameCount = frameCount;
    this.audioByteLength = audioByteLength || 0;
    this.videoCursor = 0;
    this.completedFrames = 0;
    this.videoSize = 0;
    this.keyframeRows = [];
    this.keyframeSeen = new Set();
    this.closed = false;

    const videoCodec = 1;
    const audioCodec = this.audioByteLength ? 1 : 0;
    this.keyframeInterval = Math.max(1, Math.round((this.options.keyframeIntervalSeconds || 20) * this.options.fpsNum / this.options.fpsDen));
    this.keyframeCount = countKeyframes(frameCount, this.keyframeInterval);
    const audioSamples = this.audioByteLength ? Math.floor(this.audioByteLength / this.options.audioChannels) : 0;
    this.meta = buildMeta(this.options, frameCount, audioSamples, videoCodec, audioCodec);
    this.preview = preview && preview.byteLength ? preview : null;

    this.sections = [
      { type: 'META', byteLength: this.meta.byteLength, format: 0, codec: 0, aux0: 0, aux1: 0 },
    ];
    if (this.preview) {
      this.sections.push({
        type: 'PREV',
        byteLength: this.preview.byteLength,
        format: 1,
        codec: 0,
        aux0: 80 | (60 << 16),
        aux1: 80 * 2,
      });
    }
    this.sections.push(
      { type: 'KIDX', byteLength: this.keyframeCount * 16, format: 16, codec: 0, aux0: frameCount, aux1: this.keyframeInterval },
      { type: 'AUDI', byteLength: this.audioByteLength, format: audioCodec ? this.options.audioRate : 0, codec: audioCodec, aux0: audioCodec ? this.options.audioChannels : 0, aux1: audioSamples },
      { type: 'VDAT', byteLength: 0, format: 1, codec: videoCodec, aux0: this.options.fpsNum, aux1: this.options.fpsDen },
    );

    let cursor = alignUp(512 + this.sections.length * 40);
    for (const section of this.sections) {
      section.offset = cursor;
      cursor = alignUp(cursor + section.byteLength);
    }
    this.videoSection = this.sections.find((section) => section.type === 'VDAT');
    this.audioSection = this.sections.find((section) => section.type === 'AUDI');
    this.keyframeSection = this.sections.find((section) => section.type === 'KIDX');
    this.videoCursor = this.videoSection.offset;
    if (this.videoCursor > MAX_PLAYABLE_AUV_BYTES) {
      throw new Error(`AUV audio/header area already exceeds current GBA player limit (${this.videoCursor} > ${MAX_PLAYABLE_AUV_BYTES} bytes)`);
    }
  }

  async init() {
    await this.writeAt(0, new Uint8Array(alignUp(512 + this.sections.length * 40)));
    await this.writeAt(this.sections[0].offset, this.meta);
    if (this.preview) {
      const section = this.sections.find((entry) => entry.type === 'PREV');
      await this.writeAt(section.offset, this.preview);
    }
    // Make the planned audio/keyframe area real before appending video. Some
    // browser file backends reject sparse writes far past the current EOF.
    await this.truncateTo(this.videoSection.offset, 'preextend to video section');
  }

  async writeAt(position, data) {
    try {
      for (let offset = 0; offset < data.byteLength; offset += FILE_WRITE_CHUNK_BYTES) {
        const chunk = data.subarray(offset, Math.min(data.byteLength, offset + FILE_WRITE_CHUNK_BYTES));
        await this.writable.write({ type: 'write', position: position + offset, data: chunk });
      }
    } catch (error) {
      const name = error?.name ? `${error.name}: ` : '';
      throw new Error(`AUV file write failed at ${position} len ${data.byteLength}: ${name}${error?.message || error}`);
    }
  }

  async truncateTo(size, context) {
    try {
      await this.writable.truncate(size);
    } catch (error) {
      const name = error?.name ? `${error.name}: ` : '';
      throw new Error(`AUV file truncate failed during ${context} size ${size}: ${name}${error?.message || error}`);
    }
  }

  maybeAddKeyframe(frameIndex, videoOffset) {
    if (frameIndex !== 0 && frameIndex % this.keyframeInterval !== 0) return;
    if (this.keyframeSeen.has(frameIndex)) return;
    const audioSample = this.options.audioRate && this.options.audioChannels
      ? Math.round(frameIndex * this.options.audioRate * this.options.fpsDen / this.options.fpsNum)
      : 0;
    this.keyframeSeen.add(frameIndex);
    this.keyframeRows.push({ frameIndex, videoOffset, audioSample });
  }

  estimateAppendGop(gop) {
    const videoBytes = encodedGopVideoBytes(gop);
    const estimatedFileBytes = alignUp(this.videoCursor + videoBytes);
    return {
      videoBytes,
      estimatedFileBytes,
      wouldExceedPlayableLimit: estimatedFileBytes > MAX_PLAYABLE_AUV_BYTES,
    };
  }

  async appendGop(gop) {
    const estimate = this.estimateAppendGop(gop);
    if (estimate.wouldExceedPlayableLimit) {
      return {
        audioBytes: gop.audio?.payload?.byteLength || 0,
        videoBytes: 0,
        videoOffset: this.videoCursor - this.videoSection.offset,
        fileOffset: this.videoCursor,
        frames: 0,
        totalVideoBytes: this.videoCursor - this.videoSection.offset,
        estimatedFileBytes: alignUp(this.videoCursor),
        truncated: true,
      };
    }
    const stats = {
      audioBytes: gop.audio?.payload?.byteLength || 0,
      videoBytes: 0,
      videoOffset: this.videoCursor - this.videoSection.offset,
      fileOffset: this.videoCursor,
      frames: gop.frames.length,
    };
    if (gop.audio && gop.audio.payload.byteLength) {
      await this.writeAt(this.audioSection.offset + gop.audio.startSample * this.options.audioChannels, gop.audio.payload);
    }

    let videoBytes = estimate.videoBytes;
    const gopVideo = new Uint8Array(videoBytes);
    const view = new DataView(gopVideo.buffer);
    let cursor = 0;
    const baseVideoOffset = this.videoCursor - this.videoSection.offset;
    for (let i = 0; i < gop.frames.length; i++) {
      const frame = gop.frames[i];
      const frameIndex = gop.startFrame + i;
      const recordOffset = baseVideoOffset + cursor;
      gopVideo[cursor] = frame.type & 0xff;
      view.setUint32(cursor + 4, frame.payload.byteLength >>> 0, true);
      cursor += 8;
      gopVideo.set(frame.payload, cursor);
      cursor += frame.payload.byteLength;
      this.completedFrames++;
      this.maybeAddKeyframe(frameIndex, recordOffset);
    }
    await this.writeAt(this.videoCursor, gopVideo);
    this.videoCursor += gopVideo.byteLength;
    stats.videoBytes = gopVideo.byteLength;
    stats.totalVideoBytes = this.videoCursor - this.videoSection.offset;
    stats.estimatedFileBytes = alignUp(this.videoCursor);
    return stats;
  }

  async finalize() {
    this.frameCount = this.completedFrames;
    const audioSamples = this.completedFrames > 0 && this.options.audioRate && this.options.audioChannels
      ? Math.round(this.completedFrames * this.options.audioRate * this.options.fpsDen / this.options.fpsNum)
      : 0;
    const audioBytes = Math.min(this.audioByteLength, audioSamples * this.options.audioChannels);
    this.meta = buildMeta(this.options, this.completedFrames, audioSamples, 1, audioBytes ? 1 : 0);
    this.sections[0].byteLength = this.meta.byteLength;
    this.audioSection.byteLength = audioBytes;
    this.audioSection.aux1 = audioSamples;
    this.audioSection.codec = audioBytes ? 1 : 0;
    this.audioSection.format = audioBytes ? this.options.audioRate : 0;
    this.audioSection.aux0 = audioBytes ? this.options.audioChannels : 0;
    this.keyframeCount = countKeyframes(this.completedFrames, this.keyframeInterval);
    this.keyframeSection.byteLength = this.keyframeCount * 16;
    this.keyframeSection.aux0 = this.completedFrames;
    this.videoSize = this.videoCursor - this.videoSection.offset;
    this.videoSection.byteLength = this.videoSize;
    const keyframes = buildKeyframePayloadFromRows(this.keyframeRows, this.keyframeCount);
    await this.writeAt(this.keyframeSection.offset, keyframes);
    await this.writeAt(this.sections[0].offset, this.meta);
    await this.writeAt(0, buildHeaderAndTable(this.sections));
    const total = alignUp(this.videoSection.offset + this.videoSize);
    if (total > MAX_PLAYABLE_AUV_BYTES) {
      throw new Error(`AUV finalize would exceed current GBA player limit (${total} > ${MAX_PLAYABLE_AUV_BYTES} bytes)`);
    }
    await this.truncateTo(total, 'finalize');
    try {
      await this.writable.close();
    } catch (error) {
      const name = error?.name ? `${error.name}: ` : '';
      throw new Error(`AUV file close failed: ${name}${error?.message || error}`);
    }
    this.closed = true;
    return { byteLength: total, frameCount: this.completedFrames };
  }

  async abort() {
    if (this.closed) return;
    try {
      await this.writable.close();
    } catch {
      // Preserve the original encode/write error. Some browsers throw here if
      // the file stream is already in ERRORED state.
    } finally {
      this.closed = true;
    }
  }
}
