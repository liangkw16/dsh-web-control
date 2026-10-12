import type { Context } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CURRENT_FILE_TEXT_BYTES, MAX_LOGICAL_JSON_BYTES, MAX_READ_BYTES, parseCurrentFileStat, ProtocolError, type Command, type Json, type Limits } from '../../../protocol/src/index.ts'
import { publicJson } from '../adapter/dsh-v021.ts'
import type { CurrentWorkspaceAuthority, SessionScope } from '../adapter/scope.ts'
import { currentFileProviderIdentity, supportsCurrentFiles } from './provider.ts'
import { LocalReadError, openLocalFile, type LocalFileHandle } from './local-reader.ts'

export interface CurrentFileHandle extends LocalFileHandle { assertAuthority(): void }
export class CurrentFileService {
  constructor(private readonly ctx: Context, private readonly scope: SessionScope, private readonly admission: () => void, private readonly limits: Limits, private readonly publish?: (check: () => void) => void) {}
  private check(signal: AbortSignal, authority?: CurrentWorkspaceAuthority): void {
    signal.throwIfAborted(); this.admission(); authority?.assertCurrentSync()
    if (!supportsCurrentFiles(this.ctx)) throw new LocalReadError('unsupported')
  }
  private async withResult(signal: AbortSignal, action: () => Promise<Json>): Promise<Json> {
    try { return await action() }
    catch (error) {
      signal.throwIfAborted(); this.admission()
      if (error instanceof LocalReadError) return { ok: false, code: error.code }
      if (error instanceof ProtocolError) {
        if (error.code === 'OUT_OF_SCOPE') return { ok: false, code: 'outside' }
        throw error
      }
      return { ok: false, code: 'unsupported' }
    }
  }
  private async bind(sessionId: string, signal: AbortSignal) {
    this.check(signal)
    const authority = await this.scope.bindCurrentWorkspace(sessionId, signal); this.check(signal, authority)
    const provider = this.ctx.fs, root = provider.processPath(authority.root)
    if (!posix.isAbsolute(root) || provider.processPathFromHostPath(root) !== root) throw new LocalReadError('unsupported')
    const identity = currentFileProviderIdentity(provider)
    const check = () => { this.check(signal, authority); if (currentFileProviderIdentity(this.ctx.fs) !== identity) throw new LocalReadError('changed') }
    const current = async () => { check(); await authority.assertCurrent(); check() }
    return { authority, root, provider, check, current }
  }
  private async resolve(bound: Awaited<ReturnType<CurrentFileService['bind']>>, input: string, signal: AbortSignal, base?: string): Promise<string> {
    const { root, provider, check } = bound
    if (!input || input.includes('\0') || input.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(input) || input.length > 4096) throw new LocalReadError('outside')
    if (posix.isAbsolute(input)) {
      if (!input.startsWith(root + '/')) throw new LocalReadError('outside')
      input = input.slice(root.length + 1); base = undefined
    }
    const start = base ? posix.dirname(base) : root
    const parts = start.split('/').filter(Boolean)
    // Check each supplied component before normalizing '..', so link/../file is
    // never interpreted as a safe path after erasing the link component.
    for (const part of input.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') {
        if (!base || parts.length <= root.split('/').filter(Boolean).length) throw new LocalReadError('outside')
        parts.pop(); continue
      }
      parts.push(part)
      const candidate = '/' + parts.join('/')
      if (candidate === root || candidate.startsWith(root + '/')) {
        const info = await provider.lstat(candidate, {}, signal); check()
        if (info?.type === 'symlink') throw new LocalReadError('outside')
      }
    }
    const absolute = '/' + parts.join('/')
    if (!absolute.startsWith(root + '/')) throw new LocalReadError('outside')
    const target = await provider.resolve(absolute, { signal }); check()
    if (!provider.contains(bound.authority.root, target) || provider.processPath(target) !== absolute || provider.processPathFromHostPath(absolute) !== absolute) throw new LocalReadError('outside')
    await bound.current(); check()
    return absolute.slice(root.length + 1)
  }
  private async file(sessionId: string, path: string, version: string | undefined, signal: AbortSignal, baseFile?: string): Promise<CurrentFileHandle> {
    const bound = await this.bind(sessionId, signal)
    let base: string | undefined
    if (baseFile !== undefined) {
      const relative = await this.resolve(bound, baseFile, signal)
      const file = await openLocalFile(bound.root, relative, this.options(signal))
      try { await bound.current(); await file.assertCurrent(signal); bound.check(); base = file.absolutePath }
      finally { await file.close() }
    }
    const relative = await this.resolve(bound, path, signal, base)
    const file = await openLocalFile(bound.root, relative, { ...this.options(signal), expectedVersion: version })
    const current = async (readSignal: AbortSignal) => { readSignal.throwIfAborted(); await bound.current(); readSignal.throwIfAborted(); await file.assertCurrent(readSignal); bound.check() }
    try { await current(signal) } catch (error) { await file.close(); throw error }
    return {
      absolutePath: file.absolutePath, relativePath: file.relativePath, version: file.version, bytes: file.bytes,
      close: () => file.close(), assertCurrent: current, assertAuthority: bound.check,
      readRange: async (offset, length, readSignal) => { await current(readSignal); const bytes = await file.readRange(offset, length, readSignal); await current(readSignal); return bytes },
      readTextPage: async (offset, limit, readSignal) => { await current(readSignal); const page = await file.readTextPage(offset, limit, readSignal); await current(readSignal); return page },
    }
  }
  private options(signal: AbortSignal) { return { signal, maxFileBytes: this.limits.fileBytes, maxRangeBytes: Math.min(MAX_READ_BYTES, this.limits.fileBytes), maxTextBytes: CURRENT_FILE_TEXT_BYTES } }
  stat(command: Extract<Command, { op: 'file.stat' }>, signal: AbortSignal): Promise<Json> {
    return this.withResult(signal, async () => {
      const file = await this.file(command.sessionId, command.path, undefined, signal, command.baseFile)
      let value: Json
      try {
        await file.assertCurrent(signal); this.check(signal)
        value = publicJson({ ok: true, value: { absolutePath: file.absolutePath, relativePath: file.relativePath, version: file.version, bytes: file.bytes } }, this.limits.jsonBytes - 2048)
      } finally { await file.close() }
      file.assertAuthority(); this.publish?.(file.assertAuthority); return value
    })
  }
  text(command: Extract<Command, { op: 'file.text' }>, signal: AbortSignal): Promise<Json> {
    return this.withResult(signal, async () => {
      const file = await this.file(command.sessionId, command.path, command.version, signal)
      let value: Json
      try {
        const page = await file.readTextPage(command.offset, command.limit, signal); this.check(signal)
        value = publicJson({ ok: true, value: { absolutePath: file.absolutePath, version: file.version, bytes: file.bytes, offset: command.offset, ...page } }, MAX_LOGICAL_JSON_BYTES - 2048)
      } finally { await file.close() }
      file.assertAuthority(); this.publish?.(file.assertAuthority); return value
    })
  }
  open(command: Extract<Command, { op: 'file.read' }>, signal: AbortSignal): Promise<CurrentFileHandle> {
    if (!command.version) return Promise.reject(new ProtocolError('PROTOCOL_UNSUPPORTED'))
    return this.file(command.sessionId, command.path, command.version, signal)
  }
  async *changes(sessionId: string, path: string, signal: AbortSignal): AsyncIterable<Json> {
    const bound = await this.bind(sessionId, signal)
    const relative = await this.resolve(bound, path, signal)
    const absolutePath = `${bound.root}/${relative}`
    let previous: string | undefined
    while (!signal.aborted) {
      bound.check()
      const next = parseCurrentFileStat(await this.stat({ op: 'file.stat', sessionId, path: absolutePath }, signal))
      bound.check()
      if (!next.ok && next.code !== 'missing') throw new ProtocolError(next.code === 'outside' ? 'OUT_OF_SCOPE' : 'PROTOCOL_UNSUPPORTED')
      const state = next.ok ? next.value.version : 'missing'
      this.publish?.(bound.check)
      if (previous === undefined) yield { kind: 'ready' }
      else if (state !== previous) yield { kind: 'change', change: next.ok ? { absolutePath, version: next.value.version } : { absolutePath, absent: true } }
      previous = state
      await delay(2000, undefined, { signal })
    }
  }
}
