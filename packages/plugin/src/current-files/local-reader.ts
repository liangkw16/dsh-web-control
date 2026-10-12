import fs, { type FileHandle } from 'node:fs/promises'
import { constants, type BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

export type LocalReadCode = 'missing' | 'outside' | 'not-regular' | 'too-large' | 'not-text' | 'changed' | 'unsupported'
export class LocalReadError extends Error {
  constructor(readonly code: LocalReadCode) { super(code) }
}
export interface LocalReadOptions {
  maxFileBytes: number; maxRangeBytes: number; maxTextBytes: number
  expectedVersion?: string; signal: AbortSignal
}
export interface LocalFileHandle {
  readonly absolutePath: string
  readonly relativePath: string
  readonly version: string
  readonly bytes: number
  assertCurrent(signal: AbortSignal): Promise<void>
  readRange(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>
  readTextPage(offset: number, limit: number, signal: AbortSignal): Promise<{ text: string; lines: number; eof: boolean }>
  close(): Promise<void>
}

function failure(error: unknown): never {
  if (error instanceof LocalReadError || (error instanceof Error && error.name === 'AbortError')) throw error
  const code = (error as NodeJS.ErrnoException)?.code
  throw new LocalReadError(code === 'ENOENT' ? 'missing' : code === 'ELOOP' || code === 'ENOTDIR' ? 'outside' : 'unsupported')
}
function stamp(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size].join(':')
}
function identity(stat: BigIntStats, owned: boolean): string { return [stat.dev, stat.ino, stat.birthtimeNs, ...(owned ? [stat.ctimeNs] : [])].join(':') }
function validRelative(path: string): boolean {
  return !!path && !path.includes('\0') && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..')
}

// Darwin's O_NOFOLLOW_ANY rejects symlinks in every component, including ancestors.
// Linux instead walks from a pinned directory descriptor, never following a child link.
// Do not replace this with realpath + ordinary open: that introduces a traversal race.
async function secureOpen(path: string, directory: boolean): Promise<FileHandle> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)
  if (process.platform === 'darwin') return fs.open(path, flags | 0x20000000)
  if (process.platform !== 'linux') throw new LocalReadError('unsupported')
  let parent = await fs.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const parts = path.split('/').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1
      const child = await fs.open(`/proc/self/fd/${parent.fd}/${parts[i]}`, (last ? flags : constants.O_RDONLY | constants.O_DIRECTORY) | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      await parent.close(); parent = child
    }
    return parent
  } catch (error) { await parent.close(); throw error }
}

