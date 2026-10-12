import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openLocalFile, type LocalFileHandle, type LocalReadOptions } from '../src/current-files/local-reader.ts'

const roots: string[] = [], handles: LocalFileHandle[] = []
const signal = () => new AbortController().signal
const options = () => ({ maxFileBytes: 32 * 1024 * 1024, maxRangeBytes: 1024 * 1024, maxTextBytes: 256 * 1024, signal: signal() })
async function tree() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dsh-current-file-')); roots.push(dir)
  const base = await fs.realpath(dir), root = join(base, 'workspace'), outside = join(base, 'outside')
  await fs.mkdir(root); await fs.mkdir(outside); await fs.writeFile(join(outside, 'secret'), 'PRIVATE-OUTSIDE')
  return { base, root, outside }
}
async function open(root: string, path: string, opts: LocalReadOptions = options()) { const file = await openLocalFile(root, path, opts); handles.push(file); return file }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(handles.splice(0).map(file => file.close())); await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))) })

test('returns exact original bytes and refuses a changed opened file', async () => {
  const { root } = await tree(); await fs.writeFile(join(root, '中文.txt'), 'one\r\ntwo\n')
  const file = await open(root, '中文.txt')
  expect(file.bytes).toBe(9); expect(Buffer.from(await file.readRange(0, 4, signal())).toString()).toBe('one\r')
  await fs.writeFile(join(root, '中文.txt'), 'changed')
  await expect(file.assertCurrent(signal())).rejects.toMatchObject({ code: 'changed' })
  await expect(file.readRange(0, 4, signal())).rejects.toMatchObject({ code: 'changed' })
})
test.each(['leaf', 'parent', 'root'])('rejects a %s symlink before reading content', async kind => {
  const { root, outside } = await tree(); let path = 'link'
  if (kind === 'root') { await fs.rm(root, { recursive: true }); await fs.symlink(outside, root); path = 'secret' }
  else { await fs.symlink(kind === 'leaf' ? join(outside, 'secret') : outside, join(root, 'link')); if (kind === 'parent') path += '/secret' }
  await expect(open(root, path)).rejects.toMatchObject({ code: 'outside' })
})
test.each(['../outside/secret', '/etc/passwd', 'x/../y', 'a\\b', 'a\0b', '', 'a//b', './x'])('rejects a non-normalized path %j', async path => {
  await expect(open((await tree()).root, path)).rejects.toMatchObject({ code: 'outside' })
})
test('literal percent names are not URL-decoded and directories are not file bodies', async () => {
  const { root } = await tree(); await fs.mkdir(join(root, '%2e%2e')); await fs.writeFile(join(root, '%2e%2e/x'), 'literal')
  expect(Buffer.from(await (await open(root, '%2e%2e/x')).readRange(0, 99, signal())).toString()).toBe('literal')
  await expect(open(root, '%2e%2e')).rejects.toMatchObject({ code: 'not-regular' })
  await expect(open(root, 'missing')).rejects.toMatchObject({ code: 'missing' })
})
test.each([
  ['', 1, 5, { text: '', lines: 0, eof: true }],
  ['\ufeffone\ntwo', 1, 5, { text: 'one\ntwo', lines: 2, eof: true }],
  ['\n', 1, 5, { text: '', lines: 1, eof: true }],
  ['one\ntwo\n', 1, 1, { text: 'one', lines: 1, eof: false }],
  ['one\ntwo\n', 2, 1, { text: 'two', lines: 1, eof: true }],
  ['one\ntwo', 3, 1, { text: '', lines: 0, eof: true }],
  ['one\r\ntwo\r\n', 1, 5, { text: 'one\r\ntwo\r', lines: 2, eof: true }],
] as const)('native text page semantics: %j offset %i limit %i', async (content, offset, limit, expected) => {
  const { root } = await tree(); await fs.writeFile(join(root, 'text'), content)
  expect(await (await open(root, 'text')).readTextPage(offset, limit, signal())).toEqual(expected)
})
test('UTF-8 split across read chunks is preserved without a trailing synthetic line', async () => {
  const { root } = await tree(), content = 'a'.repeat(65535) + '汉字\nlast'
  await fs.writeFile(join(root, 'text'), content)
  expect(await (await open(root, 'text')).readTextPage(1, 3, signal())).toEqual({ text: content, lines: 2, eof: true })
})
test.each([Buffer.from([0xc3, 0x28]), Buffer.from('a\0b')])('binary/invalid UTF-8 refuses text but keeps exact download bytes', async content => {
  const { root } = await tree(); await fs.writeFile(join(root, 'binary'), content); const file = await open(root, 'binary')
  await expect(file.readTextPage(1, 5, signal())).rejects.toMatchObject({ code: 'not-text' })
  expect(Buffer.from(await file.readRange(0, 99, signal()))).toEqual(content)
})
test('oversized pages fail rather than silently truncate', async () => {
  const { root } = await tree(); await fs.writeFile(join(root, 'large-line'), 'x'.repeat(256 * 1024 + 1))
  await expect((await open(root, 'large-line')).readTextPage(1, 5, signal())).rejects.toMatchObject({ code: 'too-large' })
})
test('complete file and range limits include the exact boundary and empty EOF', async () => {
  const { root } = await tree(), path = join(root, 'large'); await fs.writeFile(path, ''); await fs.truncate(path, 32 * 1024 * 1024)
  const file = await open(root, 'large')
  expect((await file.readRange(file.bytes, 0, signal())).byteLength).toBe(0)
  expect((await file.readRange(file.bytes - 2, 100, signal())).byteLength).toBe(2)
  await expect(file.readRange(0, 1024 * 1024 + 1, signal())).rejects.toMatchObject({ code: 'too-large' })
  await fs.truncate(path, file.bytes + 1); await expect(open(root, 'large')).rejects.toMatchObject({ code: 'too-large' })
})
test('versions bind subsequent opens and aborted/closed handles publish no bytes', async () => {
  const { root } = await tree(); await fs.writeFile(join(root, 'x'), 'original'); const file = await open(root, 'x')
  const same = await open(root, 'x', { ...options(), expectedVersion: file.version })
  expect(same.version).toBe(file.version)
  await fs.writeFile(join(root, 'x'), 'new')
  await expect(openLocalFile(root, 'x', { ...options(), expectedVersion: file.version })).rejects.toMatchObject({ code: 'changed' })
  const abort = new AbortController(); abort.abort()
  await expect(openLocalFile(root, 'x', { ...options(), signal: abort.signal })).rejects.toThrow()
  await file.close(); await file.close(); await expect(file.readRange(0, 1, signal())).rejects.toThrow()
})

