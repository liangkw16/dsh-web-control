import { nativeUiFixture } from './ui-fixture.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyNativeFiles } from './file-fixture.ts'
import { HostFence } from '../control-fence.ts'
import { InteractionBridge, authenticatedEvents, sharedEventReply } from '../interactions.ts'
import { LiveStreams } from '../streams.ts'
import { SessionScope } from '../adapter/scope.ts'
import { jsonObject, validateFollowFrame, publicJson } from '../adapter/dsh-v021.ts'
import { parseRemoteEventResult } from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { DshSessionAdapter } from '../adapter/dsh-v021.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/types'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'

export interface CompatibilityReport {
  supported: boolean
  dshVersion: string
  profileScope: string
  checks: { name: string; ok: boolean; reason?: string }[]
}

const behaviorNames = ['events.ready-cancel', 'shared-fetch.read', 'workspace.membership',
  'session.follow-snapshot', 'credentials.write-read-delete', 'session.turn-boundary',
  'upload.stream-roundtrip', 'workspace-files.relative-read', 'session.prompt-acceptance',
  'events.approval-result', 'events.cancelled', 'session.cancel-request', 'fixture.cleanup'] as const

/** Inspect only public services. Behavioral mutations require a task-owned profile marker. */
export async function probeHost(ctx: Context, options: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<CompatibilityReport> {
  const report: CompatibilityReport = { supported: false, dshVersion: 'unavailable', profileScope: '', checks: [] }
  const add = (name: string, ok: boolean, reason?: string) => {
    report.checks.push({ name, ok, ...(ok ? {} : { reason: reason ?? 'required public capability unavailable' }) })
  }
  const required = [
    ['gateway.invoke', typeof ctx.typertGateway?.invoke === 'function'],
    ['gateway.stream', typeof ctx.typertGateway?.stream === 'function'],
    ['gateway.events', typeof ctx.typertGateway?.wireStream?.open === 'function'],
    ['connection.fetch', typeof ctx.connection?.createSharedFetchHandler === 'function'],
    ['credentials.atomic', typeof ctx.credentials?.modifyRecord === 'function'],
    ['session.cancel', typeof ctx.sessionController?.cancel === 'function'],
    ['upload.stream', typeof ctx.fileUploads?.uploadStream === 'function'],
  ] as const
  for (const [name, ok] of required) add(name, ok)
  let dir = ''
  try {
    dir = await realpath(ctx.profileContext.dir)
    report.profileScope = createHash('sha256').update(dir).digest('hex')
    add('profile.canonical-scope', true)
  } catch { add('profile.canonical-scope', false) }
  try {
    report.dshVersion = createRequire(import.meta.url)('@deepseek-ai/dsh/package.json').version
    add('host.version', report.dshVersion === '0.2.0-rc.2', 'release has not passed this adapter gate')
  } catch { add('host.version', false) }
  let isolated = false
  try { isolated = JSON.parse(await readFile(join(dir, '.web-control-compat.json'), 'utf8')).isolated === true } catch {}
  add('fixture.isolated-profile', isolated, 'behavioral smoke requires an isolated compatibility profile')
  const fixtureConfig = isolated ? JSON.parse(await readFile(join(dir, '.web-control-compat.json'), 'utf8')) : {}
  if (isolated && fixtureConfig.captureCoreResolution === true) {
    const entries = ['@deepseek-ai/cordis', '@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-api-gateway',
      '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-file-upload', '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-llm',
      ...(fixtureConfig.task15UI === true ? ['@deepseek-ai/dsh-session/types'] : []),
      ...(fixtureConfig.task8Streams === true ? ['@deepseek-ai/dsh-api-gateway/stream-protocol', '@deepseek-ai/dsh-session/types', '@deepseek-ai/dsh-user-questions'] : []),
      ...(fixtureConfig.task7Images === true ? ['@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-session/types', '@deepseek-ai/dsh-workspace', '@deepseek-ai/dsh-attachment'] : [])]
    const resolutions = Object.fromEntries(await Promise.all(entries.map(async entry =>
      [entry, await realpath(fileURLToPath(import.meta.resolve(entry)))])))
    await writeFile(join(dir, '.web-control-core-resolution.json'), JSON.stringify(resolutions, null, 2))
  }
  if (required.every(([, ok]) => ok) && dir && isolated) {
    if (fixtureConfig.task15UI === true) add('fixture.actual-ui-native', await nativeUiFixture(ctx, dir, options.signal))
    else await smoke(ctx, dir, add, options)
  } else {
    for (const name of behaviorNames) add(name, false, 'not executed: preflight or isolated fixture unavailable')
  }
  report.supported = report.checks.every(check => check.ok)
  return report
}

async function smoke(ctx: Context, dir: string, add: (name: string, ok: boolean, reason?: string) => void, options: { signal?: AbortSignal; deadlineMs?: number }) {
  const control = new AbortController()
  const abort = () => control.abort()
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, options.deadlineMs ?? 15_000)
  const completed = new Set<string>()
  const check = async (name: string, fn: () => Promise<boolean>) => {
    try {
      control.signal.throwIfAborted()
      // Public operations receive the signal and are awaited through cleanup;
      // never abandon an operation/iterator in a Promise.race.
      add(name, await fn(), 'public behavior did not match the descriptor')
    }
    catch (error) {
      const code = error instanceof Error && /^[a-z0-9_/-]{1,80}$/i.test(String((error as { code?: unknown }).code ?? error.name))
        ? String((error as { code?: unknown }).code ?? error.name) : 'unclassified'
      add(name, false, 'public operation rejected: ' + code)
    }
    completed.add(name)
  }
  const workspacePath = join(dir, '.web-control-fixtures', randomUUID())
  let workspaceId: string | undefined
  let disposeAdapter: (() => void) | undefined
  let eventIterator: AsyncIterator<unknown> | undefined
  const task8Bridges: InteractionBridge[] = []
  let ready: { clientId: string } | undefined
  let fixtureSessionId: string | undefined
  let promptAccepted = false
  let fixturePaused = false
  let streamSettled: Promise<void> | undefined
  let modelStarted = false
  let modelImageVerified = false
  let task7Receipt: import('@deepseek-ai/dsh-client-file-upload').FileUploadReceiptId | undefined
  let task7Command: Parameters<DshSessionAdapter['prompt']>[0] | undefined
  let task7Adapter: import('../adapter/types.ts').SessionAdapter | undefined
  const invoke = (namespace: string, method: string, args: Record<string, unknown>) =>
    ctx.typertGateway.invoke({ namespace, method, args, signal: control.signal })
  try {
    await check('events.ready-cancel', async () => {
      const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} },
        (async function* () {})(), undefined, control.signal)
      eventIterator = stream[Symbol.asyncIterator]()
      const first = await eventIterator.next()
      const value = first.value as { type: string; clientId: string }
      ready = value
      return !first.done && value.type === 'ready' && typeof value.clientId === 'string'
    })
    await check('shared-fetch.read', async () => {
      const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request(
        'http://localhost/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session/list',
            payload: { args: { _request: {} } } }), signal: control.signal }))
      return response.ok && (await response.json()).result.ok === true
    })
    control.signal.throwIfAborted()
    await mkdir(workspacePath, { recursive: true })
    await writeFile(join(workspacePath, 'synthetic.txt'), 'web-control compatibility fixture\n')
    const workspace = await invoke('workspace', 'create', { request: { path: workspacePath } }) as
      { workspace: { workspaceId: string } }
    workspaceId = workspace.workspace.workspaceId
    const session = await invoke('session', 'create', { request: { workspaceId, ...(JSON.parse(await readFile(join(dir, '.web-control-compat.json'), 'utf8')).task7Images === true ? { sessionId: randomUUID() } : {}) } }) as { sessionId: string }
    const sessionId = session.sessionId
    fixtureSessionId = sessionId
    const task7 = JSON.parse(await readFile(join(dir, '.web-control-compat.json'), 'utf8')).task7Images === true
    if (task7) await check('session.create-adopt-idempotent', async () => {
      const adapter = new DshSessionAdapter(ctx).withAdmission(() => control.signal.throwIfAborted())
      const before = ctx.agents.get(SessionId(sessionId))
      const first = await adapter.create(workspaceId!, sessionId)
      const second = await adapter.create(workspaceId!, sessionId)
      const rows = await invoke('session', 'list', { _request: {} }) as import('@deepseek-ai/dsh-api-session-controller').SessionListValue
      return JSON.stringify(first) === JSON.stringify(second) && ctx.agents.get(SessionId(sessionId)) === before && rows.items.filter(row => row.sessionId === sessionId).length === 1
    })
    await check('workspace.membership', async () => {
      const snapshot = await ctx.typertGateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal: control.signal })
      const iterator = snapshot[Symbol.asyncIterator]()
      try {
        const first = await iterator.next()
        const frame = first.value as { type: string; value: { items: { workspaceId: string; sessionIds: string[] }[] } }
        return frame.type === 'baseline' && frame.value.items.some(w => w.workspaceId === workspaceId && w.sessionIds.includes(sessionId))
      } finally { await iterator.return?.() }
    })
    await check('session.follow-snapshot', async () => {
      const stream = await ctx.typertGateway.stream({ namespace: 'session', method: 'follow',
        args: { request: { address: { kind: 'session', sessionId }, assistantStream: true } }, signal: control.signal })
      const iterator = stream[Symbol.asyncIterator]()
      try {
        const frame = (await iterator.next()).value as { type: string; header: { id: string }; records: unknown[]; projections: unknown; assistantStream: unknown }
        if (JSON.parse(await readFile(join(dir, '.web-control-compat.json'), 'utf8')).task8Streams === true) {
          const opening = jsonObject(validateFollowFrame(frame)); const header = jsonObject(opening.header)
          await writeFile(join(dir, '.web-control-opening-fixture.json'), JSON.stringify({ ...opening, header: { ...header, ...(header.cwd === undefined ? {} : { cwd: '[isolated-workspace]' }) } }))
        }
        return frame.type === 'snapshot' && frame.header.id === sessionId && Array.isArray(frame.records)
          && frame.projections !== undefined && frame.assistantStream !== undefined
      } finally { await iterator.return?.() }
    })
    await check('credentials.write-read-delete', async () => {
      const { credentialKey } = await import('@deepseek-ai/dsh-credentials')
      const key = credentialKey('web-control', 'compat-' + randomUUID())
      try {
        await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { synthetic: true } }))
        const read = await ctx.credentials.readRecord(key)
        return read?.kind === 'grant' && JSON.stringify(read.payload) === '{"synthetic":true}'
      } finally {
        await ctx.credentials.deleteRecord(key)
        if (await ctx.credentials.readRecord(key) !== undefined) throw new Error('cleanup failed')
      }
    })
    const agent = ctx.agents.get(sessionId as Parameters<typeof ctx.agents.get>[0])
    await check('session.turn-boundary', async () => !!agent && ctx.sessionProjections.stateOf(agent.session, 'turnBoundary') !== undefined)
    await check('upload.stream-roundtrip', async () => {
      const receipt = await ctx.fileUploads.uploadStream({ sessionId: sessionId as Parameters<typeof ctx.fileUploads.uploadStream>[0]['sessionId'],
        name: 'synthetic.txt', data: (async function* () { yield Buffer.from('synthetic upload') })(), signal: control.signal })
      const attachments = ctx.get('attachments')
      if (!attachments || !agent || receipt.file.bytes !== Buffer.byteLength('synthetic upload')) return false
      const chunks: Uint8Array[] = []
      for await (const chunk of attachments.readFileStream(receipt.file, control.signal)) chunks.push(chunk)
      return Buffer.concat(chunks).toString() === 'synthetic upload'
        && ctx.fileUploads.resolve(agent, receipt.receiptId)?.attachmentId === receipt.file.attachmentId
    })
    await check('workspace-files.relative-read', async () => {
      const read = await invoke('workspaceFiles', 'read', { workspaceFileScopeId: sessionId, path: 'synthetic.txt', range: {} })
      return JSON.stringify(read).includes('web-control compatibility fixture')
    })
    const { LlmAdapter, ToolCallId } = await import('@deepseek-ai/dsh-llm')
    let fileToolIssued = false
    let outcome: string | undefined
    let secondOutcome: string | undefined
    let questionOutcome: import('@deepseek-ai/dsh-user-questions/types').AskUserQuestionAnswer | undefined
    const questionDecided = Promise.withResolvers<void>()
    const firstDecided = Promise.withResolvers<void>()
    const secondDecided = Promise.withResolvers<void>()
    let fixtureApprovalAsked = false
    let holdForStop = false
    const stopStarted = Promise.withResolvers<void>()
    const streamFinished = Promise.withResolvers<void>()
    streamSettled = streamFinished.promise
    const marker = JSON.parse(await readFile(join(dir, '.web-control-compat.json'), 'utf8'))
    fixturePaused = marker.pauseAtApproval === true
    class SyntheticAdapter extends LlmAdapter {
      override async listModels(provider: string) { return [{ provider, id: 'synthetic', name: 'Synthetic local fixture', inputModalities: ['text', 'image'] as const }] }
      override async resolveModel(provider: string, model: string) { return { provider, id: model, name: 'Synthetic local fixture', inputModalities: ['text', 'image'] as const } }
      override async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
        try {
          if (!options.purpose) {
            modelStarted = true
            if (marker.task7Images === true) {
              for (const message of options.messages) {
                for (const block of message.content) {
                  if (block.type === 'image') {
                    const stored = await ctx.attachments.readImage(block.attachment, control.signal)
                    modelImageVerified = stored.data.byteLength > 0 && stored.ref.mediaType === 'image/png' && stored.ref.width === 1 && stored.ref.height === 1
                  }
                }
              }
            }
          }
          if (!options.purpose && agent && ((marker.task7Images !== true && marker.task9Files !== true) || !fixtureApprovalAsked)) {
            fixtureApprovalAsked = true
            const signal = options.signal ? AbortSignal.any([options.signal, control.signal]) : control.signal
            outcome = await ctx.approval.request({ agent, toolName: 'web-control-synthetic', signal })
            firstDecided.resolve()
            if (marker.task8Streams === true) {
              secondOutcome = await ctx.approval.request({ agent, toolName: 'web-control-synthetic-second', signal })
              secondDecided.resolve()
              const userQuestions = ctx.get('userQuestions')
              if (!userQuestions) throw new Error('isolated userQuestions service unavailable')
              questionOutcome = await userQuestions.ask({ agent, signal, questions: [
                { id: 'choice', question: 'Choose the synthetic answer', options: [{ label: 'Fixture A' }, { label: 'Fixture B' }] },
                { id: 'text', question: 'Enter synthetic fixture text' },
              ] })
              questionDecided.resolve()
            }
          }
          if (!options.purpose && holdForStop) {
            holdForStop = false
            const heldSignal = options.signal ? AbortSignal.any([options.signal, control.signal]) : control.signal
            stopStarted.resolve()
            await new Promise<void>(resolve => {
              if (heldSignal.aborted) resolve()
              else heldSignal.addEventListener('abort', () => resolve(), { once: true })
            })
            heldSignal.throwIfAborted()
          }
          if (!options.purpose && marker.task9Files === true && !fileToolIssued) {
            fileToolIssued = true
            const id = ToolCallId(randomUUID())
            const argumentsText = JSON.stringify({ file_path: join(workspacePath, 'native-recorded.txt'), content: 'native task9 historical content\n' })
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: 0, id, name: 'write', argumentsDelta: argumentsText }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'write', arguments: argumentsText } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'Synthetic response' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Synthetic response' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } finally { if (!options.purpose) { firstDecided.resolve(); secondDecided.resolve(); questionDecided.resolve(); streamFinished.resolve() } }
      }
    }
    const llm = ctx.get('llm')
    if (!llm) throw new Error('synthetic fixture LLM service unavailable')
    disposeAdapter = llm.registerAdapter(['web-control-synthetic'], new SyntheticAdapter())
    await invoke('session', 'selectModel', { request: { sessionId, provider: 'web-control-synthetic', model: 'synthetic' } })
    await check('session.prompt-acceptance', async () => {
      let result: { accepted?: boolean }
      if (marker.task7Images === true) {
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
        const receipt = await ctx.fileUploads.uploadStream({ sessionId: SessionId(sessionId), name: 'synthetic.png', data: (async function* () { yield png })(), signal: control.signal })
        const adapter = new DshSessionAdapter(ctx).withAdmission(() => control.signal.throwIfAborted())
        task7Adapter = adapter
        task7Receipt = receipt.receiptId
        const requestId = randomUUID()
        const command = { op: 'session.prompt', sessionId, requestId, mode: 'queue', content: [{ kind: 'text', text: 'Synthetic compatibility image prompt' }, { kind: 'upload', receiptId: receipt.receiptId, name: 'synthetic.png', mediaType: 'image/png' }] } satisfies Parameters<typeof adapter.prompt>[0]
        task7Command = command
        if (!agent) throw new Error('fixture Agent missing')
        const results = await Promise.all([adapter.prompt(command, control.signal), adapter.withAdmission(() => control.signal.throwIfAborted()).prompt(command, control.signal)])
        const admitted = results[0]
        result = admitted as { accepted?: boolean }
      } else {
        result = await invoke('session', 'prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Synthetic compatibility prompt' }] } }) as { accepted: boolean }
      }
      promptAccepted = result.accepted === true
      return promptAccepted
    })
    await check('events.approval-result', async () => {
      if (!eventIterator || !ready) return false
      while (!control.signal.aborted) {
        const frame = (await eventIterator.next()).value as { type: string; event: string; eventId: string; agentId: string }
        if (frame.type !== 'waterfall') continue
        const matched = frame.event === 'approval/request' && frame.agentId === sessionId
        if (matched && marker.task8Streams === true && agent) {
          const incoming = { instanceId: randomUUID(), runtimeId: randomUUID(), controlId: randomUUID(), authEpoch: 1 }
          const identity = { instanceId: incoming.instanceId, authEpoch: 1, enabled: true, relayOrigin: 'https://fixture.invalid', deviceSecret: Buffer.alloc(32, 1).toString('base64url'), linkSecret: Buffer.alloc(32, 2).toString('base64url') }
          const fence = new HostFence(incoming.instanceId, incoming.runtimeId, () => identity); fence.install(incoming)
          const scope = new SessionScope(() => ctx.workspaceRegistry.list().map(workspace => ({ workspaceId: workspace.id, sessionIds: workspace.sessionIds })))
          const reply = sharedEventReply(request => ctx.connection.createSharedFetchHandler('/api').fetch(request))
          const nativeIds: string[] = []; const clients: string[] = []
          const source = async function* (signal: AbortSignal) {
            for await (const value of await authenticatedEvents(ctx)(signal)) {
              const frame = jsonObject(publicJson(value))
              if (frame.type === 'ready' && typeof frame.clientId === 'string') clients.push(frame.clientId)
              if (frame.type === 'waterfall' && frame.agentId === sessionId && typeof frame.eventId === 'string') nativeIds.push(frame.eventId)
              yield value
            }
          }
          const open = () => {
            const bridge = new InteractionBridge(incoming, fence, source, id => scope.assertSession(id), reply)
            task8Bridges.push(bridge)
            return { bridge, iterator: bridge.open(control.signal)[Symbol.asyncIterator]() }
          }
          const delivery = async (iterator: AsyncIterator<import('../streams.ts').StreamValue>) => {
            while (true) { const item = await iterator.next(); if (item.done) throw new Error('fixture event stream ended'); if (item.value.kind === 'interaction') return item.value }
          }
          const first = open(); const firstDelivery = await delivery(first.iterator)
          await first.bridge.dispose(); await first.iterator.return?.()
          const second = open(); const replay = await delivery(second.iterator)
          add('events.pending-replay', nativeIds.length === 2 && nativeIds[0] === frame.eventId && nativeIds[1] === frame.eventId && clients[0] !== clients[1] && firstDelivery.deliveryId !== replay.deliveryId && outcome === undefined)
          const currentTurn = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.openTurnStartSeq
          const live = new LiveStreams(ctx, fence, scope, new DshSessionAdapter(ctx))
          const observer = live.openWatch({ topic: 'session', sessionId, maxMessages: 64 }, incoming, control.signal)[Symbol.asyncIterator]()
          const opening = await observer.next()
          if (opening.done || opening.value.kind !== 'dsh') throw new Error('fixture follow missing opening')
          const snapshot = jsonObject(validateFollowFrame(opening.value.value))
          // Task-owned synthetic frame only; redact metadata before storing the public fixture.
          const header = jsonObject(snapshot.header)
          await writeFile(join(dir, '.web-control-follow-fixture.json'), JSON.stringify({ ...snapshot, header: { ...header, ...(header.cwd === undefined ? {} : { cwd: '[isolated-workspace]' }) } }))
          await observer.return?.()
          add('session.query-dispose-keeps-task', snapshot.type === 'snapshot' && Object.hasOwn(snapshot, 'assistantStream') && modelStarted && outcome === undefined && currentTurn !== null && currentTurn !== undefined && ctx.agents.get(SessionId(sessionId)) === agent && ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.openTurnStartSeq === currentTurn)
          await reply(parseRemoteEventResult({ clientId: ready.clientId, eventId: frame.eventId, outcome: { kind: 'result', value: 'allowed-once' } }))
          await second.bridge.answer(replay.deliveryId, 'rejected') // Native expired result is a harmless no-op.
          await firstDecided.promise
          let duplicate = false; let forged = false
          try { await second.bridge.answer(replay.deliveryId, 'allowed-once') } catch { duplicate = true }
          try { await second.bridge.answer(frame.eventId, 'allowed-once') } catch { forged = true }
          add('events.local-first-wins', outcome === 'allowed-once' && duplicate && forged)
          await second.bridge.dispose(); await second.iterator.return?.()
          const third = open()
          const remote = await delivery(third.iterator)
          let localFrame: { eventId: string } | undefined
          while (!localFrame) {
            const next = await eventIterator.next(); if (next.done) throw new Error('local fixture event stream ended')
            const item = jsonObject(publicJson(next.value))
            if (item.type === 'waterfall' && item.agentId === sessionId && typeof item.eventId === 'string') localFrame = { eventId: item.eventId }
          }
          await third.bridge.answer(remote.deliveryId, 'rejected')
          await secondDecided.promise
          const winner = secondOutcome
          await reply(parseRemoteEventResult({ clientId: ready.clientId, eventId: localFrame.eventId, outcome: { kind: 'result', value: 'allowed-once' } }))
          add('events.two-client-first-wins', winner === 'rejected' && outcome === 'allowed-once')
          const question = await delivery(third.iterator)
          if (question.event !== 'user-questions/request') throw new Error('fixture expected public question waterfall')
          const answer: Parameters<InteractionBridge['answer']>[1] = { answers: [{ id: 'choice', selected: ['Fixture B'] }, { id: 'text', selected: [], custom: 'Synthetic typed answer' }] }
          await third.bridge.answer(question.deliveryId, answer)
          await questionDecided.promise
          add('events.question-choice-text-result', questionOutcome !== undefined && JSON.stringify(questionOutcome) === JSON.stringify(answer))
          await streamFinished.promise
          await third.bridge.dispose(); await third.iterator.return?.()
          fence.invalidate()
          return outcome === 'allowed-once' && winner === 'rejected'
        }
        if (matched && fixturePaused) {
          await writeFile(join(dir, '.web-control-probe-state.json'), JSON.stringify({ state: 'approval-pending' }))
          await new Promise<void>((_, reject) => {
            const fail = () => reject(control.signal.reason)
            if (control.signal.aborted) fail()
            else control.signal.addEventListener('abort', fail, { once: true })
          })
        }
        const fetch = ctx.connection.createSharedFetchHandler('/api')
        const response = await fetch.fetch(new Request('http://localhost/api/$events/result', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request',
            rpcId: randomUUID(), method: '$events/result', payload: { args: { clientId: ready.clientId,
              eventId: frame.eventId, outcome: matched ? { kind: 'result', value: 'allowed-once' } : { kind: 'next' } } } }), signal: control.signal }))
        const reply = await response.json() as { result: { ok: boolean } }
        if (matched) {
          if (!response.ok || !reply.result.ok) return false
          await streamFinished.promise
          return outcome === 'allowed-once'
        }
      }
      return false
    })
    if (marker.task7Images === true) {
      add('session.image-model-content', modelImageVerified, 'actual synthetic model request must contain a verified image block')
      await check('session.prompt-completed-retry', async () => {
        if (!task7Adapter || !task7Command || !agent) return false
        const count = async (requestId: string): Promise<number> => {
          const observer = ctx.sessionController.follow({ address: { kind: 'session', sessionId: SessionId(sessionId) }, maxMessages: 100 }, control.signal)[Symbol.asyncIterator]()
          try {
            const frame: import('@deepseek-ai/dsh-api-session-controller').SessionFollowFrame | undefined = (await observer.next()).value
            return frame?.type === 'snapshot' ? frame.records.filter(record => record.event.type === 'user/message' && (record.event.data as { source?: { rpcId?: string } }).source?.rpcId === requestId).length : -1
          } finally { await observer.return?.() }
        }
        const settle = async (requestId: string): Promise<void> => {
          // A model stream finish is earlier than turn closure. Observe the actual user message and durable boundary.
          const observer = ctx.sessionController.follow({ address: { kind: 'session', sessionId: SessionId(sessionId) }, maxMessages: 100 }, control.signal)[Symbol.asyncIterator]()
          let seen = false
          try {
            while (!seen || ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.openTurnStartSeq !== null || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
              const next = await observer.next()
              if (next.done) throw new Error('fixture completion stream ended before settlement')
              const frame: import('@deepseek-ai/dsh-api-session-controller').SessionFollowFrame = next.value
              const records = frame.type === 'snapshot' ? frame.records : frame.type === 'event' ? [frame] : []
              if (records.some(record => record.event.type === 'user/message' && (record.event.data as { source?: { rpcId?: string } }).source?.rpcId === requestId)) seen = true
            }
          } finally { await observer.return?.() }
        }
        await settle(task7Command.requestId)
        const duplicates = await count(task7Command.requestId)
        add('session.prompt-deduplicated', duplicates === 1, 'after all admitted turns settled, repeated requestId produced ' + duplicates + ' persisted user-message occurrences')
        if (!task7Receipt) return false
        const naturallyRetired = ctx.fileUploads.resolve(agent, task7Receipt) === undefined
        add(naturallyRetired ? 'session.image-binding-observation-retired' : 'session.image-binding-explicit-retirement-required', true)
        // Exercise only this fixture's staged ownership; never delete attachment bytes or user files.
        ctx.fileUploads.retirePrompt(agent, task7Command.requestId)
        const retired = ctx.fileUploads.resolve(agent, task7Receipt) === undefined
        add('session.image-receipt-retirement', retired, 'owned bound receipt must be unavailable after public retirement')
        const restarted = new DshSessionAdapter(ctx).withAdmission(() => control.signal.throwIfAborted())
        await restarted.prompt({ ...task7Command, reconcileOnly: true }, control.signal)
        const repeated = await count(task7Command.requestId)
        add('session.prompt-completed-occurrences', repeated === 1, 'recreated adapter reconciliation after receipt retirement observed ' + repeated + ' persisted occurrences')
        return retired && repeated === 1
      })
    }
    if (marker.task7Images === true) await check('session.stop-preserves-pending-inbox', async () => {
      if (!task7Adapter || !agent) return false
      holdForStop = true
      await task7Adapter.prompt({ op: 'session.prompt', sessionId, requestId: randomUUID(), mode: 'queue', content: [{ kind: 'text', text: 'Hold this synthetic turn for the stop fixture' }] }, control.signal)
      const abortStart = () => stopStarted.reject(control.signal.reason)
      control.signal.addEventListener('abort', abortStart, { once: true })
      try { control.signal.throwIfAborted(); await stopStarted.promise }
      finally { control.signal.removeEventListener('abort', abortStart) }
      const pendingId = randomUUID()
      await task7Adapter.prompt({ op: 'session.prompt', sessionId, requestId: pendingId, mode: 'queue', content: [{ kind: 'text', text: 'Pending input must survive synchronous stop' }] }, control.signal)
      const nextTurn = [...agent.inbox.nextTurn]
      const nextStep = [...agent.inbox.nextStep]
      const pendingContent = JSON.stringify([nextTurn, nextStep])
      const token = task7Adapter.currentStopToken(sessionId)
      if (!token || !nextTurn.some(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === pendingId)) return false
      // No await between native cancellation and identity/content assertions on the actual Agent.
      const result = task7Adapter.stop(sessionId, token)
      return !!result && typeof result === 'object' && !Array.isArray(result) && result.accepted === true
        && ctx.agents.get(SessionId(sessionId)) === agent
        && JSON.stringify([agent.inbox.nextTurn, agent.inbox.nextStep]) === pendingContent
        && agent.inbox.nextTurn.length === nextTurn.length && agent.inbox.nextTurn.every((message, index) => message === nextTurn[index])
        && agent.inbox.nextStep.length === nextStep.length && agent.inbox.nextStep.every((message, index) => message === nextStep[index])
    })
    if (marker.task9Files === true) await check('files.native-fixture', async () => {
      const evidence = await verifyNativeFiles(ctx, sessionId, workspacePath, control.signal, join(dir, '.web-control-files-fixture.json'))
      await writeFile(join(dir, '.web-control-files-fixture.json'), JSON.stringify(evidence))
      return Object.entries(evidence).every(([key, value]) => typeof value === 'boolean' ? (key === 'nativeSummaryHasSnapshot' || value) : key === 'nativeBytes' ? value === 32 * 1024 * 1024 : key === 'uploadPeakBytes' && typeof value === 'number' && value <= 4 * (65536 + 44))
    })
    await check('events.cancelled', () => verifyEventCancellation(ctx, control.signal))
    await check('session.cancel-request', async () => {
      const result = await invoke('session', 'cancel', { request: { sessionId } }) as { accepted: boolean }
      return result.accepted === true
    })
  } catch {
    // No error text crosses the report: Host failures may contain credentials or paths.
  } finally {
    control.abort()
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    let clean = true
    if (fixtureSessionId && promptAccepted) {
      try { await ctx.typertGateway.invoke({ namespace: 'session', method: 'cancel', args: { request: { sessionId: fixtureSessionId } } }) } catch { clean = false }
      try { if (modelStarted) await streamSettled } catch { clean = false }
    }
    for (const bridge of task8Bridges) { try { await bridge.dispose() } catch { clean = false } }
    try { await eventIterator?.return?.() } catch { clean = false }
    try { disposeAdapter?.() } catch { clean = false }
    if (workspaceId) {
      try { await ctx.typertGateway.invoke({ namespace: 'workspace', method: 'delete', args: { request: { workspaceId } } }) } catch { clean = false }
    }
    try { await rm(workspacePath, { recursive: true, force: true }) } catch { clean = false }
    add('fixture.cleanup', clean, 'isolated fixture cleanup failed')
    completed.add('fixture.cleanup')
    if (fixturePaused) await writeFile(join(dir, '.web-control-probe-state.json'), JSON.stringify({ state: 'cleaned', clean }))
    for (const name of behaviorNames) if (!completed.has(name)) add(name, false, 'not executed: prerequisite operation failed')
  }
}

/** Child stream acquisition and next() remain owned until abort cleanup settles. */
export async function verifyEventCancellation(ctx: Context, parent: AbortSignal): Promise<boolean> {
  const child = new AbortController()
  const signal = AbortSignal.any([parent, child.signal])
  let iterator: AsyncIterator<unknown> | undefined
  try {
    signal.throwIfAborted()
    const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} },
      (async function* () {})(), undefined, signal)
    iterator = stream[Symbol.asyncIterator]()
    if ((await iterator.next()).done) return false
    parent.throwIfAborted()
    child.abort()
    try { return (await iterator.next()).done === true }
    catch (error) { return error instanceof Error && error.name === 'AbortError' }
  } finally { child.abort(); await iterator?.return?.() }
}
