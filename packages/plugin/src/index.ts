import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { ProtocolError } from '../../protocol/src/index.ts'
import { IdentityManager } from './identity.ts'
import { DshCredentialStore } from './credential-store.ts'
import { DshSessionAdapter } from './adapter/dsh-v021.ts'
import { ControlLifecycle, HostRelayClient } from './lifecycle.ts'
import { registerManagement } from './management.ts'
import { probeHost } from './compat/probe.ts'

export { ControlLifecycle, HostRelayClient } from './lifecycle.ts'
export { probeHost, type CompatibilityReport } from './compat/probe.ts'
export { IdentityManager, type Identity } from './identity.ts'
export { DshSessionAdapter } from './adapter/dsh-v021.ts'
export { UploadManager, type UploadTransport } from './uploads.ts'
export { FileService, validateRelativePath, encodeDiff } from './files.ts'
export { SessionScope } from './adapter/scope.ts'
export { LiveStreams, type StreamValue } from './streams.ts'
export { InteractionBridge, authenticatedEvents, sharedEventReply } from './interactions.ts'
export { EventLedger } from './adapter/events.ts'
export { dispatchCommand } from './commands.ts'
export type { SessionAdapter, AdditionalHandlers } from './adapter/types.ts'
export { HostFence } from './control-fence.ts'
export { DshCredentialStore, MemoryCredentialStore, profileCredentialKey, type CredentialStore } from './credential-store.ts'
export const name = 'web-control'
export const inject = ['connection', 'profileContext', 'typertGateway', 'credentials', 'settings',
  'sessionController', 'workspaceController', 'fileUploads', 'agents', 'sessionProjections', 'approval', 'workspaceRegistry', 'attachments', 'fs', 'typert', 'workspaceChanges', 'sessions']

/** The existing Connection authenticates this route; no listener is added. */
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  const ready = productionHost(ctx, lifetime.signal)
  void ready.catch(() => {})
  registerManagement(ctx, ready)
  ctx.effect(() => {
    void ready.then(owner => owner.lifecycle.start()).catch(() => {})
    return async () => { lifetime.abort(); const owner = await ready.catch(() => undefined); await owner?.lifecycle.dispose() }
  }, 'web-control lifecycle')
  let pending: ReturnType<typeof probeHost> | undefined
  ctx.connection.fetch.register({ path: '/api/web-control/probe', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const message = await request.json() as { type?: string; rpcId?: string; method?: string }
      if (message.type !== 'client-request' || message.method !== 'web-control/probe' || typeof message.rpcId !== 'string') {
        return Response.json({ error: 'invalid compatibility request' }, { status: 400 })
      }
      pending ??= probeHost(ctx, { signal: lifetime.signal }).finally(() => { pending = undefined })
      const value = await pending
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } })
    },
  })
  ctx.effect(() => async () => {
    lifetime.abort()
    await pending
  }, 'web-control: probe lifetime')
}

/** Nonmutating compatibility gate. The isolated behavioral fixture is never called here. */
export async function productionHost(ctx: Context, signal: AbortSignal) {
  const version = createRequire(import.meta.url)('@deepseek-ai/dsh/package.json').version
  if (version !== '0.2.0-rc.2' || typeof ctx.credentials?.modifyRecord !== 'function'
    || typeof ctx.credentials?.readRecord !== 'function' || typeof ctx.typertGateway?.wireStream?.open !== 'function'
    || typeof ctx.sessionController?.prompt !== 'function' || typeof ctx.fileUploads?.uploadStream !== 'function'
    || typeof ctx.connection?.createSharedFetchHandler !== 'function' || typeof ctx.sessions?.get !== 'function'
    || typeof ctx.workspaceRegistry?.list !== 'function') throw new ProtocolError('PROTOCOL_UNSUPPORTED')
  const profileScope = createHash('sha256').update(await realpath(ctx.profileContext.dir)).digest('hex')
  signal.throwIfAborted()
  const identity = new IdentityManager(new DshCredentialStore(ctx.credentials), profileScope)
  let reserve: ((bytes: number) => () => void) | undefined
  const adapter = new DshSessionAdapter(ctx, undefined, { reserve: bytes => {
    if (!reserve) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    return reserve(bytes)
  } })
  const relay = new HostRelayClient(ctx, adapter)
  reserve = relay.budget.reserve
  const lifecycle = new ControlLifecycle(identity, relay, adapter)
  return { identity, lifecycle, enroll: async (secret: string, saved?: import('./identity.ts').Identity) => {
    const current = saved ?? await identity.load(); if (!current) throw new ProtocolError('IDENTITY_MISSING')
    signal.throwIfAborted(); await relay.enroll(current, secret)
  } }
}
