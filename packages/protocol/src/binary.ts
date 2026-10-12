import { DEFAULT_LIMITS, integer, MAX_IN_FLIGHT_CHUNKS, validateLimits } from './limits.js';
import { validateId } from './schema.js';
import { ProtocolError, type Fault, type Limits } from './types.js';
/** WCB1 magic, two UUIDs (16 bytes each), uint32 index, uint32 payload length; network byte order. */
export const CHUNK_HEADER_BYTES = 44;
const MAGIC = 0x57434231;
function writeId(target: Uint8Array, offset: number, id: string): void {
  const hex = id.replaceAll('-', '');
  for (let i = 0; i < 16; i++) target[offset + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
}
function readId(source: Uint8Array, offset: number): string {
  let hex = ''; for (let i = 0; i < 16; i++) hex += source[offset + i].toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function encodeChunk(id: string, controlId: string, index: number, data: Uint8Array): Uint8Array {
  validateId(id); validateId(controlId); integer(index, 0, 0xffffffff);
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new ProtocolError('INVALID_MESSAGE');
  if (data.byteLength > DEFAULT_LIMITS.chunkBytes) throw new ProtocolError('LIMIT_EXCEEDED', `Chunk exceeds ${DEFAULT_LIMITS.chunkBytes} bytes`);
  const output = new Uint8Array(CHUNK_HEADER_BYTES + data.byteLength); const view = new DataView(output.buffer);
  view.setUint32(0, MAGIC); writeId(output, 4, id); writeId(output, 20, controlId); view.setUint32(36, index); view.setUint32(40, data.byteLength); output.set(data, CHUNK_HEADER_BYTES);
  return output;
}
export function decodeChunk(data: Uint8Array, limits: Limits): { id: string; controlId: string; index: number; data: Uint8Array } {
  validateLimits(limits);
  if (!(data instanceof Uint8Array) || data.byteLength < CHUNK_HEADER_BYTES) throw new ProtocolError('INVALID_MESSAGE');
  if (data.byteLength - CHUNK_HEADER_BYTES > limits.chunkBytes) throw new ProtocolError('LIMIT_EXCEEDED', `Chunk exceeds ${limits.chunkBytes} bytes`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0) !== MAGIC) throw new ProtocolError('PROTOCOL_UNSUPPORTED');
  const length = view.getUint32(40);
  if (length > limits.chunkBytes) throw new ProtocolError('LIMIT_EXCEEDED', `Chunk exceeds ${limits.chunkBytes} bytes`);
  if (length === 0 || length !== data.byteLength - CHUNK_HEADER_BYTES) throw new ProtocolError('INVALID_MESSAGE', 'Binary payload length mismatch');
  return { id: readId(data, 4), controlId: readId(data, 20), index: view.getUint32(36), data: data.subarray(CHUNK_HEADER_BYTES) };
}
/** Sender accounting, shared by uploads and downloads. Credit is replenished only after receiver consumption. */
export class TransferWindow {
  private credit = 0; private index = 0; private bytes = 0; private closed = false;
  constructor(private readonly declaredBytes: number, private readonly limits: Limits) { this.limits = Object.freeze(validateLimits(limits)); integer(declaredBytes, 0, limits.fileBytes); }
  grant(chunks: number): void {
    this.check();
    try {
      integer(chunks, 1, MAX_IN_FLIGHT_CHUNKS);
      if (chunks > MAX_IN_FLIGHT_CHUNKS - this.credit) throw new ProtocolError('BACKPRESSURE');
      this.credit += chunks;
    } catch (error) { this.dispose(); throw error; }
  }
  consume(bytes: number): number {
    this.check();
    try {
      integer(bytes, 1, this.limits.chunkBytes);
      if (this.credit === 0) throw new ProtocolError('BACKPRESSURE');
      if (bytes > this.declaredBytes - this.bytes || this.index > 0xffffffff) throw new ProtocolError('LIMIT_EXCEEDED');
      this.credit--; this.bytes += bytes; return this.index++;
    } catch (error) { this.dispose(); throw error; }
  }
  finish(): number {
    this.check(); if (this.bytes !== this.declaredBytes) { this.dispose(); throw new ProtocolError('INVALID_MESSAGE', 'Transfer byte count mismatch'); }
    this.dispose(); return this.index;
  }
  dispose(): void { this.closed = true; this.credit = 0; }
  private check(): void { if (this.closed) throw new ProtocolError('TRANSFER_CLOSED'); }
}
/** Bounded receiver with one waiting consumer. Abort/dispose settles reads and drops every owned buffer. */
export class TransferReceiver implements AsyncIterableIterator<Uint8Array> {
  private queue: Uint8Array[] = []; private queuedBytes = 0; private credit = 0; private index = 0; private bytes = 0;
  private ended = false; private closed = false; private error?: Error;
  private waiter?: { resolve: (result: IteratorResult<Uint8Array>) => void; reject: (error: Error) => void };
  private timer?: ReturnType<typeof setTimeout>;
  private readonly onAbort = () => this.dispose(new ProtocolError('TRANSFER_CLOSED'));
  constructor(private readonly id: string, private readonly controlId: string, private readonly declaredBytes: number, private readonly limits: Limits, private readonly signal?: AbortSignal) {
    validateId(id); validateId(controlId); this.limits = Object.freeze(validateLimits(limits)); integer(declaredBytes, 0, limits.fileBytes);
    if (signal?.aborted) this.onAbort(); else { signal?.addEventListener('abort', this.onAbort, { once: true }); this.progress(); }
  }
  get bufferedBytes(): number { return this.queuedBytes; }
  grant(chunks: number): void {
    this.check();
    try {
      integer(chunks, 1, MAX_IN_FLIGHT_CHUNKS);
      if (chunks > MAX_IN_FLIGHT_CHUNKS - this.credit - this.queue.length) throw new ProtocolError('BACKPRESSURE');
      this.credit += chunks;
    } catch (error) { this.dispose(error as Error); throw error; }
  }
  receive(frame: Uint8Array): void {
    this.check();
    try {
      const chunk = decodeChunk(frame, this.limits);
      if (chunk.id !== this.id || chunk.controlId !== this.controlId) throw new ProtocolError('STALE_CONTROL');
      if (chunk.index !== this.index) throw new ProtocolError('INVALID_MESSAGE', 'Non-contiguous chunk index');
      if (this.credit === 0) throw new ProtocolError('BACKPRESSURE');
      if (chunk.data.byteLength > this.declaredBytes - this.bytes || chunk.data.byteLength > this.limits.bufferedBytes - this.queuedBytes) throw new ProtocolError('LIMIT_EXCEEDED');
      // Copy only validated payload bytes, never retain an unbounded backing ArrayBuffer.
      const copy = new Uint8Array(chunk.data.byteLength); copy.set(chunk.data);
      this.credit--; this.index++; this.bytes += copy.byteLength; this.progress();
      if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve({ done: false, value: copy }); }
      else { this.queue.push(copy); this.queuedBytes += copy.byteLength; }
    } catch (error) { this.dispose(error as Error); throw error; }
  }
  end(chunks: number, error?: Fault): void {
    this.check();
    try {
      integer(chunks);
      if (error) throw new ProtocolError(error.code, error.message, error.retryable);
      if (chunks !== this.index || this.bytes !== this.declaredBytes) throw new ProtocolError('INVALID_MESSAGE', 'Transfer end count mismatch');
      this.ended = true; this.credit = 0;
      if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined;
      if (this.queue.length === 0) this.cleanup();
      if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve({ done: true, value: undefined }); }
    } catch (error) { this.dispose(error as Error); throw error; }
  }
  next(): Promise<IteratorResult<Uint8Array>> {
    if (this.error) return Promise.reject(this.error);
    const value = this.queue.shift();
    if (value) {
      this.queuedBytes -= value.byteLength;
      if (this.ended && this.queue.length === 0) this.cleanup();
      return Promise.resolve({ done: false, value });
    }
    if (this.closed || this.ended) return Promise.resolve({ done: true, value: undefined });
    if (this.waiter) return Promise.reject(new ProtocolError('INVALID_MESSAGE', 'Only one pending transfer read is allowed'));
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  return(): Promise<IteratorResult<Uint8Array>> { this.dispose(); return Promise.resolve({ done: true, value: undefined }); }
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> { return this; }
  dispose(error?: Error): void {
    if (this.closed) return;
    this.closed = true; this.error = error; this.queue = []; this.queuedBytes = 0; this.credit = 0; this.cleanup();
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; if (error) waiter.reject(error); else waiter.resolve({ done: true, value: undefined }); }
  }
  private check(): void { if (this.closed || this.ended) throw this.error ?? new ProtocolError('TRANSFER_CLOSED'); }
  private progress(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = setTimeout(() => this.dispose(new ProtocolError('TRANSFER_TIMEOUT')), this.limits.transferIdleMs); }
  private cleanup(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; this.signal?.removeEventListener('abort', this.onAbort); }
}
