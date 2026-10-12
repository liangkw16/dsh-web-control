/** Opt-in, task-owned public native fixture. Never runs without isolated profile marker. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export async function nativeUiFixture(ctx: Context, dir: string, owner?: AbortSignal): Promise<boolean> {
  const marker = JSON.parse(await readFile(join(dir, '.web-control-compat.json'), 'utf8'))
  if (marker.isolated !== true || marker.task15UI !== true) return false
  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(240000), ...(owner ? [owner] : [])])
  const path = join(dir, '.web-control-fixtures', randomUUID())
  let workspaceId: string | undefined, sessionId: string | undefined, dispose: (() => void) | undefined
  const tasks = new Set<Promise<void>>()
  let approvals = 0, starts = 0, stops = 0
  const invoke = (namespace: string, method: string, args: Record<string, unknown>) => ctx.typertGateway.invoke({ namespace, method, args, signal }) as Promise<any>
  try {
    await mkdir(path, { recursive: true })
    workspaceId = (await invoke('workspace', 'create', { request: { path } })).workspace.workspaceId
    sessionId = (await invoke('session', 'create', { request: { workspaceId } })).sessionId
    class FixtureAdapter extends LlmAdapter {
      override async listModels(provider: string) { return [{ provider, id: 'synthetic', name: 'Task15 isolated', inputModalities: ['text'] as const }] }
      override async resolveModel(provider: string, id: string) { return { provider, id, name: 'Task15 isolated', inputModalities: ['text'] as const } }
      override async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
        if (options.purpose) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
        const active = AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])])
        const completed = Promise.withResolvers<void>(); tasks.add(completed.promise)
        try {
          starts++
          const agent = ctx.agents.get(SessionId(sessionId!))
          if (!agent) throw new Error('fixture agent unavailable')
          const decision = await ctx.approval.request({ agent, toolName: 'task15-isolated-native', signal: active })
          if (decision === 'allowed-once') approvals++
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'Task15 native live output' }
          await new Promise<void>(resolve => { if (active.aborted) resolve(); else active.addEventListener('abort', () => resolve(), { once: true }) })
          active.throwIfAborted()
        } finally { stops++; completed.resolve(); tasks.delete(completed.promise) }
      }
    }
    const llm = ctx.get('llm'); if (!llm) throw new Error('fixture llm missing')
    dispose = llm.registerAdapter(['web-control-task15'], new FixtureAdapter())
    await invoke('session', 'selectModel', { request: { sessionId, provider: 'web-control-task15', model: 'synthetic' } })
    await invoke('session', 'rename', { request: { sessionId, title: 'Task15 native session' } })
    await invoke('session', 'prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Task15 local long turn' }] } })
    await writeFile(join(dir, '.web-control-ui-state.json'), JSON.stringify({ state: 'ready', sessionId, workspaceId }))
    while (!signal.aborted) {
      try { if (JSON.parse(await readFile(join(dir, '.web-control-ui-done.json'), 'utf8')).done === true) break } catch {}
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    signal.throwIfAborted()
    await writeFile(join(dir, '.web-control-ui-state.json'), JSON.stringify({ state: 'finished', sessionId, workspaceId, starts, approvals, stops }))
    return starts >= 2 && approvals >= 2 && stops >= 2
  } finally {
    let clean = true
    lifetime.abort()
    if (sessionId) await ctx.typertGateway.invoke({ namespace: 'session', method: 'cancel', args: { request: { sessionId } } }).catch(() => { clean = false })
    await Promise.all(tasks)
    dispose?.()
    if (workspaceId) await ctx.typertGateway.invoke({ namespace: 'workspace', method: 'delete', args: { request: { workspaceId } } }).catch(() => { clean = false })
    await rm(path, { recursive: true, force: true })
    await writeFile(join(dir, '.web-control-ui-cleanup.json'), JSON.stringify({ clean, pendingModelStreams: tasks.size }))
    if (!clean) throw new Error('isolated UI fixture cleanup failed')
  }
}
