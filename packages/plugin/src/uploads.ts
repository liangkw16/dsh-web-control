import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import { DEFAULT_LIMITS, encodeChunk, ProtocolError, TransferReceiver, validateId, validateLimits, type Fence, type Json, type Limits } from '../../protocol/src/index.ts'
import { publicJson } from './adapter/dsh-v021.ts'
import { opaqueId, type SessionScope } from './adapter/scope.ts'
import type { HostFence } from './control-fence.ts'

/** Same instance budget as transport queues/socket buffers; reserve must fail before allocation.
 * credit queues a control frame whose physical send rechecks the copied Fence.
 */
export interface UploadTransport {
  credit(id: string, fence: Fence, chunks: number): void
  reserve(bytes: number): () => void
  /** Autonomous failure only; end/cancel callers own their terminals. Queue failures are contained. */
  failed(id: string, fence: Fence, error: ProtocolError): void
}
interface Transfer {
  id: string; fence: Fence; sessionId: string; bytes: number; controller: AbortController
  receiver: TransferReceiver; limits: Limits; releases: Set<() => void>; queued: (() => void)[]
  pending: Promise<Json>; ended: boolean; endOwned: boolean; timer?: ReturnType<typeof setTimeout>; cleanup: () => void
}
/** Owns byte observers only. Staged receipt lifecycle remains entirely Host-owned. */
export class UploadManager {
  private readonly transfers = new Map<string, Transfer>()
  private limits: Limits
  private closed = false
  private nativePending = 0
  constructor(private readonly ctx: Context, private readonly hostFence: HostFence, private readonly scope: SessionScope,
    private readonly transport: UploadTransport, limits: Limits = DEFAULT_LIMITS) { this.limits = Object.freeze(validateLimits(limits)) }
  configureLimits(limits: Limits): void {
    if (this.closed || this.transfers.size) throw new ProtocolError('TRANSFER_CLOSED')
    this.limits = Object.freeze(validateLimits(limits))
  }
  open(id: string, fence: Fence, request: { sessionId: string; name: string; mediaType: string; bytes: number }): void {
    if (this.closed) throw new ProtocolError('TRANSFER_CLOSED')
    validateId(id); opaqueId(request.sessionId); opaqueId(request.name); opaqueId(request.mediaType)
    const bound = Object.freeze({ ...fence }); this.hostFence.check(bound); this.scope.assertSession(request.sessionId)
    if (this.transfers.has(id)) throw new ProtocolError('INVALID_MESSAGE')
    if (this.transfers.size >= this.limits.uploads || this.nativePending >= this.limits.uploads) throw new ProtocolError('BACKPRESSURE')
    const controller = new AbortController()
    const receiver = new TransferReceiver(id, bound.controlId, request.bytes, this.limits, controller.signal)
    const generation = this.hostFence.signal
    const onAbort = () => this.cancel(id)
    const transfer: Transfer = { id, fence: bound, sessionId: request.sessionId, bytes: request.bytes, controller, receiver, limits: this.limits,
      releases: new Set(), queued: [], ended: false, endOwned: false, pending: Promise.resolve(null), cleanup: () => generation.removeEventListener('abort', onAbort) }
    this.transfers.set(id, transfer); generation.addEventListener('abort', onAbort, { once: true })
    try {
      this.check(transfer)
      // Invoke synchronously after the admission check; no asynchronous authority gap.
      const native = this.ctx.fileUploads.uploadStream({ sessionId: SessionId(request.sessionId), data: this.data(transfer), name: request.name, signal: controller.signal })
      this.nativePending++
      transfer.pending = native.then(value => {
        this.check(transfer)
        if (!transfer.ended || value.file.bytes !== transfer.bytes) throw new ProtocolError('RESULT_UNCERTAIN')
        const agent = this.ctx.agents.get(SessionId(transfer.sessionId))
        const file = agent && this.ctx.fileUploads.resolve(agent, value.receiptId)
        this.check(transfer)
        if (!file || this.ctx.agents.get(SessionId(transfer.sessionId)) !== agent || file.attachmentId !== value.file.attachmentId) throw new ProtocolError('OUT_OF_SCOPE')
        return publicJson(value)
      }).catch(error => {
        const failure = error instanceof ProtocolError ? error : new ProtocolError('RESULT_UNCERTAIN')
        this.fail(transfer, failure); throw failure
      }).finally(() => { this.nativePending-- })
      void transfer.pending.catch(() => {})
      this.grant(transfer, 4); this.progress(transfer)
    } catch (error) { this.cancel(id); throw error }
  }
  async chunk(id: string, index: number, data: Uint8Array): Promise<void> {
    const transfer = this.get(id)
    try {
      this.check(transfer)
      if (!(data instanceof Uint8Array) || data.byteLength > transfer.limits.chunkBytes) throw new ProtocolError('LIMIT_EXCEEDED')
      const reserved = this.transport.reserve(data.byteLength + 44)
      let active = true
      const release = () => { if (active) { active = false; reserved(); transfer.releases.delete(release) } }
      transfer.releases.add(release); transfer.queued.push(release)
      this.check(transfer); transfer.receiver.receive(encodeChunk(id, transfer.fence.controlId, index, data)); this.progress(transfer)
    } catch (error) { this.cancel(id); throw error }
  }
  async end(id: string, chunks: number): Promise<Json> {
    const transfer = this.get(id)
    transfer.endOwned = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const aborted = Promise.withResolvers<never>()
    const onAbort = () => aborted.reject(new ProtocolError('TRANSFER_CLOSED'))
    transfer.controller.signal.addEventListener('abort', onAbort, { once: true })
    void aborted.promise.catch(() => {})
    try {
      this.check(transfer); transfer.receiver.end(chunks); transfer.ended = true
      if (transfer.timer !== undefined) clearTimeout(transfer.timer); transfer.timer = undefined
      const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new ProtocolError('RESULT_UNCERTAIN')); this.cancel(id) }, transfer.limits.callTimeoutMs) })
      const result = await Promise.race([transfer.pending, expired, aborted.promise])
      this.check(transfer); return result
    } finally { if (timer !== undefined) clearTimeout(timer); transfer.controller.signal.removeEventListener('abort', onAbort); this.cancel(id) }
  }
  cancel(id: string): void {
    const transfer = this.transfers.get(id)
    if (!transfer) return
    this.transfers.delete(id); if (transfer.timer !== undefined) clearTimeout(transfer.timer); transfer.controller.abort(); transfer.receiver.dispose(); this.release(transfer); transfer.cleanup()
  }
  dispose(): void { this.closed = true; for (const id of this.transfers.keys()) this.cancel(id) }
  /** Owner calls synchronously on authoritative workspace registry changes, including quiet revocation. */
  scopeChanged(): void {
    for (const [id, transfer] of this.transfers) {
      try { this.check(transfer) } catch (error) {
        if (transfer.endOwned) this.cancel(id)
        else this.fail(transfer, error instanceof ProtocolError ? error : new ProtocolError('OUT_OF_SCOPE'))
      }
    }
  }
  private fail(transfer: Transfer, error: ProtocolError): void {
    if (this.transfers.get(transfer.id) !== transfer) return
    if (transfer.endOwned) { this.release(transfer); return }
    let notify = true
    try { this.hostFence.check(transfer.fence) } catch { notify = false }
    this.cancel(transfer.id)
    if (notify) {
      try { void Promise.resolve(this.transport.failed(transfer.id, transfer.fence, error)).catch(() => {}) } catch {}
    }
  }
  private progress(transfer: Transfer): void {
    if (transfer.timer !== undefined) clearTimeout(transfer.timer)
    transfer.timer = setTimeout(() => this.fail(transfer, new ProtocolError('TRANSFER_TIMEOUT')), transfer.limits.transferIdleMs)
  }
  private get(id: string): Transfer { const transfer = this.transfers.get(id); if (!transfer) throw new ProtocolError('TRANSFER_CLOSED'); return transfer }
  private check(transfer: Transfer): void { transfer.controller.signal.throwIfAborted(); this.hostFence.check(transfer.fence); this.scope.assertSession(transfer.sessionId) }
  private grant(transfer: Transfer, chunks: number): void {
    this.check(transfer); transfer.receiver.grant(chunks); this.transport.credit(transfer.id, transfer.fence, chunks)
  }
  private release(transfer: Transfer): void { for (const release of transfer.releases) release(); transfer.queued = [] }
  private async *data(transfer: Transfer): AsyncIterable<Uint8Array> {
    try {
      for await (const chunk of transfer.receiver) {
        this.check(transfer)
        const release = transfer.queued.shift()
        try { yield chunk } finally { release?.() }
        this.check(transfer)
        if (!transfer.ended) this.grant(transfer, 1)
      }
    } finally { this.release(transfer) }
  }
}
