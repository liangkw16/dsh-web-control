import { ProtocolError, type Command } from '../../protocol/src/index.ts'
import type { BrowserTransport } from './transport.ts'
import type { DraftRevision, DraftStore } from './drafts.ts'
type Prompt = Extract<Command, { op: 'session.prompt' }>
export type SubmissionInput = Omit<Prompt, 'op' | 'requestId' | 'reconcileOnly'>
type State = 'pending' | 'accepted' | 'uncertain' | 'failed'
interface Attempt { command?: Prompt; state: State; running?: Promise<void>; draft?: { store: DraftStore; revision: DraftRevision } }
export class SubmissionQueue {
  private readonly attempts = new Map<string, Attempt>()
  constructor(private readonly transport: Pick<BrowserTransport, 'call'>) {}
  async submit(input: SubmissionInput): Promise<string> { return this.submitDraft(input) }
  /** Optional UI integration captures the revision before the first network await. */
  async submitDraft(input: SubmissionInput, draft?: { store: DraftStore; instanceId: string }): Promise<string> {
    if ([...this.attempts.values()].filter(attempt => attempt.state === 'pending' || attempt.state === 'uncertain').length >= 128) throw new ProtocolError('BACKPRESSURE')
    const requestId = crypto.randomUUID()
    const { sessionId, mode, content, clientTimeZone } = structuredClone(input)
    const command: Prompt = { op: 'session.prompt', requestId, sessionId, mode, content, ...(clientTimeZone === undefined ? {} : { clientTimeZone }) }
    const attempt: Attempt = { command, state: 'pending', ...(draft ? { draft: { store: draft.store, revision: draft.store.capture(draft.instanceId, sessionId) } } : {}) }
    this.attempts.set(requestId, attempt); await this.run(attempt, false); return requestId
  }
  async retry(requestId: string): Promise<void> {
    const attempt = this.attempts.get(requestId); if (!attempt) throw new ProtocolError('INVALID_MESSAGE')
    if (attempt.running) return attempt.running
    if (attempt.state === 'accepted') return
    if (attempt.state !== 'uncertain') throw new ProtocolError('INVALID_MESSAGE', 'Only an uncertain outcome can be checked')
    return this.run(attempt, true)
  }
  state(requestId: string): State { const attempt = this.attempts.get(requestId); if (!attempt) throw new ProtocolError('INVALID_MESSAGE'); return attempt.state }
  private run(attempt: Attempt, reconcile: boolean): Promise<void> {
    if (!attempt.command) return Promise.reject(new ProtocolError('INVALID_MESSAGE'))
    const command = attempt.command
    attempt.state = 'pending'
    attempt.running = (async () => {
      try {
        const value = await this.transport.call({ ...structuredClone(command), ...(reconcile ? { reconcileOnly: true as const } : {}) })
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.accepted !== true) throw new ProtocolError('RESULT_UNCERTAIN')
        attempt.state = 'accepted'; if (attempt.draft) attempt.draft.store.clearAccepted(attempt.draft.revision)
      } catch (error) {
        const uncertain = error instanceof Error && (('code' in error && error.code === 'RESULT_UNCERTAIN') || error.message.includes('RESULT_UNCERTAIN'))
        attempt.state = reconcile || uncertain ? 'uncertain' : 'failed'
      } finally {
        attempt.running = undefined
        if (attempt.state === 'accepted' || attempt.state === 'failed') {
          attempt.command = undefined; attempt.draft = undefined
          this.attempts.delete(command.requestId); this.attempts.set(command.requestId, attempt)
          const terminal = [...this.attempts].filter(([, value]) => value.state === 'accepted' || value.state === 'failed')
          for (const [id] of terminal.slice(0, Math.max(0, terminal.length - 128))) this.attempts.delete(id)
        }
      }
    })()
    return attempt.running
  }
}
