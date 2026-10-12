import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { ProtocolError } from '@dsh-web-control/protocol'

/** Database diagnostics may contain data or paths; never expose them as protocol errors. */
export function storageOperation<T>(operation: () => T): T {
  try { return operation() } catch (error) {
    if (error instanceof ProtocolError) throw error
    throw new ProtocolError('STORAGE_ERROR', 'Relay authentication storage failed', true)
  }
}

export function openDatabase(databasePath: string): Database.Database {
  return storageOperation(() => {
    const db = new Database(databasePath)
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('foreign_keys = ON')
      db.transaction(() => {
        db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
        const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]
        if (versions.some(({ version }) => version !== 1)) throw new ProtocolError('STORAGE_ERROR', 'Unsupported authentication database migration')
        if (!versions.length) {
          db.exec(readFileSync(new URL('./migrations/001.sql', import.meta.url), 'utf8'))
          db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run()
        }
      }).immediate()
      return db
    } catch (error) { db.close(); throw error }
  })
}
