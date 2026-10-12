import { afterEach, expect, test } from 'vitest'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../src/db.ts'
import { runCli, serveEnvironment } from '../src/cli.ts'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'dsh-cli-')); dirs.push(dir); await writeFile(join(dir,'index.html'),'<html>isolated CLI fixture</html>'); return { staticDir:dir, secret: join(dir, 'enrollment'), db: join(dir, 'relay.sqlite') } }
test('init writes private secret without printing it and refuses argv secrets', async () => {
  const f = await fixture(), output: string[] = []
  await runCli(['init', '--secret-file', f.secret], {}, line => output.push(line))
  const secret = (await readFile(f.secret, 'utf8')).trim()
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/); expect((await stat(f.secret)).mode & 0o777).toBe(0o600)
  expect(output.join('')).not.toContain(secret)
  await expect(runCli(['init', '--secret', secret], {}, () => {})).rejects.toThrow('option')
  await expect(runCli(['init', '--secret-file', f.secret], {}, () => {})).rejects.toThrow()
})
test('missing configuration reports readiness 503', async () => {
  const service = await serveEnvironment({ PORT: '0', LISTEN_HOST: '127.0.0.1' })
  try { expect((await fetch(`http://127.0.0.1:${service.port}/health/live`)).status).toBe(200); expect((await fetch(`http://127.0.0.1:${service.port}/health/ready`)).status).toBe(503) } finally { await service.close() }
})
test('configured relay is ready with zero Hosts and holds an exclusive process lock', async () => {
  const f = await fixture(); await runCli(['init', '--secret-file', f.secret], {}, () => {})
  const env = { PORT: '0', LISTEN_HOST: '127.0.0.1', PUBLIC_ORIGIN: 'https://control.example', DATABASE_PATH: f.db, ENROLLMENT_SECRET_FILE: f.secret, STATIC_DIR: f.staticDir }
  const service = await serveEnvironment(env)
  try { expect((await fetch(`http://127.0.0.1:${service.port}/health/ready`)).status).toBe(200); await expect(serveEnvironment(env)).rejects.toThrow('occupied') } finally { await service.close() }
})

test('enrollment rotation refuses a running relay and takes effect after restart', async () => {
  const f = await fixture(); await runCli(['init', '--secret-file', f.secret], {}, () => {})
  const original = (await readFile(f.secret, 'utf8')).trim()
  const env = { PORT: '0', LISTEN_HOST: '127.0.0.1', PUBLIC_ORIGIN: 'https://control.example', DATABASE_PATH: f.db, ENROLLMENT_SECRET_FILE: f.secret, STATIC_DIR: f.staticDir }
  const service = await serveEnvironment(env)
  try { await expect(runCli(['rotate-enrollment'], env, () => {})).rejects.toThrow('occupied'); expect((await readFile(f.secret, 'utf8')).trim()).toBe(original) } finally { await service.close() }
  await runCli(['rotate-enrollment'], env, () => {})
  const current = (await readFile(f.secret, 'utf8')).trim(); expect(current).not.toBe(original); expect((await stat(f.secret)).mode & 0o777).toBe(0o600)
  const restarted = await serveEnvironment(env)
  try {
    const register = (secret: string) => fetch(`http://127.0.0.1:${restarted.port}/v1/devices/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enrollmentSecret: secret, instanceId: randomUUID(), deviceSecret: current, linkVerifier: createHash('sha256').update(current).digest('hex'), authEpoch: 1 }) })
    expect((await register(original)).status).toBe(401); expect((await register(current)).status).toBe(201)
  } finally { await restarted.close() }
})

test('this schema-one server refuses a newer schema without downgrade', async () => {
  const f = await fixture(); await runCli(['init', '--secret-file', f.secret], {}, () => {})
  const db = openDatabase(f.db); db.exec('INSERT INTO schema_migrations VALUES(2)'); db.close()
  await expect(serveEnvironment({ PORT: '0', LISTEN_HOST: '127.0.0.1', PUBLIC_ORIGIN: 'https://control.example', DATABASE_PATH: f.db, ENROLLMENT_SECRET_FILE: f.secret, STATIC_DIR: f.staticDir })).rejects.toThrow('Unsupported authentication database migration')
  const read = new Database(f.db, { readonly: true })
  try { expect(read.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]) } finally { read.close() }
  await expect(stat(f.db + '.lock')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('doctor reports only public configuration, schema, protocol and live health', async () => {
  const f = await fixture(); await runCli(['init', '--secret-file', f.secret], {}, () => {})
  const env = { PORT: '0', LISTEN_HOST: '127.0.0.1', PUBLIC_ORIGIN: 'https://control.example', DATABASE_PATH: f.db, ENROLLMENT_SECRET_FILE: f.secret, STATIC_DIR: f.staticDir }
  const service = await serveEnvironment(env), output: string[] = []
  try {
    await runCli(['doctor'], { ...env, PORT: String(service.port) }, line => output.push(line))
    const diagnostic = JSON.parse(output.join(''))
    expect(Object.keys(diagnostic).sort()).toEqual(['database', 'healthy', 'protocol', 'publicUrl', 'schema', 'sqlite'])
    expect(diagnostic).toMatchObject({ database: f.db, healthy: true, protocol: 1, publicUrl: env.PUBLIC_ORIGIN, schema: 1 })
    expect(output.join('')).not.toContain((await readFile(f.secret, 'utf8')).trim())
  } finally { await service.close() }
})

test('deployment timing and limits reject invalid combinations before opening storage', async () => {
  const { deploymentTuning } = await import('../src/cli.ts')
  expect(deploymentTuning({ HEARTBEAT_MS: '2000', LEASE_TTL_MS: '7000', MAX_CALLS: '4' })).toMatchObject({ heartbeatMs: 2000, leaseTtlMs: 7000, limits: { calls: 4 } })
  for (const env of [{ HEARTBEAT_MS: '0' }, { HEARTBEAT_MS: '30000', LEASE_TTL_MS: '10000' }, { MAX_CALLS: '-1' }, { MAX_UPLOADS: 'NaN' }]) expect(() => deploymentTuning(env)).toThrow()
})
