import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { expect, test } from 'vitest'
import { apply } from '../../packages/plugin/src/index.ts'
import { probeHost, verifyEventCancellation } from '../../packages/plugin/src/compat/probe.ts'

function eventFixture(delay: 'open' | 'ready') {
  let clients = 0, returns = 0
  const acquiring = Promise.withResolvers<void>()
  const wait = (signal: AbortSignal) => new Promise<never>((_, reject) => {
    const abort = () => setTimeout(() => { clients--; reject(signal.reason) }, 5)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  const gateway = { wireStream: { async open(_method: unknown, _args: unknown, _input: unknown, _options: unknown, signal: AbortSignal) {
    clients++
    acquiring.resolve()
    if (delay === 'open') await wait(signal)
    let ended = false
    return { [Symbol.asyncIterator]() { return {
      async next() { try { return await wait(signal) } finally { ended = true } },
      async return() { returns++; if (!ended) { clients--; ended = true }; return { done: true, value: undefined } },
    } } }
  } }, invoke() {}, stream() {} }
  return { gateway, acquiring: acquiring.promise, counts: () => ({ clients, returns }) }
}

test.each(['open', 'ready'] as const)('parent deadline settles delayed %s and leaves zero event clients', async delay => {
  const events = eventFixture(delay)
  const parent = new AbortController()
  const pending = verifyEventCancellation({ typertGateway: events.gateway } as unknown as Context, parent.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  const deadline = setTimeout(() => parent.abort(), 5)
  await events.acquiring
  await rejected
  clearTimeout(deadline)
  expect(events.counts()).toEqual({ clients: 0, returns: delay === 'open' ? 0 : 1 })
})

test('plugin disposal awaits an in-flight probe and cancels its pending event client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-control-lifetime-'))
  try {
    await writeFile(join(dir, '.web-control-compat.json'), '{"isolated":true}')
    const events = eventFixture('ready')
    let route: { fetch(request: Request): Promise<Response> } | undefined
    let dispose: (() => Promise<void>) | undefined
    const ctx = { profileContext: { dir }, typertGateway: events.gateway,
      connection: { createSharedFetchHandler() {}, fetch: { register(value: typeof route) { route = value } } },
      credentials: { modifyRecord() {} }, sessionController: { cancel() {} }, fileUploads: { uploadStream() {} },
      effect(effect: () => () => Promise<void>) { dispose = effect() },
    } as unknown as Context
    apply(ctx)
    const pending = route!.fetch(new Request('http://localhost/api/web-control/probe', { method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'web-control/probe' }) }))
    await events.acquiring
    await dispose!()
    const report = (await (await pending).json()).result.value
    expect(report.supported).toBe(false)
    expect(report.checks.find((check: { name: string }) => check.name === 'fixture.cleanup').ok).toBe(true)
    expect(events.counts()).toEqual({ clients: 0, returns: 1 })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('probe deadline awaits delayed readiness cleanup before returning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-control-deadline-'))
  try {
    await writeFile(join(dir, '.web-control-compat.json'), '{"isolated":true}')
    const events = eventFixture('ready')
    const ctx = { profileContext: { dir }, typertGateway: events.gateway,
      connection: { createSharedFetchHandler() {} }, credentials: { modifyRecord() {} },
      sessionController: { cancel() {} }, fileUploads: { uploadStream() {} },
    } as unknown as Context
    const report = await probeHost(ctx, { deadlineMs: 5 })
    expect(report.supported).toBe(false)
    expect(report.checks.find(check => check.name === 'events.ready-cancel')?.ok).toBe(false)
    expect(report.checks.find(check => check.name === 'fixture.cleanup')?.ok).toBe(true)
    expect(events.counts()).toEqual({ clients: 0, returns: 1 })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
