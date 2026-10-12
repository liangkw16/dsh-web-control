import { claimEvidenceDirectory } from '../../scripts/evidence-paths.mjs'
const evidenceDir = claimEvidenceDirectory('system')
import { expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { systemFixture } from '../support/host-driver.ts'
import { DEFAULT_LIMITS } from '../../packages/protocol/src/index.ts'
import { userData } from '../support/public-host-driver.ts'

// Real socket pacing: 32 MiB / 400 kbps takes about 11.2 minutes, without public latency promises.
test('2000 records and 32 MiB upload at measured 400 kbps preserve control and bounded ownership', async () => {
  const f = await systemFixture(), abort = new AbortController(), started = performance.now()
  const samples: { at: number; hostBytes: number; relayBytes: number; proxyBytes: number; rss: number }[] = []
  const controls: { at: number; elapsed: number }[] = []
  let progressAt = 0
  let outcome = 'running'
  let uploadElapsed = 0
  let recoveredRecords = 0
  const sample = setInterval(() => samples.push({ at: performance.now() - started, hostBytes: f.host.transport.budget.bytes, relayBytes: f.relay.metrics().bufferedBytes, proxyBytes: f.relay.proxyBufferedBytes(), rss: process.memoryUsage().rss }), 100)
  try {
    f.relay.rateLimit(400000)
    const file = new File([new Uint8Array(32 * 1024 * 1024)], 'synthetic.bin', { type: 'application/octet-stream' })
    let finished = false
    const upload = f.browser.transport.upload('a', file, abort.signal).finally(() => { finished = true }); void upload.catch(() => {})
    while (!finished) {
      const at = performance.now(), response = await f.browser.transport.call({ op: 'session.list', workspaceId: 'w' })
      expect(response).toEqual({ items: [{ sessionId: 'a' }] }); controls.push({ at: at - started, elapsed: performance.now() - at })
      if (performance.now() - progressAt > 60000) {
        progressAt = performance.now(); const progress = { event: 'task13.upload.progress', receivedBytes: f.host.uploadBytes, totalBytes: file.size, elapsedMs: Math.round(performance.now() - started), peakHostBytes: f.host.peakBudgetBytes, peakRelayBytes: f.relay.peakRelayBytes() }; console.log(JSON.stringify(progress)); await writeFile(evidenceDir + '/upload-progress.json', JSON.stringify(progress))
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    const receipt = await upload
    expect(receipt).toMatchObject({ receiptId: 'receipt-a', file: { bytes: 32 * 1024 * 1024 } })
    uploadElapsed = performance.now() - started
    expect(f.host.uploadBytes).toBe(32 * 1024 * 1024)
    expect(uploadElapsed).toBeGreaterThan(32 * 1024 * 1024 * 8 / 400000 * 1000)
    expect(uploadElapsed).toBeLessThan(800000)
    expect(Math.max(...samples.map(value => value.hostBytes))).toBeLessThanOrEqual(DEFAULT_LIMITS.bufferedBytes)
    // Fake native source/Host-local journal persists the complete fixed fixture.
    const records = f.host.records.get('a')!
    for (let seq = 0; seq < 2000; seq++) records.push({ type: 'event', event: { type: 'user/message', seq, time: seq + 1, data: userData(`fixed-${seq}`) as any, surfaceOp: 'append' } })
    const iterator = f.browser.transport.watch({ topic: 'session', sessionId: 'a', maxMessages: 64 }, abort.signal)[Symbol.asyncIterator]()
    const first = (await iterator.next()).value as any
    let recovered = first.value.records
    while (recovered[0].event.seq > 0) {
      const page = await f.browser.transport.call({ op: 'session.page', sessionId: 'a', throughSeq: first.value.cursor, beforeSeq: recovered[0].event.seq, maxMessages: 64 }) as any
      recovered = [...page.records, ...recovered]
    }
    expect(recovered.map((record: any) => record.event.seq)).toEqual(Array.from({ length: 2000 }, (_, i) => i))
    expect(new Set(recovered.map((record: any) => record.event.seq)).size).toBe(2000)
    abort.abort(); await iterator.return?.(); await vi.waitFor(() => expect(f.host.observers()).toBe(1))
    recoveredRecords = recovered.length; outcome = 'passed'
  } catch (error) { outcome = error instanceof Error && 'code' in error ? String(error.code) : 'failed'; throw error }
  finally {
    clearInterval(sample); abort.abort()
    try {
      await mkdir(evidenceDir, { recursive: true })
      await writeFile(evidenceDir + '/network-measurements.json', JSON.stringify({ node: process.version, outcome, sampleIntervalMs: 100, fixtureRecords: 2000, recoveredRecords, uploadBytes: f.host.uploadBytes, shaping: 'application proxy, browser-to-relay binary uplink only; control bypass enabled', shapedWireBytes: f.relay.shapedBytes, shapedWireSha256: f.relay.binaryHash.digest('hex'), configuredBitsPerSecond: 400000, uploadElapsedMs: uploadElapsed,
      maxHostReservationBytes: f.host.peakBudgetBytes, maxRelayRetainedBytes: f.relay.peakRelayBytes(), sampledMaxHostBytes: Math.max(0, ...samples.map(value => value.hostBytes)), sampledMaxRelayBytes: Math.max(0, ...samples.map(value => value.relayBytes)), maxProxyBytes: Math.max(...samples.map(value => value.proxyBytes)), maxRss: Math.max(...samples.map(value => value.rss)),
      controlCalls: controls, selectedFrames: f.relay.sends, samples }, null, 2))
    } finally { await f.close() }
  }
}, 850000)
