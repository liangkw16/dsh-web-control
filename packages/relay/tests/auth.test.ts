import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'
import { ProtocolError } from '@dsh-web-control/protocol'
import { AuthStore, hashSecret, SESSION_LIFETIME_MS } from '../src/auth.ts'
import { openDatabase } from '../src/db.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const credential = (byte: number): string => Buffer.alloc(32, byte).toString('base64url')
const enroll = credential(1), device = credential(2), link = credential(3), rotated = credential(4)
const paths: string[] = []
const stores: AuthStore[] = []
let now = 1000
function store(path = ':memory:'): AuthStore {
  const result = new AuthStore(path, { now: () => now }, hashSecret(enroll))
  stores.push(result)
  return result
}
function file(): string { const directory = mkdtempSync(join(tmpdir(), 'dsh-relay-auth-')); paths.push(directory); return join(directory, 'relay.sqlite') }
function register(db: AuthStore, instanceId = A, authEpoch = 1): void {
  db.register({ enrollmentSecret: enroll, instanceId, deviceSecret: device, linkVerifier: hashSecret(link), authEpoch })
}
afterEach(() => { for (const db of stores.splice(0)) db.close(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); now = 1000 })

function fault(action: () => unknown, code: string): void {
  let failure: unknown
  try { action() } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(ProtocolError)
  expect(failure).toMatchObject({ code, retryable: false })
}

test('hash uses SHA-256 hex and registration authenticates only the original device', () => {
  expect(hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const db = store(); register(db)
  expect(() => db.authenticateDevice(A, device)).not.toThrow()
  fault(() => db.authenticateDevice(A, credential(9)), 'AUTH_FAILED')
  fault(() => db.authenticateDevice(B, device), 'AUTH_FAILED')
})

test('registration cannot replace an existing device or authorization', () => {
  const db = store(); register(db)
  fault(() => db.register({ enrollmentSecret: enroll, instanceId: A, deviceSecret: credential(9), linkVerifier: hashSecret(rotated), authEpoch: 10 }), 'INSTANCE_EXISTS')
  db.authenticateDevice(A, device)
  expect(db.authorize(A, db.login(A, link).sessionToken)).toEqual({ authEpoch: 1 })
})

test('invalid enrollment fails before storing an identity', () => {
  const db = store()
  fault(() => db.register({ enrollmentSecret: credential(9), instanceId: A, deviceSecret: device, linkVerifier: hashSecret(link), authEpoch: 1 }), 'AUTH_FAILED')
  register(db)
})

test('original link and browser session survive database restart and migrations are idempotent', () => {
  const path = file(); let db = store(path); register(db)
  const session = db.login(A, link); db.close(); db = store(path)
  db.authenticateDevice(A, device)
  expect(db.authorize(A, session.sessionToken)).toEqual({ authEpoch: 1 })
  expect(db.authorize(A, db.login(A, link).sessionToken)).toEqual({ authEpoch: 1 })
  const read = new Database(path, { readonly: true })
  expect(read.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 }); read.close()
})

test('sessions have a fixed 30 day expiry without sliding renewal; links remain reusable', () => {
  const db = store(); register(db); const session = db.login(A, link)
  expect(SESSION_LIFETIME_MS).toBe(30 * 24 * 60 * 60 * 1000)
  expect(session.expiresAt).toBe(1000 + SESSION_LIFETIME_MS)
  now = session.expiresAt - 1; expect(db.authorize(A, session.sessionToken)).toEqual({ authEpoch: 1 })
  now = session.expiresAt; fault(() => db.authorize(A, session.sessionToken), 'AUTH_EXPIRED')
  expect(db.login(A, link).expiresAt).toBe(now + SESSION_LIFETIME_MS)
})

test('tokens are random 32 byte secrets and bind browser authorization to one instance', () => {
  const db = store(); register(db); register(db, B)
  const first = db.login(A, link).sessionToken, second = db.login(A, link).sessionToken
  expect(Buffer.from(first, 'base64url')).toHaveLength(32); expect(first).not.toBe(second)
  fault(() => db.authorize(B, first), 'AUTH_REQUIRED')
  fault(() => db.authorize(A, credential(9)), 'AUTH_REQUIRED')
  fault(() => db.login(A, credential(9)), 'AUTH_FAILED')
})

test('rotation revokes every previous session and link durably', () => {
  const path = file(); let db = store(path); register(db)
  const first = db.login(A, link), second = db.login(A, link)
  db.syncAuthorization(A, device, 2, hashSecret(rotated), true)
  for (const session of [first, second]) fault(() => db.authorize(A, session.sessionToken), 'AUTH_REQUIRED')
  fault(() => db.login(A, link), 'AUTH_FAILED')
  const replacement = db.login(A, rotated); expect(db.authorize(A, replacement.sessionToken)).toEqual({ authEpoch: 2 })
  db.close(); db = store(path)
  fault(() => db.login(A, link), 'AUTH_FAILED'); fault(() => db.authorize(A, first.sessionToken), 'AUTH_REQUIRED')
  expect(db.authorize(A, replacement.sessionToken)).toEqual({ authEpoch: 2 })
})

