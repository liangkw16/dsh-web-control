import {
  DEFAULT_LIMITS,
  ProtocolError,
  validateHeartbeat,
  validateLimits,
  type Limits,
} from '@dsh-web-control/protocol'
import { assertOrigin } from './origin.ts'
export interface RelayConfig {
  /** Populated only from verified artifacts at release startup. */
  nativeUiReleases?: readonly import('./ui-profiles.ts').UiRelease[]
  publicOrigin: string
  listenHost: string
  port: number
  databasePath: string
  enrollmentVerifier: string
  staticDir: string
  heartbeatMs: number
  leaseTtlMs: number
  limits: Limits
}
export const HANDSHAKE_MS = 5000
export const ATTACH_MS = 10000
export const MAX_UNAUTHENTICATED = 64
export const AUTH_BODY_BYTES = 4096
export function validateConfig(config: RelayConfig): RelayConfig {
  assertOrigin(config.publicOrigin, config.publicOrigin)
  validateHeartbeat(config.heartbeatMs, config.leaseTtlMs)
  const limits = validateLimits(config.limits)
  if (
    !Number.isInteger(config.port) ||
    config.port < 0 ||
    config.port > 65535 ||
    limits.chunkBytes > DEFAULT_LIMITS.chunkBytes
  )
    throw new ProtocolError('INVALID_MESSAGE')
  return { ...config, limits }
}
