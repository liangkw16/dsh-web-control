const expected = new Set([
  'SessionEventStream|@deepseek-ai/dsh-api-session-controller/lib/client.js',
  'createSessionControlStream|@deepseek-ai/dsh-api-session-controller/lib/client.js',
  'RemoteStream|@deepseek-ai/dsh-api-gateway/lib/client.js',
])

/** Accept only the exact three diagnostics emitted by the pinned public bundles. */
export function isPublicBundleExportFailure(error) {
  const message = String(error?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '')
  const count = message.match(/^Build failed with (\d+) errors:/)
  if (count?.[1] !== '3') return false
  const diagnostics = [...message.matchAll(/\[([^\]]+)\] "([^"]+)" is not exported by "([^"]+)"\./g)]
  if (diagnostics.length !== 3 || (message.match(/\[[A-Z_]+\]/g) ?? []).length !== 3) return false
  const found = new Set()
  for (const [, code, name, path] of diagnostics) {
    const suffix = path.match(/(?:^|\/)node_modules\/(@deepseek-ai\/[^/]+\/lib\/client\.js)$/)?.[1]
    const key = name + '|' + suffix
    if (code !== 'MISSING_EXPORT' || !expected.has(key) || found.has(key)) return false
    found.add(key)
  }
  return found.size === expected.size
}
