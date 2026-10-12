import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expect, test } from 'vitest'
import { probeHost } from '../../packages/plugin/src/compat/probe.ts'

test('missing required public service fails closed', async () => {
  const report = await probeHost({ typertGateway: {} } as Context)
  expect(report.supported).toBe(false)
  expect(report.checks.some(c => c.name === 'gateway.events' && !c.ok)).toBe(true)
})

test('method presence alone never establishes support', async () => {
  const fake = { typertGateway: { invoke() {}, stream() {}, wireStream: { open() {} } },
    connection: { createSharedFetchHandler() {} }, credentials: { modifyRecord() {} },
    sessionController: { cancel() {} }, fileUploads: { uploadStream() {} } }
  expect((await probeHost(fake as unknown as Context)).supported).toBe(false)
})

test('profile identity hashes the canonical profile directory and discloses no path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-control-test-'))
  try {
    await mkdir(join(dir, 'profile'))
    await symlink(join(dir, 'profile'), join(dir, 'alias'))
    const a = await probeHost({ profileContext: { dir: join(dir, 'profile') } } as Context)
    const b = await probeHost({ profileContext: { dir: join(dir, 'alias') } } as Context)
    expect(a.profileScope).toMatch(/^[a-f0-9]{64}$/)
    expect(b.profileScope).toBe(a.profileScope)
    expect(JSON.stringify(a)).not.toContain(dir)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
