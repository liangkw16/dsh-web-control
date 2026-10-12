import { mkdir, rm, rename, chmod, open, lstat, link } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

export const SCHEMA_VERSION = 1
/** Shared volume lock; stale locks fail closed and require an operator's stopped-service check. */
export async function acquireDatabaseLock(databasePath: string): Promise<() => Promise<void>> {
  const path = resolve(databasePath) + '.lock'
  await mkdir(dirname(path), { recursive: true })
  try { await mkdir(path, { mode: 0o700 }) } catch { throw new Error('Database occupied; stop relay before this operation (stale locks require manual verification)') }
  return async () => { await rm(path, { recursive: true }) }
}
async function sync(path: string): Promise<void> { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e } }
async function regularFile(path: string): Promise<void> { if (!(await lstat(path)).isFile()) throw new Error('Database must be a regular file, not a symlink') }
export function inspectDatabase(path: string): { schema: number; sqlite: string } {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Database integrity check failed')
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]
    if (versions.length !== 1 || versions[0]!.version !== SCHEMA_VERSION) throw new Error('Unsupported database schema')
    db.prepare('SELECT id, device_verifier, link_verifier, auth_epoch, enabled, revoked FROM devices LIMIT 0').all()
    db.prepare('SELECT token_verifier, instance_id, auth_epoch, expires_at FROM browser_sessions LIMIT 0').all()
    if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Database foreign key check failed')
    return { schema: SCHEMA_VERSION, sqlite: (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v }
  } finally { db.close() }
}
async function snapshot(db: Database.Database, destination: string): Promise<void> {
  if (await exists(destination)) throw new Error('Backup destination already exists')
  const temporary = destination + '.tmp-' + randomUUID()
  try {
    await db.backup(temporary); await chmod(temporary, 0o600); await sync(temporary)
    // Hard-link publication refuses an existing destination, unlike rename overwriting it.
    await link(temporary, destination); await sync(dirname(destination))
  } finally { await rm(temporary, { force: true }) }
}
/** SQLite online backup takes a committed snapshot, including active WAL contents. */
export async function backupDatabase(databasePath: string, destination: string): Promise<void> {
  if (resolve(databasePath) === resolve(destination)) throw new Error('Backup destination must differ from database')
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try { await snapshot(db, destination) } finally { db.close() }
}
/** Hold both the shared process lock and SQLite's exclusive file locks through replacement. */
export async function restoreDatabase(backupPath: string, databasePath: string): Promise<void> {
  if (resolve(backupPath) === resolve(databasePath)) throw new Error('Restore source must differ from target')
  const release = await acquireDatabaseLock(databasePath), temporary = databasePath + '.restore-' + randomUUID()
  let target: Database.Database | undefined
  try {
    await regularFile(backupPath); inspectDatabase(backupPath)
    await backupDatabase(backupPath, temporary); inspectDatabase(temporary)
    if (await exists(databasePath)) {
      await regularFile(databasePath)
      if (await exists(databasePath + '.previous')) throw new Error('Previous recovery snapshot already exists')
      target = new Database(databasePath, { fileMustExist: true, timeout: 0 })
      target.pragma('locking_mode = EXCLUSIVE')
      const checkpoint = target.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
      if (checkpoint[0]?.busy) throw new Error('Database occupied')
      target.exec('BEGIN EXCLUSIVE'); target.exec('ROLLBACK')
      // Exit WAL while still exclusively locked. Closing this old connection after
      // replacement must not unlink sidecars belonging to the new database inode.
      if (target.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') throw new Error('Database occupied')
      await snapshot(target, databasePath + '.previous')
    }
    await rm(databasePath + '-wal', { force: true }); await rm(databasePath + '-shm', { force: true })
    await rename(temporary, databasePath); await sync(dirname(databasePath))
  } finally {
    try { target?.close() } finally { await rm(temporary, { force: true }); await release() }
  }
}
