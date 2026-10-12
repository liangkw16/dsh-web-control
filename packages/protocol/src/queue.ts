import { integer } from './limits.js';
import { ProtocolError } from './types.js';
export class BoundedQueue {
  private control: Uint8Array[] = [];
  private data: Uint8Array[] = [];
  private total = 0;
  private dataBytes = 0;
  constructor(private readonly limit: number, private readonly controlReserve: number) { integer(limit); integer(controlReserve, 0, limit); }
  get bytes(): number { return this.total; }
  /** bufferedBytes is the current WebSocket bufferedAmount; caller samples it before enqueue/send. */
  enqueue(priority: 'control' | 'data', data: Uint8Array, bufferedBytes = 0): void {
    integer(bufferedBytes);
    if (priority !== 'control' && priority !== 'data' || !(data instanceof Uint8Array) || data.byteLength === 0) throw new ProtocolError('INVALID_MESSAGE');
    if (data.byteLength > this.limit - bufferedBytes - this.total || priority === 'data' && data.byteLength > this.limit - this.controlReserve - this.dataBytes) throw new ProtocolError('BACKPRESSURE');
    const copy = new Uint8Array(data.byteLength); copy.set(data);
    (priority === 'control' ? this.control : this.data).push(copy); this.total += copy.byteLength;
    if (priority === 'data') this.dataBytes += copy.byteLength;
  }
  take(): Uint8Array | undefined {
    const control = this.control.shift(); const data = control ?? this.data.shift();
    if (data) { this.total -= data.byteLength; if (!control) this.dataBytes -= data.byteLength; }
    return data;
  }
  clear(): void { this.control = []; this.data = []; this.total = 0; this.dataBytes = 0; }
}
