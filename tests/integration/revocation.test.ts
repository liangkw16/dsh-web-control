import { claimEvidenceDirectory } from '../../scripts/evidence-paths.mjs'
const evidenceDir = claimEvidenceDirectory('system')
import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import { systemFixture, prompt } from '../support/host-driver.ts'
test.each(['rotate', 'stop'] as const)('%s revokes the old cookie and old Fence before further intake', async action => {
  const f = await systemFixture()
  try {
    const cookie = f.browser.cookie, oldFence = f.browser.transport.getSnapshot().fence!
    await f.host.lifecycle[action]()
    await vi.waitFor(() => expect(f.browser.transport.getSnapshot().phase).not.toBe('ready'))
    const response = await fetch(`${f.relay.origin}/v1/instances/${oldFence.instanceId}/control-status`, { method: 'POST', headers: { Cookie: cookie, Origin: f.relay.publicOrigin, 'Content-Type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(401); await response.body?.cancel()
    await expect(f.browser.transport.call(prompt())).rejects.toThrow(); expect(f.host.acceptedPrompts()).toEqual([])
  } finally { await f.close() }
})
test('relay older DB is overwritten by latest Host epoch before attach; old cookie fails', async () => {
  const f = await systemFixture()
  try {
    const cookie = f.browser.cookie; f.host.disconnect(); await f.browser.close(); const backup = await f.relay.backup(); await f.host.reconnect(); await f.host.lifecycle.rotate()
    f.host.disconnect(); await f.relay.restart(backup); await f.host.reconnect()
    const id = (await f.host.identity.load())!.instanceId
    const response = await fetch(`${f.relay.origin}/v1/instances/${id}/control-status`, { method: 'POST', headers: { Cookie: cookie, Origin: f.relay.publicOrigin, 'Content-Type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(401); await response.body?.cancel(); expect(f.host.lifecycle.status().phase).toBe('ready')
  } finally { await f.close() }
})

test('old control and auth epoch frames execute zero production commands', async () => {
  const f = await systemFixture()
  try {
    const old = f.browser.transport.getSnapshot().fence!; f.browser.disconnect()
    await vi.waitFor(() => expect(f.browser.transport.getSnapshot().phase).not.toBe('ready')); await f.browser.connect()
    const socket = [...f.browser.sockets][0]
    socket.send(JSON.stringify({ v: 1, type: 'call', id: crypto.randomUUID(), fence: old, command: prompt() }))
    await vi.waitFor(() => expect(f.browser.transport.getSnapshot().code).toBe('STALE_CONTROL')); expect(f.host.acceptedPrompts()).toEqual([])
    await f.host.lifecycle.rotate(); await f.browser.login(); await f.browser.connect()
    const next = [...f.browser.sockets][0], current = f.browser.transport.getSnapshot().fence!
    next.send(JSON.stringify({ v: 1, type: 'call', id: crypto.randomUUID(), fence: { ...current, authEpoch: old.authEpoch }, command: prompt() }))
    await vi.waitFor(() => expect(f.browser.transport.getSnapshot().phase).not.toBe('ready')); expect(f.host.acceptedPrompts()).toEqual([])
  } finally { await f.close() }
})

test('relay tables, closed backup, browser resume storage and retained diagnostics exclude synthetic forbidden markers', async () => {
  const f = await systemFixture()
  try {
    const rawLink = (await f.host.identity.load())!.linkSecret
    const body = 'synthetic-session-body-' + crypto.randomUUID(), source = 'synthetic-source-file-' + crypto.randomUUID(), modelKey = 'synthetic-model-key-' + crypto.randomUUID()
    f.host.configureModelProvider(modelKey)
    const abort = new AbortController(), iterator = f.browser.transport.watch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, abort.signal)[Symbol.asyncIterator]()
    const remoteValues: unknown[] = [(await iterator.next()).value]
    const command = prompt(); command.content[0].text = body; remoteValues.push(await f.browser.transport.call(command))
    expect(f.host.modelAuthorizations(), 'configured provider must consume its credential').toBe(1)
    // Session watches also carry control baselines; consume until actual model progress.
    for (let frame = 0; frame < 4 && !JSON.stringify(remoteValues).includes('deterministic provider completed'); frame++) remoteValues.push((await iterator.next()).value)
    expect(JSON.stringify(remoteValues).includes('deterministic provider completed'), 'real remote observer receives provider progress').toBe(true)
    remoteValues.push(await f.browser.transport.call({ op: 'session.list', workspaceId: 'w' }), await f.browser.transport.call({ op: 'session.page', sessionId: 'a', throughSeq: 1, maxMessages: 64 }))
    expect(JSON.stringify(remoteValues).includes(modelKey), 'remote progress/query credential scan').toBe(false)
    abort.abort(); await iterator.return?.()
    await f.browser.transport.upload('a', new File([source], 'marker.txt'), new AbortController().signal)
    const markers = [rawLink, body, source, modelKey]
    const serializedStorage = JSON.stringify([...f.browser.storageValues])
    for (const marker of markers) expect(serializedStorage.includes(marker), 'browser forbidden marker scan').toBe(false)
    await f.browser.close(); f.host.disconnect(); const backup = await f.relay.backup()
    const { readFile, readdir } = await import('node:fs/promises'), { join } = await import('node:path')
    for (const path of [...(await readdir(f.relay.dir)).map(name => join(f.relay.dir, name)), backup]) {
      const bytes = await readFile(path); for (const marker of markers) expect(bytes.includes(Buffer.from(marker)), 'relay/backup forbidden marker scan').toBe(false)
    }
    await mkdir(evidenceDir, { recursive: true })
    const diagnostics = (await readdir(evidenceDir)).filter(name => /\.(json|log)$/.test(name))
    for (const name of diagnostics) {
      const bytes = await readFile(join(evidenceDir, name))
      for (const marker of markers) expect(bytes.includes(Buffer.from(marker)), 'retained diagnostic forbidden marker scan').toBe(false)
    }
    await writeFile(evidenceDir + '/marker-scan.json', JSON.stringify({ markers: 4, modelProviderAuthorizations: f.host.modelAuthorizations(), remoteProgressAndQueryCredentialScan: 'pass', relayFilesAndBackup: 'pass', browserSessionStorage: 'pass', retainedDiagnosticFiles: diagnostics.length, diagnostics: 'pass', rawValuesPrinted: false }))
  } finally { await f.close() }
})
