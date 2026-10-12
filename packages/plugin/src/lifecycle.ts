import { randomUUID } from 'node:crypto'
import { ProtocolError } from '../../protocol/src/index.ts'
import { IdentityManager, type Identity } from './identity.ts'
import type { SessionAdapter } from './adapter/types.ts'

export interface ControlStatus { phase: 'disabled' | 'connecting' | 'syncing' | 'ready' | 'offline' | 'error'; instanceId: string | null; controllerPresent: boolean; code?: string }
export interface RelayConnection {
  connect(identity: Identity, runtimeId: string, signal: AbortSignal): Promise<void>
  sync(identity: Identity): Promise<void>
  close(): void
  invalidate?(): void
  dispose?(): void | Promise<void>
  onChange?: (event: { connected?: boolean; controllerPresent?: boolean; error?: ProtocolError }) => void
}
/** Owns plugin transport lifetime, never accepted Agent work. */
export class ControlLifecycle {
  private readonly runtimeId = randomUUID()
  private lifetime = new AbortController()
  private current?: Identity
  private state: ControlStatus = { phase: 'disabled', instanceId: null, controllerPresent: false }
  private acknowledged = 0
  private disposed = false
  private starting?: Promise<void>
  private rotating?: Promise<void>
  private stopping?: Promise<void>
  private retry?: ReturnType<typeof setTimeout>
  private attempts = 0
  private revision = 0
  private transitions: Promise<void> = Promise.resolve()
  constructor(private readonly identity: IdentityManager, private readonly relay: RelayConnection, _adapter: SessionAdapter) {
    relay.onChange = event => {
      if (this.disposed) return
      if (event.controllerPresent !== undefined) this.state = { ...this.state, controllerPresent: event.controllerPresent }
      if (event.connected === false && this.current?.enabled && !this.lifetime.signal.aborted) {
        this.acknowledged = 0; this.state = { ...this.state, phase: 'offline', controllerPresent: false, code: event.error?.code ?? 'HOST_OFFLINE' }
        this.schedule(event.error)
      }
    }
  }
  status(): ControlStatus { return { ...this.state } }
  link(): string | null {
    if (this.state.phase !== 'ready' || !this.current?.enabled || this.acknowledged !== this.current.authEpoch) return null
    const url = new URL(`/connect/${this.current.instanceId}`, this.current.relayOrigin)
    url.hash = new URLSearchParams({ key: this.current.linkSecret }).toString(); return url.href
  }
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new ProtocolError('TRANSFER_CLOSED'))
    return this.starting ??= this.open().finally(() => { this.starting = undefined })
  }
  private async open(): Promise<void> {
    this.clearRetry()
    const revision = this.revision
    this.acknowledged = 0; this.relay.invalidate?.()
    let identity: Identity | undefined
    try { identity = await this.identity.load() }
    catch (error) {
      if (!this.disposed && revision === this.revision) { this.relay.close(); this.state = { ...this.state, phase: 'error', controllerPresent: false, code: failureCode(error) } }
      throw error
    }
    if (this.disposed || revision !== this.revision) return
    this.current = identity
    if (!identity?.enabled) { this.lifetime.abort(); this.relay.close(); this.state = { phase: 'disabled', instanceId: identity?.instanceId ?? null, controllerPresent: false }; return }
    this.lifetime.abort(); const lifetime = this.lifetime = new AbortController()
    const owns = () => !this.disposed && revision === this.revision && this.current === identity && this.lifetime === lifetime && !lifetime.signal.aborted
    this.state = { phase: 'connecting', instanceId: identity.instanceId, controllerPresent: false }
    try {
      await this.relay.connect(identity, this.runtimeId, lifetime.signal)
      if (!owns()) return
      this.acknowledged = identity.authEpoch; this.attempts = 0; this.state = { ...this.state, phase: 'ready', code: undefined }
    } catch (error) {
      if (owns()) {
        this.state = { ...this.state, phase: 'offline', code: failureCode(error) }; this.schedule(error)
      }
      throw error
    }
  }
  async configure(origin: string | undefined, enrollmentSecret: string | undefined, enroll: (identity: Identity, secret: string) => Promise<void>): Promise<void> {
    if (this.disposed) throw new ProtocolError('TRANSFER_CLOSED')
    const revision = ++this.revision
    this.clearRetry(); this.relay.invalidate?.(); this.acknowledged = 0
    const check = () => { if (this.disposed || this.revision !== revision) throw new ProtocolError('TRANSFER_CLOSED') }
    const persisted = this.transitions.catch(() => {}).then(async () => {
      check()
      const target = origin ?? (await this.identity.load())?.relayOrigin
      check(); if (!target) throw new ProtocolError('IDENTITY_MISSING')
      const next = await this.identity.enable(target); check(); this.current = next; return next
    })
    this.transitions = persisted.then(() => {}, () => {})
    const next = await persisted; check()
    if (this.starting) await this.starting.catch(() => {})
    check()
    try { await this.start() }
    catch (error) {
      check()
      if (!(error instanceof ProtocolError) || error.code !== 'AUTH_FAILED' || !enrollmentSecret) throw error
      await enroll(next, enrollmentSecret); check(); await this.start()
    }
  }
  /** Local commits share the stop queue; network work never holds that queue. */
  async replaceRegistration(origin: string, enrollmentSecret: string, enroll: (identity: Identity, secret: string) => Promise<void>): Promise<void> {
    if (!enrollmentSecret || this.disposed) throw new ProtocolError('INVALID_MESSAGE')
    const revision = ++this.revision
    this.clearRetry(); this.relay.invalidate?.(); this.acknowledged = 0
    this.state = { ...this.state, phase: 'syncing', controllerPresent: false }
    const current = () => !this.disposed && this.revision === revision
    const check = () => { if (!current()) throw new ProtocolError('TRANSFER_CLOSED') }
    const stopped = this.transitions.catch(() => {}).then(async () => {
      check()
      const saved = await this.identity.load(); check()
      const next = saved ? await this.identity.stop() : undefined
      check(); this.current = next
      return next
    })
    this.transitions = stopped.then(() => {}, () => {})
    try {
      const old = await stopped; check()
      if (old) { try { await this.relay.sync(old) } catch { /* Local stop is durable; old relay may be unreachable/revoked. */ } }
      check(); this.lifetime.abort(); this.relay.close()
      const persisted = this.transitions.catch(() => {}).then(async () => {
        check(); const next = await this.identity.replace(origin); check(); this.current = next; return next
      })
      this.transitions = persisted.then(() => {}, () => {})
      const next = await persisted; check()
      this.state = { phase: 'offline', instanceId: next.instanceId, controllerPresent: false }
      // A crash/lost ACK is resumed by Configure, which authenticates this saved identity first.
      await enroll(next, enrollmentSecret); check()
      if (this.starting) await this.starting.catch(() => {})
      check(); await this.start()
    } catch (error) {
      if (current()) { this.lifetime.abort(); this.relay.close(); this.state = { ...this.state, phase: 'error', controllerPresent: false, code: failureCode(error) } }
      throw error
    }
  }
  rotate(): Promise<void> {
    return this.rotating ??= this.enqueueChange('rotate').finally(() => { this.rotating = undefined })
  }
  stop(): Promise<void> {
    return this.stopping ??= this.enqueueChange('stop').finally(() => { this.stopping = undefined })
  }
  private enqueueChange(action: 'rotate' | 'stop'): Promise<void> {
    this.revision++; this.clearRetry(); this.relay.invalidate?.(); this.acknowledged = 0
    this.state = { ...this.state, phase: 'syncing', controllerPresent: false }
    // Serialize local commits only. A network ACK must never hold the durable stop lock.
    const persisted = this.transitions.catch(() => {}).then(async () => {
      if (this.disposed) throw new ProtocolError('TRANSFER_CLOSED')
      let next: Identity
      try { next = await this.identity[action]() }
      catch (error) { this.state = { ...this.state, phase: 'error', code: failureCode(error) }; throw error }
      this.revision++; this.current = next; this.relay.invalidate?.(); this.acknowledged = 0
      return next
    })
    this.transitions = persisted.then(() => {}, () => {})
    return persisted.then(next => this.synchronize(action, next))
  }
  private async synchronize(action: 'rotate' | 'stop', next: Identity): Promise<void> {
    if (this.disposed || this.current !== next) return
    try {
      await this.relay.sync(next)
      if (!this.disposed && this.current === next) { this.acknowledged = next.authEpoch; this.state = { ...this.state, phase: next.enabled ? 'ready' : 'disabled', code: undefined } }
    } catch (error) {
      if (action === 'rotate') {
        if (!this.disposed && this.current === next) { this.state = { ...this.state, phase: 'syncing', code: failureCode(error) }; this.schedule(error) }
        throw error
      }
    } finally {
      if (action === 'stop' && !this.disposed && this.current === next) {
        this.lifetime.abort(); this.relay.close(); this.state = { phase: 'disabled', instanceId: next.instanceId, controllerPresent: false }
      }
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.revision++; this.clearRetry(); this.lifetime.abort(); this.relay.invalidate?.(); this.relay.close(); await this.relay.dispose?.()
    this.acknowledged = 0; this.state = { ...this.state, phase: 'offline', controllerPresent: false }
  }
  private clearRetry(): void { if (this.retry) clearTimeout(this.retry); this.retry = undefined }
  private schedule(error: unknown): void {
    if (this.disposed || !this.current?.enabled || this.retry) return
    const code = failureCode(error)
    if (/^AUTH_|^IDENTITY_|^PROTOCOL_|^INVALID_/.test(code) || (code === 'HOST_ID_IN_USE' && this.attempts >= 3)) { this.state = { ...this.state, phase: 'error', code }; return }
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempts++, 6)) * (0.8 + Math.random() * 0.4)
    this.retry = setTimeout(() => { this.retry = undefined; void this.start().catch(() => {}) }, Math.min(30_000, delay))
  }
}
export function failureCode(error: unknown): string { return error instanceof ProtocolError ? error.code : 'HOST_OFFLINE' }
export { HostRelayClient } from './host-transport.ts'
