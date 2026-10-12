import { DEFAULT_LIMITS, ProtocolError } from '../../protocol/src/index.ts'
export { validateRelativePath } from './adapter/scope.ts'

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes'
import type { Command, Json } from '../../protocol/src/index.ts'
import { jsonObject, publicJson } from './adapter/dsh-v021.ts'
import { RecordedWorkspaceChanged, validateRelativePath, type SessionScope } from './adapter/scope.ts'

/** Immutable per-dispatch admission guard, supplied by AdditionalHandlers. */
export class FileService {
  constructor(private readonly ctx: Context, private readonly scope: SessionScope, private readonly admission: () => void, private readonly jsonBytes = DEFAULT_LIMITS.jsonBytes) {}
  async readFile(command: Extract<Command, { op: 'file.read' }>, signal: AbortSignal): Promise<Json> {
    this.check(command.sessionId, signal)
    await this.scope.assertReadableFile(command.sessionId, command.path)
    throw new ProtocolError('PROTOCOL_UNSUPPORTED')
  }
  async readChanges(sessionId: string, seq: number): Promise<Json> {
    number(seq); this.check(sessionId)
    const summary = this.ctx.workspaceChanges.summary(SessionId(sessionId), seq)
    this.check(sessionId)
    if (!summary) return { status: 'unavailable' }
    // Bound/copy the public DTO before awaits; no public mutable list becomes browser authority.
    const snapshot = jsonObject(publicJson(summary, this.jsonBytes)); number(snapshot.turn)
    if (!Array.isArray(snapshot.files) || typeof snapshot.cwd !== 'string') throw new ProtocolError('INVALID_MESSAGE')
    const assertWorkspace = await this.scope.bindRecordedWorkspace(sessionId, snapshot.cwd)
    this.check(sessionId); assertWorkspace.assertCurrentSync()
    const originalFiles = snapshot.files
    const files: Json[] = []; let added = 0; let deleted = 0
    for (let index = 0; index < snapshot.files.length; index++) {
      const file = jsonObject(snapshot.files[index]); const path = file.path; const display = file.display
      if (typeof path !== 'string' || typeof display !== 'string') throw new ProtocolError('INVALID_MESSAGE')
      await assertWorkspace.assertCurrent(); this.check(sessionId); assertWorkspace.assertCurrentSync()
      try {
        validateRelativePath(path); validateRelativePath(display)
        await this.scope.assertRecordedFile(sessionId, path, snapshot.cwd)
      } catch (error) {
        this.check(sessionId)
        if (error instanceof RecordedWorkspaceChanged) throw error
        if (error instanceof ProtocolError && error.code === 'OUT_OF_SCOPE') { await assertWorkspace.assertCurrent(); this.check(sessionId); assertWorkspace.assertCurrentSync(); continue }
        throw error
      }
      this.check(sessionId); assertWorkspace.assertCurrentSync(); number(file.added); number(file.deleted)
      files.push({ index, path, display, added: file.added, deleted: file.deleted,
        ...(file.binary === true ? { binary: true } : {}), ...(file.oversized === true ? { oversized: true } : {}) })
      added += file.added; deleted += file.deleted
    }
    this.check(sessionId)
    if (this.ctx.workspaceChanges.summary(SessionId(sessionId), seq) !== summary || summary.files.length !== snapshot.files.length
      || summary.files.some((file, index) => { const original = jsonObject(originalFiles[index]); return file.path !== original.path || file.display !== original.display })) return { status: 'unavailable' }
    await assertWorkspace.assertCurrent()
    number(added); number(deleted); this.check(sessionId); assertWorkspace.assertCurrentSync()
    return publicJson({ turn: snapshot.turn, files, total: files.length, added, deleted }, this.jsonBytes)
  }
  async readDiff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<Json> {
    number(seq); number(index); this.check(sessionId, signal)
    const summary = this.ctx.workspaceChanges.summary(SessionId(sessionId), seq)
    this.check(sessionId)
    if (!summary) return { status: 'unavailable' }
    const file = summary.files[index]
    if (!file) throw new ProtocolError('OUT_OF_SCOPE')
    const path = validateRelativePath(file.path); const display = validateRelativePath(file.display); const cwd = summary.cwd
    const authority = await this.scope.bindRecordedWorkspace(sessionId, cwd, signal)
    authority.assertCurrentSync()
    await this.scope.assertRecordedFile(sessionId, path, cwd, signal)
    this.check(sessionId, signal); authority.assertCurrentSync()
    if (this.ctx.workspaceChanges.summary(SessionId(sessionId), seq) !== summary || summary.files[index] !== file || file.path !== path || file.display !== display) return { status: 'unavailable' }
    this.check(sessionId, signal); authority.assertCurrentSync()
    const value = await this.ctx.workspaceChanges.diff(SessionId(sessionId), seq, index, signal)
    this.check(sessionId, signal); authority.assertCurrentSync()
    await this.scope.assertRecordedFile(sessionId, path, cwd, signal)
    this.check(sessionId, signal); authority.assertCurrentSync()
    if (this.ctx.workspaceChanges.summary(SessionId(sessionId), seq) !== summary || summary.files[index] !== file || file.path !== path || file.display !== display) return { status: 'unavailable' }
    if (value && (value.path !== path || value.display !== display)) throw new ProtocolError('OUT_OF_SCOPE')
    this.check(sessionId, signal); authority.assertCurrentSync()
    return encodeDiff(value, this.jsonBytes)
  }
  private check(sessionId: string, signal?: AbortSignal): void { this.admission(); signal?.throwIfAborted(); this.scope.assertSession(sessionId) }
}
function number(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) throw new ProtocolError('INVALID_MESSAGE') }
function fields(value: Record<string, Json>, names: readonly string[]): void {
  if (Object.keys(value).some(name => !names.includes(name)) || names.some(name => !Object.hasOwn(value, name))) throw new ProtocolError('INVALID_MESSAGE')
}
export function encodeDiff(value: WorkspaceFileDiff | undefined, jsonBytes = DEFAULT_LIMITS.jsonBytes): Json {
  if (value === undefined) return { status: 'unavailable' }
  const dto = jsonObject(publicJson(value, jsonBytes))
  if (typeof dto.path !== 'string' || typeof dto.display !== 'string') throw new ProtocolError('INVALID_MESSAGE')
  validateRelativePath(dto.path); validateRelativePath(dto.display)
  if (dto.kind === 'binary' || dto.kind === 'oversized') fields(dto, ['kind', 'path', 'display'])
  else if (dto.kind === 'text') {
    fields(dto, ['kind', 'path', 'display', 'before', 'after', 'hunks', 'coarse'])
    if (typeof dto.before !== 'boolean' || typeof dto.after !== 'boolean' || typeof dto.coarse !== 'boolean' || !Array.isArray(dto.hunks)) throw new ProtocolError('INVALID_MESSAGE')
    for (const raw of dto.hunks) {
      const hunk = jsonObject(raw); fields(hunk, ['oldStart', 'oldLines', 'newStart', 'newLines', 'lines'])
      number(hunk.oldStart); number(hunk.oldLines); number(hunk.newStart); number(hunk.newLines)
      if (!Array.isArray(hunk.lines) || hunk.lines.some(line => typeof line !== 'string' || !/^[+\- ]/.test(line))) throw new ProtocolError('INVALID_MESSAGE')
    }
  } else throw new ProtocolError('INVALID_MESSAGE')
  return dto
}
