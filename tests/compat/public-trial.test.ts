import { test, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
// These rejection paths must finish before installing or starting any Host.
test.each(['HTTP origin', 'world readable enrollment', 'TLS disabled', 'custom CA'])('public runner rejects %s before native execution', async variant => {
 const dir = await mkdtemp(join(tmpdir(), 'public-trial-input-'))
 try {
  const secret = join(dir, 'enrollment'); await writeFile(secret, 'fixture-private-value', { mode: variant === 'world readable enrollment' ? 0o644 : 0o600 })
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: dir }
  if (variant === 'TLS disabled') env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  if (variant === 'custom CA') env.NODE_EXTRA_CA_CERTS = secret
  const run = spawnSync(process.execPath, ['scripts/public-trial.mjs', '--origin', variant === 'HTTP origin' ? 'http://203.0.113.25:8443' : 'https://203.0.113.25:8443', '--enrollment-file', secret], { env, encoding: 'utf8', timeout: 10000 })
  expect(run.status).toBe(1)
  expect(run.stdout).not.toContain('RUNNING')
  expect(run.stderr).not.toContain('fixture-private-value')
 } finally { await rm(dir, { recursive: true, force: true }) }
})