test('stopping disables link and cookies after restart while device can sync a higher epoch', () => {
  const path = file(); let db = store(path); register(db); const session = db.login(A, link)
  db.syncAuthorization(A, device, 2, hashSecret(link), false); db.close(); db = store(path)
  fault(() => db.login(A, link), 'AUTH_REVOKED'); fault(() => db.authorize(A, session.sessionToken), 'AUTH_REQUIRED')
  db.authenticateDevice(A, device); db.syncAuthorization(A, device, 3, hashSecret(rotated), true)
  expect(db.authorize(A, db.login(A, rotated).sessionToken)).toEqual({ authEpoch: 3 })
})

test('same epoch is idempotent but differing verifier or enabled state conflicts; downgrade is rejected', () => {
  const db = store(); register(db, A, 3); const session = db.login(A, link)
  db.syncAuthorization(A, device, 3, hashSecret(link), true)
  fault(() => db.syncAuthorization(A, device, 3, hashSecret(rotated), true), 'AUTH_EPOCH_CONFLICT')
  fault(() => db.syncAuthorization(A, device, 3, hashSecret(link), false), 'AUTH_EPOCH_CONFLICT')
  fault(() => db.syncAuthorization(A, device, 2, hashSecret(rotated), true), 'AUTH_EPOCH_CONFLICT')
  expect(db.authorize(A, session.sessionToken)).toEqual({ authEpoch: 3 })
})

test('unauthenticated device cannot rotate or stop authorization', () => {
  const db = store(); register(db)
  fault(() => db.syncAuthorization(A, credential(9), 2, hashSecret(rotated), false), 'AUTH_FAILED')
  expect(db.authorize(A, db.login(A, link).sessionToken)).toEqual({ authEpoch: 1 })
})

test('removal retains a tombstone across restarts, rejects enrollment and leaves other instances authorized', () => {
  const path = file(); let db = store(path); register(db); register(db, B)
  const first = db.login(A, link), other = db.login(B, link)
  db.remove(A); db.remove(A); db.close(); db = store(path)
  fault(() => db.authenticateDevice(A, device), 'AUTH_REVOKED'); fault(() => db.login(A, link), 'AUTH_REVOKED')
  fault(() => db.authorize(A, first.sessionToken), 'AUTH_REQUIRED'); fault(() => register(db), 'INSTANCE_EXISTS')
  fault(() => db.syncAuthorization(A, device, 2, hashSecret(rotated), true), 'AUTH_REVOKED')
  expect(db.authorize(B, other.sessionToken)).toEqual({ authEpoch: 1 })
  const read = new Database(path, { readonly: true })
  expect(read.prepare('SELECT revoked, enabled FROM devices WHERE id = ?').get(A)).toEqual({ revoked: 1, enabled: 0 }); read.close()
})

test('database persists only verifiers, uses WAL and enforces foreign keys', () => {
  const path = file(); const db = store(path); register(db); const session = db.login(A, link)
  const read = openDatabase(path)
  expect(read.pragma('foreign_keys', { simple: true })).toBe(1)
  expect(read.pragma('journal_mode', { simple: true })).toBe('wal')
  expect(read.prepare('SELECT device_verifier, link_verifier FROM devices').get()).toEqual({ device_verifier: hashSecret(device), link_verifier: hashSecret(link) })
  expect(read.prepare('SELECT token_verifier FROM browser_sessions').get()).toEqual({ token_verifier: hashSecret(session.sessionToken) })
  expect(() => read.prepare('INSERT INTO browser_sessions VALUES (?, ?, ?, ?)').run(hashSecret(rotated), B, 1, 1000)).toThrow('FOREIGN KEY')
  read.close(); db.close()
  for (const secret of [enroll, device, link, session.sessionToken]) expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false)
})

test('rotation rolls back device changes when session revocation fails', () => {
  const path = file(); const db = store(path); register(db); const session = db.login(A, link)
  const connection = new Database(path)
  connection.exec("CREATE TRIGGER reject_session_delete BEFORE DELETE ON browser_sessions BEGIN SELECT RAISE(ABORT, 'synthetic secret must not escape'); END")
  let rejected: unknown
  try { db.syncAuthorization(A, device, 2, hashSecret(rotated), true) } catch (error) { rejected = error }
  expect(rejected).toMatchObject({ code: 'STORAGE_ERROR' })
  expect(String(rejected)).not.toContain('synthetic secret must not escape')
  expect(db.authorize(A, session.sessionToken)).toEqual({ authEpoch: 1 })
  expect(() => db.login(A, link)).not.toThrow(); fault(() => db.login(A, rotated), 'AUTH_FAILED')
  connection.close()
})

