export interface DraftRevision { readonly instanceId: string; readonly sessionId: string; readonly revision: number; readonly text: string }
/** Storage failure must never disable editing. Warning is consumed by the UI layer. */
export class DraftStore {
  private readonly memory = new Map<string, { text: string; revision: number }>()
  persistenceWarning = false
  private readonly warningListeners = new Set<()=>void>()
  subscribeWarning = (listener:()=>void):(()=>void) => { this.warningListeners.add(listener); return()=>{this.warningListeners.delete(listener)} }
  private warn():void { if(this.persistenceWarning)return; this.persistenceWarning=true; for(const listener of this.warningListeners)listener() }
  constructor(private readonly storage: Storage) {}
  private key(instanceId: string, sessionId: string): string { return `dsh:draft:${JSON.stringify([instanceId, sessionId])}` }
  read(instanceId: string, sessionId: string): string {
    const key = this.key(instanceId, sessionId); const cached = this.memory.get(key); if (cached) return cached.text
    let text = ''; try { text = this.storage.getItem(key) ?? '' } catch { this.warn() }
    this.memory.set(key, { text, revision: 0 }); return text
  }
  write(instanceId: string, sessionId: string, text: string): void {
    this.read(instanceId, sessionId); const key = this.key(instanceId, sessionId)
    this.memory.set(key, { text, revision: this.memory.get(key)!.revision + 1 })
    try { this.storage.setItem(key, text) } catch { this.warn() }
  }
  capture(instanceId: string, sessionId: string): DraftRevision { const text = this.read(instanceId, sessionId); return Object.freeze({ instanceId, sessionId, text, revision: this.memory.get(this.key(instanceId, sessionId))!.revision }) }
  clearAccepted(submitted: DraftRevision): void {
    const current = this.capture(submitted.instanceId, submitted.sessionId)
    if (current.revision === submitted.revision && current.text === submitted.text) this.write(submitted.instanceId, submitted.sessionId, '')
  }
}
