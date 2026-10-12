import { expect, test } from 'vitest'
import {
  DEFAULT_LIMITS,
  parseController,
  parseHandshake,
} from '../src/index.ts'
const id = '10000000-0000-0000-0000-000000000001',
  fence = { instanceId: id, runtimeId: id, controlId: id, authEpoch: 1 }
test('central relay handshake schemas are strict and separate from business traffic', () => {
  const messages = [
    {
      type: 'browser.hello',
      versions: [1],
      resume: { id, secret: 'A'.repeat(43) },
    },
    {
      type: 'browser.lease',
      id,
      resumeSecret: 'A'.repeat(43),
      fence,
      expiresAt: 1,
    },
    { type: 'browser.lease-ack', id },
    {
      type: 'relay.config',
      limits: DEFAULT_LIMITS,
      heartbeatMs: 10,
      leaseTtlMs: 30,
    },
    {
      type: 'host.auth',
      authEpoch: 2,
      linkVerifier: 'a'.repeat(64),
      enabled: true,
    },
    { type: 'detach', fence },
    {
      type: 'fault',
      error: {
        code: 'AUTH_REVOKED',
        message: 'AUTH_REVOKED',
        retryable: false,
      },
    },
  ]
  for (const message of messages) {
    const wire = { v: 1, ...message }
    expect(parseHandshake(JSON.stringify(wire), DEFAULT_LIMITS)).toEqual(wire)
    expect(() =>
      parseHandshake(
        JSON.stringify({ ...wire, deviceSecret: 'hidden' }),
        DEFAULT_LIMITS,
      ),
    ).toThrow()
    expect(() =>
      parseController(JSON.stringify(wire), DEFAULT_LIMITS),
    ).toThrow()
  }
  expect(() =>
    parseHandshake(
      JSON.stringify({
        v: 1,
        type: 'relay.config',
        limits: { ...DEFAULT_LIMITS, extra: 1 },
        heartbeatMs: 10,
        leaseTtlMs: 30,
      }),
      DEFAULT_LIMITS,
    ),
  ).toThrow()
  expect(() =>
    parseHandshake(
      JSON.stringify({
        v: 1,
        type: 'relay.config',
        limits: DEFAULT_LIMITS,
        heartbeatMs: 30,
        leaseTtlMs: 10,
      }),
      DEFAULT_LIMITS,
    ),
  ).toThrow()
})
