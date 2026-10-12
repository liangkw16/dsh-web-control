import { randomBytes } from 'node:crypto'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_LIMITS, validateHeartbeat, validateLimits } from '@dsh-web-control/protocol'
import { assertOrigin } from './origin.ts'
import { AuthStore, hashSecret, validateSecret } from './auth.ts'
import { acquireDatabaseLock, backupDatabase, restoreDatabase, inspectDatabase } from './backup.ts'
import { log } from './logging.ts'
import { startRelay } from './server.ts'
import { probeHealth, unavailableHealth } from './health.ts'

type Environment = Record<string, string | undefined>
async function secretFile(path: string | undefined): Promise<string> {
  if (!path) throw new Error('Secret file required')
  const secret = path === '-' ? await new Promise<string>((resolve, reject) => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { text += chunk; if (text.length > 128) { reject(new Error('Secret input too large')); process.stdin.destroy() } }); process.stdin.on('end', () => resolve(text.trim())); process.stdin.on('error', reject) }) : (await readFile(path, 'utf8')).trim()
  validateSecret(secret); return secret
}
export function deploymentTuning(env: Environment) {
  const integer = (key: string, fallback: number) => {
    const value = env[key]
    if (value === undefined) return fallback
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid deployment tuning')
    return Number(value)
  }
  const heartbeatMs = integer('HEARTBEAT_MS', 10000), leaseTtlMs = integer('LEASE_TTL_MS', 30000)
  validateHeartbeat(heartbeatMs, leaseTtlMs)
  const limits = validateLimits({ ...DEFAULT_LIMITS, bufferedBytes: integer('BUFFERED_BYTES', DEFAULT_LIMITS.bufferedBytes), calls: integer('MAX_CALLS', DEFAULT_LIMITS.calls), streams: integer('MAX_STREAMS', DEFAULT_LIMITS.streams), uploads: integer('MAX_UPLOADS', DEFAULT_LIMITS.uploads) })
  return { heartbeatMs, leaseTtlMs, limits }
}
export async function serveEnvironment(env: Environment) {
  const tuning = deploymentTuning(env)
  const port = Number(env.PORT ?? 8787), host = env.LISTEN_HOST ?? '0.0.0.0'
  if (!env.PUBLIC_ORIGIN || !env.DATABASE_PATH || !env.ENROLLMENT_SECRET_FILE) return unavailableHealth(port, host)
  const verifier = hashSecret(await secretFile(env.ENROLLMENT_SECRET_FILE)), release = await acquireDatabaseLock(env.DATABASE_PATH)
  try {
    const service = await startRelay({ publicOrigin: env.PUBLIC_ORIGIN, databasePath: env.DATABASE_PATH, enrollmentVerifier: verifier, listenHost: host, port, staticDir: env.STATIC_DIR ?? new URL('../public', import.meta.url).pathname, ...tuning })
    const metricsTimer = setInterval(() => log({ level: 'info', event: 'relay.metrics', ...service.metrics() }), 30000); metricsTimer.unref()
    return { port: service.port, close: async () => { clearInterval(metricsTimer); try { await service.close() } finally { await release() } } }
  } catch (error) { await release(); throw error }
}
export async function runCli(args: string[], env: Environment = process.env, print: (line: string) => void = console.log): Promise<void> {
  const [command, ...rest] = args, options: Record<string, string> = {}
  const allowed = new Set(['--secret-file', '--database', '--destination', '--backup', '--instance'])
  for (let i = 0; i < rest.length; i += 2) { const key = rest[i]!, value = rest[i + 1]; if (!allowed.has(key) || !value || value.startsWith('--') || options[key]) throw new Error('Invalid CLI option'); options[key] = value }
  const database = options['--database'] ?? env.DATABASE_PATH, path = options['--secret-file'] ?? env.ENROLLMENT_SECRET_FILE
  if (command === 'init') {
    if (!path || path === '-') throw new Error('Writable secret file required')
    await writeFile(path, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' }); print('Enrollment secret initialized in private file'); return
  }
  if (command === 'serve') {
    const service = await serveEnvironment(env); print(JSON.stringify({ event: 'relay.listening', port: service.port }))
    let stopping = false
    const stop = () => { if (stopping) return; stopping = true; const timer = setTimeout(() => process.exit(1), 5000); timer.unref(); void service.close().then(() => { clearTimeout(timer); process.exit(0) }, () => process.exit(1)) }
    process.once('SIGTERM', stop); process.once('SIGINT', stop); return
  }
  if (command === 'healthcheck') { await probeHealth(Number(env.PORT ?? 8787)); return }
  if (!database) throw new Error('Database path required')
  if (command === 'backup') { if (!options['--destination']) throw new Error('Destination required'); await backupDatabase(database, options['--destination']); print('Consistent database backup complete'); return }
  if (command === 'restore') { if (!options['--backup']) throw new Error('Backup required'); await restoreDatabase(options['--backup'], database); print('Database restored; previous snapshot retained'); return }
  if (command === 'doctor') {
    if (env.PUBLIC_ORIGIN) assertOrigin(env.PUBLIC_ORIGIN, env.PUBLIC_ORIGIN)
    const diagnostics = inspectDatabase(database); let healthy = false
    try { await probeHealth(Number(env.PORT ?? 8787)); healthy = true } catch {}
    print(JSON.stringify({ publicUrl: env.PUBLIC_ORIGIN ?? null, database, ...diagnostics, protocol: 1, healthy })); return
  }
  if (command !== 'rotate-enrollment' && command !== 'remove-device') throw new Error('Unknown CLI command')
  const release = await acquireDatabaseLock(database)
  try {
    if (command === 'rotate-enrollment') {
      if (!path || path === '-') throw new Error('Writable secret file required')
      // Rotation uses a newly generated value, never a secret argv argument.
      const temporary = path + '.rotate'; await writeFile(temporary, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' })
      try { await rename(temporary, path) } finally { await rm(temporary, { force: true }) }; print('Enrollment rotated; force-recreate the relay container after atomic secret replacement before enrollment (docker compose up -d --force-recreate relay)')
    } else {
      if (!options['--instance']) throw new Error('Instance required')
      const store = new AuthStore(database, { now: Date.now }, hashSecret(await secretFile(path)))
      try { store.remove(options['--instance']) } finally { store.close() }; print('Device revoked')
    }
  } finally { await release() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runCli(process.argv.slice(2)).catch(error => { if (error instanceof Error && /Unsupported .*database|Unsupported authentication database/.test(error.message)) { console.error('Unsupported database schema; this image cannot serve it'); process.exitCode = 1; return }; console.error('Relay command failed; check configuration, schema, permissions and stopped-service lock'); process.exitCode = 1 })
}
