import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'
import { parsePairingConfig } from '../src/client/pairing-config.ts'

test.each([
  'http://relay.example', 'https://relay.example/path', 'https://user:pass@relay.example',
  'https://relay.example/#key=x', 'https://relay.example/?key=x', 'https://relay.example/../',
])('configuration import rejects ambiguous or insecure server origin %s', relayOrigin => {
  expect(() => parsePairingConfig(JSON.stringify({ kind: 'dsh-web-control-connection', version: 1, relayOrigin, enrollmentSecret: 'A'.repeat(43) }))).toThrow('INVALID_CONNECTION_CONFIG')
})
test('invalid, oversized, unsupported and extra-field configuration never exposes its contents in errors', () => {
  const valid = { kind: 'dsh-web-control-connection', version: 1, relayOrigin: 'https://relay.example', enrollmentSecret: 'A'.repeat(43) }
  for (const source of ['secret', 'x'.repeat(8193), JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, action: 'replace-registration' }), JSON.stringify({ ...valid, enrollmentSecret: 'bad-secret' })]) {
    expect(() => parsePairingConfig(source)).toThrow(/^INVALID_CONNECTION_CONFIG$/)
  }
})

test('deployment setup generator writes a private import file and never prints its secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-pairing-')), output = join(dir, 'connection.json'), secret = 'A'.repeat(43)
  const run = (origin: string) => spawnSync(process.execPath, ['scripts/create-connection-config.mjs', '--origin', origin, '--secret-file', '-', '--output', output], { input: secret, encoding: 'utf8' })
  try {
    const result = run('https://relay.example/')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout + result.stderr).not.toContain(secret)
    expect(statSync(output).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ kind: 'dsh-web-control-connection', version: 1, relayOrigin: 'https://relay.example', enrollmentSecret: secret })
    const before = readFileSync(output, 'utf8')
    expect(run('https://other.example').status).not.toBe(0)
    expect(readFileSync(output, 'utf8')).toBe(before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
