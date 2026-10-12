import { CURRENT_FILES_CAPABILITY, parseCurrentFileStat } from '../../protocol/src/index.ts'
import { CHUNK_HEADER_BYTES, DEFAULT_LIMITS, MAX_READ_BYTES, ProtocolError, TransferReceiver, TransferWindow, checkJsonLength, decodeChunk, encodeChunk, parseController, parseHandshake, parseHost, validateDownloadMetadata, validateId, type Command, type DownloadMetadata, type Fence, type HostMessage, type Json, type Limits, type Watch, type SelectedUiProfile, parseSelectedUiProfile } from '../../protocol/src/index.ts'
import { BrowserAuthorization, controlStatus } from './connect.ts'
import { JsonFragmentSequence, LARGE_JSON_CAPABILITY, assembledHost, fragmentableRead, type JsonFragment } from '../../protocol/src/index.ts'
export interface ConnectionSnapshot { phase: 'connecting' | 'syncing' | 'ready' | 'offline' | 'busy' | 'replaced' | 'revoked' | 'error'; fence: Fence | null; code?: string }
export interface SyncBarrier { ready(): void; fail(error: unknown): void }
export interface SyncGeneration { fence: Fence; signal: AbortSignal; barrier: SyncBarrier }
interface Options { uiProfile?: SelectedUiProfile; origin?: string; socket?: (url: string) => WebSocket; storage?: Storage; authorization?: BrowserAuthorization; reconnect?: boolean; fetch?: typeof fetch }
interface FragmentState { sequence: JsonFragmentSequence; parts: string[]; release?: () => void; timer?: ReturnType<typeof setTimeout> }
interface Operation { fragments?: FragmentState; downloadOpener?: boolean; kind: 'call' | 'watch' | 'upload' | 'download'; finish(error?: Error): void; receive(message: HostMessage): void; binary?(bytes: Uint8Array): void; timer?: ReturnType<typeof setTimeout>; cleanup?(): void }
interface Recent { fragments?: FragmentState; downloadOpener?: boolean; kind: Operation['kind']; drained: boolean; timer: ReturnType<typeof setTimeout> }
const sameFence = (a: Fence | null, b: Fence) => !!a && a.instanceId === b.instanceId && a.authEpoch === b.authEpoch && a.runtimeId === b.runtimeId && a.controlId === b.controlId
const sameUiProfile = (a: SelectedUiProfile, b: SelectedUiProfile) => a.runtimeId === b.runtimeId && a.uiRevision === b.uiRevision
  && a.host.schema === b.host.schema && a.host.dshVersion === b.host.dshVersion && a.host.adapter === b.host.adapter && a.host.uiApi === b.host.uiApi
  && [...a.host.capabilities].sort().join('\0') === [...b.host.capabilities].sort().join('\0')
