import {afterEach,expect,test,vi} from 'vitest'
import {NativePreferences} from '../src/native-ui/preferences.ts'
import {ProtocolError} from '../../protocol/src/index.ts'
const value=(revision:number,busyEnter:'queue'|'steer')=>({ns:'ui-conversation',revision,busyEnter})
function fixture(){
  vi.useFakeTimers()
  let phase='ready',answer=value(1,'queue')
  const call=vi.fn(async()=>answer),fail=vi.fn(),life=new AbortController()
  const preferences=new NativePreferences({call,getSnapshot:()=>({phase})} as any,fail)
  return{preferences,call,fail,life,set:(next:typeof answer)=>{answer=next},phase:(next:string)=>{phase=next}}
}
afterEach(()=>vi.useRealTimers())
test('updates the accepted preference in place without duplicating unchanged notifications',async()=>{
  const f=fixture(),changed=vi.fn();f.preferences.subscribe(changed)
  await f.preferences.begin(f.life.signal)
  expect(f.preferences.value).toEqual(value(1,'queue'))
  changed.mockClear();await vi.advanceTimersByTimeAsync(1000);expect(changed).not.toHaveBeenCalled()
  f.set(value(2,'steer'));await vi.advanceTimersByTimeAsync(1000)
  expect(f.preferences.value).toEqual(value(2,'steer'));expect(changed).toHaveBeenCalledOnce()
  f.preferences.dispose();await vi.advanceTimersByTimeAsync(5000);expect(f.call).toHaveBeenCalledTimes(3)
})
test('never overlaps reads, applies stale replies, or polls while the controller is not ready',async()=>{
  const f=fixture();await f.preferences.begin(f.life.signal)
  const old=Promise.withResolvers<any>();f.call.mockReturnValueOnce(old.promise)
  await vi.advanceTimersByTimeAsync(1000);await vi.advanceTimersByTimeAsync(5000);expect(f.call).toHaveBeenCalledTimes(2)
  f.life.abort();f.set(value(3,'queue'));const next=new AbortController();await f.preferences.begin(next.signal)
  old.resolve(value(2,'steer'));await Promise.resolve();await Promise.resolve()
  expect(f.preferences.value).toEqual(value(3,'queue'))
  f.phase('replaced');await vi.advanceTimersByTimeAsync(3000);expect(f.call).toHaveBeenCalledTimes(3)
  f.preferences.dispose()
})
test('a malformed or regressing preference fails closed instead of silently keeping a stale send mode',async()=>{
  const f=fixture();await f.preferences.begin(f.life.signal)
  f.set(value(0,'steer'));await vi.advanceTimersByTimeAsync(1000)
  expect(f.fail).toHaveBeenCalledWith(expect.any(ProtocolError))
  await vi.advanceTimersByTimeAsync(3000);expect(f.call).toHaveBeenCalledTimes(2)
  f.preferences.dispose()
})