test.each(['leaf', 'parent', 'root', 'write'] as const)('refuses %s replacement and restoration during an actual read', async kind => {
  const { base, root, outside } = await tree(); await fs.mkdir(join(root, 'dir')); await fs.writeFile(join(root, 'dir/x'), 'original')
  const originalOpen = fs.open.bind(fs)
  let armed = false, swapped = false
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const fd = await originalOpen(...args), originalRead = fd.read.bind(fd)
    fd.read = (async (...readArgs: unknown[]) => {
      const result = await (originalRead as (...args: unknown[]) => Promise<unknown>)(...readArgs)
      if (armed && !swapped) {
        swapped = true
        if (kind === 'write') { await fs.writeFile(join(root, 'dir/x'), 'modified'); await fs.writeFile(join(root, 'dir/x'), 'original') }
        else {
          const target = kind === 'leaf' ? join(root, 'dir/x') : kind === 'parent' ? join(root, 'dir') : root
          const moved = `${target}.owned-race`
          await fs.rename(target, moved)
          try { await fs.symlink(kind === 'leaf' ? join(outside, 'secret') : outside, target) }
          finally { await fs.unlink(target); await fs.rename(moved, target) }
        }
      }
      return result
    }) as typeof fd.read
    return fd
  })
  const file = await open(root, 'dir/x'); armed = true
  await expect(file.readRange(0, 8, signal())).rejects.toMatchObject({ code: 'changed' })
  expect(swapped).toBe(true)
})

test('unrelated shared ancestor contents do not invalidate a contained file', async () => {
  const { base, root } = await tree(); await fs.writeFile(join(root, 'x'), 'inside'); const file = await open(root, 'x')
  await fs.writeFile(join(base, 'unrelated'), 'other')
  expect(Buffer.from(await file.readRange(0, 6, signal())).toString()).toBe('inside')
})

