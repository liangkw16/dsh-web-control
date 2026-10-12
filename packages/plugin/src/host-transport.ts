import { supportsCurrentFiles } from './current-files/provider.ts'
import { CURRENT_FILES_CAPABILITY } from '../../protocol/src/index.ts'
import { createRequire } from 'node:module'
import { supportsNativeUi } from './adapter/ui-rc2.ts'
import { RC2_UI_PROFILE, NATIVE_UI_MARKER, MANAGEMENT_CAPABILITY } from '../../protocol/src/ui-profile.ts'
import { supportsWorkspaceManagement } from './adapter/ui-rc2.ts'
import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_LIMITS, LARGE_JSON_CAPABILITY, ProtocolError, parseHandshake, parseController, parseHost, decodeChunk, type Fence, type HostMessage, type HandshakeMessage, type Limits } from '../../protocol/src/index.ts'
import type { Identity } from './identity.ts'
import type { SessionAdapter } from './adapter/types.ts'
import type { RelayConnection } from './lifecycle.ts'
import { HostFence } from './control-fence.ts'
import { HostOperations } from './host-operations.ts'
export const linkVerifier = (identity: Identity): string => createHash('sha256').update(identity.linkSecret).digest('hex')
export function wireFault(error: unknown): { code: string; message: string; retryable: boolean } {
  const code = error instanceof ProtocolError ? error.code : 'RESULT_UNCERTAIN'
  return { code, message: code, retryable: error instanceof ProtocolError && error.retryable }
}
/** A single account of retained buffers across sources, transfers, calls and socket sends. */
export class HostBudget {
  private owned = 0
  constructor(private limit = DEFAULT_LIMITS.bufferedBytes, private readonly buffered: () => number = () => 0) {}
  configure(limit: number): void { this.limit = limit; this.check() }
  get bytes(): number { return this.owned + this.buffered() }
  check(additional = 0): void { if (this.bytes + additional > this.limit) throw new ProtocolError('RESYNC_REQUIRED') }
  reserve = (bytes: number): (() => void) => this.claim(bytes, false)
  reserveControl = (bytes: number): (() => void) => this.claim(bytes, true)
  private claim(bytes: number, control: boolean): (() => void) {
    const ceiling = control ? this.limit : this.limit - Math.min(65536, Math.floor(this.limit / 8))
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.bytes + bytes > ceiling) throw new ProtocolError('RESYNC_REQUIRED')
    this.owned += bytes; let active = true
    return () => { if (active) { active = false; this.owned -= bytes } }
  }
}
interface PendingSend { data: string | Uint8Array; check(): void; release(): void; resolve(): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }
interface Acknowledgment { identity: Identity; resolve(): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }
/** Test routing is constructor-only and requires an explicit isolated test flag. Never a persisted setting. */
export interface RelayTestOptions { isolatedTest: true; origin: string }
export class HostRelayClient implements RelayConnection {
  onChange?: RelayConnection['onChange']
  private socket?: WebSocket
  private readonly sockets = new Set<WebSocket>()
  private identity?: Identity
  private fence?: HostFence
  private incoming?: Fence
  private operations?: HostOperations
  private limits: Limits = { ...DEFAULT_LIMITS }
  private configReady = false
  private ack?: Acknowledgment
  private queues: [PendingSend[], PendingSend[]] = [[], []]
  private sending?: PendingSend
  private heartbeat?: ReturnType<typeof setInterval>
  private lastPong = 0
  private closed = true
  private suspended = true
  private signalCleanup?: () => void
  readonly budget = new HostBudget(DEFAULT_LIMITS.bufferedBytes, () => [...this.sockets].reduce((bytes, socket) => bytes + socket.bufferedAmount, 0))
  constructor(private readonly ctx: Context, private readonly adapter: SessionAdapter, private readonly test?: RelayTestOptions) {
    if (test && (!test.isolatedTest || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(test.origin))) throw new ProtocolError('INVALID_RELAY_ORIGIN')
  }
  async enroll(identity: Identity, enrollmentSecret: string): Promise<void> {
    const response = await fetch(new URL('/v1/devices/register', this.test?.origin ?? identity.relayOrigin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentSecret, instanceId: identity.instanceId, deviceSecret: identity.deviceSecret, linkVerifier: linkVerifier(identity), authEpoch: identity.authEpoch }),
    }).catch(() => { throw new ProtocolError('HOST_OFFLINE') })
    if (!response.ok) throw new ProtocolError('REGISTRATION_FAILED')
    await response.body?.cancel()
  }
  connect(identity: Identity, runtimeId: string, signal: AbortSignal): Promise<void> {
    this.close(); this.closed = false; this.suspended = false; this.identity = { ...identity }; this.configReady = false
    if (this.fence) this.fence.rebind(identity.instanceId, runtimeId)
    if (!this.fence) {
      this.fence = new HostFence(identity.instanceId, runtimeId, () => this.identity!)
      this.operations = new HostOperations(this.ctx, this.adapter, this.fence, this.budget.reserve,
        (message, check, priority) => this.send(message, check, priority), error => this.fail(error), (bytes, check) => this.sendBinary(bytes, check))
    }
    const url = new URL('/v1/host', this.test?.origin ?? identity.relayOrigin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${identity.deviceSecret}`, 'X-DSH-Instance': identity.instanceId },
      perMessageDeflate: false, maxPayload: Math.max(DEFAULT_LIMITS.jsonBytes, DEFAULT_LIMITS.chunkBytes + 44), followRedirects: false, handshakeTimeout: 5000 })
    this.socket = socket; this.sockets.add(socket)
    const completion = Promise.withResolvers<void>()
    const handshakeTimer = setTimeout(() => { const error = new ProtocolError('HOST_OFFLINE'); completion.reject(error); if (this.socket === socket) this.fail(error) }, 5000)
    void completion.promise.then(() => clearTimeout(handshakeTimer), () => clearTimeout(handshakeTimer))
    const ack = this.waitAck(identity, () => { if (this.configReady) completion.resolve() })
    void ack.catch(completion.reject)
    const abort = () => this.close(); signal.addEventListener('abort', abort, { once: true }); this.signalCleanup = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) { this.close(); completion.reject(new ProtocolError('HOST_OFFLINE')); return completion.promise }
    socket.on('open', () => {
      void this.send({ v: 1, type: 'host.hello', instanceId: identity.instanceId, runtimeId, versions: [1], capabilities: this.capabilities(), authEpoch: identity.authEpoch, linkVerifier: linkVerifier(identity), enabled: identity.enabled, limits: DEFAULT_LIMITS }, () => this.assertSocket(socket)).catch(error => { if (this.socket === socket) this.fail(error) })
    })
    socket.on('unexpected-response', (_request, response) => {
      response.resume(); if (this.socket !== socket) return; const error = new ProtocolError(response.statusCode === 401 ? 'AUTH_FAILED' : response.statusCode === 403 ? 'AUTH_REVOKED' : 'HOST_OFFLINE')
      completion.reject(error); this.fail(error)
    })
    socket.on('message', (data, binary) => {
      if (this.socket !== socket || this.closed) return
      try {
        if (binary) {
          if (!this.configReady || !this.incoming) throw new ProtocolError('STALE_CONTROL')
          this.fence!.check(this.incoming); const chunk = decodeChunk(new Uint8Array(data as Buffer), this.limits)
          if (chunk.controlId !== this.incoming.controlId) throw new ProtocolError('STALE_CONTROL')
          this.operations!.chunk(chunk.id, chunk.index, chunk.data); return
        }
        const text = data.toString()
        let message: HandshakeMessage
        try { message = parseHandshake(text, this.limits) }
        catch {
          if (!this.configReady) throw new ProtocolError('INVALID_MESSAGE')
          this.operations!.receive(parseController(text, this.limits)); return
        }
        if (message.type === 'fault') throw new ProtocolError(message.error.code, message.error.code, message.error.retryable)
        if (message.type === 'relay.ack') {
          if (!this.ack || message.version !== 1 || message.authEpoch !== this.ack.identity.authEpoch || message.linkVerifier !== linkVerifier(this.ack.identity) || message.enabled !== this.ack.identity.enabled) throw new ProtocolError('AUTH_EPOCH_CONFLICT')
          const pending = this.ack; this.ack = undefined; clearTimeout(pending.timer); pending.resolve(); return
        }
        if (message.type === 'relay.config') {
          if (this.ack || this.configReady) throw new ProtocolError('INVALID_MESSAGE')
          this.limits = message.limits; this.budget.configure(message.limits.bufferedBytes); this.operations!.configure(message.limits)
          this.configReady = true; this.lastPong = Date.now()
          this.heartbeat = setInterval(() => { if (Date.now() - this.lastPong > message.leaseTtlMs) this.fail(new ProtocolError('HOST_OFFLINE')); else if (socket.readyState === WebSocket.OPEN) socket.ping() }, message.heartbeatMs)
          completion.resolve(); return
        }
        if (!this.configReady) throw new ProtocolError('INVALID_MESSAGE')
        if (message.type === 'attach') {
          if (this.suspended) throw new ProtocolError('STALE_CONTROL')
          this.invalidate(); this.suspended = false; this.fence!.install(message.fence); this.incoming = { ...message.fence }; this.operations!.attach(message.fence)
          const copied = { ...message.fence }
          void this.send({ v: 1, type: 'host.attached', id: message.id, fence: copied }, () => this.fence!.check(copied)).then(() => { try { this.fence!.check(copied); this.onChange?.({ controllerPresent: true }) } catch {} }, error => { if (this.socket === socket && this.incoming?.controlId === copied.controlId) this.fail(error) }); return
        }
        if (message.type === 'detach') { if (this.incoming && sameFence(this.incoming, message.fence)) { this.invalidate(); this.suspended = false } return }
        throw new ProtocolError('INVALID_MESSAGE')
      } catch (error) { completion.reject(error); this.fail(error) }
    })
    socket.on('pong', () => { this.lastPong = Date.now() })
    socket.on('error', () => { const error = new ProtocolError('HOST_OFFLINE'); completion.reject(error); if (this.socket === socket) this.fail(error) })
    socket.on('close', () => { this.sockets.delete(socket); completion.reject(new ProtocolError('HOST_OFFLINE')); if (this.socket === socket && !this.closed) this.fail(new ProtocolError('HOST_OFFLINE')) })
    return completion.promise
  }
  private capabilities(): string[] {
    let version: string | undefined
    try { version = createRequire(import.meta.url)('@deepseek-ai/dsh/package.json').version } catch {}
    return version && supportsNativeUi(this.ctx, version) ? [...RC2_UI_PROFILE.capabilities, NATIVE_UI_MARKER, LARGE_JSON_CAPABILITY, ...(supportsCurrentFiles(this.ctx) ? [CURRENT_FILES_CAPABILITY] : []), ...(supportsWorkspaceManagement(this.ctx) ? [MANAGEMENT_CAPABILITY] : [])] : ['session', 'interactions', 'uploads', 'recorded-diff']
  }
  async sync(identity: Identity): Promise<void> {
    this.invalidate(); this.identity = { ...identity }; this.suspended = false
    if (!this.socket || !this.configReady || this.closed) throw new ProtocolError('HOST_OFFLINE')
    const socket = this.socket; const acknowledged = this.waitAck(identity)
    try { await this.send({ v: 1, type: 'host.auth', authEpoch: identity.authEpoch, linkVerifier: linkVerifier(identity), enabled: identity.enabled }, () => this.assertSocket(socket)); await acknowledged }
    catch (error) { void acknowledged.catch(() => {}); if (this.socket === socket) this.fail(error); throw error }
  }
  invalidate(): void { this.suspended = true; this.incoming = undefined; this.fence?.invalidate(); this.operations?.detach(); this.onChange?.({ controllerPresent: false }) }
  close(): void {
    this.closed = true; this.invalidate(); this.configReady = false
    this.signalCleanup?.(); this.signalCleanup = undefined
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined
    if (this.ack) { clearTimeout(this.ack.timer); this.ack.reject(new ProtocolError('HOST_OFFLINE')); this.ack = undefined }
    for (const queue of this.queues) for (const item of queue.splice(0)) this.settle(item, new ProtocolError('HOST_OFFLINE'))
    if (this.sending) { this.settle(this.sending, new ProtocolError('HOST_OFFLINE')); this.sending = undefined }
    const socket = this.socket; this.socket = undefined; socket?.terminate()
  }
  async dispose(): Promise<void> {
    // Register exact owned close completions before immediate authority revocation.
    const closed = [...this.sockets].map(socket => socket.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise<void>(resolve => socket.once('close', resolve)))
    this.close()
    await Promise.all([this.operations?.dispose(), ...closed])
  }
  private waitAck(identity: Identity, resolved?: () => void): Promise<void> {
    if (this.ack) throw new ProtocolError('INVALID_MESSAGE')
    const value = Promise.withResolvers<void>()
    this.ack = { identity: { ...identity }, resolve: () => { resolved?.(); value.resolve() }, reject: value.reject,
      timer: setTimeout(() => this.fail(new ProtocolError('HOST_OFFLINE')), 5000) }
    return value.promise
  }
  private assertSocket(socket: WebSocket): void { if (this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.closed) throw new ProtocolError('HOST_OFFLINE') }
  private fail(error: unknown): void {
    if (this.closed) return
    this.close(); this.onChange?.({ connected: false, error: error instanceof ProtocolError ? error : new ProtocolError('HOST_OFFLINE') })
  }
  private send(message: HandshakeMessage | HostMessage, check: () => void, priority: 'control' | 'data' = 'control'): Promise<void> {
    try {
      check(); const data = JSON.stringify(message)
      if ('fence' in message && ['json.fragment', 'event', 'result', 'end', 'upload.credit', 'download.end'].includes(message.type)) parseHost(data, this.limits)
      else parseHandshake(data, this.limits)
      return this.enqueue(data, check, priority)
    } catch (error) { return Promise.reject(error) }
  }
  private sendBinary(data: Uint8Array, check: () => void): Promise<void> {
    try { check(); decodeChunk(data, this.limits); return this.enqueue(data, check, 'data') }
    catch (error) { return Promise.reject(error) }
  }
  private enqueue(data: string | Uint8Array, check: () => void, priority: 'control' | 'data'): Promise<void> {
    try {
      const release = (priority === 'control' ? this.budget.reserveControl : this.budget.reserve)(Buffer.byteLength(data) + 128)
      const done = Promise.withResolvers<void>()
      const item: PendingSend = { data, check, release, ...done, timer: setTimeout(() => this.fail(new ProtocolError('RESYNC_REQUIRED')), this.limits.callTimeoutMs) }
      this.queues[priority === 'control' ? 0 : 1].push(item); this.drain(); return done.promise
    } catch (error) { return Promise.reject(error) }
  }
  private settle(item: PendingSend, error?: unknown): void { clearTimeout(item.timer); item.release(); if (error) item.reject(error); else item.resolve() }
  private drain(): void {
    if (this.sending) return
    const item = this.queues[0].shift() ?? this.queues[1].shift(); if (!item) return
    const socket = this.socket
    try {
      if (!socket) throw new ProtocolError('HOST_OFFLINE')
      this.assertSocket(socket); item.check();
      // The queued string remains retained until callback; allow the socket copy
      // plus the largest masked WebSocket frame header before submitting it.
      this.budget.check(Buffer.byteLength(item.data) + 14); this.sending = item
      socket.send(item.data, error => {
        if (this.sending !== item) return
        this.sending = undefined; this.settle(item, error ? new ProtocolError('HOST_OFFLINE') : undefined)
        if (error) this.fail(error); else setImmediate(() => this.drain())
      })
    } catch (error) { this.settle(item, error); setImmediate(() => this.drain()) }
  }
}
function sameFence(a: Fence, b: Fence): boolean { return a.instanceId === b.instanceId && a.runtimeId === b.runtimeId && a.authEpoch === b.authEpoch && a.controlId === b.controlId }
