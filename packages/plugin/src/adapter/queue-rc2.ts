import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionUpdateQueueRequest } from '@deepseek-ai/dsh-api-session-controller'
import { ProtocolError, validateJson, type Command, type Json } from '../../../protocol/src/index.ts'
import type { SessionScope } from './scope.ts'
export class DshQueueAdapter {
  constructor(private readonly ctx: Context, private readonly scope: SessionScope, private readonly currentStopToken: (id: string) => string | null) {}
  async update(command: Extract<Command, { op: 'session.queue' }>, signal: AbortSignal, admission: () => void): Promise<Json> {
    const check = () => { admission(); signal.throwIfAborted(); this.scope.assertSession(command.sessionId) }
    check()
    const sessionId = SessionId(command.sessionId)
    let agent = this.ctx.agents.get(sessionId)
    try {
      if (!agent) {
        const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
        check(); if ('error' in resolved) throw resolved.error
        agent = resolved.agent
      }
      check()
      if (this.ctx.agents.get(sessionId) !== agent) throw new ProtocolError('STALE_ACTION')
      if (![...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(item => item.id === command.itemId)) throw new ProtocolError('STALE_ACTION')
      if (command.action.kind === 'steer' && (!command.stopToken || this.currentStopToken(command.sessionId) !== command.stopToken)) throw new ProtocolError('STALE_ACTION')
      const request: SessionUpdateQueueRequest = { sessionId, itemId: brandString<SessionUpdateQueueRequest['itemId']>(command.itemId), action: command.action }
      // rc.2's live-Agent branch performs the mutation synchronously before returning its Promise.
      // Resolve cold Agents above, then recheck immediately before entering that public branch.
      check()
      const value = await this.ctx.sessionController.updateQueue(request)
      check(); return validateJson(value)
    } catch (error) {
      if (error instanceof ProtocolError || signal.aborted) throw error
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code === 'session/queue-item-not-found' || code === 'session/steer-unavailable') throw new ProtocolError('STALE_ACTION')
      if (code === 'session/writer-held') throw new ProtocolError('WRITER_HELD')
      if (code === 'session/subagent-owned') throw new ProtocolError('OUT_OF_SCOPE')
      throw new ProtocolError('RESULT_UNCERTAIN')
    }
  }
}