export async function openLocalFile(root: string, relativePath: string, options: LocalReadOptions): Promise<LocalFileHandle> {
  const { signal } = options
  signal.throwIfAborted()
  if (!validRelative(relativePath) || !posix.isAbsolute(root) || root.includes('\0') || root.includes('\\') || posix.normalize(root) !== root || root.endsWith('/')) throw new LocalReadError('outside')
  for (const bound of [options.maxFileBytes, options.maxRangeBytes, options.maxTextBytes]) {
    if (!Number.isSafeInteger(bound) || bound < 1) throw new LocalReadError('unsupported')
  }
  const absolutePath = `${root}/${relativePath}`
  const witnesses: { path: string; handle: FileHandle; identity: string; owned: boolean }[] = []
  let handle: FileHandle | undefined, closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await Promise.allSettled([handle?.close(), ...witnesses.map(item => item.handle.close())])
  }
  try {
    // Pin all identities and retain ctime from the workspace downward. Shared
    // ancestors (e.g. /tmp) can change contents independently. The root witness
    // plus the reopened leaf identity still bind the body to this workspace.
    let ancestor = ''
    for (const component of posix.dirname(absolutePath).split('/').filter(Boolean)) {
      signal.throwIfAborted(); ancestor += '/' + component
      const directory = await secureOpen(ancestor, true)
      const owned = ancestor === root || ancestor.startsWith(root + '/')
      try { witnesses.push({ path: ancestor, handle: directory, identity: identity(await directory.stat({ bigint: true }), owned), owned }) }
      catch (error) { await directory.close(); throw error }
    }
    signal.throwIfAborted(); handle = await secureOpen(absolutePath, false)
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) throw new LocalReadError('not-regular')
    if (stat.size > BigInt(options.maxFileBytes)) throw new LocalReadError('too-large')
    const bytes = Number(stat.size), initial = stamp(stat), version = createHash('sha256').update(initial).digest('hex')
    if (options.expectedVersion !== undefined && version !== options.expectedVersion) throw new LocalReadError('changed')
    const assertCurrent = async (readSignal: AbortSignal) => {
      signal.throwIfAborted(); readSignal.throwIfAborted()
      if (closed || !handle) throw new LocalReadError('changed')
      try {
        if (stamp(await handle.stat({ bigint: true })) !== initial) throw new LocalReadError('changed')
        for (const witness of witnesses) {
          readSignal.throwIfAborted()
          if (identity(await witness.handle.stat({ bigint: true }), witness.owned) !== witness.identity) throw new LocalReadError('changed')
          const current = await secureOpen(witness.path, true)
          try { if (identity(await current.stat({ bigint: true }), witness.owned) !== witness.identity) throw new LocalReadError('changed') }
          finally { await current.close() }
        }
        const current = await secureOpen(absolutePath, false)
        try { if (stamp(await current.stat({ bigint: true })) !== initial) throw new LocalReadError('changed') }
        finally { await current.close() }
        signal.throwIfAborted(); readSignal.throwIfAborted()
      } catch (error) {
        await close()
        signal.throwIfAborted(); readSignal.throwIfAborted()
        throw new LocalReadError('changed')
      }
    }
    await assertCurrent(signal)
    const read = async (offset: number, length: number, readSignal: AbortSignal) => {
      signal.throwIfAborted(); readSignal.throwIfAborted()
      if (closed || !handle) throw new LocalReadError('changed')
      const buffer = Buffer.alloc(length)
      let used = 0
      while (used < length) {
        signal.throwIfAborted(); readSignal.throwIfAborted()
        const result = await handle.read(buffer, used, Math.min(65536, length - used), offset + used)
        if (!result.bytesRead) break
        used += result.bytesRead
      }
      return buffer.subarray(0, used)
    }
    const bounded = async <T>(readSignal: AbortSignal, action: () => Promise<T>): Promise<T> => {
      try { await assertCurrent(readSignal); const result = await action(); await assertCurrent(readSignal); return result }
      catch (error) {
        // Text classification errors do not invalidate a file's binary representation.
        if (!(error instanceof LocalReadError) || !['not-text', 'too-large'].includes(error.code)) await close()
        failure(error)
      }
    }
    return {
      absolutePath, relativePath, bytes, version, assertCurrent, close,
      async readRange(offset, length, readSignal) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > options.maxRangeBytes) throw new LocalReadError('too-large')
        return bounded(readSignal, () => read(offset, Math.max(0, Math.min(length, bytes - offset)), readSignal))
      },
      async readTextPage(offset, limit, readSignal) {
        if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000 || !Number.isSafeInteger(offset + limit)) throw new LocalReadError('too-large')
        return bounded(readSignal, async () => {
          const decoder = new TextDecoder('utf-8', { fatal: true })
          const lines: string[] = []
          let current = '', line = 1, size = 0, eof = true
          const admit = (text: string) => {
            if (text.includes('\0')) throw new LocalReadError('not-text')
            size += Buffer.byteLength(text)
            if (size > options.maxTextBytes) throw new LocalReadError('too-large')
          }
          const complete = () => { if (lines.length) admit('\n'); lines.push(current); current = '' }
          const consume = (chunk: string) => {
            for (let position = 0; position < chunk.length;) {
              if (line >= offset + limit) { eof = false; return false }
              const newline = chunk.indexOf('\n', position)
              const segment = newline < 0 ? chunk.slice(position) : chunk.slice(position, newline)
              if (line >= offset) { admit(segment); current += segment }
              if (newline < 0) break
              if (line >= offset) complete()
              line++; position = newline + 1
            }
            return true
          }
          for (let position = 0; position < bytes; position += 65536) {
            const chunk = await read(position, Math.min(65536, bytes - position), readSignal)
            let text: string
            try { text = decoder.decode(chunk, { stream: true }) } catch { throw new LocalReadError('not-text') }
            if (!consume(text)) break
          }
          if (eof) {
            let tail: string
            try { tail = decoder.decode() } catch { throw new LocalReadError('not-text') }
            consume(tail)
            if (current.length) complete()
          }
          return { text: lines.join('\n'), lines: lines.length, eof }
        })
      },
    }
  } catch (error) { await close(); failure(error) }
}
