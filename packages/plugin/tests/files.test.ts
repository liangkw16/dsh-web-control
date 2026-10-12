import { expect, test } from 'vitest'
import { validateRelativePath } from '../src/files.ts'
test.each(['../secret', '/etc/passwd', 'C:\\secret', 'a/../../secret', 'a\u0000b', '\\\\server\\share', 'a\\..\\secret', 'file:///secret'])('refuses external path %s', path => {
  expect(() => validateRelativePath(path)).toThrow('OUT_OF_SCOPE')
})
test('encoded traversal remains a literal filename, never decoded twice', () => {
  expect(validateRelativePath('%2e%2e/file')).toBe('%2e%2e/file')
})
import type { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'
import { FileService, encodeDiff } from '../src/files.ts'
import { SessionScope } from '../src/adapter/scope.ts'
function fixture() {
  let selected = ['a']; let root = 'remote:/workspace'; let workspaceId = 'w'
  let liveSession: { header: { cwd: string } } | undefined = { header: { cwd: root } }
  const summary = { turn: 1, cwd: root, files: [
    { path: '../outside', display: '../outside', added: 9, deleted: 9 },
    { path: 'deleted.txt', display: 'deleted.txt', added: 0, deleted: 2 },
    { path: 'leak.txt', display: '/private/secret', added: 9, deleted: 9 },
  ], total: 3, added: 18, deleted: 20 }
  const diff = vi.fn(async () => ({ kind: 'text', path: 'deleted.txt', display: 'deleted.txt', before: true, after: false, coarse: true, hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 0, lines: ['-one', '-two'] }] }))
  const fs = { resolve: vi.fn(async (path: string, opts?: { cwd?: string }) => ({ targetKey: path.startsWith('remote:') ? path : opts?.cwd + '/' + path, displayPath: path })),
    processPath: (target: { targetKey: string }) => target.targetKey,
    contains: (parent: { targetKey: string }, target: { targetKey: string }) => target.targetKey === parent.targetKey || target.targetKey.startsWith(parent.targetKey + '/'),
    lstat: vi.fn(async () => undefined), stat: vi.fn(async () => undefined),
  }
  const ctx = { fs, sessions: { get: () => liveSession }, typert: { lookups: { get: () => ({ resolve: async () => ({ sessionId: 'a', workspaceRoot: root }) }) } }, workspaceChanges: { summary: vi.fn(() => summary), diff }, typertGateway: { invoke: vi.fn() } } as unknown as Context
  const scope = new SessionScope(() => [{ workspaceId, sessionIds: selected }], ctx)
  const admission = vi.fn(); const files = new FileService(ctx, scope, admission)
  return { files, ctx, fs, diff, summary, admission, setWorkspace: (value: string) => { workspaceId = value }, setSelected: (value: string[]) => { selected = value }, setRoot: (value: string) => { root = value; liveSession = { header: { cwd: value } } }, dropSession: () => { liveSession = undefined } }
}
test('filters summary paths and display and preserves original index for absent recorded file', async () => {
  const f = fixture(); expect(await f.files.readChanges('a', 3)).toEqual({ turn: 1, files: [{ index: 1, path: 'deleted.txt', display: 'deleted.txt', added: 0, deleted: 2 }], total: 1, added: 0, deleted: 2 })
  expect(await f.files.readDiff('a', 3, 1, new AbortController().signal)).toMatchObject({ kind: 'text', coarse: true, after: false })
  expect(f.diff).toHaveBeenCalledWith('a', 3, 1, expect.any(AbortSignal))
  await expect(f.files.readDiff('a', 3, 0, new AbortController().signal)).rejects.toThrow('OUT_OF_SCOPE')
})
test('cleared history is unavailable without current-file fallback', async () => {
  const f = fixture(); vi.mocked(f.ctx.workspaceChanges.summary).mockReturnValue(undefined)
  expect(await f.files.readChanges('a', 3)).toEqual({ status: 'unavailable' })
  expect(await f.files.readDiff('a', 3, 1, new AbortController().signal)).toEqual({ status: 'unavailable' }); expect(f.diff).not.toHaveBeenCalled()
})
test('scope revocation after public diff suppresses result', async () => {
  const f = fixture(); f.diff.mockImplementation(async () => { f.setSelected([]); return { kind: 'text', path: 'deleted.txt', display: 'deleted.txt', before: true, after: false, coarse: true, hunks: [] } })
  await expect(f.files.readDiff('a', 3, 1, new AbortController().signal)).rejects.toThrow('OUT_OF_SCOPE')
})
test('historical cwd must match latest Host root and present links are refused', async () => {
  const f = fixture(); f.setRoot('remote:/new')
  await expect(f.files.readDiff('a', 3, 1, new AbortController().signal)).rejects.toThrow('OUT_OF_SCOPE')
  expect(f.diff).not.toHaveBeenCalled()
})
test('live preview fails closed before any public file read on rc.2', async () => {
  const f = fixture()
  await expect(f.files.readFile({ op: 'file.read', sessionId: 'a', path: 'safe.txt', offset: 0, length: 4 }, new AbortController().signal)).rejects.toThrow('PROTOCOL_UNSUPPORTED')
  expect(f.ctx.typertGateway.invoke).not.toHaveBeenCalled()
})
test('diff encoder strictly preserves public states and rejects extras', () => {
  expect(encodeDiff(undefined)).toEqual({ status: 'unavailable' })
  expect(encodeDiff({ kind: 'binary', path: 'x', display: 'x' })).toEqual({ kind: 'binary', path: 'x', display: 'x' })
  expect(encodeDiff({ kind: 'oversized', path: 'x', display: 'x' })).toEqual({ kind: 'oversized', path: 'x', display: 'x' })
  expect(() => encodeDiff({ kind: 'binary', path: '../x', display: 'x' })).toThrow('OUT_OF_SCOPE')
})
test('changed native diff path and revoked admission cannot emit data', async () => {
  const f = fixture(); f.diff.mockImplementation(async () => ({ kind: 'text', path: '../secret', display: 'deleted.txt', before: true, after: false, coarse: true, hunks: [] }))
  await expect(f.files.readDiff('a', 3, 1, new AbortController().signal)).rejects.toThrow('OUT_OF_SCOPE')
  f.admission.mockImplementation(() => { throw new Error('STALE_CONTROL') })
  await expect(f.files.readChanges('a', 3)).rejects.toThrow('STALE_CONTROL')
})
test('public diff DTO rejects unknown fields and malformed hunk bodies', () => {
  const extra = { kind: 'binary' as const, path: 'x', display: 'x', private: 'secret' }
  expect(() => encodeDiff(extra)).toThrow('INVALID_MESSAGE')
  expect(() => encodeDiff({ kind: 'text', path: 'x', display: 'x', before: true, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['unprefixed'] }] })).toThrow('INVALID_MESSAGE')
})

