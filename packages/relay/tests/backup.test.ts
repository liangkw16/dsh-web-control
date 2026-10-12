import { afterEach, expect, test } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { backupDatabase, restoreDatabase, acquireDatabaseLock } from '../src/backup.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { AuthStore, hashSecret } from '../src/auth.ts'
import { openDatabase } from '../src/db.ts'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function paths() { const dir = await mkdtemp(join(tmpdir(), 'dsh-deploy-')); dirs.push(dir); return { databasePath: join(dir, 'relay.sqlite'), backupPath: join(dir, 'backup.sqlite') } }
test('backup contains committed rows while WAL is active', async () => {
  const { databasePath, backupPath } = await paths()
  const db = new Database(databasePath)
  try {
    db.pragma('journal_mode = WAL'); db.exec('CREATE TABLE proof(id INTEGER PRIMARY KEY); INSERT INTO proof VALUES(1)')
    await backupDatabase(databasePath, backupPath)
    const restored = new Database(backupPath, { readonly: true })
    try { expect(restored.prepare('SELECT id FROM proof').all()).toEqual([{ id: 1 }]) } finally { restored.close() }
  } finally { db.close() }
})
test('restore preserves authorization links and old consistent database', async () => {
  const { databasePath, backupPath } = await paths()
  const enrollmentSecret = randomBytes(32).toString('base64url'), linkSecret = randomBytes(32).toString('base64url'), deviceSecret = randomBytes(32).toString('base64url'), instanceId = randomUUID()
  const store = new AuthStore(databasePath, { now: Date.now }, hashSecret(enrollmentSecret))
  store.register({ enrollmentSecret, deviceSecret, instanceId, linkVerifier: hashSecret(linkSecret), authEpoch: 1 })
  const { sessionToken } = store.login(instanceId, linkSecret); store.close()
  await backupDatabase(databasePath, backupPath)
  const changed = new AuthStore(databasePath, { now: Date.now }, hashSecret(enrollmentSecret)); changed.remove(instanceId); changed.close()
  await restoreDatabase(backupPath, databasePath)
  const restored = new AuthStore(databasePath, { now: Date.now }, hashSecret(enrollmentSecret))
  try { expect(restored.authorize(instanceId, sessionToken)).toEqual({ authEpoch: 1 }); expect(restored.login(instanceId, linkSecret).sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/); restored.authenticateDevice(instanceId, deviceSecret) } finally { restored.close() }
  expect((await readFile(databasePath + '.previous')).length).toBeGreaterThan(0)
})
test('restore rejects unsupported schema and corrupt files without replacing target', async () => {
  const { databasePath, backupPath } = await paths()
  openDatabase(databasePath).close()
  const original = await readFile(databasePath)
  const newer = openDatabase(backupPath); newer.exec('INSERT INTO schema_migrations VALUES(2)'); newer.close()
  await expect(restoreDatabase(backupPath, databasePath)).rejects.toThrow('Unsupported')
  expect(await readFile(databasePath)).toEqual(original)
  await writeFile(backupPath, 'not sqlite')
  await expect(restoreDatabase(backupPath, databasePath)).rejects.toThrow()
  expect(await readFile(databasePath)).toEqual(original)
})
test('restore rejects a running relay process lock', async () => {
  const { databasePath, backupPath } = await paths(); openDatabase(databasePath).close(); await backupDatabase(databasePath, backupPath)
  const release = await acquireDatabaseLock(databasePath)
  try { await expect(restoreDatabase(backupPath, databasePath)).rejects.toThrow('occupied') } finally { await release() }
})

test('restore refuses a busy SQLite writer even without the cooperative lock', async () => {
  const { databasePath, backupPath } = await paths(); openDatabase(databasePath).close(); await backupDatabase(databasePath, backupPath)
  const writer = new Database(databasePath); writer.exec('BEGIN IMMEDIATE')
  try { await expect(restoreDatabase(backupPath, databasePath)).rejects.toThrow() } finally { writer.exec('ROLLBACK'); writer.close() }
})

test('restore refuses another open WAL database connection', async () => {
  const { databasePath, backupPath } = await paths(); const reader = openDatabase(databasePath); await backupDatabase(databasePath, backupPath)
  try { await expect(restoreDatabase(backupPath, databasePath)).rejects.toThrow() } finally { reader.close() }
})