test.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('invalid auth epoch %s cannot register or sync', authEpoch => {
  const db = store()
  fault(() => register(db, A, authEpoch), 'INVALID_MESSAGE'); register(db)
  fault(() => db.syncAuthorization(A, device, authEpoch, hashSecret(link), true), 'INVALID_MESSAGE')
})

test('maximum safe epoch is supported', () => {
  const db = store(); register(db, A, Number.MAX_SAFE_INTEGER)
  expect(db.authorize(A, db.login(A, link).sessionToken)).toEqual({ authEpoch: Number.MAX_SAFE_INTEGER })
})

test.each(['host-a', 'abcdefab-cdef-4abc-8abc-abcdefabcdef'.toUpperCase(), `${A}\r\nInjected: true`])('invalid instance %s is rejected', instanceId => {
  const db = store(); fault(() => register(db, instanceId), 'INVALID_MESSAGE')
  fault(() => db.authenticateDevice(instanceId, device), 'INVALID_MESSAGE'); fault(() => db.remove(instanceId), 'INVALID_MESSAGE')
})

test('malformed secrets, verifiers and enabled state cannot be persisted or used', () => {
  const db = store()
  fault(() => db.register({ enrollmentSecret: enroll, instanceId: A, deviceSecret: 'short', linkVerifier: hashSecret(link), authEpoch: 1 }), 'INVALID_MESSAGE')
  fault(() => db.register({ enrollmentSecret: enroll, instanceId: A, deviceSecret: device, linkVerifier: 'plaintext', authEpoch: 1 }), 'INVALID_MESSAGE')
  register(db)
  fault(() => db.syncAuthorization(A, device, 2, hashSecret(link), 1 as unknown as boolean), 'INVALID_MESSAGE')
  fault(() => db.login(A, 'short'), 'INVALID_MESSAGE'); fault(() => db.authorize(A, 'short'), 'INVALID_MESSAGE')
})


test('authorization rejects a known stale-epoch session even if a row is retained', () => {
  const path = file(); const db = store(path); register(db); const session = db.login(A, link)
  db.syncAuthorization(A, device, 2, hashSecret(rotated), true)
  const connection = new Database(path)
  connection.prepare('INSERT INTO browser_sessions VALUES (?, ?, ?, ?)').run(hashSecret(session.sessionToken), A, 1, session.expiresAt)
  connection.close()
  fault(() => db.authorize(A, session.sessionToken), 'AUTH_REVOKED')
})

test('a second store sees authorization changes without stale in-memory state', () => {
  const path = file(); const first = store(path); register(first); const second = store(path)
  const session = second.login(A, link)
  first.syncAuthorization(A, device, 2, hashSecret(rotated), true)
  fault(() => second.authorize(A, session.sessionToken), 'AUTH_REQUIRED')
  fault(() => second.syncAuthorization(A, device, 1, hashSecret(link), true), 'AUTH_EPOCH_CONFLICT')
  expect(second.authorize(A, second.login(A, rotated).sessionToken)).toEqual({ authEpoch: 2 })
})

test('a failed migration rolls back every newly created table and migration marker', () => {
  const path = file(); const connection = new Database(path)
  connection.exec('CREATE TABLE browser_sessions (existing INTEGER)')
  expect(() => store(path)).toThrow('STORAGE_ERROR')
  expect(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: 'browser_sessions' }])
  connection.close()
})

test('constructor rejects plaintext enrollment verifier with a shared Fault', () => {
  fault(() => new AuthStore(':memory:', { now: () => now }, enroll), 'INVALID_MESSAGE')
})

test('readiness writes and rolls back without authorization changes, rejects read-only and busy storage within bound', () => {
  const path = file(), auth = store(path); register(auth)
  const db = new Database(path)
  try {
    const before = db.prepare('SELECT * FROM devices').all(); auth.check()
    expect(db.prepare('SELECT * FROM devices').all()).toEqual(before)
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }])
    // Simulate connection-level read-only storage; SELECT alone would succeed.
    const owned = (auth as unknown as { db: Database.Database }).db
    owned.pragma('query_only = ON'); expect(() => auth.check()).toThrow('Relay authentication storage failed'); owned.pragma('query_only = OFF')
    db.exec('BEGIN IMMEDIATE'); const started = Date.now(); expect(() => auth.check()).toThrow('Relay authentication storage failed'); expect(Date.now() - started).toBeLessThan(1000); db.exec('ROLLBACK')
    auth.check()
  } finally { if (db.inTransaction) db.exec('ROLLBACK'); db.close() }
})
