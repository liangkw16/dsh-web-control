import { ProtocolError, type Fence } from '../../../protocol/src/index.ts'
import type { SyncBarrier, SyncGeneration } from '../transport.ts'
export interface GenerationTicket { readonly epoch: number; readonly selection: number; readonly opening: number; readonly sessionId?: string; readonly signal: AbortSignal; readonly fence: Fence }
/** Readiness belongs to an exact remote generation and the selected journal opening. */
export class NativeGeneration {
  private epoch = 0
  private selection = 0
  private opening = 0
  private selected: string | null = null
  private context?: SyncGeneration
  private life = new AbortController()
  private selectionLife = new AbortController()
  private barrier?: SyncBarrier
  private globals = new Set<string>()
  private cursor: number | null = null
  private stopToken: string | null | undefined
  private ready = false
  private disposed = false
  private readonly waiting = new Set<{ resolve(ticket: GenerationTicket): void; reject(error: unknown): void }>()
  constructor(private readonly holdSync: () => SyncBarrier, private readonly requirePreferences = false) {}
  begin(context: SyncGeneration): void {
    if (this.disposed) throw new ProtocolError('TRANSFER_CLOSED')
    this.life.abort(new ProtocolError('STALE_CONTROL')); this.life = new AbortController(); this.epoch++
    this.context = { ...context, fence: Object.freeze({ ...context.fence }), signal: AbortSignal.any([context.signal, this.life.signal]) }
    this.globals.clear(); this.cursor = null; this.stopToken = undefined; this.ready = false; this.barrier = context.barrier
    const current = this.capture(); for (const waiter of this.waiting) waiter.resolve(current); this.waiting.clear()
  }
  select(sessionId: string | null): void {
    if (sessionId === this.selected) return
    this.selectionLife.abort(new ProtocolError('STALE_ACTION'));this.selectionLife=new AbortController()
    this.selection++; this.selected = sessionId; this.cursor = null; this.stopToken = undefined; this.ready = false
    if (this.context && !this.context.signal.aborted) { this.barrier = this.holdSync(); this.complete() }
  }
  capture(sessionId?: string): GenerationTicket {
    if (this.disposed || !this.context || this.context.signal.aborted) throw new ProtocolError('HOST_OFFLINE')
    return Object.freeze({ epoch: this.epoch, selection: this.selection, opening:this.opening, ...(sessionId ? { sessionId } : {}), signal: this.context.signal, fence: this.context.fence })
  }
  follow(sessionId:string):GenerationTicket {
    const ticket=this.capture(sessionId)
    if(sessionId!==this.selected)return ticket
    if(this.ready)this.barrier=this.holdSync()
    this.opening++;this.cursor=null;this.stopToken=undefined;this.ready=false
    return this.capture(sessionId)
  }
  async wait(signal: AbortSignal): Promise<GenerationTicket> {
    signal.throwIfAborted()
    if (this.disposed) throw new ProtocolError('TRANSFER_CLOSED')
    if (this.context && !this.context.signal.aborted) return this.capture()
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiting.delete(waiter); reject(signal.reason) }
      const finish = () => signal.removeEventListener('abort', abort)
      const waiter = { resolve: (ticket: GenerationTicket) => { finish(); resolve(ticket) }, reject: (e: unknown) => { finish(); reject(e) } }
      this.waiting.add(waiter); signal.addEventListener('abort', abort, { once: true })
    })
  }
  current(ticket: GenerationTicket): boolean { return !this.disposed && ticket.epoch === this.epoch && !ticket.signal.aborted && (!ticket.sessionId || (ticket.selection === this.selection && ticket.opening===this.opening && ticket.sessionId === this.selected)) }
  baseline(ticket: GenerationTicket, topic: 'workspaces' | 'sessions' | 'interactions' | 'preferences'): void { if (this.current(ticket)) { this.globals.add(topic); this.complete() } }
  snapshot(ticket: GenerationTicket, cursor: number): void { if (ticket.sessionId && this.current(ticket)) { if(this.ready)this.barrier=this.holdSync();this.cursor = cursor; this.stopToken = undefined; this.ready = false; this.complete() } }
  stop(ticket: GenerationTicket, token: string | null): void { if (ticket.sessionId && this.current(ticket)) { this.stopToken = token; this.complete() } }
  failed(ticket: GenerationTicket, error: unknown): void { if (this.current(ticket)) { this.ready = false; this.barrier?.fail(error) } }
  assertWritable(sessionId?: string): void {
    if (!this.context || this.context.signal.aborted || this.disposed) throw new ProtocolError('HOST_OFFLINE')
    if (!this.ready || (sessionId !== undefined && sessionId !== this.selected)) throw new ProtocolError('SYNC_REQUIRED')
  }
  action(sessionId?: string): { fence: Fence; signal: AbortSignal; stopToken: string | null } { this.assertWritable(sessionId); return { fence: this.context!.fence, signal: AbortSignal.any([this.context!.signal,this.selectionLife.signal]), stopToken: this.stopToken ?? null } }
  /** Row actions may target a different session and can themselves change selection.
   * They remain bound to this control generation, not the selected chat lifetime.
   */
  managementAction(): { fence: Fence; signal: AbortSignal } { this.assertWritable(); return { fence: this.context!.fence, signal: this.context!.signal } }
  private complete(): void {
    if (!this.ready && this.globals.size === (this.requirePreferences ? 4 : 3) && (!this.selected || (this.cursor !== null && this.stopToken !== undefined))) { this.ready = true; this.barrier?.ready() }
  }
  dispose(): void { this.disposed = true; this.life.abort(new ProtocolError('TRANSFER_CLOSED')); for (const waiter of this.waiting) waiter.reject(new ProtocolError('TRANSFER_CLOSED')); this.waiting.clear(); this.context = undefined }
}
