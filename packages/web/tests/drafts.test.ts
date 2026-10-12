import { expect, test, vi } from 'vitest'
import { DraftStore } from '../src/drafts.ts'
function memory(): Storage { const data = new Map<string,string>(); return { get length() { return data.size }, clear: () => data.clear(), key: i => [...data.keys()][i] ?? null, getItem: k => data.get(k) ?? null, setItem: (k,v) => { data.set(k,v) }, removeItem: k => { data.delete(k) } } }
test('drafts persist with instance/session isolation', () => { const storage = memory(); const a = new DraftStore(storage); a.write('a','b','hello'); a.write('b','a','world'); const b = new DraftStore(storage); expect(b.read('a','b')).toBe('hello'); expect(b.read('b','a')).toBe('world') })
test('storage failure leaves input usable in memory and exposes warning', () => { const storage = memory(); storage.setItem = () => { throw Error('QuotaExceededError') }; const store = new DraftStore(storage); store.write('a','b','text'); expect(store.read('a','b')).toBe('text'); expect(store.persistenceWarning).toBe(true) })
test('only exact accepted draft revision clears, including edit-away-and-back', () => { const store = new DraftStore(memory()); store.write('a','b','first'); const revision = store.capture('a','b'); store.write('a','b','new'); store.write('a','b','first'); store.clearAccepted(revision); expect(store.read('a','b')).toBe('first'); store.clearAccepted(store.capture('a','b')); expect(store.read('a','b')).toBe('') })
test('persistence warning publishes once to the visible status subscription',()=>{
 const storage=memory(),store=new DraftStore(storage),notify=vi.fn();const release=store.subscribeWarning(notify)
 storage.setItem=()=>{throw Error('QuotaExceededError')};store.write('a','b','first');store.write('a','b','newer')
 expect(notify).toHaveBeenCalledOnce();expect(store.persistenceWarning).toBe(true);expect(store.read('a','b')).toBe('newer');release()
})
