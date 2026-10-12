/** Installation material, kept only in memory until the local pairing request. */
export interface PairingConfig { kind: 'dsh-web-control-connection'; version: 1; relayOrigin: string; enrollmentSecret: string }
export const pairingConfigLimit = 8192
export function parsePairingConfig(source: string): PairingConfig {
  const invalid = () => new Error('INVALID_CONNECTION_CONFIG')
  if (new TextEncoder().encode(source).length > pairingConfigLimit) throw invalid()
  let value: unknown
  try { value = JSON.parse(source) } catch { throw invalid() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 4 || input.kind !== 'dsh-web-control-connection' || input.version !== 1
    || typeof input.relayOrigin !== 'string' || !/^https:\/\/[^\s\\/@?#]+\/?$/i.test(input.relayOrigin)
    || typeof input.enrollmentSecret !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(input.enrollmentSecret)) throw invalid()
  let url: URL
  try { url = new URL(input.relayOrigin) } catch { throw invalid() }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalid()
  return { kind: 'dsh-web-control-connection', version: 1, relayOrigin: url.origin, enrollmentSecret: input.enrollmentSecret }
}
