import { claimEvidenceDirectory } from '../../scripts/evidence-paths.mjs'
const evidenceDir = claimEvidenceDirectory('system')
import { expect, test } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { systemFixture } from '../support/host-driver.ts'
import { DEFAULT_LIMITS } from '../../packages/protocol/src/index.ts'

test('independent shaped timers can deliver end before final binary; serialized forwarding prevents that', async () => {
  const failures: { faults: string[]; frames: unknown[] }[] = []
  for (let run = 0; run < 1; run++) {
    const f = await systemFixture({ ...DEFAULT_LIMITS, chunkBytes: 1024 })
    f.relay.independentTimersForRegression = true; f.relay.endTimerAdvanceMsForRegression = 2; f.relay.rateLimit(400000)
    try {
      const result = await f.browser.transport.upload('a', new File([new Uint8Array(65536)], 'short.bin'), new AbortController().signal).catch(error => ({ failed: error.code }))
      const frames = f.relay.sends.filter(frame => frame.route === 'browser-to-relay' && (frame.type === 'binary' || frame.type === 'upload.end'))
      const end = frames.findIndex(frame => frame.type === 'upload.end'), final = frames.findIndex(frame => frame.type === 'binary' && frame.index === 63)
      if (end >= 0 && (final < 0 || end < final)) failures.push({ faults: f.relay.faults, frames })
      if (result && typeof result === 'object' && !Array.isArray(result) && 'failed' in result) expect(f.relay.faults.length).toBeGreaterThan(0)
    } finally { await f.close() }
  }
  expect(failures.length).toBeGreaterThan(0)
  const f = await systemFixture({ ...DEFAULT_LIMITS, chunkBytes: 1024 }); f.relay.rateLimit(400000)
  try {
    await expect(f.browser.transport.upload('a', new File([new Uint8Array(65536)], 'ordered.bin'), new AbortController().signal)).resolves.toMatchObject({ file: { bytes: 65536 } })
    const frames = f.relay.sends.filter(frame => frame.route === 'browser-to-relay' && (frame.type === 'binary' || frame.type === 'upload.end'))
    expect(frames.slice(0, 64).map(frame => frame.index)).toEqual(Array.from({ length: 64 }, (_, i) => i)); expect(frames[64].type).toBe('upload.end')
    expect(f.relay.faults).toEqual([])
    await mkdir(evidenceDir, { recursive: true }); await writeFile(evidenceDir + '/proxy-ordering.json', JSON.stringify({ independentlyScheduledFailures: failures, endAdvanceFaultMs: 2, serializedFrames: frames }, null, 2))
  } finally { await f.close() }
}, 30000)
