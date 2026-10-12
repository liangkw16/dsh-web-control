import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-settings'
import { ProtocolError, parseUiReadResult, type Command, type Json } from '../../../protocol/src/index.ts'
import type { SessionScope } from './scope.ts'
const workspaceMethods = ['rename', 'delete', 'insertBefore', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'] as const
export function supportsWorkspaceManagement(ctx: Context): boolean {
  const controller = ctx.get?.('workspaceController')
  return !!controller && workspaceMethods.every(method => typeof controller[method] === 'function')
    && typeof ctx.sessionController?.rename === 'function' && typeof ctx.sessionController?.fork === 'function'
    && typeof ctx.sessionController?.list === 'function' && typeof ctx.sessionController?.search === 'function'
    && typeof ctx.typertGateway?.invoke === 'function'
}
export interface UiReadAdapter { read(command: Extract<Command, { op: 'ui.read' }>, signal: AbortSignal, admission: () => void): Promise<Json> }
export function supportsNativeUi(ctx: Context, version: string): boolean {
  return version === '0.2.0-rc.2' && typeof ctx.settings?.describe === 'function'
    && typeof ctx.sessionController?.inspect === 'function' && typeof ctx.sessionController?.updateQueue === 'function'
    && typeof ctx.typertGateway?.wireStream?.open === 'function'
}
/** Only the three declared read views. No browser-chosen namespace or gateway method. */
export class DshUiReadAdapter implements UiReadAdapter {
  constructor(private readonly ctx: Context, private readonly scope: SessionScope) {}
  async read(command: Extract<Command, { op: 'ui.read' }>, signal: AbortSignal, admission: () => void): Promise<Json> {
    const check = () => { admission(); signal.throwIfAborted(); if (command.view === 'session') this.scope.assertSession(command.sessionId) }
    check()
    let value: unknown
    switch (command.view) {
      case 'host-facts': value = { home: homedir() }; break // Same public source used by rc.2 api-remotes.
      case 'conversation-settings': {
        const views = this.ctx.settings.describe({ redactSecrets: true }).filter(v => v.ns === 'ui-conversation')
        if (views.length !== 1) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
        const view = views[0], settings = view.value
        if (!settings || typeof settings !== 'object' || !('busyEnter' in settings)) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
        value = { ns: view.ns, revision: view.revision, busyEnter: settings.busyEnter }; break
      }
      case 'session': {
        const inspected = await this.ctx.sessionController.inspect(SessionId(command.sessionId), signal)
        check()
        if (inspected.meta.id !== command.sessionId) throw new ProtocolError('OUT_OF_SCOPE')
        value = { sessionId: inspected.meta.id, createdAt: inspected.meta.createdAt, ...(inspected.meta.cwd === undefined ? {} : { cwd: inspected.meta.cwd }) }; break
      }
      default: throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    }
    check()
    return parseUiReadResult(command.view, value)
  }
}
