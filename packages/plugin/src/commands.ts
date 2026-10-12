import { ProtocolError, type Command, type Fence, type Json } from '../../protocol/src/index.ts'
import type { HostFence } from './control-fence.ts'
import type { AdditionalHandlers, SessionAdapter } from './adapter/types.ts'

/** Additional handlers must call admission immediately before mutations after preparation awaits.
 * Transport owners must likewise recheck their Fence before each actual queued send.
 */
export async function dispatchCommand(adapter: SessionAdapter, fence: HostFence, incoming: Fence,
  command: Command, signal: AbortSignal, additional: AdditionalHandlers, jsonBytes?: number): Promise<Json> {
  const bound = Object.freeze({ ...incoming })
  const admission = () => { fence.check(bound) }
  admission(); signal.throwIfAborted()
  const scoped = adapter.withAdmission(admission)
  let result: Json
  switch (command.op) {
    case 'ui.manage': {
      const handler = additional['ui.manage']
      if (!handler) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      result = await handler(command, signal, admission); break
    }
    case 'ui.catalog': {
      const handler = additional['ui.catalog']
      if (!handler) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      result = await handler(command, signal, admission); break
    }
    case 'ui.search': {
      const handler = additional['ui.search']
      if (!handler) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      result = await handler(command, signal, admission); break
    }
    case 'session.list': result = await scoped.list(command.workspaceId, command.cursor); break
    case 'session.create': result = await scoped.create(command.workspaceId, command.sessionId); break
    case 'session.prompt': result = await scoped.prompt(command, signal); break
    case 'session.page': result = await scoped.page(command, signal, jsonBytes); break
    case 'session.stop':
      await scoped.assertSession(command.sessionId)
      admission(); signal.throwIfAborted()
      result = scoped.stop(command.sessionId, command.stopToken)
      break
    case 'ui.read': {
      const handler = additional['ui.read']
      if (!handler) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      result = await handler(command, signal, admission); signal.throwIfAborted(); break
    }
    case 'session.queue': {
      const handler = additional['session.queue']
      if (!handler) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      result = await handler(command, signal, admission); break
    }
    case 'interaction.delegate': {
      const handler = additional['interaction.delegate']
      if (!handler) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      result = await handler(command, signal, admission); break
    }
    case 'interaction.answer': {
      const handler = additional[command.op]
      if (!handler) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      result = await handler(command, signal, admission); break
    }
    case 'file.stat': case 'file.text': case 'file.read': case 'file.changes': case 'file.diff': {
      await scoped.assertSession(command.sessionId)
      admission()
      // Branches retain each handler's precise discriminated Command type.
      if (command.op === 'file.stat' && additional['file.stat']) result = await additional['file.stat'](command, signal, admission)
      else if (command.op === 'file.text' && additional['file.text']) result = await additional['file.text'](command, signal, admission)
      else if (command.op === 'file.read' && additional['file.read']) result = await additional['file.read'](command, signal, admission)
      else if (command.op === 'file.changes' && additional['file.changes']) result = await additional['file.changes'](command, signal, admission)
      else if (command.op === 'file.diff' && additional['file.diff']) result = await additional['file.diff'](command, signal, admission)
      else throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      break
    }
    default: throw new ProtocolError('PROTOCOL_UNSUPPORTED')
  }
  admission()
  return result
}
