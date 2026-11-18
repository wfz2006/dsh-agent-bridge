import { open, realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

// A single JSON value must be parsed in memory. Stream between records and
// report a gap for an exceptionally large value instead of dropping it silently.
export const sourceValueLimit = 32 * 1024 * 1024;
const chunkSize = 64 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function sourceChanged() {
  return Object.assign(new Error('Source changed while being read'), { sourceReason: 'source-changed' });
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

export async function* sourceChunks(file, signal) {
  signal?.throwIfAborted();
  const expected = await stat(file, { bigint: true });
  const handle = await open(file, 'r');
  try {
    const start = await handle.stat({ bigint: true });
    if (!start.isFile() || !sameFile(start, expected) || await realpath(file) !== file) throw sourceChanged();
    const end = Number(start.size);
    if (!Number.isSafeInteger(end)) throw Object.assign(new Error('Source is too large'), { sourceReason: 'source-too-large' });
    let position = 0;
    while (position < end) {
      signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(chunkSize, end - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) throw sourceChanged();
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    const current = await handle.stat({ bigint: true });
    const currentPath = await stat(file, { bigint: true }).catch(() => undefined);
    if (!currentPath || !sameFile(start, currentPath) || await realpath(file) !== file
      || current.size < start.size || (current.size === start.size && current.mtimeNs !== start.mtimeNs)) {
      throw sourceChanged();
    }
  } finally {
    await handle.close();
  }
}

function corruptCompressed(cause) {
  return Object.assign(new Error('Compressed history cannot be decoded', { cause }),
    { sourceReason: 'corrupt-compressed-source' });
}

// Node's Zstandard stream can return successfully at the end of a truncated
// frame. Check the framing as the bytes pass through the native decoder.
// The decoder still validates compressed blocks and content checksums.
class ZstdFrames {
  header = Buffer.alloc(4);
  state = 'magic';
  fill = 0;
  headerSize = 4;
  skip = 0;
  checksum = false;
  frames = 0;

  next(state, headerSize, skip = 0) {
    this.state = state;
    this.headerSize = headerSize;
    this.skip = skip;
    this.fill = 0;
  }

  headerReady() {
    if (this.state === 'magic') {
      const magic = this.header.readUInt32LE();
      if (magic === 0xfd2fb528) this.next('frame', 1);
      else if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) this.next('skippable', 4);
      else throw corruptCompressed();
    } else if (this.state === 'skippable') {
      this.next('magic', 4, this.header.readUInt32LE());
    } else if (this.state === 'frame') {
      const descriptor = this.header[0];
      if (descriptor & 8) throw corruptCompressed();
      const singleSegment = Boolean(descriptor & 32);
      const sizeFlag = descriptor >>> 6;
      const frameSizeBytes = sizeFlag ? (2 ** sizeFlag) : Number(singleSegment);
      const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
      this.checksum = Boolean(descriptor & 4);
      this.next('block', 3, Number(!singleSegment) + frameSizeBytes + dictionaryBytes);
    } else {
      const bits = this.header.readUIntLE(0, 3);
      const type = (bits >>> 1) & 3;
      if (type === 3) throw corruptCompressed();
      const payload = type === 1 ? 1 : bits >>> 3;
      if (bits & 1) {
        this.frames++;
        this.next('magic', 4, payload + (this.checksum ? 4 : 0));
      } else this.next('block', 3, payload);
    }
  }

  update(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.skip) {
        const advance = Math.min(this.skip, chunk.length - offset);
        this.skip -= advance;
        offset += advance;
        continue;
      }
      const size = Math.min(this.headerSize - this.fill, chunk.length - offset);
      chunk.copy(this.header, this.fill, offset, offset + size);
      this.fill += size;
      offset += size;
      if (this.fill === this.headerSize) this.headerReady();
    }
  }

  finish() {
    if (this.state !== 'magic' || this.fill || this.skip || !this.frames) throw corruptCompressed();
  }
}

async function* checkedCompressedSource(file, signal) {
  const structure = new ZstdFrames();
  for await (const chunk of sourceChunks(file, signal)) {
    structure.update(chunk);
    yield chunk;
  }
  structure.finish();
}

async function* decompressedSource(file, signal) {
  const input = Readable.from(checkedCompressedSource(file, signal), { objectMode: false });
  const decoder = zlib.createZstdDecompress();
  const done = pipeline(input, decoder).catch(error => error);
  try {
    yield* decoder;
    const error = await done;
    if (error) throw error;
  } catch (error) {
    if (signal?.aborted || error.sourceReason) throw error;
    throw corruptCompressed(error);
  } finally {
    input.destroy();
    decoder.destroy();
  }
}

function parseRecord(parts, bytes) {
  if (bytes > sourceValueLimit) return { gap: 'record-too-large' };
  if (bytes === 0) return {};
  try {
    const text = utf8.decode(Buffer.concat(parts, bytes));
    if (!text.trim()) return {};
    const row = JSON.parse(text);
    return row && typeof row === 'object' && !Array.isArray(row) ? { row, bytes } : { gap: 'malformed-record' };
  } catch {
    return { gap: 'malformed-record' };
  }
}

export async function* sourceJsonl(file, { compressed, signal }) {
  let parts = [];
  let bytes = 0;
  const chunks = compressed ? decompressedSource(file, signal) : sourceChunks(file, signal);
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      bytes += end - offset;
      if (bytes <= sourceValueLimit) parts.push(chunk.subarray(offset, end));
      else parts = [];
      if (newline === -1) break;
      const record = parseRecord(parts, bytes);
      if (record.row || record.gap) yield record;
      bytes = 0;
      parts = [];
      offset = newline + 1;
    }
  }
  const record = parseRecord(parts, bytes);
  if (record.row || record.gap) yield record;
}

export async function sourceJson(file, signal) {
  const parts = [];
  let bytes = 0;
  for await (const chunk of sourceChunks(file, signal)) {
    bytes += chunk.length;
    if (bytes > sourceValueLimit) return { gap: 'record-too-large' };
    parts.push(chunk);
  }
  return parseRecord(parts, bytes);
}
