import type { ControlStatus } from '../lifecycle.ts'
export interface ManagementSnapshot { status: ControlStatus; link: string | null; busy: boolean; error?: string }
export type ManageInput = { action: 'configure' | 'replace-registration'; relayOrigin: string; enrollmentSecret?: string } | { action: 'resume' | 'start' | 'stop' | 'rotate' | 'status' | 'link' }
export class ManagementStore {
  private state: ManagementSnapshot = { status: { phase: 'disabled', instanceId: null, controllerPresent: false }, link: null, busy: false }
  private revision = 0
  private actionPending = false
  private poll?: { revision: number; promise: Promise<void> }
  private listeners = new Set<() => void>()
  constructor(private readonly call: (input: ManageInput) => Promise<{ status: ControlStatus; link: string | null }>) {}
  snapshot = (): ManagementSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private set(patch: Partial<ManagementSnapshot>): void {
    const next = { ...this.state, ...patch }, before = this.state.status, after = next.status
    if (before.phase === after.phase && before.instanceId === after.instanceId && before.controllerPresent === after.controllerPresent && before.code === after.code) next.status = before
    if (next.status === before && next.link === this.state.link && next.busy === this.state.busy && next.error === this.state.error) return
    this.state = next; for (const listener of this.listeners) listener()
  }
  refresh(): Promise<void> {
    // Reopening while a mutation is still in flight restores its pending feedback.
    if (this.actionPending) { this.set({ busy: true }); return Promise.resolve() }
    if (this.poll?.revision === this.revision) return this.poll.promise
    const poll = { revision: this.revision, promise: this.readStatus(this.revision) }; this.poll = poll
    void poll.promise.then(() => { if (this.poll === poll) this.poll = undefined })
    return poll.promise
  }
  private async readStatus(revision: number): Promise<void> {
    try { const result = await this.call({ action: 'status' }); if (revision === this.revision) this.set({ ...result, error: undefined }) }
    catch (error) { if (revision === this.revision) this.set({ error: error instanceof Error ? error.message : 'Operation incomplete', link: null }) }
  }
  async run(input: ManageInput): Promise<void> {
    if (this.actionPending) return
    // A mutation owns presentation over any earlier read, even after close/reopen.
    this.actionPending = true
    const revision = ++this.revision
    this.set({ busy: true, error: undefined, ...(input.action === 'rotate' || input.action === 'stop' ? { link: null } : {}) })
    try { const result = await this.call(input); if (revision === this.revision) this.set(result) }
    catch (error) { if (revision === this.revision) this.set({ error: error instanceof Error ? error.message : 'Operation incomplete', link: null }) }
    finally { this.actionPending = false; if (revision === this.revision || this.state.busy) this.set({ busy: false }) }
  }
  close(): void { this.revision++; this.set({ link: null, error: undefined, busy: false }) }
}
