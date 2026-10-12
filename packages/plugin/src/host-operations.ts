import { randomUUID } from 'node:crypto'
import { FileDownloads } from './current-files/downloads.ts'
import { CurrentFileService } from './current-files/service.ts'
import { DshQueueAdapter } from './adapter/queue-rc2.ts'
import { DshUiReadAdapter } from './adapter/ui-rc2.ts'
import { DshManagementAdapter } from './adapter/management-rc2.ts'
import { supportsWorkspaceManagement } from './adapter/ui-rc2.ts'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_LIMITS, MAX_LOGICAL_JSON_BYTES, prepareJson, ProtocolError, type ControllerMessage, type Fence, type HostMessage, type Json, type Limits } from '../../protocol/src/index.ts'
import type { SessionAdapter, AdditionalHandlers } from './adapter/types.ts'
import { SessionScope } from './adapter/scope.ts'
import { HostFence } from './control-fence.ts'
import { dispatchCommand } from './commands.ts'
import { UploadManager } from './uploads.ts'
import { FileService } from './files.ts'
import { InteractionBridge, authenticatedEvents, sharedEventReply } from './interactions.ts'
import { LiveStreams } from './streams.ts'
import { wireFault } from './host-transport.ts'
interface Operation { id: string; kind: 'call' | 'watch' | 'upload' | 'download'; fence: Fence; controller: AbortController; terminal: boolean; cancelled: boolean; drained: boolean; expires: number; fragments?: boolean; publication?: () => void; download?: { id: string; owner: FileDownloads }; timer?: ReturnType<typeof setTimeout> }
type Send = (message: HostMessage, check: () => void, priority?: 'control' | 'data') => Promise<void>
/** Per-generation typed identities; upload native permits remain owned for this entire Host lifetime. */
export class HostOperations {
  private limits: Limits = { ...DEFAULT_LIMITS }
  private readonly scope: SessionScope
  private readonly uiReads: DshUiReadAdapter
  readonly uploads: UploadManager
  private incoming?: Fence
  private bridge?: InteractionBridge
  private streams?: LiveStreams
  private downloads?: FileDownloads
  private records = new Map<string, Operation>()
  private generation = new AbortController()
  private cleanups = new Set<Promise<unknown>>()
  private largeSend: Promise<void> = Promise.resolve()
  private track<T>(promise: Promise<T>): Promise<T> { this.cleanups.add(promise); void promise.then(() => this.cleanups.delete(promise), () => this.cleanups.delete(promise)); return promise }
  private sweep?: ReturnType<typeof setInterval>
  constructor(private readonly ctx: Context, private readonly adapter: SessionAdapter, private readonly fence: HostFence,
    private readonly reserve: (bytes: number) => () => void, private readonly send: Send, private readonly fail: (error: unknown) => void, private readonly sendBinary: (bytes: Uint8Array, check: () => void) => Promise<void> = async () => { throw new ProtocolError('PROTOCOL_UNSUPPORTED') }) {
    this.scope = new SessionScope(() => ctx.workspaceRegistry.list().map(item => ({ workspaceId: item.id, sessionIds: item.sessionIds })), ctx, supportsWorkspaceManagement(ctx) ? 'host-profile' : 'registered-workspaces')
    this.uiReads = new DshUiReadAdapter(ctx, this.scope)
    this.uploads = new UploadManager(ctx, fence, this.scope, {
      reserve,
      credit: (id, incoming, chunks) => { const record = this.records.get(id); if (record && !record.terminal) void this.send({ v: 1, type: 'upload.credit', id, fence: incoming, chunks }, () => { fence.check(incoming); if (record.terminal) throw new ProtocolError('TRANSFER_CLOSED') }).catch(error => this.transportFailure(error, record)) },
      failed: (id, incoming, error) => { const record = this.records.get(id); if (record && record.fence.controlId === incoming.controlId) this.result(record, undefined, error) },
    })
  }
  configure(limits: Limits): void { this.limits = { ...limits }; this.uploads.configureLimits(limits) }
  attach(incoming: Fence): void {
    this.detach(); this.fence.check(incoming); this.incoming = Object.freeze({ ...incoming }); this.generation = new AbortController()
    this.downloads = new FileDownloads({ limits: this.limits, reserve: this.reserve, sendBinary: this.sendBinary, sendEnd: async (message, check) => {
      const record = this.records.get(message.id); if (!record || record.terminal) return
      if (!message.error) { try { check() } catch { message = { ...message, error: wireFault(new ProtocolError('OUT_OF_SCOPE')) } } }
      this.terminal(record, message, 'data')
    } })
    const shared = this.ctx.connection.createSharedFetchHandler('/api')
    this.bridge = new InteractionBridge(incoming, this.fence, authenticatedEvents(this.ctx), id => this.scope.assertSession(id), sharedEventReply(request => shared.fetch(request)), this.reserve)
    this.streams = new LiveStreams(this.ctx, this.fence, this.scope, this.adapter, this.bridge, this.reserve)
    this.sweep = setInterval(() => { try { this.prune() } catch (error) { this.fail(error) } }, Math.min(1000, this.deadline()))
    const signal = this.generation.signal
    void this.track((async () => {
      try {
        for await (const _ of await this.ctx.typertGateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal })) {
          if (signal.aborted) break
          this.fence.check(incoming); this.uploads.scopeChanged()
        }
        if (!signal.aborted) throw new ProtocolError('RESYNC_REQUIRED')
      } catch (error) { if (!signal.aborted) this.fail(error) }
    })())
  }
  detach(): void {
    this.incoming = undefined; this.generation.abort(); if (this.sweep) clearInterval(this.sweep); this.sweep = undefined
    for (const record of this.records.values()) { record.controller.abort(); if (record.timer) clearTimeout(record.timer) }
    const downloads = this.downloads; this.downloads = undefined; if (downloads) void this.track(downloads.dispose())
    this.records.clear(); const bridge = this.bridge; this.bridge = undefined; this.streams = undefined; if (bridge) void this.track(bridge.dispose().catch(() => {}))
  }
  async dispose(): Promise<void> { this.detach(); this.uploads.dispose(); await Promise.allSettled([...this.cleanups]) }
  receive(message: ControllerMessage): void {
    this.fence.check(message.fence)
    if (!this.incoming || this.incoming.controlId !== message.fence.controlId) throw new ProtocolError('STALE_CONTROL')
    if (message.type === 'heartbeat') return
    if (message.type === 'cancel') {
      const record = this.required(message.id)
      if (record.terminal) return
      record.cancelled = true; record.controller.abort()
      if (record.kind === 'download') this.downloads?.cancel(record.id)
      if (record.kind === 'upload') { this.uploads.cancel(record.id); this.result(record, undefined, new ProtocolError('TRANSFER_CLOSED')) }
      // Calls/watches send a terminal after their own drain; never cancel native Agent work.
      return
    }
    if (message.type === 'download.credit') { const record = this.required(message.id, 'download'); if (!record.terminal) this.downloads!.credit(message.id, message.chunks); return }
    if (message.type === 'upload.end') {
      const record = this.required(message.id, 'upload'); if (record.terminal) return
      void this.uploads.end(message.id, message.chunks).then(value => this.result(record, value), error => this.result(record, undefined, error)); return
    }
    const kind = message.type === 'upload.open' ? 'upload' : message.type
    const record = this.admit(message.id, kind, message.fence)
    record.fragments = message.type !== 'upload.open' && message.fragments === true
    const jsonBytes = record.fragments ? MAX_LOGICAL_JSON_BYTES : this.limits.jsonBytes
    if (message.type === 'upload.open') {
      try { this.uploads.open(message.id, message.fence, message) } catch (error) { this.result(record, undefined, error) }
    } else if (message.type === 'call') {
      const release = this.reserve(Buffer.byteLength(JSON.stringify(message)) + 128)
      const signal = AbortSignal.any([record.controller.signal, this.generation.signal])
      const bridge = this.bridge!, downloads = this.downloads!
      const handlers: AdditionalHandlers = {
        'ui.manage': (command, signal, admission) => new DshManagementAdapter(this.ctx, this.scope).manage(command, signal, admission),
        'ui.catalog': (_command, signal, admission) => new DshManagementAdapter(this.ctx, this.scope).catalog(signal, admission, jsonBytes - 2048),
        'ui.search': (command, signal, admission) => new DshManagementAdapter(this.ctx, this.scope).search(command.query, signal, admission, jsonBytes - 2048),
        'session.queue': (command, signal, admission) => new DshQueueAdapter(this.ctx, this.scope, id => this.adapter.currentStopToken(id)).update(command, signal, admission),
        'interaction.delegate': (command, signal, admission) => { admission(); return bridge.delegate(command.deliveryId, signal) },
        'ui.read': (command, signal, admission) => this.uiReads.read(command, signal, admission),
        'interaction.answer': async (command, signal, admission) => { admission(); return bridge.answer(command.deliveryId, command.answer, signal) },
        'file.stat': (command, signal, admission) => new CurrentFileService(this.ctx, this.scope, admission, this.limits, check => { record.publication = check }).stat(command, signal),
        'file.text': (command, signal, admission) => new CurrentFileService(this.ctx, this.scope, admission, this.limits, check => { record.publication = check }).text(command, signal),
        'file.read': async (command, signal, admission) => {
          const file = await new CurrentFileService(this.ctx, this.scope, admission, this.limits).open(command, signal)
          let transfer: Operation | undefined
          try {
            admission(); signal.throwIfAborted(); transfer = this.admit(randomUUID(), 'download', record.fence)
            record.publication = file.assertAuthority; transfer.publication = file.assertAuthority
            const current = () => { admission(); file.assertAuthority() }
            const metadata = await downloads.open(transfer.id, transfer.fence, file, command, AbortSignal.any([signal, transfer.controller.signal]), current, false)
            record.download = { id: transfer.id, owner: downloads }
            signal.throwIfAborted()
            return { ...metadata }
          } catch (error) { if (transfer) { await downloads.discard(transfer.id); this.records.delete(transfer.id) }; await file.close(); throw error }
        },
        'file.changes': (command, signal, admission) => new FileService(this.ctx, this.scope, () => { admission(); signal.throwIfAborted() }, jsonBytes - 2048).readChanges(command.sessionId, command.seq),
        'file.diff': (command, signal, admission) => new FileService(this.ctx, this.scope, admission, jsonBytes - 2048).readDiff(command.sessionId, command.seq, command.index, signal),
      }
      record.timer = setTimeout(() => { record.cancelled = true; record.controller.abort(); this.result(record, undefined, new ProtocolError('RESULT_UNCERTAIN')) }, this.limits.callTimeoutMs)
      void dispatchCommand(this.adapter, this.fence, record.fence, message.command, signal, handlers, jsonBytes)
        .then(value => this.result(record, value), error => this.result(record, undefined, record.cancelled ? new ProtocolError('RESULT_UNCERTAIN') : error)).finally(release)
    } else {
      const streams = this.streams!
      const signal = AbortSignal.any([record.controller.signal, this.generation.signal])
      void this.track((async () => {
        let error: unknown
        try {
          for await (const value of (message.watch.topic === 'file' ? new CurrentFileService(this.ctx, this.scope, () => this.fence.check(record.fence), this.limits,check=>{record.publication=check}).changes(message.watch.sessionId, message.watch.path, signal) : streams.openWatch(message.watch, record.fence, signal, jsonBytes))) {
            await this.sendValue(record, { v: 1, type: 'event', id: record.id, fence: record.fence, value }, () => { this.fence.check(record.fence); if (record.cancelled || record.terminal) throw new ProtocolError('TRANSFER_CLOSED') }, 'data')
          }
        } catch (caught) { if (!record.cancelled) error = caught }
        this.terminal(record, { v: 1, type: 'end', id: record.id, fence: record.fence, ...(error ? { error: wireFault(error) } : {}) }, 'data')
      })())
    }
  }
  chunk(id: string, index: number, data: Uint8Array): void {
    const record = this.required(id, 'upload'); if (record.terminal) return
    this.fence.check(record.fence)
    void this.uploads.chunk(id, index, data).catch(error => this.result(record, undefined, error))
  }
  private required(id: string, kind?: Operation['kind']): Operation {
    const record = this.records.get(id)
    if (!record || (kind && record.kind !== kind)) throw new ProtocolError('INVALID_MESSAGE')
    return record
  }
  private deadline(): number { return Math.max(1000, this.limits.callTimeoutMs, this.limits.transferIdleMs) }
  private prune(): void {
    for (const [id, record] of this.records) if (record.terminal && record.expires <= Date.now()) {
      if (!record.drained) throw new ProtocolError('RESYNC_REQUIRED')
      this.records.delete(id)
    }
  }
  private admit(id: string, kind: Operation['kind'], incoming: Fence): Operation {
    this.prune()
    if (this.records.has(id)) throw new ProtocolError('INVALID_MESSAGE')
    const cap = Math.max(16, Math.min(4096, 4 * (this.limits.calls + this.limits.streams + this.limits.uploads)))
    if (this.records.size >= cap) {
      const done = [...this.records.values()].find(record => record.terminal && record.drained)
      if (!done) throw new ProtocolError('RESYNC_REQUIRED'); this.records.delete(done.id)
    }
    const limit = kind === 'call' ? this.limits.calls : kind === 'watch' ? this.limits.streams : this.limits.uploads
    if ([...this.records.values()].filter(record => record.kind === kind && !record.terminal).length >= limit) throw new ProtocolError('BACKPRESSURE')
    const record: Operation = { id, kind, fence: Object.freeze({ ...incoming }), controller: new AbortController(), terminal: false, cancelled: false, drained: false, expires: Infinity }
    this.records.set(id, record); return record
  }
  private result(record: Operation, value?: Json, error?: unknown): void {
    this.terminal(record, { v: 1, type: 'result', id: record.id, fence: record.fence, result: error ? { ok: false, error: wireFault(error) } : { ok: true, value: value ?? null } })
  }
  private async sendValue(record: Operation, message: HostMessage, check: () => void, priority: 'control' | 'data'): Promise<void> {
    const originalCheck = check
    check = () => { originalCheck(); if (message.type === 'event' || (message.type === 'download.end' && !message.error) || (message.type === 'result' && message.result.ok && !(message.result.value && typeof message.result.value === 'object' && 'ok' in message.result.value && message.result.value.ok === false))) record.publication?.() }
    if (message.type !== 'result' && message.type !== 'event') return this.send(message, check, priority)
    const prepared = prepareJson(message, this.limits)
    // The source queue hands ownership here. Serialization retains only bounded
    // pieces, including while another operation owns the large-body send window.
    const release = this.reserve(prepared.bytes + 256)
    if (prepared.bytes <= this.limits.jsonBytes || !record.fragments) {
      try { return await this.send(message, check, priority) } finally { release() }
    }
    const prior = this.largeSend
    let unlock!: () => void
    this.largeSend = new Promise<void>(resolve => { unlock = resolve })
    const deadline = Date.now() + this.limits.callTimeoutMs
    let releasePieces: (() => void) | undefined
    try {
      await prior
      check(); releasePieces = this.reserve(this.limits.jsonBytes)
      const current = () => { check(); if (Date.now() >= deadline) throw new ProtocolError('TRANSFER_TIMEOUT') }
      for (const part of prepared.fragments()) { current(); await this.send(part, current, 'data') }
    } finally { releasePieces?.(); release(); unlock() }
  }
  private terminal(record: Operation, message: HostMessage, priority: 'control' | 'data' = 'control'): void {
    if (record.terminal || this.records.get(record.id) !== record) return
    record.terminal = true; record.expires = Date.now() + this.deadline(); if (record.timer) clearTimeout(record.timer)
    const discard = async () => {
      const pending = record.download; record.download = undefined
      if (pending) { await pending.owner.discard(pending.id); this.records.delete(pending.id) }
    }
    const send = () => this.sendValue(record, message, () => this.fence.check(record.fence), priority)
    const sending = record.download && message.type === 'result' && !message.result.ok ? discard().then(send) : send()
    void this.track(sending.then(() => {
      if (record.download) { record.download.owner.announce(record.download.id); record.download = undefined }
    }).catch(async error => {
      await discard()
      if (!record.publication || !(message.type === 'result' || message.type === 'download.end') || (error instanceof ProtocolError && !['OUT_OF_SCOPE', 'TRANSFER_CLOSED', 'PROTOCOL_UNSUPPORTED'].includes(error.code))) throw error
      const fault = wireFault(new ProtocolError('OUT_OF_SCOPE'))
      const failure: HostMessage = message.type === 'result' ? { ...message, result: { ok: false, error: fault } } : { ...message, error: fault }
      await this.send(failure, () => this.fence.check(record.fence), priority)
    })).then(() => { record.drained = true }, error => this.transportFailure(error, record))
  }
  private transportFailure(error: unknown, record: Operation): void {
    if (this.records.get(record.id) !== record) return
    if (error instanceof ProtocolError && ['STALE_CONTROL', 'AUTH_REVOKED', 'TRANSFER_CLOSED'].includes(error.code)) return
    this.fail(error)
  }
}