test('an abort during read closes the owned file descriptor and returns no body', async () => {
  const { root } = await tree(); await fs.writeFile(join(root, 'x'), 'original')
  const abort = new AbortController(), originalOpen = fs.open.bind(fs)
  let closed = false
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const fd = await originalOpen(...args), originalRead = fd.read.bind(fd), originalClose = fd.close.bind(fd)
    fd.read = (async (...readArgs: unknown[]) => {
      const result = await (originalRead as (...args: unknown[]) => Promise<unknown>)(...readArgs)
      abort.abort(); return result
    }) as typeof fd.read
    fd.close = async () => { closed = true; await originalClose() }
    return fd
  })
  const file = await open(root, 'x'); closed = false
  await expect(file.readRange(0, 8, abort.signal)).rejects.toThrow()
  expect(closed).toBe(true)
  await expect(file.readRange(0, 8, signal())).rejects.toThrow()
})

test.each(['leaf', 'parent', 'root'] as const)('open-time %s symlink swap cannot return bytes or leak descriptors', async kind => {
  const { root, outside } = await tree()
  await fs.mkdir(join(root, 'dir')); await fs.writeFile(join(root, 'dir/x'), 'INSIDE')
  await fs.mkdir(join(outside, 'dir')); await fs.writeFile(join(outside, 'dir/x'), 'OUTSIDE')
  await fs.writeFile(join(outside, 'x'), 'OUTSIDE')
  const leaf = join(root, 'dir/x'), target = kind === 'leaf' ? leaf : kind === 'parent' ? join(root, 'dir') : root
  const replacement = kind === 'leaf' ? join(outside, 'x') : outside
  const original = fs.open.bind(fs), live = new Set<number>(); let swapped = false, reads = 0
  vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const absolute = String(path).startsWith('/proc/self/fd/') ? join(await fs.realpath(String(path).slice(0, String(path).lastIndexOf('/'))), String(path).split('/').at(-1)!) : String(path)
    const mutate = !swapped && absolute === leaf
    if (mutate) { swapped = true; await fs.rename(target, target + '.saved'); await fs.symlink(replacement, target) }
    try {
      const fd = await original(path, flags, mode), id = fd.fd, close = fd.close.bind(fd), read = fd.read.bind(fd)
      live.add(id); fd.close = async () => { try { return await close() } finally { live.delete(id) } }
      fd.read = ((...args: any[]) => { reads++; return (read as any)(...args) }) as typeof fd.read
      return fd
    } finally { if (mutate) { await fs.unlink(target); await fs.rename(target + '.saved', target) } }
  })
  await expect(open(root, 'dir/x')).rejects.toThrow()
  expect(swapped).toBe(true); expect(reads).toBe(0); expect(live.size).toBe(0)
})

test.each(['leaf', 'parent', 'root'] as const)('open-time borrowed %s restored before validation is refused and all descriptors close', async kind => {
  const { root, outside } = await tree()
  await fs.mkdir(join(root, 'dir')); await fs.writeFile(join(root, 'dir/x'), 'INSIDE')
  await fs.mkdir(join(outside, 'dir')); await fs.writeFile(join(outside, 'dir/x'), 'OUTSIDE')
  await fs.writeFile(join(outside, 'x'), 'OUTSIDE')
  const leaf = join(root, 'dir/x'), target = kind === 'leaf' ? leaf : kind === 'parent' ? join(root, 'dir') : root
  const replacement = kind === 'leaf' ? join(outside, 'x') : outside
  const original = fs.open.bind(fs), live = new Set<number>(); let swapped = false, reads = 0
  vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
    const absolute = String(path).startsWith('/proc/self/fd/') ? join(await fs.realpath(String(path).slice(0, String(path).lastIndexOf('/'))), String(path).split('/').at(-1)!) : String(path)
    // Directory cases exercise witness acquisition, leaf case exercises final open.
    const mutate = !swapped && absolute === target
    if (mutate) { swapped = true; await fs.rename(target, target + '.saved'); await fs.rename(replacement, target) }
    try {
      const fd = await original(path, flags, mode), id = fd.fd, close = fd.close.bind(fd), read = fd.read.bind(fd)
      live.add(id); fd.close = async () => { try { return await close() } finally { live.delete(id) } }
      fd.read = ((...args: any[]) => { reads++; return (read as any)(...args) }) as typeof fd.read
      return fd
    } finally { if (mutate) { await fs.rename(target, replacement); await fs.rename(target + '.saved', target) } }
  })
  await expect(open(root, 'dir/x')).rejects.toThrow()
  expect(swapped).toBe(true); expect(reads).toBe(0); expect(live.size).toBe(0)
})
