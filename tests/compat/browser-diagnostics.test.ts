import { expect, test } from 'vitest'
// @ts-expect-error standalone ESM runner helper has no generated declarations
import { isPublicBundleExportFailure } from '../../scripts/browser-diagnostics.mjs'
const rows = [
  '[MISSING_EXPORT] "SessionEventStream" is not exported by "runtime/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js".',
  '[MISSING_EXPORT] "createSessionControlStream" is not exported by "runtime/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js".',
  '[MISSING_EXPORT] "RemoteStream" is not exported by "runtime/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.js".',
]
const error = (lines: string[]) => new Error(`Build failed with ${lines.length} errors:\n\n` + lines.join('\n\n'))
test('only exact documented diagnostic set permits the browser adapter fallback', () => {
  expect(isPublicBundleExportFailure(error(rows))).toBe(true)
})
test.each([
  '[UNRESOLVED_IMPORT] Cannot resolve "unrelated".',
  '[PARSE_ERROR] Unexpected syntax.',
  '[MISSING_EXPORT] "unrelated" is not exported by "runtime/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.js".',
])('additional diagnostic fails closed: %s', extra => {
  expect(isPublicBundleExportFailure(error([...rows, extra]))).toBe(false)
})
test('wrong public entry or duplicated/missing export fails closed', () => {
  expect(isPublicBundleExportFailure(error(rows.map(row => row.replace('dsh-api-gateway', 'different-package'))))).toBe(false)
  expect(isPublicBundleExportFailure(error([rows[0]!, rows[0]!, rows[2]!]))).toBe(false)
})
