import { basename } from 'node:path'
import { CHUNK_HEADER_BYTES, MAX_READ_BYTES, TransferWindow, encodeChunk, ProtocolError, validateId, type DownloadMetadata, type Fence, type HostMessage, type Limits } from '../../../protocol/src/index.ts'
import type { LocalFileHandle } from './local-reader.ts'

type End = Extract<HostMessage, { type: 'download.end' }>
interface Download {
  id: string; fence: Fence; file: LocalFileHandle; offset: number; bytes: number; sent: number; chunks: number
  window: TransferWindow; credit: number; signal: AbortSignal; check(): void; abort(): void; release(): void
  timer?: ReturnType<typeof setTimeout>; task?: Promise<void>; stopped?: ProtocolError; terminal: boolean; announced: boolean
}
/** Owns only remote read handles. A transfer waiting for credit retains metadata,
 * never a file body and never a place in the control socket's send queue. */
export class FileDownloads {
  private records = new Map<string, Download>()
  private tasks = new Set<Promise<void>>()
  private disposed = false
  constructor(private readonly options: {
    limits: Limits; reserve(bytes: number): () => void
    sendBinary(bytes: Uint8Array, check: () => void): Promise<void>
    sendEnd(message: End, check: () => void): Promise<void>
  }) {}
  async open(id: string, fence: Fence, file: LocalFileHandle, range: { offset: number; length: number }, signal: AbortSignal, check: () => void, announced = true): Promise<DownloadMetadata> {
    let record: Download | undefined
    try {
      validateId(id); check(); signal.throwIfAborted()
      if (this.disposed) throw new ProtocolError('TRANSFER_CLOSED')
      if (this.records.has(id)) throw new ProtocolError('INVALID_MESSAGE')
      if (this.records.size >= this.options.limits.uploads) throw new ProtocolError('BACKPRESSURE')
      if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 0 || range.length > MAX_READ_BYTES || range.offset > Number.MAX_SAFE_INTEGER - range.length || file.bytes > this.options.limits.fileBytes) throw new ProtocolError('LIMIT_EXCEEDED')
      const bytes = Math.max(0, Math.min(range.length, file.bytes - range.offset))
      const release = this.options.reserve(512)
      record = { id, fence: Object.freeze({ ...fence }), file, offset: range.offset, bytes, sent: 0, chunks: 0, window: new TransferWindow(bytes, this.options.limits), credit: 0, signal, check, abort: () => this.cancel(id), release, terminal: false, announced }
      this.records.set(id, record)
      await file.assertCurrent(signal); check(); signal.throwIfAborted()
      if (this.disposed || record.terminal || record.stopped) throw new ProtocolError('TRANSFER_CLOSED')
      signal.addEventListener('abort', record.abort, { once: true }); if (record.announced) this.progress(record)
      return { transferId: id, name: basename(file.absolutePath), mediaType: 'application/octet-stream', bytes, offset: range.offset, eof: range.offset + bytes >= file.bytes }
    } catch (error) {
      if (record) { this.records.delete(id); record.release(); record.window.dispose(); signal.removeEventListener('abort', record.abort); clearTimeout(record.timer) }
      await file.close(); throw error
    }
  }
  announce(id: string): void {
    const record = this.records.get(id)
    if (!record || record.terminal) return
    record.announced = true; this.progress(record); this.run(record)
  }
  async discard(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    record.announced = false
    this.stop(record, new ProtocolError('TRANSFER_CLOSED'))
    await record.task
  }
  credit(id: string, chunks: number): void {
    const record = this.records.get(id)
    if (!record || record.terminal || record.stopped) return
    try { record.window.grant(chunks); record.credit += chunks; if (record.announced) { this.progress(record); this.run(record) } }
    catch (error) { this.stop(record, error instanceof ProtocolError ? error : new ProtocolError('INVALID_MESSAGE')) }
  }
  cancel(id: string): void { const record = this.records.get(id); if (record) this.stop(record, new ProtocolError('TRANSFER_CLOSED')) }
  private stop(record: Download, error: ProtocolError): void {
    if (record.terminal) return
    record.stopped ??= error
    this.run(record)
  }
  private progress(record: Download): void {
    clearTimeout(record.timer)
    record.timer = setTimeout(() => this.stop(record, new ProtocolError('TRANSFER_TIMEOUT')), this.options.limits.transferIdleMs)
  }
  private current(record: Download): void {
    record.check(); record.signal.throwIfAborted()
    if (record.stopped || record.terminal) throw record.stopped ?? new ProtocolError('TRANSFER_CLOSED')
  }
  private run(record: Download): void {
    if (record.task || record.terminal || (!record.announced && !record.stopped)) return
    const task = (async () => {
      try {
        while (record.credit > 0 || record.stopped) {
          this.current(record)
          if (record.sent === record.bytes) { await record.file.assertCurrent(record.signal); this.current(record); record.window.finish(); await this.end(record); return }
          const length = Math.min(this.options.limits.chunkBytes, record.bytes - record.sent)
          const release = this.options.reserve(2 * length + CHUNK_HEADER_BYTES)
          try {
            const bytes = await record.file.readRange(record.offset + record.sent, length, record.signal)
            this.current(record)
            if (bytes.length !== length) throw new ProtocolError('TRANSFER_CLOSED')
            const index = record.window.consume(bytes.length); record.credit--
            await record.file.assertCurrent(record.signal); this.current(record)
            await this.options.sendBinary(encodeChunk(record.id, record.fence.controlId, index, bytes), () => this.current(record))
            record.sent += bytes.length; record.chunks++; this.progress(record)
          } finally { release() }
          if (record.sent === record.bytes) { await record.file.assertCurrent(record.signal); this.current(record); record.window.finish(); await this.end(record); return }
        }
      } catch (error) { await this.end(record, error instanceof ProtocolError ? error : new ProtocolError('TRANSFER_CLOSED')) }
    })()
    record.task = task; this.tasks.add(task)
    void task.finally(() => { this.tasks.delete(task); record.task = undefined; if (!record.terminal && (record.stopped || record.credit)) this.run(record) }).catch(() => {})
  }
  private async end(record: Download, error?: ProtocolError): Promise<void> {
    if (record.terminal) return
    record.terminal = true; clearTimeout(record.timer); record.signal.removeEventListener('abort', record.abort); record.window.dispose()
    try {
      await record.file.close()
      if (record.announced) await this.options.sendEnd({ v: 1, type: 'download.end', id: record.id, fence: record.fence, chunks: record.chunks, ...(error ? { error: { code: error.code, message: error.code, retryable: false } } : {}) }, record.check)
    } finally { record.release(); this.records.delete(record.id) }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const record of this.records.values()) this.stop(record, new ProtocolError('TRANSFER_CLOSED'))
    await Promise.allSettled([...this.tasks])
  }
}
