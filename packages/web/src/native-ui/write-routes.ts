import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { ProtocolError, validateId, type Command, type ContentPart, type Fence, type Json } from '../../../protocol/src/index.ts'
import { argsOf, fields, object, rpcFailure, text } from './read-routes.ts'
import { NativePromptAttempts, digest } from './prompt-attempts.ts'
export interface ActionContext { fence: Fence; signal: AbortSignal; stopToken: string | null }
interface Options {
  call(command: Command, signal?: AbortSignal): Promise<Json>
  action(sessionId?: string): ActionContext
  content(sessionId: string, content: Json[], signal: AbortSignal): Promise<ContentPart[]>
  accepted?(content: ContentPart[]): void
  submission?(sessionId: string, requestId: string): (accepted: boolean, terminal?: boolean) => void
}
export const WRITE_ENDPOINTS = new Set(['session/prompt', 'session/create', 'session/cancel', 'session/updateQueue'])
/** A native user gesture captures authority synchronously before file preparation or hashing. */
export class NativeWriteRoutes {
  private readonly attempts: NativePromptAttempts
  private readonly lifetime = new AbortController()
  private readonly prepared = new Map<string, { digest: string; value?: Promise<ContentPart[]>; terminal?: { value?: Json; error?: unknown } }>()
  constructor(private readonly options: Options) { this.attempts = new NativePromptAttempts(options.call) }
  call(channel: string, endpoint: string, payload: unknown, caller: AbortSignal): Promise<ConnectionRpcResult<unknown>> {
    try {
      if (!WRITE_ENDPOINTS.has(endpoint)) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      const args = argsOf(channel, payload, endpoint === 'session/prompt' ? 48 * 1024 * 1024 : undefined); fields(args, ['request'])
      const request = object(args.request), sessionId = endpoint === 'session/create' && request.sessionId === undefined ? 'session-' + crypto.randomUUID() : text(request.sessionId)
      const action = this.options.action(endpoint === 'session/create' ? undefined : sessionId)
      const signal = AbortSignal.any([caller, action.signal, this.lifetime.signal]); signal.throwIfAborted()
      if (endpoint === 'session/cancel') {
        fields(request, ['sessionId']); if (!action.stopToken) throw new ProtocolError('STALE_ACTION')
        return this.result(this.options.call({ op: 'session.stop', sessionId, stopToken: action.stopToken }, signal))
      }
      if (endpoint === 'session/updateQueue') {
        fields(request, ['sessionId', 'itemId', 'action']); const queueAction = object(request.action)
        if (queueAction.kind === 'edit') {
          fields(queueAction, ['kind', 'content']); if (!Array.isArray(queueAction.content) || !queueAction.content.length) throw new ProtocolError('INVALID_MESSAGE')
          for (const item of queueAction.content) { const part = object(item); fields(part, ['type', 'text']); if (part.type !== 'text' || typeof part.text !== 'string') throw new ProtocolError('INVALID_MESSAGE') }
        } else { fields(queueAction, ['kind']); if (queueAction.kind !== 'remove' && queueAction.kind !== 'steer') throw new ProtocolError('INVALID_MESSAGE') }
        if (queueAction.kind === 'steer' && !action.stopToken) throw new ProtocolError('STALE_ACTION')
        return this.result(this.options.call({ op: 'session.queue', sessionId, itemId: text(request.itemId), action: queueAction as Extract<Command, {op:'session.queue'}>['action'], ...(queueAction.kind === 'steer' ? { stopToken: action.stopToken! } : {}) }, signal))
      }
      if (endpoint === 'session/create') {
        fields(request, ['workspaceId'], ['sessionId'])
        return this.result(this.options.call({ op: 'session.create', sessionId, workspaceId: text(request.workspaceId) }, signal))
      }
      fields(request, ['sessionId', 'requestId', 'mode', 'content'], ['clientTimeZone']); validateId(request.requestId)
      if ((request.mode !== 'queue' && request.mode !== 'steer') || !Array.isArray(request.content) || !request.content.length || request.content.length > 1024) throw new ProtocolError('INVALID_MESSAGE')
      const mode = request.mode, requestId = request.requestId, content = request.content, clientTimeZone = request.clientTimeZone === undefined ? undefined : text(request.clientTimeZone)
      const settled = this.options.submission?.(sessionId, requestId)
      return this.result((async () => {
        const hash = await digest({ sessionId, requestId, mode, content, clientTimeZone }), key = JSON.stringify([sessionId, requestId]); signal.throwIfAborted()
        let prepared = this.prepared.get(key)
        if (prepared && prepared.digest !== hash) throw new ProtocolError('INVALID_MESSAGE')
        if (!prepared) {
          if ([...this.prepared.values()].filter(p => !p.terminal).length >= 128) throw new ProtocolError('BACKPRESSURE')
          prepared = { digest: hash, value: this.options.content(sessionId, content, signal) }; this.prepared.set(key, prepared); void prepared.value!.catch(() => {})
        }
        if (prepared.terminal) { if ('error' in prepared.terminal) throw prepared.terminal.error; return prepared.terminal.value! }
        try {
          const converted = await prepared.value!; signal.throwIfAborted()
          const value = await this.attempts.submit({ op: 'session.prompt', sessionId, requestId, mode, content: converted, ...(clientTimeZone === undefined ? {} : { clientTimeZone }) }, signal)
          this.options.accepted?.(converted); prepared.terminal = { value }; return value
        } catch (error) {
          if (!this.attempts.isUncertain(sessionId, requestId)) prepared.terminal = { error }
          throw error
        } finally {
          if (prepared.terminal) {
            prepared.value = undefined; this.prepared.delete(key); this.prepared.set(key, prepared)
            const terminal = [...this.prepared].filter(([, item]) => item.terminal)
            for (const [id] of terminal.slice(0, Math.max(0, terminal.length - 128))) this.prepared.delete(id)
          }
        }
      })().then(value => { settled?.(true); return value }, error => { settled?.(false, !this.attempts.isUncertain(sessionId, requestId)); throw error }))
    } catch (error) { return Promise.resolve(rpcFailure(error)) }
  }
  private async result(promise: Promise<Json>): Promise<ConnectionRpcResult<unknown>> { try { return { ok: true, value: await promise } } catch (error) { return rpcFailure(error) } }
  dispose(): void { this.lifetime.abort(); this.prepared.clear() }
}
