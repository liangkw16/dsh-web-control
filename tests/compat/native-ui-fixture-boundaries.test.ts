import { expect, test, vi } from 'vitest'
import { fixtureTarget } from '../../scripts/native-ui-fixture-proxy.mjs'
import { cleanupNativeFixture } from '../../scripts/native-ui-cleanup.mjs'

test.each(['//foreign.invalid/leak', 'https://foreign.invalid/leak', '/\\foreign.invalid/leak', ' /api/data', '*'])('fixture target rejects credential escape %j', path => {
  expect(() => fixtureTarget(path, 'http://127.0.0.1:12345')).toThrow()
})
test('fixture target permits original path/query only under its owned upstream', () => {
  expect(fixtureTarget('/plugins/??a/client.js&rev=abc', 'http://127.0.0.1:12345').href).toBe('http://127.0.0.1:12345/plugins/??a/client.js&rev=abc')
})
test('cleanup attempts Host and key cleanup even when browser and proxy closure both fail', async () => {
  const host = vi.fn().mockResolvedValue(undefined), key = vi.fn().mockResolvedValue(undefined)
  const result = await cleanupNativeFixture({ browser: async () => { throw new Error('browser close failed') }, proxy: async () => { throw new Error('proxy close failed') }, host, key })
  expect(host).toHaveBeenCalledOnce(); expect(key).toHaveBeenCalledOnce()
  expect(result.browserClosed).toBe(false); expect(result.hostExited).toBe(true)
  expect(result.errors.map(row => row.operation)).toEqual(['browser', 'proxy'])
})
