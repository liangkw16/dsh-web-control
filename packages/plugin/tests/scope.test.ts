import { expect, test } from 'vitest'
import { SessionScope } from '../src/adapter/scope.ts'

test('membership is live and cannot authorize from an earlier list', () => {
  let items = [{ workspaceId: 'w', sessionIds: ['a'] }]
  const scope = new SessionScope(() => items)
  scope.assertSession('a')
  items = [{ workspaceId: 'w', sessionIds: [] }]
  expect(() => scope.assertSession('a')).toThrow('OUT_OF_SCOPE')
  items = []
  expect(() => scope.assertWorkspace('w')).toThrow('OUT_OF_SCOPE')
})
test('explicit create/adopt cannot move an existing foreign session', () => {
  const scope = new SessionScope(() => [
    { workspaceId: 'w', sessionIds: ['a'] }, { workspaceId: 'other', sessionIds: ['b'] },
  ])
  scope.assertCreate('w', 'a'); scope.assertCreate('w', 'new')
  expect(() => scope.assertCreate('w', 'b')).toThrow('OUT_OF_SCOPE')
  expect(() => scope.assertCreate('missing', 'new')).toThrow('OUT_OF_SCOPE')
  expect(() => scope.assertSession('')).toThrow('INVALID_MESSAGE')
})