test.each(['root', 'workspace'])('whole summary fails when %s changes after its first accepted entry', async kind => {
  const f = fixture()
  f.summary.files = ['first.txt', 'second.txt'].map(path => ({ path, display: path, added: 1, deleted: 0 }))
  let sawFirst = false
  f.fs.lstat.mockImplementation(async (...args: unknown[]) => {
    if (args[0] === 'first.txt') sawFirst = true
    if (args[0] === 'second.txt') {
      expect(sawFirst).toBe(true)
      if (kind === 'root') f.setRoot('remote:/new')
      else f.setWorkspace('new-workspace')
    }
    return undefined
  })
  await expect(f.files.readChanges('a', 3)).rejects.toThrow('OUT_OF_SCOPE')
})
test('whole summary rechecks root after the final public summary callback', async () => {
  const f = fixture(); let calls = 0
  vi.mocked(f.ctx.workspaceChanges.summary).mockImplementation(() => {
    if (++calls === 2) f.setRoot('remote:/new')
    return f.summary
  })
  await expect(f.files.readChanges('a', 3)).rejects.toThrow('OUT_OF_SCOPE')
})

test.each(['root', 'replacement', 'missing'])('whole summary rejects %s change during its final canonical resolver await', async kind => {
  const f = fixture()
  f.summary.files = ['first.txt', 'second.txt'].map(path => ({ path, display: path, added: 1, deleted: 0 }))
  let summaryCalls = 0; let armed = false; let switched = false
  vi.mocked(f.ctx.workspaceChanges.summary).mockImplementation(() => { if (++summaryCalls === 2) armed = true; return f.summary })
  const resolve = f.fs.resolve.getMockImplementation()!
  f.fs.resolve.mockImplementation(async (path, opts) => {
    if (armed && path === 'remote:/workspace') {
      armed = false; switched = true
      if (kind === 'missing') f.dropSession()
      else f.setRoot(kind === 'root' ? 'remote:/new' : 'remote:/workspace')
    }
    await Promise.resolve()
    return resolve(path, opts)
  })
  await expect(f.files.readChanges('a', 3)).rejects.toThrow('OUT_OF_SCOPE')
  expect(switched).toBe(true)
})

test('recorded summaries require a live Session even when registry and persisted lookup remain', async () => {
  const f = fixture(); f.dropSession()
  await expect(f.files.readChanges('a', 3)).rejects.toThrow('OUT_OF_SCOPE')
  expect(f.fs.resolve).not.toHaveBeenCalled()
})
test('final caller-side synchronous witness rejects Session replacement after its last await', async () => {
  const f = fixture(); let summaryCalls = 0; let finalCheck = false
  vi.mocked(f.ctx.workspaceChanges.summary).mockImplementation(() => { if (++summaryCalls === 2) finalCheck = true; return f.summary })
  f.admission.mockImplementation(() => { if (finalCheck) { finalCheck = false; f.setRoot('remote:/workspace') } })
  await expect(f.files.readChanges('a', 3)).rejects.toThrow('OUT_OF_SCOPE')
})

test('opted recorded diff retains a complete hunk larger than one wire frame', () => {
  const value = { kind: 'text' as const, path: 'large.txt', display: 'large.txt', before: true, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+' + '差异'.repeat(50000)] }] }
  expect(() => encodeDiff(value)).toThrow('LIMIT_EXCEEDED')
  expect(encodeDiff(value, 1024 * 1024)).toEqual(value)
})
