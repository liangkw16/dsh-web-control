import { test, expect, afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionScope } from '../src/adapter/scope.ts'
import { CurrentFileService } from '../src/current-files/service.ts'
import { supportsCurrentFiles } from '../src/current-files/provider.ts'
import { DEFAULT_LIMITS, ProtocolError } from '../../protocol/src/index.ts'
const disposals: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(disposals.splice(0).map(fn => fn())) })
const signal = () => new AbortController().signal
async function fixture(sandbox = false) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'dsh-current-service-'))), root = join(base, 'workspace')
  await fs.mkdir(root); await fs.writeFile(join(root, 'x.txt'), 'one\ntwo\n'); await fs.mkdir(join(root, 'docs')); await fs.writeFile(join(root, 'docs/doc.md'), 'doc'); await fs.writeFile(join(base, 'secret'), 'PRIVATE')
  const local = new Context()
  local.provide('sandboxPolicy')
  local.set('sandboxPolicy', { defaultMode: 'read-only' })
  if (sandbox) new SandboxedFileSystem(local, { cwd: root, diffBasisMaxBytes: 10485760, mode: 'read-only' } as ConstructorParameters<typeof SandboxedFileSystem>[1])
  else new LocalFileSystem(local, { cwd: root, diffBasisMaxBytes: 10485760 })
  disposals.push(async () => { await fs.rm(base, { recursive: true, force: true }) })
  let session: { header: { cwd: string } } | undefined = { header: { cwd: root } }, members = ['s'], workspaceId = 'w', lookupRoot = root
  const lookup = vi.fn(async () => ({ sessionId: 's', workspaceRoot: lookupRoot }))
  // Keep Cordis service resolution intact: each fs access is a fresh public
  // traceable proxy even when the underlying provider has not changed.
  local.provide('sessions', { get: () => session } as any)
  local.provide('typert', { lookups: { get: () => ({ resolve: lookup }) } } as any)
  const ctx = local
  const admission = vi.fn(), scope = new SessionScope(() => [{ workspaceId, sessionIds: members }], ctx, 'host-profile')
  const service = new CurrentFileService(ctx, scope, admission, DEFAULT_LIMITS)
  return { root, base, ctx, scope, service, lookup, admission, revoke: () => { members = [] }, move: () => { workspaceId = 'other' }, staleLookup: () => { lookupRoot = base }, replace: () => { session = { header: { cwd: root } } }, remove: () => { session = undefined } }
}
test('queued file metadata cannot publish after workspace membership is revoked',async()=>{
  const f=await fixture(),abort=new AbortController();let publication:(()=>void)|undefined
  const service=new CurrentFileService(f.ctx,f.scope,f.admission,DEFAULT_LIMITS,check=>{publication=check})
  const stream=service.changes('s','x.txt',abort.signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({kind:'ready'})
  expect(publication).toBeTypeOf('function');f.revoke();expect(publication).toThrow('OUT_OF_SCOPE')
  abort.abort();await stream.return?.()
})
test.each([false, true])('published Cordis filesystem supports current files (sandbox=%s)', async sandbox => {
  const f = await fixture(sandbox)
  expect(supportsCurrentFiles(f.ctx)).toBe(true)
  const stat = await f.service.stat({ op: 'file.stat', sessionId: 's', path: 'x.txt' }, signal()) as { ok: true; value: { version: string } }
  expect(stat).toMatchObject({ ok: true, value: { absolutePath: join(f.root, 'x.txt'), relativePath: 'x.txt', bytes: 8 } })
  expect(await f.service.text({ op: 'file.text', sessionId: 's', path: 'x.txt', version: stat.value.version, offset: 2, limit: 5 }, signal())).toMatchObject({ ok: true, value: { text: 'two', lines: 1, eof: true, offset: 2, bytes: 8 } })
})
test('native absolute and parent-relative document dependencies remain bound to one workspace', async () => {
  const f = await fixture()
  for (const path of ['x.txt', join(f.root, 'x.txt')]) expect(await f.service.stat({ op: 'file.stat', sessionId: 's', path }, signal())).toMatchObject({ ok: true })
  expect(await f.service.stat({ op: 'file.stat', sessionId: 's', path: '../x.txt', baseFile: 'docs/doc.md' }, signal())).toMatchObject({ ok: true, value: { relativePath: 'x.txt' } })
  for (const path of [join(f.base, 'secret'), '../../secret']) expect(await f.service.stat({ op: 'file.stat', sessionId: 's', path, baseFile: 'docs/doc.md' }, signal())).toEqual({ ok: false, code: 'outside' })
  expect(await f.service.stat({ op: 'file.stat', sessionId: 's', path: 'x.txt', baseFile: join(f.base, 'secret') }, signal())).toEqual({ ok: false, code: 'outside' })
})
test('symlinks are not hidden by canonical resolution and percent names stay literal', async () => {
  const f = await fixture(); await fs.symlink(join(f.root, 'x.txt'), join(f.root, 'alias')); await fs.symlink(f.base, join(f.root, 'link'))
  for (const path of ['alias', 'link/secret', 'link/../x.txt']) expect(await f.service.stat({ op: 'file.stat', sessionId: 's', path }, signal())).toEqual({ ok: false, code: 'outside' })
  await fs.mkdir(join(f.root, '%2e%2e')); await fs.writeFile(join(f.root, '%2e%2e/x'), 'literal')
  expect(await f.service.stat({ op: 'file.stat', sessionId: 's', path: '%2e%2e/x' }, signal())).toMatchObject({ ok: true, value: { relativePath: '%2e%2e/x' } })
})
test.each(['revoke', 'move', 'replace', 'remove', 'staleLookup'] as const)('refuses %s during public lookup without returning file content', async kind => {
  const f = await fixture(); const resolve = f.lookup.getMockImplementation()!
  f.lookup.mockImplementation(async () => { const value = await resolve(); f[kind](); return value })
  expect(await f.service.stat({ op: 'file.stat', sessionId: 's', path: 'x.txt' }, signal())).toEqual({ ok: false, code: 'outside' })
})
test('unknown providers, missing versions, changed files and stale control fail closed', async () => {
  const f = await fixture(), command = { op: 'file.read' as const, sessionId: 's', path: 'x.txt', offset: 0, length: 8 }
  await expect(f.service.open(command, signal())).rejects.toThrow('PROTOCOL_UNSUPPORTED')
  const stat = await f.service.stat({ op: 'file.stat', sessionId: 's', path: 'x.txt' }, signal()) as { ok: true; value: { version: string } }
  await fs.writeFile(join(f.root, 'x.txt'), 'different')
  await expect(f.service.open({ ...command, version: stat.value.version }, signal())).rejects.toMatchObject({ code: 'changed' })
  f.admission.mockImplementation(() => { throw new ProtocolError('STALE_CONTROL') })
  await expect(f.service.stat({ op: 'file.stat', sessionId: 's', path: 'x.txt' }, signal())).rejects.toThrow('STALE_CONTROL')
  f.admission.mockReset(); f.ctx.fs = { ...f.ctx.fs } as typeof f.ctx.fs
  expect(supportsCurrentFiles(f.ctx)).toBe(false)
  expect(await f.service.stat({ op: 'file.stat', sessionId: 's', path: 'x.txt' }, signal())).toEqual({ ok: false, code: 'unsupported' })
})
test('native invalidations are target metadata only and abort settles a waiting poll', async () => {
  const f = await fixture(), abort = new AbortController()
  // Only the actual delay is shortened. Filesystem authority still uses real I/O.
  const stream = f.service.changes('s', 'x.txt', abort.signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({ kind: 'ready' })
  await fs.writeFile(join(f.root, 'x.txt'), 'updated')
  expect((await stream.next()).value).toMatchObject({ kind: 'change', change: { absolutePath: join(f.root, 'x.txt'), version: expect.any(String) } })
  await fs.unlink(join(f.root, 'x.txt'))
  expect((await stream.next()).value).toEqual({ kind: 'change', change: { absolutePath: join(f.root, 'x.txt'), absent: true } })
  const pending = stream.next(); abort.abort()
  await expect(pending).rejects.toThrow()
}, 10000)