const failure = (error: unknown, fallback = 'INVALID_MESSAGE') => error instanceof ProtocolError ? error : new ProtocolError(fallback)
const mutation = (command: Command) => ['ui.manage', 'session.queue', 'session.prompt', 'session.stop', 'interaction.answer', 'interaction.delegate', 'session.create'].includes(command.op)
/** No DSH runtime is loaded here. All business frames use the central strict protocol. */
export class BrowserTransport {
  private snapshot: ConnectionSnapshot = { phase: 'offline', fence: null }
  private readonly listeners = new Set<() => void>()
  private readonly operations = new Map<string, Operation>()
  private readonly recent = new Map<string, Recent>()
  private socket?: WebSocket
  private readonly retiring = new Set<WebSocket>()
  private buffered(): number { return [...this.retiring].reduce((sum, socket) => sum + socket.bufferedAmount, this.socket?.bufferedAmount ?? 0) }
  private generation = 0
  private lifetime = new AbortController()
  private syncRevision = 0
  private syncTimer?: ReturnType<typeof setTimeout>
  private synchronize?: (generation: SyncGeneration) => void
  private limits: Limits = { ...DEFAULT_LIMITS }
  private queuedBytes = 0
  private activeDownloads = 0
  private instanceId?: string
  private disposed = false
  private heartbeat?: ReturnType<typeof setInterval>
  private handshake?: ReturnType<typeof setTimeout>
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private busyProbes = 0
  private retryDelay = 500
  private readyWaiter?: { resolve(): void; reject(error: Error): void }
  private readonly origin: string
  private readonly createSocket: (url: string) => WebSocket
  private readonly storage?: Storage
  private readonly authorization?: BrowserAuthorization
  private resumeAttempt?: Promise<void>
  private nativeProfile?: SelectedUiProfile
  private resumeLease?: { instanceId: string; id: string; secret: string }
  constructor(private readonly options: Options = {}) {
    if (options.uiProfile) this.nativeProfile = parseSelectedUiProfile(options.uiProfile)
    this.origin = options.origin ?? location.origin
    if (new URL(this.origin).protocol !== 'https:') throw new ProtocolError('INVALID_MESSAGE', 'HTTPS origin required')
    this.createSocket = options.socket ?? (url => new WebSocket(url))
    try { this.storage = options.storage ?? globalThis.sessionStorage } catch { /* Page-local resume still works. */ }
    this.authorization = options.authorization ?? (typeof location === 'undefined' ? undefined : new BrowserAuthorization())
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot = (): ConnectionSnapshot => this.snapshot
  private publish(snapshot: ConnectionSnapshot): void { this.snapshot = Object.freeze(snapshot); for (const listener of this.listeners) listener() }
  /** Register once before connect. No consumer means no writable state. */
  registerSynchronizer(synchronize: (generation: SyncGeneration) => void): () => void {
    if (this.synchronize || this.socket) throw new ProtocolError('INVALID_MESSAGE')
    this.synchronize = synchronize
    return () => { if (this.synchronize === synchronize) { this.synchronize = undefined; this.holdSync() } }
  }
  /** Selection-generation barrier. Old completions cannot reopen mutation admission. */
  holdSync(): SyncBarrier {
    clearTimeout(this.syncTimer)
    const generation = this.generation; const revision = ++this.syncRevision; const fence = this.snapshot.fence
    if (fence) this.publish({ phase: 'syncing', fence })
    const current = () => generation === this.generation && revision === this.syncRevision && fence !== null && sameFence(this.snapshot.fence, fence) && !this.lifetime.signal.aborted
    if (fence && this.synchronize) this.syncTimer = setTimeout(() => { if (current()) this.fail(new ProtocolError('RESYNC_REQUIRED')) }, this.limits.callTimeoutMs)
    return { ready: () => { if (current() && this.synchronize) { clearTimeout(this.syncTimer); this.retryDelay = 500; this.busyProbes = 0; this.publish({ phase: 'ready', fence }); this.readyWaiter?.resolve(); this.readyWaiter = undefined } }, fail: error => { if (current()) this.fail(failure(error)) } }
  }
  async connect(instanceId: string): Promise<void> {
    validateId(instanceId); if (this.disposed) throw new ProtocolError('TRANSFER_CLOSED')
    this.disconnect(new ProtocolError('HOST_OFFLINE')); this.lifetime = new AbortController(); this.instanceId = instanceId
    const attempt = this.generation
    this.publish({ phase: 'connecting', fence: null })
    try { if (this.authorization?.hasLink) await this.authorization.authorize(instanceId, this.lifetime.signal) } catch (error) { if (attempt === this.generation) this.fail(failure(error, 'HOST_OFFLINE')); throw error }
    if (attempt !== this.generation || this.disposed) throw new ProtocolError('HOST_OFFLINE')
    return this.prepareSocket(true)
  }
  /** A deliberate retry claims ownership; it never replays business operations. */
  retry(): Promise<void> {
    if (!this.instanceId) return Promise.reject(new ProtocolError('INVALID_MESSAGE'))
    this.busyProbes = 0; this.retryDelay = 500
    return this.connect(this.instanceId)
  }
  /** Original Connection retries may only join/resume this physical carrier. */
  resume(): Promise<void> {
    if (this.disposed) return Promise.reject(new ProtocolError('TRANSFER_CLOSED'))
    if (!this.instanceId) return Promise.reject(new ProtocolError('INVALID_MESSAGE'))
    const state = this.snapshot
    if (state.phase === 'replaced' || state.phase === 'revoked' || state.phase === 'error') return Promise.reject(new ProtocolError(state.code ?? 'HOST_OFFLINE'))
    if (state.phase === 'ready') return Promise.resolve()
    if (this.resumeAttempt) return this.resumeAttempt
    if (state.phase === 'connecting' || state.phase === 'syncing') return new Promise((resolve, reject) => {
      const unsubscribe = this.subscribe(() => {
        const next = this.snapshot
        if (next.phase === 'ready') { unsubscribe(); resolve() }
        else if (next.phase !== 'connecting' && next.phase !== 'syncing') { unsubscribe(); reject(new ProtocolError(next.code ?? 'HOST_OFFLINE')) }
      })
    })
    if (!this.hasResume()) return Promise.reject(new ProtocolError('STALE_CONTROL'))
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined
    return this.prepareSocket(false)
  }
  private hasResume(): boolean {
    if (this.resumeLease?.instanceId === this.instanceId) return true
    try { return !!this.storage?.getItem(`dsh:resume:${this.instanceId}`) } catch { return false }
  }
  private prepareSocket(takeover = false): Promise<void> {
    if (!takeover && this.resumeAttempt) return this.resumeAttempt
    const attempt = this.prepareSocketOnce(takeover)
    if (!takeover) {
      this.resumeAttempt = attempt
      void attempt.finally(() => { if (this.resumeAttempt === attempt) this.resumeAttempt = undefined }).catch(() => {})
    }
    return attempt
  }
  private async prepareSocketOnce(takeover: boolean): Promise<void> {
    const generation = this.generation; this.lifetime = new AbortController()
    try {
      const status = await controlStatus(this.instanceId!, this.options.fetch, this.lifetime.signal)
      if (generation !== this.generation || this.disposed) throw new ProtocolError('TRANSFER_CLOSED')
      if (!status.hostOnline) throw new ProtocolError('HOST_OFFLINE')
      if (status.remoteConnected && !takeover) throw new ProtocolError('REMOTE_BUSY')
      return await this.openSocket(takeover)
    } catch (error) { if (generation === this.generation && !this.disposed) this.fail(failure(error, 'HOST_OFFLINE')); throw error }
  }
  private openSocket(takeover: boolean): Promise<void> {
    const generation = ++this.generation; this.lifetime = new AbortController(); this.publish({ phase: 'connecting', fence: null })
    const instanceId = this.instanceId!; let configured = false; let lease: Fence | null = null; let attached = false; let heartbeatMs = 0
    const promise = new Promise<void>((resolve, reject) => { this.readyWaiter = { resolve, reject } })
    let socket: WebSocket
    try { socket = this.createSocket(`${this.origin.replace(/^https:/, 'wss:')}/v1/instances/${instanceId}/control`) } catch (error) { this.fail(failure(error, 'HOST_OFFLINE')); return promise }
    this.socket = socket; socket.binaryType = 'arraybuffer'
    const current = () => this.socket === socket && generation === this.generation && !this.disposed
    this.handshake = setTimeout(() => { if (current()) this.fail(new ProtocolError('HOST_OFFLINE')) }, 5000)
    socket.addEventListener('open', () => {
      if (!current()) return
      try {
        let resume = this.resumeLease?.instanceId === instanceId ? { id: this.resumeLease.id, secret: this.resumeLease.secret } : undefined
        if (!resume) { try { const value = this.storage?.getItem(`dsh:resume:${instanceId}`); if (value) { const parsed = JSON.parse(value); const hello = parseHandshake(JSON.stringify({ v: 1, type: 'browser.hello', versions: [1], resume: parsed }), this.limits); if (hello.type === 'browser.hello') resume = hello.resume } } catch { /* A corrupt/disabled tab store cannot confer authority. */ } }
        this.sendHandshake({ v: 1, type: 'browser.hello', versions: [1], ...(this.nativeProfile ? { uiApi: 1 } : {}), ...(takeover ? { takeover: true } : {}), ...(resume ? { resume } : {}) })
      } catch (error) { this.fail(failure(error)) }
    })
    socket.addEventListener('message', event => {
      if (!current()) return
      try {
        if (typeof event.data !== 'string') {
          if (!attached || !(event.data instanceof ArrayBuffer)) throw new ProtocolError('INVALID_MESSAGE')
          const bytes = new Uint8Array(event.data); const chunk = decodeChunk(bytes, this.limits)
          if (chunk.controlId !== this.snapshot.fence?.controlId) return
          const op = this.operations.get(chunk.id)
          if (!op) { if (this.recent.get(chunk.id)?.kind === 'download') return; throw new ProtocolError('INVALID_MESSAGE') }
          if (op.kind !== 'download') throw new ProtocolError('INVALID_MESSAGE'); op.binary!(bytes); return
        }
        checkJsonLength(event.data, this.limits.jsonBytes)
        const raw = JSON.parse(event.data)
        if (['relay.config', 'browser.lease', 'ready', 'fault'].includes(raw.type)) {
          const message = parseHandshake(event.data, this.limits)
          if (message.type === 'fault') { this.fail(new ProtocolError(message.error.code)); return }
          if (message.type === 'relay.config') {
            if (configured || lease || attached) throw new ProtocolError('INVALID_MESSAGE')
            this.limits = message.limits; heartbeatMs = message.heartbeatMs; configured = true
          } else if (message.type === 'browser.lease') {
            if (!configured || lease || message.fence.instanceId !== instanceId) throw new ProtocolError('INVALID_MESSAGE')
            lease = Object.freeze({ ...message.fence }); this.resumeLease = { instanceId, id: message.id, secret: message.resumeSecret }
            try { this.storage?.setItem(`dsh:resume:${instanceId}`, JSON.stringify({ id: message.id, secret: message.resumeSecret })) } catch { /* Still retained in this page. */ }
            this.sendHandshake({ v: 1, type: 'browser.lease-ack', id: message.id })
            clearTimeout(this.handshake); this.handshake = setTimeout(() => { if (current()) this.fail(new ProtocolError('HOST_OFFLINE')) }, 10000)
          } else if (message.type === 'ready') {
            if (attached || !sameFence(lease, message.fence)) throw new ProtocolError('STALE_CONTROL')
            if (this.nativeProfile ? (!message.uiProfile || !sameUiProfile(message.uiProfile, this.nativeProfile)) : message.uiProfile !== undefined) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
            attached = true; clearTimeout(this.handshake); this.handshake = undefined
            this.publish({ phase: 'syncing', fence: lease }); const barrier = this.holdSync()
            this.heartbeat = setInterval(() => { if (current()) { try { this.send({ v: 1, type: 'heartbeat', fence: lease! }) } catch (error) { this.fail(failure(error)) } } }, heartbeatMs)
            this.synchronize?.({ fence: lease!, signal: this.lifetime.signal, barrier })
          }
          return
        }
        if (!attached) throw new ProtocolError('INVALID_MESSAGE')
        let message = parseHost(event.data, this.limits)
        if (!sameFence(this.snapshot.fence, message.fence)) return
        const op = this.operations.get(message.id)
        if (!op) { this.late(message); return }
        if (message.type === 'json.fragment') {
          const assembled = this.fragment(message, op)
          if (!assembled) return
          message = assembled
        } else if (op.fragments?.sequence.active) {
          if (!((message.type === 'end' && message.error) || (message.type === 'result' && !message.result.ok))) throw new ProtocolError('INVALID_MESSAGE')
          this.clearFragments(op.fragments)
        }
        const kind = message.type === 'event' || message.type === 'end' ? 'watch' : message.type === 'download.end' ? 'download' : message.type === 'upload.credit' ? 'upload' : undefined
        if ((kind && op.kind !== kind) || (!kind && op.kind !== 'call' && op.kind !== 'upload')) throw new ProtocolError('INVALID_MESSAGE')
        op.receive(message)
      } catch (error) { this.fail(failure(error)) }
    })
    socket.addEventListener('close', event => { this.retiring.delete(socket); if (current()) this.fail(new ProtocolError(event.code === 1009 ? 'LIMIT_EXCEEDED' : (/^[A-Z_]+$/.test(event.reason) ? event.reason : 'HOST_OFFLINE'))) })
    socket.addEventListener('error', () => { if (current()) this.fail(new ProtocolError('HOST_OFFLINE')) })
    return promise
  }
  private fragmentState(): FragmentState | undefined {
    return this.nativeProfile?.host.capabilities.includes(LARGE_JSON_CAPABILITY) ? { sequence: new JsonFragmentSequence(), parts: [] } : undefined
  }
  private clearFragments(state?: FragmentState, keepSequence = false): void {
    if (!state) return
    state.parts.length = 0; state.release?.(); state.release = undefined; clearTimeout(state.timer); state.timer = undefined
    if (!keepSequence) state.sequence.clear()
  }
  private fragment(part: JsonFragment, op: Operation): HostMessage | undefined {
    const state = op.fragments
    if (!state || (op.kind === 'call' ? part.logicalType !== 'result' : op.kind !== 'watch' || part.logicalType !== 'event')) throw new ProtocolError('INVALID_MESSAGE')
    if (!state.sequence.active) {
      // Budget the retained chunks plus the joined/reparsed body before storing data.
      state.release = this.reserve(2 * part.bytes + 1024)
      state.timer = setTimeout(() => this.cancel(part.id, new ProtocolError('TRANSFER_TIMEOUT')), this.limits.callTimeoutMs)
    }
    const done = state.sequence.accept(part)
    state.parts.push(part.data)
    if (!done) return
    try {
      const text = state.parts.join(''); state.parts.length = 0
      return assembledHost(text, part, this.limits)
    } finally { this.clearFragments(state) }
  }
  private sendHandshake(value: unknown): void { this.sendRaw(JSON.stringify(parseHandshake(JSON.stringify(value), this.limits)), true) }
  private send(value: unknown): void { this.sendRaw(JSON.stringify(parseController(JSON.stringify(value), this.limits)), true) }
  private sendRaw(value: string | Uint8Array, control = false): void {
    if (!this.socket || this.socket.readyState !== 1) throw new ProtocolError('HOST_OFFLINE')
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength
    if (this.queuedBytes + this.buffered() + bytes + 14 > this.limits.bufferedBytes - (control ? 0 : Math.min(1024, Math.floor(this.limits.bufferedBytes / 4)))) throw new ProtocolError('RESYNC_REQUIRED')
    this.socket.send(value as string & ArrayBufferView<ArrayBuffer>)
  }
  private reserve(bytes: number): () => void {
    if (bytes + this.queuedBytes + this.buffered() > this.limits.bufferedBytes) throw new ProtocolError('RESYNC_REQUIRED')
    this.queuedBytes += bytes; let released = false
    return () => { if (!released) { released = true; this.queuedBytes -= bytes } }
  }
  private admit(kind: Operation['kind'], write: boolean): Fence {
    const fence = this.snapshot.fence
    if (!fence || (this.snapshot.phase !== 'ready' && (write || this.snapshot.phase !== 'syncing'))) throw new ProtocolError(this.snapshot.phase === 'syncing' ? 'SYNC_REQUIRED' : 'HOST_OFFLINE')
    const limit = kind === 'watch' ? this.limits.streams : kind === 'upload' || kind === 'download' ? this.limits.uploads : this.limits.calls
    if ([...this.operations.values()].filter(op => op.kind === kind).length >= limit) throw new ProtocolError('LIMIT_EXCEEDED')
    return fence
  }
  private retire(id: string, drained: boolean): void {
    const op = this.operations.get(id); if (!op) return
    this.operations.delete(id); clearTimeout(op.timer); op.cleanup?.()
    this.clearFragments(op.fragments, true)
    const cap = Math.max(16, Math.min(4096, 4 * (this.limits.calls + this.limits.streams + this.limits.uploads)))
    while (this.recent.size >= cap) { const removable = [...this.recent].find(([, value]) => value.drained); if (!removable) { this.fail(new ProtocolError('RESYNC_REQUIRED')); return } clearTimeout(removable[1].timer); this.recent.delete(removable[0]) }
    const recent: Recent = { fragments: op.fragments, kind: op.kind, downloadOpener: op.downloadOpener, drained, timer: setTimeout(() => { if (this.recent.get(id) !== recent) return; this.recent.delete(id); if (!recent.drained) this.fail(new ProtocolError('RESYNC_REQUIRED')) }, Math.max(1000, this.limits.callTimeoutMs, this.limits.transferIdleMs)) }
    this.recent.set(id, recent)
  }
  private late(message: HostMessage): void {
    const recent = this.recent.get(message.id); if (!recent) throw new ProtocolError('INVALID_MESSAGE')
    if (message.type === 'json.fragment') {
      if (recent.drained || !recent.fragments || (recent.kind === 'call' ? message.logicalType !== 'result' : recent.kind !== 'watch' || message.logicalType !== 'event')) throw new ProtocolError('INVALID_MESSAGE')
      if (recent.fragments.sequence.accept(message) && recent.kind === 'call') recent.drained = true
      return
    }
    if (recent.fragments?.sequence.active) {
      if (!(message.type === 'end' || (message.type === 'result' && !message.result.ok))) throw new ProtocolError('INVALID_MESSAGE')
      recent.fragments.sequence.clear()
    }
    const valid = recent.kind === 'watch' ? message.type === 'event' || message.type === 'end' : recent.kind === 'download' ? message.type === 'download.end' : recent.kind === 'upload' ? message.type === 'result' || message.type === 'upload.credit' : message.type === 'result'
    if (!valid) throw new ProtocolError('INVALID_MESSAGE')
    if (message.type === 'result' || message.type === 'end' || message.type === 'download.end') recent.drained = true
    if (recent.downloadOpener && message.type === 'result' && message.result.ok && typeof message.result.value === 'object' && message.result.value && !Array.isArray(message.result.value) && typeof message.result.value.transferId === 'string') {
      const id = validateDownloadMetadata(message.result.value, this.limits).transferId
      if (this.operations.has(id) || this.recent.has(id)) throw new ProtocolError('INVALID_MESSAGE')
      this.operations.set(id, { kind: 'download', finish() {}, receive() {} }); this.retire(id, false); this.send({ v: 1, type: 'cancel', id, fence: this.snapshot.fence })
    }
  }
  private cancel(id: string, error: Error): void { const op = this.operations.get(id); if (!op) return; op.finish(error); this.retire(id, false); if (this.socket && this.snapshot.fence) { try { this.send({ v: 1, type: 'cancel', id, fence: this.snapshot.fence }) } catch (cause) { this.fail(failure(cause)) } } }
  call(command: Command, signal?: AbortSignal): Promise<Json> { return this.callOpening(command, signal) }
  private callOpening(command: Command, signal?: AbortSignal, opening?: (value: Json) => void): Promise<Json> {
    try {
      const fence = this.admit('call', mutation(command)); signal?.throwIfAborted(); const id = crypto.randomUUID()
      const fragments = fragmentableRead(command) ? this.fragmentState() : undefined
      // Validate before recording a possibly dispatched mutation.
      const wire = parseController(JSON.stringify({ v: 1, type: 'call', id, fence, command, ...(fragments ? { fragments: true } : {}) }), this.limits)
      return new Promise<Json>((resolve, reject) => {
        let sent = false
        const abort = () => this.cancel(id, new ProtocolError(sent && mutation(command) ? 'RESULT_UNCERTAIN' : 'TRANSFER_CLOSED'))
        const op: Operation = { fragments, kind: 'call', downloadOpener: command.op === 'file.read', finish: reject, cleanup: () => signal?.removeEventListener('abort', abort), receive: message => {
          if (message.type !== 'result') return
          this.retire(id, true)
          if (message.result.ok) { try { opening?.(message.result.value); resolve(message.result.value) } catch (error) { reject(error); this.fail(failure(error)) } } else reject(new ProtocolError(message.result.error.code))
        } }
        this.operations.set(id, op); signal?.addEventListener('abort', abort, { once: true })
        op.timer = setTimeout(() => this.cancel(id, new ProtocolError('RESULT_UNCERTAIN')), this.limits.callTimeoutMs)
        try { this.send(wire); sent = true } catch (error) { this.operations.delete(id); clearTimeout(op.timer); op.cleanup?.(); reject(error) }
      })
    } catch (error) { return Promise.reject(error) }
  }
  async *watch(watch: Watch, signal: AbortSignal): AsyncIterable<Json> {
    const fence = this.admit('watch', false); signal.throwIfAborted(); const id = crypto.randomUUID()
    const queue: { value: Json; release(): void }[] = []; let wake: (() => void) | undefined; let ended = false; let error: Error | undefined
    const finish = (cause?: Error) => { ended = true; error = cause; if (cause) { for (const item of queue) item.release(); queue.length = 0 } wake?.() }
    const abort = () => this.cancel(id, new ProtocolError('TRANSFER_CLOSED'))
    const op: Operation = { fragments: this.fragmentState(), kind: 'watch', finish, cleanup: () => signal.removeEventListener('abort', abort), receive: message => {
      if (message.type === 'event') {
        clearTimeout(op.timer); op.timer = undefined
        if (queue.length >= 128) throw new ProtocolError('RESYNC_REQUIRED')
        const release = this.reserve(new TextEncoder().encode(JSON.stringify(message.value)).byteLength + 128)
        queue.push({ value: message.value, release }); wake?.()
      } else if (message.type === 'end') { this.retire(id, true); finish(new ProtocolError(message.error?.code ?? 'RESYNC_REQUIRED')) }
    } }
    this.operations.set(id, op); signal.addEventListener('abort', abort, { once: true })
    op.timer = setTimeout(() => this.cancel(id, new ProtocolError('RESULT_UNCERTAIN')), this.limits.callTimeoutMs)
    try {
      this.send({ v: 1, type: 'watch', id, fence, watch, ...(op.fragments ? { fragments: true } : {}) })
      while (true) { if (error) throw error; const item = queue.shift(); if (item) { item.release(); yield item.value } else { if (ended) break; await new Promise<void>(resolve => { wake = resolve }) } }
    } finally { for (const item of queue) item.release(); if (this.operations.has(id)) this.cancel(id, new ProtocolError('TRANSFER_CLOSED')) }
  }
  async upload(sessionId: string, file: File, signal: AbortSignal): Promise<Json> {
    const fence = this.admit('upload', true); signal.throwIfAborted(); const id = crypto.randomUUID(); const generation = this.generation
    const window = new TransferWindow(file.size, this.limits); let wake: (() => void) | undefined; let error: Error | undefined; let credit = 0; let ended = false
    const result = Promise.withResolvers<Json>(); void result.promise.catch(() => {})
    const abort = () => this.cancel(id, new ProtocolError(ended ? 'RESULT_UNCERTAIN' : 'TRANSFER_CLOSED'))
    const progress = () => { clearTimeout(op.timer); op.timer = setTimeout(() => this.cancel(id, new ProtocolError(ended ? 'RESULT_UNCERTAIN' : 'TRANSFER_TIMEOUT')), ended ? this.limits.callTimeoutMs : this.limits.transferIdleMs) }
    const op: Operation = { kind: 'upload', finish: cause => { error = cause ?? new ProtocolError('TRANSFER_CLOSED'); window.dispose(); result.reject(error); wake?.() }, cleanup: () => signal.removeEventListener('abort', abort), receive: message => {
      if (message.type === 'upload.credit' && !ended) { window.grant(message.chunks); credit += message.chunks; wake?.() }
      if (message.type === 'result') { this.retire(id, true); if (message.result.ok && ended) result.resolve(message.result.value); else { error = new ProtocolError(message.result.ok ? 'INVALID_MESSAGE' : message.result.error.code); result.reject(error); wake?.() } }
    } }
    this.operations.set(id, op); signal.addEventListener('abort', abort, { once: true }); progress()
    try {
      this.send({ v: 1, type: 'upload.open', id, fence, sessionId, name: file.name, mediaType: file.type || 'application/octet-stream', bytes: file.size })
      for (let offset = 0; offset < file.size;) {
        while (!credit && !error) await new Promise<void>(resolve => { wake = resolve }); if (error) throw error; signal.throwIfAborted()
        const length = Math.min(this.limits.chunkBytes, 65536, file.size - offset); const release = this.reserve(2 * length + CHUNK_HEADER_BYTES)
        try { const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()); if (generation !== this.generation || !this.operations.has(id)) throw error ?? new ProtocolError('TRANSFER_CLOSED'); signal.throwIfAborted(); const index = window.consume(bytes.length); credit--; this.sendRaw(encodeChunk(id, fence.controlId, index, bytes)); offset += bytes.length; progress() } finally { release() }
        // Give control/heartbeat frames a turn between chunks.
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (error) throw error; ended = true; this.send({ v: 1, type: 'upload.end', id, fence, chunks: window.finish() }); progress()
      return await result.promise
    } catch (cause) { if (this.operations.has(id)) this.cancel(id, failure(cause, ended ? 'RESULT_UNCERTAIN' : 'TRANSFER_CLOSED')); throw cause }
    finally { window.dispose() }
  }
  async readFileRange(command: { sessionId: string; path: string; version: string; offset: number; length: number }, signal: AbortSignal): Promise<{ blob: Blob; metadata: DownloadMetadata }> {
    this.admit('download', false)
    if (this.activeDownloads >= this.limits.uploads) throw new ProtocolError('LIMIT_EXCEEDED')
    this.activeDownloads++
    try { return await this.receiveFileRange(command, signal) } finally { this.activeDownloads-- }
  }
  private async receiveFileRange(command: { sessionId: string; path: string; version?: string; offset: number; length: number }, signal: AbortSignal): Promise<{ blob: Blob; metadata: DownloadMetadata }> {
    const fence = this.admit('download', false), generation = this.generation, { offset, length } = command
    signal.throwIfAborted()
    let metadata!: DownloadMetadata, receiver: TransferReceiver | undefined, releases: (() => void)[] = [], transferId = ''
    const parts: Blob[] = []
    const abort = () => { if (transferId) this.cancel(transferId, new ProtocolError('TRANSFER_CLOSED')) }
    try {
      await this.callOpening({ op: 'file.read', ...command }, signal, value => {
        metadata = validateDownloadMetadata(value, this.limits)
        if (this.operations.has(metadata.transferId) || this.recent.has(metadata.transferId) || metadata.offset !== offset || metadata.bytes > length || (!metadata.eof && metadata.bytes === 0 && length !== 0)) throw new ProtocolError('INVALID_MESSAGE')
        transferId = metadata.transferId
        const opened = new TransferReceiver(transferId, fence.controlId, metadata.bytes, this.limits)
        receiver = opened
        this.operations.set(transferId, { kind: 'download', cleanup: () => signal.removeEventListener('abort', abort),
          finish: error => { opened.dispose(error); for (const release of releases) release(); releases = [] },
          receive: message => { if (message.type === 'download.end') { try { opened.end(message.chunks, message.error) } catch (error) { if (!message.error) throw error } this.retire(transferId, true) } },
          binary: bytes => { const release = this.reserve(bytes.byteLength); try { opened.receive(bytes); releases.push(release) } catch (error) { release(); throw error } },
        })
        signal.addEventListener('abort', abort, { once: true })
        signal.throwIfAborted(); opened.grant(1); this.send({ v: 1, type: 'download.credit', id: transferId, fence, chunks: 1 })
      })
      for await (const bytes of receiver!) {
        parts.push(new Blob([bytes as Uint8Array<ArrayBuffer>]))
        releases.shift()?.()
        if (this.operations.has(transferId)) { receiver!.grant(1); this.send({ v: 1, type: 'download.credit', id: transferId, fence, chunks: 1 }) }
      }
      if (generation !== this.generation) throw new ProtocolError('TRANSFER_CLOSED')
      signal.throwIfAborted()
      const blob = new Blob(parts, { type: metadata.mediaType })
      if (blob.size !== metadata.bytes) throw new ProtocolError('INVALID_MESSAGE')
      return { blob, metadata }
    } finally {
      parts.length = 0; receiver?.dispose(); for (const release of releases) release()
      if (this.operations.has(transferId)) this.cancel(transferId, new ProtocolError('TRANSFER_CLOSED'))
    }
  }
  async download(sessionId: string, path: string, signal: AbortSignal, version?: string): Promise<{ blob: Blob; name: string; mediaType: string }> {
    this.admit('download', false)
    if (this.activeDownloads >= this.limits.uploads) throw new ProtocolError('LIMIT_EXCEEDED')
    this.activeDownloads++
    const generation = this.generation, parts: Blob[] = []
    let offset = 0, name = '', mediaType = '', total: number | undefined
    try {
      if (version !== undefined || this.nativeProfile?.host.capabilities.includes(CURRENT_FILES_CAPABILITY)) {
        const stat = parseCurrentFileStat(await this.call({ op: 'file.stat', sessionId, path }, signal))
        if (!stat.ok || (version !== undefined && version !== stat.value.version)) throw new ProtocolError('TRANSFER_CLOSED')
        version = stat.value.version; total = stat.value.bytes; path = stat.value.relativePath
        if (total > this.limits.fileBytes) throw new ProtocolError('LIMIT_EXCEEDED')
      }
      while (true) {
        signal.throwIfAborted(); if (generation !== this.generation) throw new ProtocolError('TRANSFER_CLOSED')
        const length = Math.min(MAX_READ_BYTES, (total ?? this.limits.fileBytes) - offset)
        if (length < 0 || (length === 0 && total === undefined)) throw new ProtocolError('LIMIT_EXCEEDED')
        const { blob, metadata } = await this.receiveFileRange({ sessionId, path, offset, length, ...(version ? { version } : {}) }, signal)
        if (offset && (metadata.name !== name || metadata.mediaType !== mediaType)) throw new ProtocolError('INVALID_MESSAGE')
        name = metadata.name; mediaType = metadata.mediaType; offset += metadata.bytes
        if (total !== undefined && (metadata.bytes !== length || metadata.eof !== (offset === total))) throw new ProtocolError('INVALID_MESSAGE')
        parts.push(blob)
        if (metadata.eof) {
          signal.throwIfAborted(); if (generation !== this.generation) throw new ProtocolError('TRANSFER_CLOSED')
          return { blob: new Blob(parts, { type: mediaType }), name, mediaType }
        }
      }
    } finally { parts.length = 0; this.activeDownloads-- }
  }
  private fail(error: ProtocolError): void {
    const code = error.code; this.disconnect(error)
    const phase = code === 'AUTH_REVOKED' ? 'revoked' : code === 'REMOTE_REPLACED' ? 'replaced' : code === 'REMOTE_BUSY' ? 'busy' : ['HOST_OFFLINE', 'RESYNC_REQUIRED', 'STALE_CONTROL'].includes(code) ? 'offline' : 'error'
    this.publish({ phase, fence: null, code })
    if (!this.disposed && (phase === 'offline' || (phase === 'busy' && this.hasResume() && ++this.busyProbes <= 6)) && this.options.reconnect !== false && this.instanceId) { const delay = this.retryDelay; this.retryDelay = Math.min(30000, delay * 2); this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.prepareSocket().catch(() => {}) }, delay) }
  }
  private disconnect(error: Error): void {
    this.resumeAttempt = undefined
    this.generation++; this.syncRevision++; const socket = this.socket; this.socket = undefined; if (socket && socket.bufferedAmount) this.retiring.add(socket); this.lifetime.abort(error); clearTimeout(this.syncTimer); clearInterval(this.heartbeat); clearTimeout(this.handshake); clearTimeout(this.reconnectTimer)
    this.heartbeat = undefined; this.handshake = undefined; this.reconnectTimer = undefined
    for (const [id, op] of this.operations) { this.clearFragments(op.fragments); clearTimeout(op.timer); op.cleanup?.(); op.finish(new ProtocolError(op.kind === 'call' || op.kind === 'upload' ? 'RESULT_UNCERTAIN' : (error instanceof ProtocolError ? error.code : 'HOST_OFFLINE'))); this.operations.delete(id) }
    for (const recent of this.recent.values()) clearTimeout(recent.timer); this.recent.clear()
    socket?.close(); this.readyWaiter?.reject(error); this.readyWaiter = undefined
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.disconnect(new ProtocolError('TRANSFER_CLOSED')); this.publish({ phase: 'offline', fence: null }); this.listeners.clear() }
}
