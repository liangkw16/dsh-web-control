import { parseUiReadResult, ProtocolError } from '../../../protocol/src/index.ts'
import type { BrowserTransport } from '../transport.ts'

type Preference = { ns: 'ui-conversation'; revision: number; busyEnter: 'queue' | 'steer' }
export interface PreferenceStore {
  readonly value: Preference | undefined
  subscribe(listener: () => void): () => void
}

/** Refresh the existing finite read view; no generic settings events or new Host permissions.
 * A single request at a time, once a second while ready. Browser background timer
 * throttling applies. Generation changes abort reads and discard late responses.
 */
export class NativePreferences implements PreferenceStore {
  value: Preference | undefined
  private readonly listeners = new Set<() => void>()
  private owner?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private release?: () => void
  private disposed = false
  constructor(private readonly transport: Pick<BrowserTransport, 'call' | 'getSnapshot'>, private readonly fail: (error: unknown) => void) {}
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: Preference | undefined): void {
    if (this.value?.revision === value?.revision && this.value?.busyEnter === value?.busyEnter) return
    this.value = value
    for (const listener of this.listeners) listener()
  }
  async begin(generation: AbortSignal): Promise<void> {
    if (this.disposed) throw new ProtocolError('TRANSFER_CLOSED')
    this.stop(); this.publish(undefined)
    const owner = new AbortController(), signal = AbortSignal.any([generation, owner.signal])
    this.owner = owner
    const stop = () => { if (this.owner === owner) this.stop() }
    signal.addEventListener('abort', stop, { once: true })
    this.release = () => signal.removeEventListener('abort', stop)
    const read = async () => {
      signal.throwIfAborted()
      const value = parseUiReadResult('conversation-settings', await this.transport.call({ op: 'ui.read', view: 'conversation-settings' }, signal)) as Preference
      signal.throwIfAborted()
      if (this.owner !== owner) throw new ProtocolError('STALE_CONTROL')
      if (this.value && (value.revision < this.value.revision || (value.revision === this.value.revision && value.busyEnter !== this.value.busyEnter))) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      this.publish(value)
    }
    const schedule = () => {
      if (signal.aborted || this.owner !== owner) return
      this.timer = setTimeout(() => {
        this.timer = undefined
        if (this.transport.getSnapshot().phase !== 'ready') { schedule(); return }
        void read().then(schedule, error => {
          if (signal.aborted || this.owner !== owner) return
          this.stop()
          this.fail(error)
        })
      }, 1000)
    }
    try { await read(); schedule() }
    catch (error) { if (this.owner === owner) this.stop(); throw error }
  }
  private stop(): void {
    this.release?.(); this.release = undefined
    clearTimeout(this.timer); this.timer = undefined
    const owner = this.owner; this.owner = undefined; owner?.abort()
  }
  dispose(): void { this.disposed = true; this.stop(); this.listeners.clear() }
}
