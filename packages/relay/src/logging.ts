import { ProtocolError, type Fault } from '@dsh-web-control/protocol'
export interface LogRecord {
  level: 'info' | 'error'
  event: string
  instanceId?: string
  code?: string
  duration?: number
  byteCount?: number
  connections?: number
  hosts?: number
  controllers?: number
  rttMs?: number
  rttSamples?: number
  bufferedBytes?: number
  peakBufferedBytes?: number
  reconnects?: number
}
/** Deliberately reconstruct the record: no URL, headers, payload or raw Error spread. */
export function log(record: LogRecord): void {
  const { level, event, instanceId, code, duration, byteCount, connections, hosts, controllers, rttMs, rttSamples, bufferedBytes, peakBufferedBytes, reconnects } = record
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      event,
      instanceId,
      code,
      duration,
      byteCount, connections, hosts, controllers, rttMs, rttSamples, bufferedBytes, peakBufferedBytes, reconnects,
    }),
  )
}
export function fault(error: unknown): Fault {
  const code = error instanceof ProtocolError ? error.code : 'INTERNAL_ERROR'
  return {
    code,
    message: code,
    retryable: error instanceof ProtocolError && error.retryable,
  }
}
