import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import { ProtocolError } from '../../../protocol/src/index.ts'

export function opaqueId(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096) throw new ProtocolError('INVALID_MESSAGE')
  return value
}
/** Whole-read authorization failure; never treat it as one filtered path. */
export class RecordedWorkspaceChanged extends ProtocolError {
  constructor() { super('OUT_OF_SCOPE') }
}
export interface RecordedWorkspaceAuthority {
  assertCurrent(): Promise<void>
  /** Call after the caller's final await, immediately before emitting recorded data. */
  assertCurrentSync(): void
}
interface RecordedSessionAuthority { cwd: string; check(): void }
interface WorkspaceMembership { workspaceId: string; sessionIds: readonly string[] }
export interface CurrentWorkspaceAuthority extends RecordedWorkspaceAuthority { readonly root: FsTarget }
/** Registered-workspace mode reads membership afresh. Host-profile mode grants
 * session APIs for this authorized DSH instance, including ungrouped sessions;
 * the native API checks existence/ownership. Neither mode grants filesystem access.
 */
export class SessionScope {
  constructor(private readonly read: () => readonly WorkspaceMembership[], private readonly files?: Pick<Context, 'fs' | 'typert' | 'sessions'>, readonly sessionAuthority: 'registered-workspaces' | 'host-profile' = 'registered-workspaces') {}
  /** Current selected membership, for detecting observer baseline refreshes. */
  sessionIds(): readonly string[] { return [...new Set(this.read().flatMap(item => item.sessionIds.map(opaqueId)))].sort() }
  assertWorkspace(id: string): WorkspaceMembership {
    opaqueId(id)
    const workspace = this.read().find(item => item.workspaceId === id)
    if (!workspace) throw new ProtocolError('OUT_OF_SCOPE')
    return workspace
  }
  assertSession(id: string, workspaceId?: string): void {
    opaqueId(id)
    if (workspaceId === undefined && this.sessionAuthority === 'host-profile') return
    const items = workspaceId === undefined ? this.read() : [this.assertWorkspace(workspaceId)]
    if (!items.some(item => item.sessionIds.includes(id))) throw new ProtocolError('OUT_OF_SCOPE')
  }
  async bindCurrentWorkspace(sessionId: string, signal: AbortSignal): Promise<CurrentWorkspaceAuthority> {
    this.assertSession(sessionId)
    const membership = this.read().find(item => item.sessionIds.includes(sessionId))?.workspaceId
    if (membership === undefined) throw new RecordedWorkspaceChanged()
    const live = this.bindRecordedSession(sessionId, membership, signal)
    const root = await this.recordedWorkspaceRoot(sessionId, live, signal); live.check()
    const info = await this.files!.fs.stat(root, signal); live.check()
    if (info?.type !== 'directory') throw new RecordedWorkspaceChanged()
    return {
      root, assertCurrentSync: live.check,
      assertCurrent: async () => {
        const current = await this.recordedWorkspaceRoot(sessionId, live, signal); live.check()
        if (current.targetKey !== root.targetKey) throw new RecordedWorkspaceChanged()
        const next = await this.files!.fs.stat(current, signal); live.check()
        if (next?.type !== 'directory' || next.version !== info.version) throw new RecordedWorkspaceChanged()
      },
    }
  }
  /** Bind one multi-file read to its initial selected workspace and canonical Host root. */
  async bindRecordedWorkspace(sessionId: string, recordedRoot: string, signal?: AbortSignal): Promise<RecordedWorkspaceAuthority> {
    this.assertSession(sessionId)
    const membership = this.read().find(item => item.sessionIds.includes(sessionId))?.workspaceId
    if (membership === undefined) throw new RecordedWorkspaceChanged()
    const live = this.bindRecordedSession(sessionId, membership, signal)
    const root = await this.recordedWorkspaceRoot(sessionId, live, signal)
    live.check()
    const recorded = await this.files!.fs.resolve(recordedRoot, { signal })
    live.check()
    if (root.targetKey !== recorded.targetKey) throw new RecordedWorkspaceChanged()
    return {
      assertCurrentSync: live.check,
      assertCurrent: async () => {
        const current = await this.recordedWorkspaceRoot(sessionId, live, signal)
        live.check()
        if (current.targetKey !== root.targetKey) throw new RecordedWorkspaceChanged()
      },
    }
  }
  /** Recorded immutable snapshots only. An absent working-tree file does not erase its history.
   * This does NOT authorize current byte reads: rc.2 has no atomic scoped read capability.
   */
  async assertRecordedFile(sessionId: string, path: string, recordedRoot: string, signal?: AbortSignal): Promise<void> {
    validateRelativePath(path); this.assertSession(sessionId); signal?.throwIfAborted()
    const ctx = this.files
    if (!ctx) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    const membership = this.read().find(item => item.sessionIds.includes(sessionId))?.workspaceId
    if (membership === undefined) throw new RecordedWorkspaceChanged()
    const live = this.bindRecordedSession(sessionId, membership, signal)
    const check = live.check
    const root = await this.recordedWorkspaceRoot(sessionId, live, signal); check()
    const recorded = await ctx.fs.resolve(recordedRoot, { signal }); check()
    if (root.targetKey !== recorded.targetKey) throw new RecordedWorkspaceChanged()
    const cwd = ctx.fs.processPath(root)
    const parts = path.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const entry = await ctx.fs.lstat(parts.slice(0, i).join('/'), { cwd }, signal); check()
      if (entry && (i === parts.length ? entry.type !== 'file' : entry.type !== 'directory')) throw new ProtocolError('OUT_OF_SCOPE')
    }
    const target = await ctx.fs.resolve(path, { cwd, signal }); check()
    if (!ctx.fs.contains(root, target)) throw new ProtocolError('OUT_OF_SCOPE')
    const finalRoot = await this.recordedWorkspaceRoot(sessionId, live, signal); check()
    if (finalRoot.targetKey !== root.targetKey) throw new RecordedWorkspaceChanged()
    const finalTarget = await ctx.fs.resolve(path, { cwd: ctx.fs.processPath(finalRoot), signal }); check()
    if (finalTarget.targetKey !== target.targetKey || !ctx.fs.contains(finalRoot, finalTarget)) throw new ProtocolError('OUT_OF_SCOPE')
  }
  private checkRecordedWorkspace(sessionId: string, workspaceId: string, signal?: AbortSignal): void {
    signal?.throwIfAborted()
    try { this.assertSession(sessionId, workspaceId) } catch (error) {
      if (error instanceof ProtocolError && error.code === 'OUT_OF_SCOPE') throw new RecordedWorkspaceChanged()
      throw error
    }
  }
  private bindRecordedSession(sessionId: string, workspaceId: string, signal?: AbortSignal): RecordedSessionAuthority {
    const ctx = this.files
    if (!ctx) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    this.checkRecordedWorkspace(sessionId, workspaceId, signal)
    const session = ctx.sessions.get(SessionId(sessionId))
    const header = session?.header
    const cwd = header?.cwd
    // Public rc.2 retains recorded changes only for live Sessions with a cwd.
    if (!session || !header || typeof cwd !== 'string' || !cwd) throw new RecordedWorkspaceChanged()
    const check = () => {
      this.checkRecordedWorkspace(sessionId, workspaceId, signal)
      if (ctx.sessions.get(SessionId(sessionId)) !== session || session.header !== header || header.cwd !== cwd) throw new RecordedWorkspaceChanged()
    }
    check()
    return { cwd, check }
  }
  private async recordedWorkspaceRoot(sessionId: string, live: RecordedSessionAuthority, signal?: AbortSignal): Promise<FsTarget> {
    const ctx = this.files
    if (!ctx) throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    live.check()
    const value = await ctx.typert.lookups.get('workspaceFileScope')?.resolve(sessionId)
    live.check()
    if (!value || typeof value !== 'object' || !('sessionId' in value) || value.sessionId !== sessionId
      || !('workspaceRoot' in value) || value.workspaceRoot !== live.cwd) throw new RecordedWorkspaceChanged()
    const root = await ctx.fs.resolve(live.cwd, { signal })
    live.check()
    return root
  }
  /** Current previews remain unavailable until Host offers an atomic contained read. */
  async assertReadableFile(sessionId: string, path: string): Promise<void> {
    this.assertSession(sessionId); validateRelativePath(path)
    throw new ProtocolError('PROTOCOL_UNSUPPORTED', 'Atomic scoped file reads are unavailable on public rc.2')
  }
  assertCreate(workspaceId: string, sessionId: string): void {
    opaqueId(sessionId)
    this.assertWorkspace(workspaceId)
    if (this.read().some(item => item.workspaceId !== workspaceId && item.sessionIds.includes(sessionId))) throw new ProtocolError('OUT_OF_SCOPE')
  }
}

/** Protocol JSON paths are already decoded. Never URL-decode filesystem names. */
export function validateRelativePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096 || input.includes('\0')
    || input.startsWith('/') || input.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(input)
    || input.split('/').some(part => part === '..' || part === '')) throw new ProtocolError('OUT_OF_SCOPE')
  return input
}
