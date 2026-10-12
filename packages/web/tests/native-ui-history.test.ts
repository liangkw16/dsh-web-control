import {expect,test,vi} from 'vitest'
import {NativeHistory} from '../src/native-ui/history.ts'
import type {BrowserTransport} from '../src/transport.ts'
const file=(index:number,path:string)=>({index,path,display:path,added:2,deleted:1})
function fixture(){
  let state:any={phase:'ready',fence:{runtimeId:'a',leaseId:'l',epoch:1}}
  const listeners=new Set<()=>void>()
  const transport={call:vi.fn(),getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)}}
  const history=new NativeHistory(transport as unknown as BrowserTransport)
  return {history,transport,change(next:any){state={...state,...next};listeners.forEach(fn=>fn())}}
}
test('stock array positions resolve to authorized Host indices, including filtered gaps',async()=>{
  const {history,transport}=fixture()
  transport.call.mockResolvedValueOnce({turn:1,total:2,files:[file(1,'one.txt'),file(4,'four.txt')],added:4,deleted:2}).mockResolvedValueOnce({kind:'binary',path:'four.txt',display:'four.txt'})
  await history.loadSummary('session A',5)
  expect(history.summaries.getSnapshot()['api/changes.summary?sessionId=session+A&seq=5']).toMatchObject({files:[{path:'one.txt'},{path:'four.txt'}]})
  await history.loadDiff('session A',5,1)
  expect(transport.call.mock.calls[1][0]).toEqual({op:'file.diff',sessionId:'session A',seq:5,index:4})
  await history.loadDiff('session A',5,8)
  expect(transport.call).toHaveBeenCalledTimes(2)
  history.dispose()
})
test('coalesces native card and hover reads and can retry a failed diff',async()=>{
  const {history,transport}=fixture(),pending=Promise.withResolvers<any>()
  transport.call.mockReturnValueOnce(pending.promise)
  const a=history.loadSummary('s',1),b=history.loadSummary('s',1)
  expect(transport.call).toHaveBeenCalledTimes(1)
  pending.resolve({turn:1,total:1,files:[file(0,'a')],added:2,deleted:1});await Promise.all([a,b])
  transport.call.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({status:'unavailable'})
  await history.loadDiff('s',1,0)
  expect(history.diffs.getSnapshot()['api/changes.diff?sessionId=s&seq=1&index=0']).toBe('error')
  await history.loadDiff('s',1,0)
  expect(history.diffs.getSnapshot()['api/changes.diff?sessionId=s&seq=1&index=0']).toBe('missing')
  history.dispose()
})
test('a replaced controller discards pending data and reconnect starts an empty cache',async()=>{
  const {history,transport,change}=fixture(),pending=Promise.withResolvers<any>()
  transport.call.mockReturnValueOnce(pending.promise)
  const old=history.loadSummary('s',1),signal=transport.call.mock.calls[0][1]
  change({phase:'replaced'})
  expect(signal.aborted).toBe(true)
  pending.resolve({turn:1,total:1,files:[file(0,'private')],added:2,deleted:1});await old
  expect(history.summaries.getSnapshot()).toEqual({})
  await history.loadSummary('s',1);expect(transport.call).toHaveBeenCalledTimes(1)
  change({phase:'ready',fence:{runtimeId:'b'}})
  transport.call.mockResolvedValueOnce({status:'unavailable'})
  await history.loadSummary('s',1)
  expect(history.summaries.getSnapshot()['api/changes.summary?sessionId=s&seq=1']).toBe('missing')
  history.dispose()
})

test('a card mounted during sync sees a state change that retries its stock effect',async()=>{
  const {history,transport,change}=fixture(),key='api/changes.summary?sessionId=s&seq=1'
  change({phase:'syncing'})
  await history.loadSummary('s',1)
  expect(history.summaries.getSnapshot()[key]).toBe('loading')
  expect(transport.call).not.toHaveBeenCalled()
  change({phase:'ready'})
  expect(history.summaries.getSnapshot()[key]).toBeUndefined()
  transport.call.mockResolvedValueOnce({status:'unavailable'})
  await history.loadSummary('s',1)
  expect(history.summaries.getSnapshot()[key]).toBe('missing')
  history.dispose()
})

test('summary failures use the missing state supported by the original review',async()=>{
  const {history,transport}=fixture()
  transport.call.mockRejectedValueOnce(new Error('unavailable'))
  await history.loadSummary('s',1)
  expect(history.summaries.getSnapshot()['api/changes.summary?sessionId=s&seq=1']).toBe('missing')
  history.dispose()
})

test('large recorded diffs survive the native injected read face',async()=>{
  const {history,transport}=fixture(),diff={kind:'text',path:'a',display:'a',before:true,after:true,coarse:false,hunks:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:['-'+'旧内容'.repeat(50000),'+'+'新内容'.repeat(50000)]}]}
  transport.call.mockResolvedValueOnce({turn:1,total:1,files:[file(0,'a')],added:2,deleted:1}).mockResolvedValueOnce(diff)
  await history.loadDiff('s',1,0)
  expect(history.diffs.getSnapshot()['api/changes.diff?sessionId=s&seq=1&index=0']).toEqual(diff)
  history.dispose()
})

test('scoped original deliverables keeps the original observable code-view preference',async()=>{
  const {registerNativeHistory}=await import('../src/native-ui/history.ts')
  let enabled=true
  const preference={getSnapshot:()=>enabled,subscribe:()=>()=>{}}
  const registrations:any[]=[]
  const slots={inject:(_key:string,run:()=>unknown)=>run(),register:(options:any,component:unknown)=>{registrations.push({options,component});return()=>{}}}
  const component=()=>null,effects:(()=>void)[]=[]
  const scoped:any={slots,provide(_name:string,value:unknown){this.slots=value},plugin(plugin:any){plugin.apply(this);return{state:2,await:async()=>{},dispose(){}}}}
  const ctx:any={slots,isolate:()=>scoped,effect:(run:()=>any)=>{const release=run();if(typeof release==='function')effects.push(release)},loader:{unwrapExports:(value:unknown)=>value},locale:{bind:()=>()=>''},sidebarRightTabs:{register:()=>()=>{}}}
  const require=(id:string)=>id==='react'?{createElement:()=>null}:{apply(owner:any){owner.slots.register({name:'conversation.chat.turnTail',id:'@deepseek-ai/dsh-client-ui-deliverables',inject:()=>({hooks:{showCodeDiff:preference}})},component)}}
  const {transport}=fixture()
  await registerNativeHistory(ctx,require,transport as unknown as BrowserTransport)
  const card=registrations.find(row=>row.component===component).options.inject()
  expect(card.hooks.showCodeDiff.getSnapshot()).toBe(true)
  enabled=false
  expect(card.hooks.showCodeDiff.getSnapshot()).toBe(false)
  effects.forEach(release=>release())
})
