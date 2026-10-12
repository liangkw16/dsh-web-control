import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DshSessionAdapter } from '../src/adapter/dsh-v021.ts'
import { StopTokens } from '../src/adapter/stop-tokens.ts'

test('late stop cannot cancel a successor turn', () => {
  const agent = {}; let turnStartSeq = 12
  const cancel = vi.fn(() => ({ accepted: true }))
  const tokens = new StopTokens(() => ({ agent, turnStartSeq }), cancel)
  const token = tokens.current('session-a')!
  turnStartSeq = 24
  expect(() => tokens.stop('session-a', token)).toThrow('STALE_ACTION')
  expect(cancel).not.toHaveBeenCalled()
})
test('same ID rebuilt Agent and idle state invalidate tokens', () => {
  let current: { agent: object; turnStartSeq: number } | null = { agent: {}, turnStartSeq: 0 }
  const cancel = vi.fn(() => ({ accepted: true }))
  const tokens = new StopTokens(() => current, cancel)
  const token = tokens.current('a')!
  current = { agent: {}, turnStartSeq: 0 }
  expect(() => tokens.stop('a', token)).toThrow('STALE_ACTION')
  current = null
  expect(tokens.current('a')).toBeNull()
  expect(() => tokens.stop('a', token)).toThrow('STALE_ACTION')
  expect(cancel).not.toHaveBeenCalled()
})
test('one token accepts only one of two competing stops before turn projection changes', () => {
  const agent = {}; const cancel = vi.fn(() => ({ accepted: true }))
  const tokens = new StopTokens(() => ({ agent, turnStartSeq: 12 }), cancel)
  const token = tokens.current('a')!
  expect(tokens.current('a')).toBe(token)
  expect(tokens.stop('a', token)).toEqual({ accepted: true })
  expect(() => tokens.stop('a', token)).toThrow('STALE_ACTION')
  expect(cancel).toHaveBeenCalledTimes(1)
})

test('adapter stop preserves pending input on the exact cancelled Agent synchronously', () => {
  const pending = { source: { kind: 'user', rpcId: 'pending-request' }, content: [{ type: 'text', text: 'queued input' }] }
  const agent = { id: 'a', session: {}, inbox: { nextTurn: [pending], nextStep: [] } }
  const cancel = vi.fn(({ sessionId }: { sessionId: string }) => {
    expect(sessionId).toBe(agent.id)
    return { accepted: true }
  })
  const ctx = { workspaceRegistry: { list: () => [{ id: 'w', sessionIds: ['a'] }] },
    agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ openTurnStartSeq: 12 }) }, sessionController: { cancel } } as unknown as Context
  const adapter = new DshSessionAdapter(ctx).withAdmission(() => {})
  const token = adapter.currentStopToken(agent.id)!
  expect(adapter.stop(agent.id, token)).toEqual({ accepted: true })
  expect(agent.inbox.nextTurn).toHaveLength(1)
  expect(agent.inbox.nextTurn[0]).toBe(pending)
  expect(agent.inbox.nextTurn[0]).toEqual({ source: { kind: 'user', rpcId: 'pending-request' }, content: [{ type: 'text', text: 'queued input' }] })
  expect(agent.inbox.nextStep).toEqual([])
  expect(cancel).toHaveBeenCalledExactlyOnceWith({ sessionId: agent.id })
})
