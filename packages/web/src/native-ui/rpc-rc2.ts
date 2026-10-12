import { NativeFileRoutes, FILE_ENDPOINTS } from './file-routes.ts'
import { CURRENT_FILES_CAPABILITY } from '../../../protocol/src/index.ts'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { MANAGEMENT_CAPABILITY, ProtocolError, type Json, type SelectedUiProfile, type Watch } from '../../../protocol/src/index.ts'
import type { BrowserTransport, SyncGeneration } from '../transport.ts'
import { NativeWriteRoutes, WRITE_ENDPOINTS } from './write-routes.ts'
import { NativeManagementRoutes, MANAGEMENT_ENDPOINTS } from './management-routes.ts'
import { NativeInteractions } from './interaction-routes.ts'
import { NativeUploads } from './upload-routes.ts'
import { NativeGeneration, type GenerationTicket } from './generation.ts'
import { argsOf, dispatchRead, fields, object, openRead, readHostFacts, readWatch, rpcFailure, type ReadTransport } from './read-routes.ts'
export interface NativeRpcOwner { rpc: ClientConnectionRpc; fileUpload: { fetch: NativeUploads['fetch'] }; useCarrierError(create:(cause:unknown)=>Error):void; begin(generation: SyncGeneration): void; select(sessionId: string | null): void; dispose(): Promise<void> }
export function createNativeRpc(options: { transport: BrowserTransport; profile: SelectedUiProfile; prepareGeneration?(context: SyncGeneration): Promise<void>; submission?(sessionId: string, requestId: string): (accepted: boolean, terminal?: boolean) => void }): NativeRpcOwner {
  const { transport, profile } = options, generation = new NativeGeneration(() => transport.holdSync(), !!options.prepareGeneration), lifetime = new AbortController()
  let carrierError=(cause:unknown)=>new Error('Remote carrier closed',{cause})
  const uploads = new NativeUploads(transport, sessionId => generation.action(sessionId))
  const files = new NativeFileRoutes(transport, profile.host.capabilities.includes(CURRENT_FILES_CAPABILITY))
  const canManage = profile.host.capabilities.includes(MANAGEMENT_CAPABILITY)
  const management = new NativeManagementRoutes({ enabled: canManage, call: (command, signal) => transport.call(command, signal), action: () => generation.managementAction() })
  const writes = new NativeWriteRoutes({ call: (command, signal) => transport.call(command, signal), action: id => generation.action(id), content: (id, content, signal) => uploads.content(id, content, signal), accepted: content => uploads.release(content), submission: options.submission })
  const interactions = new NativeInteractions((command, signal) => transport.call(command, signal))
  const pending = new Set<Promise<unknown>>(), closers = new Set<() => Promise<void>>()
  const track = <T>(promise: Promise<T>): Promise<T> => { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise }
  const current = (ticket: GenerationTicket, signal: AbortSignal) => { signal.throwIfAborted(); ticket.signal.throwIfAborted() }
  const watched = (ticket: GenerationTicket): ReadTransport => ({
    call: (command, signal) => transport.call(command, signal),
    async *watch(watch: Watch, signal: AbortSignal) {
      const selected = ticket
      for await (const value of transport.watch(watch, signal)) {
        current(ticket, signal); const event = object(value)
        if (event.kind === 'dsh') {
          const frame = object(event.value)
          if (frame.type === 'baseline' && (watch.topic === 'workspaces' || watch.topic === 'sessions')) generation.baseline(ticket, watch.topic)
          if (frame.type === 'snapshot' && watch.topic === 'session') {
            if (object(frame.header).id !== watch.sessionId || !Number.isSafeInteger(frame.cursor)) throw new ProtocolError('INVALID_MESSAGE')
            generation.snapshot(selected, frame.cursor as number)
          }
        } else if (event.kind === 'stop-token' && watch.topic === 'session') {
          if (event.sessionId !== watch.sessionId || (event.token !== null && typeof event.token !== 'string')) throw new ProtocolError('INVALID_MESSAGE')
          generation.stop(selected, event.token)
        } else if (event.kind === 'interactions-ready') generation.baseline(ticket, 'interactions')
        yield value
      }
    },
  })
  async function* eventRead(remote: ReadTransport, payload: unknown, signal: AbortSignal): AsyncIterable<unknown> {
    fields(argsOf('/api', payload), [])
    interactions.dispose()
    const host = await readHostFacts(remote, signal)
    let ready = false
    for await (const value of remote.watch({ topic: 'interactions' }, signal)) {
      const frame = object(value)
      if (frame.kind === 'interactions-ready' && !ready) { ready = true; yield interactions.begin(host) }
      else if (ready) { const native = interactions.accept(value); if (native !== undefined) yield native }
      else throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    }
  }
  const rpc: ClientConnectionRpc = {
    call: (channel, endpoint, payload, caller) => track((async () => {
      const signal = caller ? AbortSignal.any([caller, lifetime.signal]) : lifetime.signal
      try {
        if (WRITE_ENDPOINTS.has(endpoint)) return await writes.call(channel, endpoint, payload, signal)
        if (MANAGEMENT_ENDPOINTS.has(endpoint)) return await management.call(channel, endpoint, payload, signal)
        if (channel === '/api' && endpoint === '$events/result') {
          const action = generation.action(); return await interactions.answer(payload, AbortSignal.any([signal, action.signal]))
        }
        if (channel === '/api' && endpoint === 'fileUploads/upload') return { ok: true, value: await uploads.rpc(payload, signal) }
        const ticket = await generation.wait(signal), linked = AbortSignal.any([signal, ticket.signal])
        const result = FILE_ENDPOINTS.has(endpoint) ? await files.call(channel, endpoint, payload, linked) : await dispatchRead(transport, channel, endpoint, payload, linked, canManage)
        current(ticket, linked); return result
      } catch (error) { return rpcFailure(error) }
    })()),
    async *open(channel, endpoint, payload, caller, _uplink) {
      // Validate before waiting, and do not consume/send any native uplink here.
      if (endpoint === '$events' && channel === '/api') fields(argsOf(channel, payload), [])
      else if (endpoint !== 'workspaceFiles/changes') readWatch(channel, endpoint, payload)
      const fileStream = endpoint === 'workspaceFiles/changes'
      const owned = new AbortController(), signal = AbortSignal.any([caller, lifetime.signal, owned.signal])
      let iterator: AsyncIterator<unknown> | undefined, ticket: GenerationTicket | undefined, closing: Promise<void> | undefined
      const close = () => closing ??= (async () => { owned.abort(); await iterator?.return?.() })()
      closers.add(close)
      try {
        ticket = await generation.wait(signal)
        if (endpoint === 'session/follow') { const watch = readWatch(channel, endpoint, payload); if (watch.topic === 'session') ticket = generation.follow(watch.sessionId) }
        const linked = AbortSignal.any([signal, ticket.signal]), remote = watched(ticket)
        iterator = (fileStream ? files.open(channel, endpoint, payload, linked) : endpoint === '$events' ? eventRead(remote, payload, linked) : openRead(remote, channel, endpoint, payload, linked))[Symbol.asyncIterator]()
        while (true) {
          const next = await iterator.next(); current(ticket, linked)
          if (next.done) { if (!fileStream) generation.failed(ticket, new ProtocolError('RESYNC_REQUIRED')); return }
          yield next.value
        }
      } catch (error) {
        // Use the Gateway's own public class, supplied by the single stock loader.
        // A lost physical generation must not permanently terminate its domain streams.
        if(ticket?.signal.aborted&&!signal.aborted)throw carrierError(error)
        if (!fileStream && ticket && !signal.aborted && !ticket.signal.aborted) generation.failed(ticket, error)
        throw error
      }
      finally { await close(); closers.delete(close) }
    },
  }
  return { rpc, fileUpload: { fetch: uploads.fetch },useCarrierError(create){carrierError=create},
    begin(context) {
      if (context.fence.runtimeId !== profile.runtimeId) { context.barrier.fail(new ProtocolError('PROTOCOL_UNSUPPORTED')); return }
      interactions.dispose(); generation.begin(context)
      if (options.prepareGeneration) {
        const ticket = generation.capture()
        track(options.prepareGeneration(context).then(() => generation.baseline(ticket, 'preferences'), error => generation.failed(ticket, error)))
      }
    },
    select: id => generation.select(id),
    async dispose() { lifetime.abort(); files.dispose(); generation.dispose(); interactions.dispose(); writes.dispose(); await uploads.dispose(); await Promise.allSettled([...closers].map(close => close())); await Promise.allSettled(pending) },
  }
}
