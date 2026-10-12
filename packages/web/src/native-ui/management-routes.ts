import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { ProtocolError, validateManagementAction, type Fence } from '../../../protocol/src/index.ts'
import type { BrowserTransport } from '../transport.ts'
import { argsOf, fields, object, rpcFailure, text } from './read-routes.ts'

export const MANAGEMENT_ENDPOINTS = new Map<string, string>([
  ['session/rename', 'session.rename'], ['session/fork', 'session.fork'],
  ...['rename', 'delete', 'insertBefore', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'].map(method => [`workspace/${method}`, `workspace.${method}`] as [string, string]),
])
/** Original menus/dialogs own all UX and confirmation. This layer only translates
 * declared requests/results; mutations are sent once, never automatically retried.
 */
export class NativeManagementRoutes {
  constructor(private readonly options: { enabled: boolean; call: BrowserTransport['call']; action(): { fence: Fence; signal: AbortSignal } }) {}
  async call(channel: string, endpoint: string, payload: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<unknown>> {
    try {
      const kind = MANAGEMENT_ENDPOINTS.get(endpoint)
      if (!this.options.enabled || !kind) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      const args = argsOf(channel, payload); fields(args, ['request'])
      const request = object(args.request)
      // A supplied kind must not overwrite the finite mapping.
      if ('kind' in request) throw new ProtocolError('INVALID_MESSAGE')
      const action = validateManagementAction({ kind, ...request })
      const admitted = this.options.action(), linked = AbortSignal.any([signal, admitted.signal])
      linked.throwIfAborted()
      const result = object(await this.options.call({ op: 'ui.manage', action }, linked))
      linked.throwIfAborted()
      if (result.ok === true) { fields(result, ['ok', 'value']); return { ok: true, value: result.value } }
      fields(result, ['ok', 'error']); if (result.ok !== false) throw new ProtocolError('INVALID_MESSAGE')
      const error = object(result.error); fields(error, ['code', 'message', 'details'])
      return { ok: false, error: { code: text(error.code), message: text(error.message), details: object(error.details) } }
    } catch (error) { return rpcFailure(error) }
  }
}
