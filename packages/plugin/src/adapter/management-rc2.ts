import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_LIMITS, ProtocolError, validateManagementAction, type Command, type Json } from '../../../protocol/src/index.ts'
import { publicJson } from './dsh-v021.ts'
import type { SessionScope } from './scope.ts'
import { supportsWorkspaceManagement } from './ui-rc2.ts'

/** Invoke only the finite public native commands. Invocation is admission into the
 * native command's own queue; disconnect never rolls back or replays accepted work.
 */
export class DshManagementAdapter {
  constructor(private readonly ctx: Context, private readonly scope: SessionScope) {}
  async catalog(signal: AbortSignal, admission: () => void, jsonBytes = DEFAULT_LIMITS.jsonBytes): Promise<Json> {
    const check = () => { admission(); signal.throwIfAborted(); this.requireCapability() }
    check()
    const value = await this.ctx.sessionController.list({}, signal)
    check()
    return publicJson(value, jsonBytes)
  }
  async search(query: string, signal: AbortSignal, admission: () => void, jsonBytes = DEFAULT_LIMITS.jsonBytes): Promise<Json> {
    const check = () => { admission(); signal.throwIfAborted(); this.requireCapability() }
    check()
    const value = await this.ctx.sessionController.search({ query }, signal)
    check()
    return publicJson(value, jsonBytes)
  }
  async manage(command: Extract<Command, { op: 'ui.manage' }>, signal: AbortSignal, admission: () => void): Promise<Json> {
    const check = () => { admission(); signal.throwIfAborted(); this.requireCapability() }
    check()
    const action = validateManagementAction(command.action)
    if ('workspaceId' in action) this.scope.assertWorkspace(action.workspaceId)
    if ('beforeWorkspaceId' in action && action.beforeWorkspaceId !== undefined) this.scope.assertWorkspace(action.beforeWorkspaceId)
    if ('sessionId' in action) this.scope.assertSession(action.sessionId)
    const { kind, ...request } = action
    // kind has been independently validated; never accept a caller-selected RPC namespace.
    const [namespace, method] = kind.split('.')
    check()
    try {
      const value = await this.ctx.typertGateway.invoke({ namespace, method, args: { request } })
      check()
      return { ok: true, value: publicJson(value) }
    } catch (error) {
      check()
      if (error instanceof ProtocolError) throw error
      const failure = nativeFailure(error, action.kind, 'sessionId' in action ? action.sessionId : undefined)
      if (failure) return failure
      throw new ProtocolError('RESULT_UNCERTAIN')
    }
  }
  private requireCapability(): void { if (!supportsWorkspaceManagement(this.ctx)) throw new ProtocolError('PROTOCOL_UNSUPPORTED') }
}
function nativeFailure(error: unknown, kind: string, sessionId?: string): Json | undefined {
  if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return
  const code = error.code
  const message = 'message' in error && typeof error.message === 'string' && error.message.length <= 4096 ? error.message : code
  if (code === 'workspace/session-active' && kind === 'workspace.archiveSession' && 'details' in error) {
    const details = publicJson(error.details)
    if (!details || typeof details !== 'object' || Array.isArray(details) || details.sessionId !== sessionId || !Array.isArray(details.activity)) throw new ProtocolError('RESULT_UNCERTAIN')
    const activity = details.activity.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.kind !== 'string') throw new ProtocolError('RESULT_UNCERTAIN')
      const items = entry.items
      if (items !== undefined && (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || ('label' in item && typeof item.label !== 'string')))) throw new ProtocolError('RESULT_UNCERTAIN')
      return { kind: entry.kind, ...(items ? { items: (items as Record<string, Json>[]).map(item => ({ id: item.id, ...(item.label === undefined ? {} : { label: item.label }) })) } : {}) }
    })
    return { ok: false, error: { code, message, details: { sessionId: sessionId!, activity } } }
  }
  if (['session/title-invalid', 'session/fork-unavailable', 'session/not-found', 'session/writer-held', 'session/subagent-owned', 'workspace/not-found', 'workspace/name-conflict', 'workspace/move-invalid', 'gateway/bad-request'].includes(code)) return { ok: false, error: { code, message, details: {} } }
}
