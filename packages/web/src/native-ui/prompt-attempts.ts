import { DEFAULT_LIMITS, ProtocolError, checkJsonLength, type Command, type Json } from '../../../protocol/src/index.ts'
type Prompt = Extract<Command, { op: 'session.prompt' }>
type Call = (command: Command, signal?: AbortSignal) => Promise<Json>
interface Attempt { digest: string; command?: Prompt; state: 'pending' | 'uncertain' | 'accepted' | 'failed'; running?: Promise<Json>; error?: unknown; bytes: number }
export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
}
/** Scoped to one page instance. An original requestId is never regenerated here. */
export class NativePromptAttempts {
  private readonly attempts = new Map<string, Attempt>()
  private bytes = 0
  constructor(private readonly call: Call) {}
  async submit(command: Prompt, signal?: AbortSignal): Promise<Json> {
    const copy = structuredClone(command); delete copy.reconcileOnly
    const canonical = { op: copy.op, sessionId: copy.sessionId, requestId: copy.requestId, mode: copy.mode, content: copy.content, ...(copy.clientTimeZone === undefined ? {} : { clientTimeZone: copy.clientTimeZone }) }
    const json = JSON.stringify(canonical); checkJsonLength(json, DEFAULT_LIMITS.jsonBytes)
    const hash = await digest(canonical), key = JSON.stringify([copy.sessionId, copy.requestId])
    signal?.throwIfAborted()
    const old = this.attempts.get(key)
    if (old) {
      if (old.digest !== hash) throw new ProtocolError('INVALID_MESSAGE')
      if (old.running) return old.running
      if (old.state === 'accepted') return { accepted: true }
      if (old.state === 'failed') throw old.error
      return this.run(key, old, true, signal)
    }
    const bytes = new TextEncoder().encode(json).byteLength
    if ([...this.attempts.values()].filter(a => a.state === 'pending' || a.state === 'uncertain').length >= 128 || this.bytes + bytes > DEFAULT_LIMITS.bufferedBytes) throw new ProtocolError('BACKPRESSURE')
    const attempt: Attempt = { digest: hash, command: canonical, state: 'pending', bytes }; this.attempts.set(key, attempt); this.bytes += bytes
    return this.run(key, attempt, command.reconcileOnly === true, signal)
  }
  reconcile(sessionId: string, requestId: string, signal?: AbortSignal): Promise<Json> {
    const key = JSON.stringify([sessionId, requestId]), attempt = this.attempts.get(key)
    if (!attempt) return Promise.reject(new ProtocolError('RESULT_UNCERTAIN'))
    if (attempt.running) return attempt.running
    if (attempt.state === 'accepted') return Promise.resolve({ accepted: true })
    if (attempt.state !== 'uncertain') return Promise.reject(attempt.error)
    return this.run(key, attempt, true, signal)
  }
  isUncertain(sessionId: string, requestId: string): boolean { return this.attempts.get(JSON.stringify([sessionId, requestId]))?.state === 'uncertain' }
  private run(key: string, attempt: Attempt, reconcile: boolean, signal?: AbortSignal): Promise<Json> {
    attempt.state = 'pending'
    const run = Promise.resolve().then(async () => {
      try {
        const value = await this.call({ ...attempt.command!, ...(reconcile ? { reconcileOnly: true as const } : {}) }, signal)
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.accepted !== true) throw new ProtocolError('RESULT_UNCERTAIN')
        attempt.state = 'accepted'; return value
      } catch (error) {
        const uncertain = reconcile || (error instanceof ProtocolError && ['RESULT_UNCERTAIN', 'HOST_OFFLINE', 'STALE_CONTROL', 'REMOTE_REPLACED'].includes(error.code))
        attempt.state = uncertain ? 'uncertain' : 'failed'; attempt.error = error; throw error
      } finally {
        attempt.running = undefined
        if (attempt.state === 'accepted' || attempt.state === 'failed') {
          this.bytes -= attempt.bytes; attempt.bytes = 0; attempt.command = undefined
          this.attempts.delete(key); this.attempts.set(key, attempt)
          const terminal = [...this.attempts].filter(([, a]) => a.state === 'accepted' || a.state === 'failed')
          for (const [id] of terminal.slice(0, Math.max(0, terminal.length - 128))) this.attempts.delete(id)
        }
      }
    })
    attempt.running = run; return run
  }
}
