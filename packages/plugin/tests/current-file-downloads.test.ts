import { afterEach, expect, test, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LIMITS, decodeChunk, ProtocolError, type HostMessage } from '../../protocol/src/index.ts'
import { openLocalFile } from '../src/current-files/local-reader.ts'
import { FileDownloads } from '../src/current-files/downloads.ts'
const fence = { instanceId: randomUUID(), runtimeId: randomUUID(), controlId: randomUUID(), authEpoch: 1 }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanup.splice(0).map(fn => fn())) })
async function fixture(content: Uint8Array = Buffer.alloc(200000, 5), idle = 60000) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'dsh-download-'))), path = join(root, 'file.bin')
  await fs.writeFile(path, content)
  const sent: Uint8Array[] = [], ends: Extract<HostMessage, { type: 'download.end' }>[] = []
  let reserved = 0, active = true
  const check = () => { if (!active) throw new ProtocolError('STALE_CONTROL') }
  const downloads = new FileDownloads({ limits: { ...DEFAULT_LIMITS, transferIdleMs: idle }, reserve: bytes => { reserved += bytes; return () => { reserved -= bytes } }, sendBinary: async (bytes, check) => { check(); sent.push(bytes.slice()) }, sendEnd: async (message, check) => { check(); ends.push(message) } })
  cleanup.push(async () => { await downloads.dispose(); await fs.rm(root, { recursive: true, force: true }); expect(reserved).toBe(0) })
  const open = async (offset = 0, length = content.length) => {
    const signal = new AbortController().signal, file = await openLocalFile(root, 'file.bin', { signal, maxFileBytes: DEFAULT_LIMITS.fileBytes, maxRangeBytes: 1048576, maxTextBytes: 262144 }), id = randomUUID()
    const metadata = await downloads.open(id, fence, file, { offset, length }, signal, check)
    return { metadata, id }
  }
  return { downloads, open, sent, ends, path, revoked: () => { active = false }, reserved: () => reserved }
}
test('range metadata precedes credited chunks and exact end, retaining no file body', async () => {
  const f = await fixture(), { metadata, id } = await f.open(10, 100000)
  expect(metadata).toMatchObject({ transferId: id, offset: 10, bytes: 100000, eof: false }); expect(Object.keys(metadata)).toHaveLength(6)
  expect(f.sent).toHaveLength(0); f.downloads.credit(id, 1)
  await vi.waitFor(() => expect(f.sent).toHaveLength(1))
  expect(decodeChunk(f.sent[0], DEFAULT_LIMITS)).toMatchObject({ id, controlId: fence.controlId, index: 0 })
  expect(f.ends).toHaveLength(0); f.downloads.credit(id, 1)
  await vi.waitFor(() => expect(f.ends).toHaveLength(1))
  expect(f.sent.map(bytes => decodeChunk(bytes, DEFAULT_LIMITS).data.length)).toEqual([65536, 34464])
  expect(f.ends[0]).toMatchObject({ id, chunks: 2 }); expect(f.ends[0].error).toBeUndefined()
})
test('empty file ends once with zero chunks after its opener is consumed', async () => {
  const f = await fixture(new Uint8Array()), { id, metadata } = await f.open()
  expect(metadata).toMatchObject({ bytes: 0, eof: true }); expect(f.ends).toHaveLength(0)
  f.downloads.credit(id, 1); await vi.waitFor(() => expect(f.ends).toHaveLength(1))
  expect(f.ends[0].chunks).toBe(0); expect(f.sent).toHaveLength(0)
})
test('changed file refuses subsequent credit without a successful terminal', async () => {
  const f = await fixture(), { id } = await f.open()
  f.downloads.credit(id, 1); await vi.waitFor(() => expect(f.sent).toHaveLength(1))
  await fs.writeFile(f.path, Buffer.alloc(200000, 8)); f.downloads.credit(id, 1)
  await vi.waitFor(() => expect(f.ends).toHaveLength(1))
  expect(f.sent).toHaveLength(1); expect(f.ends[0].error).toBeDefined()
})
test('cancel without credit closes a transfer and returns reservations', async () => {
  const f = await fixture(), { id } = await f.open(); f.downloads.cancel(id)
  await vi.waitFor(() => expect(f.ends).toHaveLength(1)); expect(f.ends[0].error?.code).toBe('TRANSFER_CLOSED'); expect(f.sent).toHaveLength(0)
})
test('no-credit transfers expire and concurrent openers are bounded', async () => {
  const f = await fixture(undefined, 50); await f.open(); await f.open()
  await expect(f.open()).rejects.toThrow('BACKPRESSURE')
  await vi.waitFor(() => expect(f.ends).toHaveLength(2)); expect(f.ends.every(end => end.error?.code === 'TRANSFER_TIMEOUT')).toBe(true)
})
test('revoked admission cannot publish a credited chunk', async () => {
  const f = await fixture(), { id } = await f.open(); f.revoked(); f.downloads.credit(id, 1)
  await f.downloads.dispose(); expect(f.sent).toHaveLength(0); expect(f.ends).toHaveLength(0)
})
