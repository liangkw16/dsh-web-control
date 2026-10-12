import { expect, test, vi } from 'vitest'
import { SubmissionQueue } from '../src/submissions.ts'

test('lost ACK reconciliation preserves business id and never replays prompt', async () => {
  const call = vi.fn().mockRejectedValueOnce(Error('RESULT_UNCERTAIN')).mockResolvedValueOnce({ accepted: true })
  const queue = new SubmissionQueue({ call }); const id = await queue.submit({ sessionId: 'a', mode: 'queue', content: [{ kind: 'text', text: 'continue' }] })
  expect(queue.state(id)).toBe('uncertain'); await queue.retry(id)
  expect(call.mock.calls.map(([c]) => c.requestId)).toEqual([id, id]); expect(call.mock.calls[0][0]).not.toHaveProperty('reconcileOnly')
  expect(call.mock.calls[1][0].reconcileOnly).toBe(true); expect(queue.state(id)).toBe('accepted')
})
test('unproven reconciliation stays uncertain; caller mutation cannot change original content', async () => {
  const call = vi.fn().mockRejectedValue(Error('RESULT_UNCERTAIN')); const queue = new SubmissionQueue({ call })
  const content = [{ kind: 'text' as const, text: 'original' }]; const id = await queue.submit({ sessionId: 'a', mode: 'queue', content }); content[0].text = 'new'
  await queue.retry(id); expect(queue.state(id)).toBe('uncertain'); expect(call.mock.calls[1][0].content[0].text).toBe('original')
})
test('pre-send offline failure is failed and cannot silently retry as a mutation', async () => {
  const call = vi.fn().mockRejectedValue(Error('HOST_OFFLINE')); const queue = new SubmissionQueue({ call })
  const id = await queue.submit({ sessionId: 'a', mode: 'queue', content: [{ kind: 'text', text: 'x' }] })
  expect(queue.state(id)).toBe('failed'); await expect(queue.retry(id)).rejects.toThrow(); expect(call).toHaveBeenCalledTimes(1)
})

test('Host acceptance clears only captured draft, uncertain and later edits remain', async () => {
  const { DraftStore } = await import('../src/drafts.ts'); const data = new Map<string,string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key,value) } } as Storage
  const drafts = new DraftStore(storage); drafts.write('i','a','original'); const receipt = Promise.withResolvers<{ accepted: true }>()
  const call = vi.fn().mockImplementationOnce(() => receipt.promise).mockResolvedValue({ accepted: true }); const queue = new SubmissionQueue({ call })
  const submitting = queue.submitDraft({ sessionId: 'a', mode: 'queue', content: [{ kind: 'text', text: 'original' }] }, { store: drafts, instanceId: 'i' })
  drafts.write('i','a','new'); receipt.resolve({ accepted: true }); const id = await submitting
  expect(queue.state(id)).toBe('accepted'); expect(drafts.read('i','a')).toBe('new')
  await queue.submitDraft({ sessionId: 'a', mode: 'queue', content: [{ kind: 'text', text: 'new' }] }, { store: drafts, instanceId: 'i' }); expect(drafts.read('i','a')).toBe('')
})
