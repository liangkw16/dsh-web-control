import { test, expect, vi } from 'vitest'
import { NativeFileRoutes } from '../src/native-ui/file-routes.ts'
import type { BrowserTransport } from '../src/transport.ts'
import { NativeDownloads, downloadName } from '../src/native-ui/files.ts'
const stat = { absolutePath: '/workspace/image.png', relativePath: 'image.png', version: 'v1', bytes: 3 }
const payload = (extra = {}) => ({ args: { workspaceFileScopeId: 's', path: 'image.png', ...extra } })
const signal = () => new AbortController().signal
function fixture() {
  const call = vi.fn(async (command: any) => command.op === 'file.stat' ? { ok: true, value: stat } : { ok: true, value: { absolutePath: stat.absolutePath, version: stat.version, bytes: 3, offset: command.offset, text: 'abc', lines: 1, eof: true } })
  const readFileRange = vi.fn(async (command: any) => ({ blob: new Blob([new Uint8Array([0,255,5])]), metadata: { transferId: crypto.randomUUID(), name: 'image.png', mediaType: 'application/octet-stream', bytes: 3, offset: command.offset, eof: true } }))
  const watch = vi.fn(async function* () { yield { kind: 'ready' }; yield { kind: 'change', change: { absolutePath: stat.absolutePath, version: 'v2' } } })
  const routes = new NativeFileRoutes({ call, readFileRange, watch } as unknown as BrowserTransport, true)
  return { call, readFileRange, watch, routes }
}
test('stock byte response contains native Uint8Array and no bridge-only metadata', async () => {
  const f = fixture(), response = await f.routes.call('/api', 'workspaceFiles/readBytes', payload({ options: {} }), signal()) as any
  expect(response).toMatchObject({ ok: true, value: { absolutePath: stat.absolutePath, version: 'v1', bytes: 3, offset: 0, eof: true } })
  expect(response.value.data).toBeInstanceOf(Uint8Array); expect([...response.value.data]).toEqual([0,255,5]); expect(response.value.relativePath).toBeUndefined()
  expect(f.readFileRange.mock.calls[0][0]).toEqual({ sessionId: 's', path: 'image.png', version: 'v1', offset: 0, length: 3 })
})
test('text and dependency routes use exact native arguments and explicit versioned reads', async () => {
  const f = fixture()
  expect(await f.routes.call('/api', 'workspaceFiles/read', payload({ range: { offset: 2, limit: 4 } }), signal())).toMatchObject({ ok: true, value: { offset: 2, text: 'abc' } })
  expect(f.call.mock.calls[1][0]).toEqual({ op: 'file.text', sessionId: 's', path: 'image.png', version: 'v1', offset: 2, limit: 4 })
  await f.routes.call('/api', 'workspaceFiles/readBytes', { args: { workspaceFileScopeId: 's', path: '../image.png', options: { baseFile: '/workspace/docs/a.html' } } }, signal())
  expect(f.call.mock.calls[2][0]).toEqual({ op: 'file.stat', sessionId: 's', path: '../image.png', baseFile: '/workspace/docs/a.html' })
})
test.each(['missing', 'outside', 'not-text', 'too-large', 'not-regular'] as const)('file failure %s keeps native domain error semantics', async code => {
  const f = fixture(); f.call.mockResolvedValue({ ok: false, code } as any)
  const reply = await f.routes.call('/api', 'workspaceFiles/stat', payload(), signal()) as any
  expect(reply.ok).toBe(false); expect(reply.error.code).toMatch(/^workspace-file\//); expect(f.readFileRange).not.toHaveBeenCalled()
})
test('unknown routes, keys and unsupported Host never forward a generic RPC', async () => {
  const f = fixture()
  for (const [endpoint, data] of [['workspaceFiles/list', payload()], ['workspaceFiles/stat', payload({ namespace: 'fs' })], ['workspaceFiles/readBytes', payload({ options: { range: { offset: -1 } } })]] as const) expect((await f.routes.call('/api', endpoint, data, signal()) as any).ok).toBe(false)
  expect(f.call).not.toHaveBeenCalled()
  const disabled = new NativeFileRoutes({ call: f.call } as unknown as BrowserTransport, false)
  expect(await disabled.call('/api', 'workspaceFiles/stat', payload(), signal())).toMatchObject({ ok: false, error: { code: 'PROTOCOL_UNSUPPORTED' } })
})
test('changes preserve native ready/change frames and disposal cancels callers', async () => {
  const f = fixture(), frames = []
  for await (const value of f.routes.open('/api', 'workspaceFiles/changes', payload(), signal())) frames.push(value)
  expect(frames).toEqual([{ kind: 'ready' }, { kind: 'change', change: { absolutePath: stat.absolutePath, version: 'v2' } }])
  const pending = Promise.withResolvers<any>(); f.call.mockReturnValue(pending.promise)
  const request = f.routes.call('/api', 'workspaceFiles/stat', payload(), signal()); f.routes.dispose(); pending.resolve({ ok: true, value: stat })
  expect(await request).toMatchObject({ ok: false })
})
test('stock download seats share one pending download and releasing the last seat cancels it', async () => {
  const pending = Promise.withResolvers<any>(), listeners = new Set<() => void>(), save = vi.fn(() => () => {})
  const call = vi.fn(async () => ({ ok: true, value: stat })), download = vi.fn(() => pending.promise)
  const transport = { call, download, getSnapshot: () => ({ phase: 'ready', fence: { controlId: 'a' } }), subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } }
  const files = new NativeDownloads(transport as unknown as BrowserTransport, save), key = files.key('s', stat.absolutePath)
  const releaseOne = files.retain(key), releaseTwo = files.retain(key)
  const first = files.start('s', stat.absolutePath); await files.start('s', stat.absolutePath); await Promise.resolve()
  expect(download).toHaveBeenCalledTimes(1); expect(download.mock.calls[0]).toMatchObject(['s', 'image.png', expect.any(AbortSignal), 'v1'])
  releaseOne(); expect((download.mock.calls[0] as unknown as any[])[2].aborted).toBe(false)
  releaseTwo(); expect((download.mock.calls[0] as unknown as any[])[2].aborted).toBe(true)
  pending.resolve({ blob: new Blob(['x']), name: 'x' }); await first; expect(save).not.toHaveBeenCalled(); files.dispose(); expect(listeners.size).toBe(0)
})
test('native download uses safe filenames and releases its owned URL on disposal', async () => {
  const release = vi.fn(), save = vi.fn(() => release)
  const transport = { call: vi.fn(async () => ({ ok: true, value: stat })), download: vi.fn(async () => ({ blob: new Blob(['abc']), name: '../bad\0name.txt' })), getSnapshot: () => ({ phase: 'ready', fence: null }), subscribe: () => () => {} }
  const files = new NativeDownloads(transport as unknown as BrowserTransport, save)
  files.retain(files.key('s', 'x')); await files.start('s', 'x')
  expect(save).toHaveBeenCalledWith(expect.any(Blob), 'bad_name.txt'); expect(downloadName('..')).toBe('_')
  files.dispose(); expect(release).toHaveBeenCalledOnce()
})
test('closing the final native tab releases completed download URLs immediately', async () => {
  const release = vi.fn(), save = vi.fn(() => release)
  const transport = { call: vi.fn(async () => ({ ok: true, value: stat })), download: vi.fn(async () => ({ blob: new Blob(['abc']), name: 'x' })), getSnapshot: () => ({ phase: 'ready', fence: null }), subscribe: () => () => {} }
  const files = new NativeDownloads(transport as unknown as BrowserTransport, save), close = files.retain(files.key('s', 'x'))
  await files.start('s', 'x'); close(); expect(release).toHaveBeenCalledOnce()
  files.dispose(); expect(release).toHaveBeenCalledOnce()
})
