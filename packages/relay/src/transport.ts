import WebSocket from 'ws'
import {
  BoundedQueue,
  ProtocolError,
  checkJsonLength,
  decodeChunk,
  type ControllerMessage,
  type HostMessage,
  type HandshakeMessage,
  type Limits,
} from '@dsh-web-control/protocol'
/** A single queue/budget shared by both directions for one authenticated instance. */
export class TransportGroup {
  private readonly queue: BoundedQueue
  private readonly sockets = new Map<number, WebSocket>()
  private nextId = 0
  private nextFrame = 0
  private readonly guards = new Map<
    number,
    { guard?: () => void; settled?: () => void }
  >()
  private scheduled?: NodeJS.Immediate
  private timer?: NodeJS.Timeout
  private sending = false
  private inFlightBytes = 0
  private peak = 0
  private disposed = false
  private retired?: () => void
  constructor(
    readonly limits: Limits,
    private readonly failed: (code: string) => void,
  ) {
    this.queue = new BoundedQueue(
      limits.bufferedBytes,
      Math.min(Math.floor(limits.bufferedBytes / 4), limits.jsonBytes),
    )
  }
  add(ws: WebSocket): Transport {
    const id = ++this.nextId
    this.sockets.set(id, ws)
    ws.once('close', () => this.remove(id))
    return new Transport(this, ws, id)
  }
  remove(id: number): void {
    this.sockets.delete(id)
    this.finishRetirement()
  }
  retire(closed: () => void): void {
    this.retired = closed
    this.finishRetirement()
  }
  private finishRetirement(): void {
    if (this.retired && this.sockets.size === 0) {
      const closed = this.retired
      this.retired = undefined
      this.dispose()
      closed()
    }
  }
  get bufferedBytes(): number {
    return this.inFlightBytes + [...this.sockets.values()].reduce((n, s) => n + s.bufferedAmount, 0)
  }
  get retainedBytes(): number { return this.bufferedBytes + this.queue.bytes }
  get peakRetainedBytes(): number { return this.peak }
  private sample(): void { this.peak = Math.max(this.peak, this.retainedBytes) }
  enqueue(
    id: number,
    data: Uint8Array,
    binary: boolean,
    guard?: () => void,
    ordered = false,
    settled?: () => void,
  ): void {
    if (this.disposed) throw new ProtocolError('RESYNC_REQUIRED')
    // Charge destination/guard metadata and at least the maximum WS header size.
    // Closing sockets remain in bufferedBytes until their actual close event.
    const frameId = ++this.nextFrame >>> 0
    const frame = new Uint8Array(data.length + 16)
    new DataView(frame.buffer).setUint32(0, id)
    new DataView(frame.buffer).setUint32(4, frameId)
    frame[8] = Number(binary)
    frame.set(data, 16)
    try {
      this.queue.enqueue(
        binary || ordered ? 'data' : 'control',
        frame,
        this.bufferedBytes,
      )
    } catch {
      this.failed('RESYNC_REQUIRED')
      throw new ProtocolError('RESYNC_REQUIRED')
    }
    this.sample()
    if (guard || settled) this.guards.set(frameId, { guard, settled })
    if (!this.timer)
      this.timer = setTimeout(
        () => this.failed('RESYNC_REQUIRED'),
        this.limits.transferIdleMs,
      )
    this.schedule()
  }
  private schedule(): void {
    if (!this.scheduled && !this.sending && !this.disposed)
      this.scheduled = setImmediate(() => {
        this.scheduled = undefined
        this.drain()
      })
  }
  private drain(): void {
    if (this.bufferedBytes + this.queue.bytes > this.limits.bufferedBytes) {
      this.failed('RESYNC_REQUIRED')
      return
    }
    const frame = this.queue.take()
    if (!frame) {
      clearTimeout(this.timer)
      this.timer = undefined
      return
    }
    const id = new DataView(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength,
      ).getUint32(0),
      ws = this.sockets.get(id)
    const frameId = new DataView(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength,
      ).getUint32(4),
      entry = this.guards.get(frameId)
    this.guards.delete(frameId)
    try {
      entry?.guard?.()
    } catch {
      entry?.settled?.()
      this.schedule()
      return
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      entry?.settled?.()
      this.schedule()
      return
    }
    // The frame remains referenced through completion, overlapping the physical
    // socket copy. Admission must cover both copies before submitting the send.
    if (this.queue.bytes + this.bufferedBytes + frame.byteLength + frame.byteLength - 16 + 14 > this.limits.bufferedBytes) {
      entry?.settled?.()
      this.failed('RESYNC_REQUIRED')
      return
    }
    this.inFlightBytes = frame.byteLength
    this.sending = true
    this.sample()
    ws.send(frame.subarray(16), { binary: !!frame[8] }, (error) => {
      this.sending = false
      this.inFlightBytes = 0
      entry?.settled?.()
      if (error) {
        this.failed('RESYNC_REQUIRED')
        return
      }
      clearTimeout(this.timer)
      this.timer = undefined
      if (this.queue.bytes)
        this.timer = setTimeout(
          () => this.failed('RESYNC_REQUIRED'),
          this.limits.transferIdleMs,
        )
      this.schedule()
    })
    this.sample()
  }
  dispose(): void {
    this.disposed = true
    this.queue.clear()
    for (const entry of this.guards.values()) entry.settled?.()
    this.guards.clear()
    clearImmediate(this.scheduled)
    clearTimeout(this.timer)
    this.sockets.clear()
  }
}
export class Transport {
  constructor(
    private readonly group: TransportGroup,
    readonly ws: WebSocket,
    private readonly id: number,
  ) {}
  send(
    message: HostMessage | ControllerMessage | HandshakeMessage,
    guard?: () => void,
    settled?: () => void,
  ): void {
    const text = JSON.stringify(message)
    checkJsonLength(text, this.group.limits.jsonBytes)
    this.group.enqueue(
      this.id,
      Buffer.from(text),
      false,
      guard,
      message.type === 'upload.end' || message.type === 'download.end',
      settled,
    )
  }
  sendChunk(chunk: Uint8Array, guard?: () => void): void {
    decodeChunk(chunk, this.group.limits)
    this.group.enqueue(this.id, chunk, true, guard)
  }
  close(code: number, reason = ''): void {
    if (this.ws.readyState === WebSocket.CLOSED) return
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(code, reason)
    const timer = setTimeout(() => this.ws.terminate(), 1000)
    timer.unref()
    this.ws.once('close', () => clearTimeout(timer))
  }
}
