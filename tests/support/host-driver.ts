/** Production Host components, deterministic public rc.2 service fixtures; NOT stock-native evidence. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { WebSocket as SocketType } from 'ws'
const require = createRequire(new URL('../../packages/relay/package.json', import.meta.url))
const WebSocket = require('ws') as typeof import('ws').default
import { readFile } from 'node:fs/promises'
import { DEFAULT_LIMITS, ProtocolError, type Json } from '../../packages/protocol/src/index.ts'
import { MemoryCredentialStore } from '../../packages/plugin/src/credential-store.ts'
import { IdentityManager } from '../../packages/plugin/src/identity.ts'
import { ControlLifecycle, HostRelayClient } from '../../packages/plugin/src/lifecycle.ts'
import { DshSessionAdapter } from '../../packages/plugin/src/adapter/dsh-v021.ts'
import { BrowserTransport } from '../../packages/web/src/transport.ts'
import { userData, assistantData } from './public-host-driver.ts'
import { RelayDriver } from './relay-driver.ts'
import { enrollmentSecret } from '../../packages/relay/tests/socket-fixture.ts'

/** Abort-aware public observer source; native session ownership is independent. */
class Source {
  readonly readers = new Set<{ push(value: unknown): void }>()
  open(initial: unknown[], signal: AbortSignal): AsyncIterable<unknown> {
    const readers = this.readers
    return (async function* () {
      const queue = [...initial]; let wake: (() => void) | undefined
      const reader = { push(value: unknown) { queue.push(value); wake?.() } }
      const abort = () => wake?.(); readers.add(reader); signal.addEventListener('abort', abort, { once: true })
      try { while (!signal.aborted) { if (queue.length) yield queue.shift(); else await new Promise<void>(resolve => { wake = resolve; if (signal.aborted) resolve() }) } }
      finally { readers.delete(reader); signal.removeEventListener('abort', abort) }
    })()
  }
  push(value: unknown): void { for (const reader of this.readers) reader.push(value) }
}
/** Test-native model client and in-memory provider; never calls fetch/network. */
class DeterministicProvider {
  authorizedRequests = 0
  constructor(private readonly apiKey: string) {}
  async generate(): Promise<string> {
    const request = new Request('https://synthetic-provider.invalid/generate', { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` } })
    // Consume the client credential at the provider boundary, not in remote DTOs.
    if (request.headers.get('Authorization') !== `Bearer ${this.apiKey}`) throw new ProtocolError('AUTH_REQUIRED')
    this.authorizedRequests++
    return 'deterministic provider completed'
  }
}
export class HostDriver {
  readonly store = new MemoryCredentialStore()
  readonly identity = new IdentityManager(this.store, 'e'.repeat(64))
  lifecycle!: ControlLifecycle
  transport!: HostRelayClient
  private adapter!: DshSessionAdapter
  readonly context: Context
  readonly records = new Map<string, Json[]>([['a', []]])
  readonly agents = new Map<string, { inbox: { nextTurn: unknown[]; nextStep: unknown[] }; session: object; running: boolean }>([['a', { inbox: { nextTurn: [], nextStep: [] }, session: {}, running: false }]])
  readonly workspace = new Source()
  readonly events = new Source()
  readonly journal = new Source()
  readonly control = new Source()
  workspacePresent = true
  promptWait?: Promise<void>
  uploadWait?: Promise<void>
  uploadConsumeWait?: Promise<void>
  nativeUploads = 0
  uploadBytes = 0
  peakBudgetBytes = 0
  nativeCancels = 0
  imageBytes = new Uint8Array(1024)
  imageWait?: Promise<void>
  bindingsCreated = 0
  bindingsCommitted = 0
  bindingsDisposed = 0
  readonly decisions: string[] = []
  readonly pending = new Set(['approval-a'])
  private golden: any
  private readonly work = new Map<string, ReturnType<typeof setInterval>>()
  private modelProvider?: DeterministicProvider
  readonly steps = new Map<string, number>()
  constructor(readonly relay: RelayDriver) {
    const follow = (sessionId: string, signal: AbortSignal) => this.journal.open([this.snapshot(sessionId)], signal)
    this.context = {
      workspaceRegistry: { list: () => this.workspacePresent ? [{ id: 'w', sessionIds: [...this.records.keys()] }] : [] },
      agents: { get: (id: string) => this.agents.get(id) },
      sessionProjections: { stateOf: () => ({ openTurnStartSeq: 0 }) },
      connection: { createSharedFetchHandler: () => ({ fetch: async (request: Request) => {
        const envelope = await request.json() as any, result = envelope.payload.args
        if (this.pending.delete(result.eventId)) { this.decisions.push(result.eventId); this.events.push({ type: 'cancel', eventId: result.eventId }) }
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true } })
      } }) },
      typertGateway: {
        invoke: async ({ method, args, signal }: any) => {
          const value = args.request
          if (method === 'list') return { items: [...this.records.keys()].map(sessionId => ({ sessionId })) }
          if (method === 'create') { if (!this.records.has(value.sessionId)) { this.records.set(value.sessionId, []); this.agents.set(value.sessionId, { inbox: { nextTurn: [], nextStep: [] }, session: {}, running: false }) }; return { sessionId: value.sessionId } }
          if (method === 'page') return this.page(value)
          if (method === 'prompt') {
            signal?.throwIfAborted()
            const records = this.records.get(value.sessionId)!, agent = this.agents.get(value.sessionId)!
            const data = userData(value.content.map((part: any) => part.text ?? '').join(''), value.requestId)
            const record: Json = { type: 'event', event: { type: 'user/message', seq: records.length, time: Date.now(), data: data as unknown as Json, surfaceOp: 'append' } }
            records.push(record); agent.running = true; this.journal.push(record)
            if (!this.work.has(value.sessionId)) this.work.set(value.sessionId, setInterval(() => this.steps.set(value.sessionId, (this.steps.get(value.sessionId) ?? 0) + 1), 5))
            if (this.modelProvider) {
              const completion = await this.modelProvider.generate()
              const progress: Json = { type: 'event', event: { type: 'assistant/message', seq: records.length, time: Date.now(), data: assistantData(completion) as unknown as Json, surfaceOp: 'append' } }
              records.push(progress); this.journal.push(progress)
            }
            if (this.promptWait) await this.promptWait
            return { accepted: true }
          }
          throw new ProtocolError('PROTOCOL_UNSUPPORTED')
        },
        stream: async ({ namespace, method, args, signal }: any) => {
          if (namespace === 'workspace') return this.workspace.open([{ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }], signal)
          if (method === 'follow') return follow(args.request.address.sessionId, signal)
          return this.control.open([{ type: 'baseline', value: { projections: {} } }], signal)
        },
        wireStream: { open: (_name: string, _args: unknown, _input: unknown, _options: unknown, signal: AbortSignal) => this.events.open([
          { type: 'ready', clientId: 'public-fixture', host: { home: '/isolated' } },
          ...[...this.pending].map(eventId => ({ type: 'waterfall', eventId, agentId: 'a', event: 'approval/request', request: { toolName: 'shell', reason: 'isolated decision' } })),
        ], signal) },
      },
      sessionController: { prompt() {}, follow: ({ address }: any, signal: AbortSignal) => follow(address.sessionId, signal), page: async (request: any) => this.page(request), cancel: () => { this.nativeCancels++; return { accepted: true } } },
      attachments: {
        imageLimits: { maxImageBytes: 20971520, maxImagesPerMessage: 20, maxMessageImageBytes: 209715200, mediaTypes: ['image/png'] },
        readFileStream: () => (async function* (bytes: Uint8Array) { yield bytes })(this.imageBytes),
        validateImage: async () => { if (this.imageWait) await this.imageWait },
      },
      fileUploads: {
        uploadStream: async ({ data, signal, name }: any) => {
          this.nativeUploads++
          try { if (this.uploadConsumeWait) await this.uploadConsumeWait; let bytes = 0; for await (const chunk of data) { bytes += chunk.byteLength; this.uploadBytes += chunk.byteLength }; if (this.uploadWait) await this.uploadWait; signal.throwIfAborted()
            return { receiptId: 'receipt-a', file: { attachmentId: 'attachment-a', bytes, name } }
          } finally { this.nativeUploads-- }
        }, resolve: () => ({ attachmentId: 'attachment-a', bytes: this.imageBytes.length, name: 'verified.png' }),
        bindPrompt: () => { this.bindingsCreated++; return { commit: () => { this.bindingsCommitted++ }, [Symbol.dispose]: () => { this.bindingsDisposed++ } } },
      },
    } as unknown as Context
  }
  private page(request: any): { records: Json[]; hasMore: boolean } {
    const rows = this.records.get(request.address.sessionId)!.filter((record: any) => request.beforeSeq === undefined || record.event.seq < request.beforeSeq)
    const records = rows.slice(-(request.maxMessages ?? 64)); return { records, hasMore: rows.length > records.length }
  }
  private snapshot(id: string): unknown { return { ...this.golden, header: { ...this.golden.header, id }, cursor: this.records.get(id)!.length - 1, ...this.page({ address: { sessionId: id } }) } }
  async start(): Promise<void> {
    this.golden ??= JSON.parse(await readFile(new URL('../../packages/plugin/tests/fixtures/session-opening-rc2.json', import.meta.url), 'utf8'))
    const existing = await this.identity.load()
    const current = existing ?? await this.identity.enable(this.relay.publicOrigin)
    let reserve: (bytes: number) => () => void = () => { throw new Error('not ready') }
    this.adapter = new DshSessionAdapter(this.context, undefined, { reserve: bytes => reserve(bytes) })
    this.transport = new HostRelayClient(this.context, this.adapter, { isolatedTest: true, origin: this.relay.origin }); const budget = this.transport.budget
    for (const key of ['reserve', 'reserveControl'] as const) {
      const claim = budget[key]
      budget[key] = bytes => { const release = claim(bytes); this.peakBudgetBytes = Math.max(this.peakBudgetBytes, budget.bytes); return release }
    }
    reserve = budget.reserve
    this.lifecycle = new ControlLifecycle(this.identity, this.transport, this.adapter)
    if (!existing) await this.transport.enroll(current, enrollmentSecret)
    await this.lifecycle.start()
  }
  closeRuntime(): void { for (const timer of this.work.values()) clearInterval(timer); this.work.clear(); this.modelProvider = undefined }
  configureModelProvider(apiKey: string): void { this.modelProvider = new DeterministicProvider(apiKey) }
  modelAuthorizations(): number { return this.modelProvider?.authorizedRequests ?? 0 }
  async quit(): Promise<void> { await this.lifecycle?.dispose() }
  async restart(): Promise<void> { await this.quit(); await this.start() }
  disconnect(): void { this.transport.close() }
  async reconnect(): Promise<void> { await this.lifecycle.start() }
  acceptedPrompts(): string[] { return [...this.records.values()].flat().map((record: any) => record.event.data?.source?.rpcId).filter(Boolean) }
  running(id: string): boolean { return this.agents.get(id)?.running ?? false }
  pendingApprovals(): string[] { return [...this.pending] }
  localAnswer(): void { if (this.pending.delete('approval-a')) { this.decisions.push('approval-a'); this.events.push({ type: 'cancel', eventId: 'approval-a' }) } }
  deleteWorkspace(): void { this.workspacePresent = false; this.workspace.push({ type: 'remove', workspaceId: 'w' }) }
  observeSends(callbackDelayMs = 0): { frames: { type: string; at: number; bytes: number }[]; restore(): void } {
    const socket = (this.transport as unknown as { socket: SocketType }).socket
    const original = socket.send.bind(socket), frames: { type: string; at: number; bytes: number }[] = []
    socket.send = ((data: string, callback: (error?: Error) => void) => {
      frames.push({ type: JSON.parse(data).type, at: performance.now(), bytes: Buffer.byteLength(data) })
      original(data, error => { if (callbackDelayMs) setTimeout(() => callback(error), callbackDelayMs); else callback(error) })
    }) as typeof socket.send
    return { frames, restore: () => { socket.send = original } }
  }
  observers(): number { return this.workspace.readers.size + this.events.readers.size + this.journal.readers.size + this.control.readers.size }
}
export class BrowserDriver {
  readonly transport: BrowserTransport
  readonly storageValues = new Map<string, string>()
  readonly sockets = new Set<SocketType>()
  cookie = ''
  constructor(readonly host: HostDriver, readonly relay: RelayDriver) {
    const storage = { getItem: (key: string) => this.storageValues.get(key) ?? null, setItem: (key: string, value: string) => this.storageValues.set(key, value), removeItem: (key: string) => this.storageValues.delete(key) } as unknown as Storage
    this.transport = new BrowserTransport({ origin: relay.publicOrigin, reconnect: false, storage,
      fetch: (async (path: string, options: RequestInit) => fetch(relay.origin + path, { ...options, headers: { ...options.headers, Origin: relay.publicOrigin, Cookie: this.cookie } })) as typeof fetch,
      socket: url => { const socket = new WebSocket(relay.origin.replace('http:', 'ws:') + new URL(url).pathname, { headers: { Origin: relay.publicOrigin, Cookie: this.cookie } }); this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); return socket as unknown as globalThis.WebSocket },
    })
    this.transport.registerSynchronizer(({ barrier }) => barrier.ready())
  }
  async login(): Promise<void> {
    const identity = await this.host.identity.load()
    const response = await fetch(`${this.relay.origin}/v1/instances/${identity!.instanceId}/login`, { method: 'POST', headers: { Origin: this.relay.publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: identity!.linkSecret }) })
    if (!response.ok) throw new Error(`login status ${response.status}`)
    this.cookie = response.headers.get('set-cookie')!.split(';')[0]; await response.body?.cancel()
  }
  async connect(): Promise<void> { await this.transport.connect((await this.host.identity.load())!.instanceId); await this.waitForReady() }
  async waitForReady(): Promise<void> {
    if (this.transport.getSnapshot().phase === 'ready') return
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { unsubscribe(); reject(new Error(`ready timeout: ${this.transport.getSnapshot().phase}`)) }, 15000)
      const unsubscribe = this.transport.subscribe(() => { if (this.transport.getSnapshot().phase === 'ready') { clearTimeout(timer); unsubscribe(); resolve() } }) })
  }
  disconnect(): void { for (const socket of this.sockets) socket.terminate() }
  async close(): Promise<void> { this.transport.dispose(); await Promise.all([...this.sockets].map(socket => new Promise<void>(resolve => { if (socket.readyState === WebSocket.CLOSED) resolve(); else { socket.once('close', resolve); socket.terminate() } }))) }
}
export async function systemFixture(limits = DEFAULT_LIMITS) {
  const relay = new RelayDriver({ ...limits }); await relay.start(); const host = new HostDriver(relay)
  try { await host.start(); const browser = new BrowserDriver(host, relay); await browser.login(); await browser.connect()
    return { relay, host, browser, async close() { await browser.close(); await host.quit(); host.closeRuntime(); await relay.close() } }
  } catch (error) { await host.quit(); host.closeRuntime(); await relay.close(); throw error }
}
export const prompt = (requestId: string = randomUUID()) => ({ op: 'session.prompt' as const, sessionId: 'a', requestId, mode: 'queue' as const, content: [{ kind: 'text' as const, text: 'isolated task' }] })
