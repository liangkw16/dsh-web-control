/** Task-owned, opt-in native acceptance fixture. No execution on import or ordinary startup. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HostFence } from '../control-fence.ts'
import { SessionScope } from '../adapter/scope.ts'
import { FileService } from '../files.ts'
import { UploadManager } from '../uploads.ts'
import { jsonObject, publicJson } from '../adapter/dsh-v021.ts'
import { ProtocolError } from '../../../protocol/src/index.ts'

export async function verifyNativeFiles(ctx: Context, sessionId: string, workspacePath: string, signal: AbortSignal, evidencePath: string): Promise<Record<string, boolean | number | string>> {
  const incoming = { instanceId: randomUUID(), runtimeId: randomUUID(), controlId: randomUUID(), authEpoch: 1 }
  const identity = { instanceId: incoming.instanceId, authEpoch: 1, enabled: true, relayOrigin: 'https://relay.test', deviceSecret: Buffer.alloc(32, 1).toString('base64url'), linkSecret: Buffer.alloc(32, 2).toString('base64url') }
  const fence = new HostFence(incoming.instanceId, incoming.runtimeId, () => identity); fence.install(incoming)
  const membership = () => ctx.workspaceRegistry.list().map(workspace => ({ workspaceId: workspace.id, sessionIds: workspace.sessionIds }))
  const scope = new SessionScope(membership, ctx)
  const files = new FileService(ctx, scope, () => { signal.throwIfAborted(); fence.check(incoming) })
  const outside = workspacePath + '-outside'
  const result: Record<string, boolean | number | string> = {}
  let credits = 0; let reserved = 0; let peak = 0
  const uploads = new UploadManager(ctx, fence, scope, { failed() {}, credit(_id, _fence, count) { credits += count }, reserve(bytes) { reserved += bytes; peak = Math.max(peak, reserved); return () => { reserved -= bytes } } })
  const onAbort = () => { fence.invalidate(); uploads.dispose() }; signal.addEventListener('abort', onAbort, { once: true })
  try {
    await mkdir(outside); await writeFile(join(outside, 'secret'), 'owned outside fixture')
    await symlink(join(outside, 'secret'), join(workspacePath, 'linked'))
    result.symlinkDenied = await denied(() => scope.assertRecordedFile(sessionId, 'linked', workspacePath, signal))
    result.relativeEscapeDenied = await denied(() => scope.assertRecordedFile(sessionId, '../secret', workspacePath, signal))
    await scope.assertRecordedFile(sessionId, 'absent.txt', workspacePath, signal); result.absentRecordedAllowed = true
    // Demonstrate the actual public rc.2 read boundary using only our own outside fixture.
    const unconfined = await ctx.typertGateway.invoke({ namespace: 'workspaceFiles', method: 'read', args: { workspaceFileScopeId: sessionId, path: join(outside, 'secret'), range: {} }, signal })
    result.publicOutsideReadObserved = JSON.stringify(unconfined).includes('owned outside fixture')
    try { await files.readFile({ op: 'file.read', sessionId, path: 'synthetic.txt', offset: 0, length: 8 }, signal); result.previewUnsupported = false }
    catch (error) { result.previewUnsupported = error instanceof ProtocolError && error.code === 'PROTOCOL_UNSUPPORTED' }
    // A real ancestor replacement, deterministically scheduled between public filesystem calls.
    const directory = join(workspacePath, 'race'); await mkdir(directory); await writeFile(join(directory, 'secret'), 'inside')
    const first = Promise.withResolvers<void>(); const replaced = Promise.withResolvers<void>()
    const abortRace = () => { first.reject(signal.reason); replaced.resolve() }
    signal.addEventListener('abort', abortRace, { once: true })
    let paused = false
    const racing = new SessionScope(membership, { typert: ctx.typert, sessions: ctx.sessions, fs: new Proxy(ctx.fs, { get(target, key) {
      if (key === 'lstat') return async (...args: Parameters<typeof ctx.fs.lstat>) => {
        const entry = await ctx.fs.lstat(...args)
        if (!paused && args[0] === 'race') { paused = true; first.resolve(); await replaced.promise }
        return entry
      }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } }) })
    const check = denied(() => racing.assertRecordedFile(sessionId, 'race/secret', workspacePath, signal))
    try { await first.promise; await rename(directory, directory + '-old'); await symlink(outside, directory) }
    finally { replaced.resolve(); signal.removeEventListener('abort', abortRace) }
    result.concurrentAncestorReplacementDenied = await check
    const foreignValue = jsonObject(publicJson(await ctx.typertGateway.invoke({ namespace: 'session', method: 'create', args: { request: { workspaceId: membership().find(item => item.sessionIds.includes(SessionId(sessionId)))!.workspaceId } }, signal })))
    if (typeof foreignValue.sessionId !== 'string') throw new Error('foreign fixture session missing')
    const id = randomUUID(); const bytes = 32 * 1024 * 1024
    uploads.open(id, incoming, { sessionId, name: 'native-task9.bin', mediaType: 'image/png', bytes })
    let index = 0
    while (index * 65536 < bytes) {
      signal.throwIfAborted()
      if (!credits) { await new Promise(resolve => setImmediate(resolve)); continue }
      credits--; await uploads.chunk(id, index++, new Uint8Array(65536).fill(7))
      await new Promise(resolve => setImmediate(resolve))
    }
    const receipt = jsonObject(await uploads.end(id, index))
    const agent = ctx.agents.get(SessionId(sessionId)); const foreign = ctx.agents.get(SessionId(foreignValue.sessionId))
    if (!agent || !foreign || typeof receipt.receiptId !== 'string') throw new Error('native fixture receiver missing')
    // Public durable DTO is native; resolve signature supplies its receipt identity type without private imports.
    const nativeReceipt = receipt.receiptId as Parameters<typeof ctx.fileUploads.resolve>[1]
    const file = ctx.fileUploads.resolve(agent, nativeReceipt)
    result.nativeReceipt = !!file && file.bytes === bytes
    result.crossSessionDenied = ctx.fileUploads.resolve(foreign, nativeReceipt) === undefined
    let actual = 0
    if (file) for await (const chunk of ctx.attachments.readFileStream(file, signal)) { actual += chunk.byteLength; if (chunk.some(byte => byte !== 7)) throw new Error('native upload bytes changed') }
    result.nativeBytes = actual; result.uploadPeakBytes = peak; result.uploadReleased = reserved === 0
    const follow = ctx.sessionController.follow({ address: { kind: 'session', sessionId: SessionId(sessionId) }, maxMessages: 100 }, signal)[Symbol.asyncIterator]()
    try {
      let seq: number | undefined
      while (seq === undefined) {
        const next = await follow.next(); if (next.done) throw new Error('native change event missing')
        const frame = next.value; const records = frame.type === 'snapshot' ? frame.records : frame.type === 'event' ? [frame] : []
        seq = records.find(record => record.event.type === 'workspace/changes')?.event.seq
      }
      const summary = ctx.workspaceChanges.summary(SessionId(sessionId), seq)
      const index = summary?.files.findIndex(file => file.path === 'native-recorded.txt') ?? -1
      if (index < 0) throw new Error('native recorded file missing')
      const visible = jsonObject(await files.readChanges(sessionId, seq))
      result.nativeRecordedSummary = Array.isArray(visible.files) && visible.files.some(raw => { const file = jsonObject(raw); return file.index === index && file.path === 'native-recorded.txt' })
      result.nativeSummaryHasSnapshot = summary?.snapshot !== undefined
      const diff = jsonObject(await files.readDiff(sessionId, seq, index, signal))
      result.nativeRecordedDiff = diff.kind === 'text' && JSON.stringify(diff).includes('native task9 historical content')
      await rm(join(workspacePath, 'native-recorded.txt'))
      result.deletedHistoryPreserved = JSON.stringify(await files.readDiff(sessionId, seq, index, signal)) === JSON.stringify(diff)
      result.missingHistoryUnavailable = JSON.stringify(await files.readChanges(sessionId, Number.MAX_SAFE_INTEGER)) === '{"status":"unavailable"}'
    } finally { await follow.return?.() }
    return result
  } catch (error) { result.failure = error instanceof Error ? error.message.replaceAll(workspacePath, '[workspace]').replaceAll(outside, '[outside]') : 'unknown'; throw error }
  finally { await writeFile(evidencePath, JSON.stringify(result)); signal.removeEventListener('abort', onAbort); uploads.dispose(); fence.invalidate(); await rm(outside, { recursive: true, force: true }) }
}
async function denied(action: () => Promise<void>): Promise<boolean> { try { await action(); return false } catch (error) { return error instanceof ProtocolError && error.code === 'OUT_OF_SCOPE' } }
