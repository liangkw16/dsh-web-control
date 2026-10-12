import { expect, test, vi } from 'vitest'
import { NativeGeneration } from '../src/native-ui/generation.ts'
import { createNativeRpc } from '../src/native-ui/rpc-rc2.ts'
import { BrowserTransport, type SyncGeneration } from '../src/transport.ts'
import { DEFAULT_LIMITS, RC2_UI_PROFILE, type Fence } from '../../protocol/src/index.ts'
const fence: Fence = {instanceId:'11111111-1111-4111-8111-111111111111',runtimeId:'22222222-2222-4222-8222-222222222222',controlId:'33333333-3333-4333-8333-333333333333',authEpoch:1}
const profile={host:RC2_UI_PROFILE,runtimeId:fence.runtimeId,uiRevision:'a'.repeat(64)}
const context=():SyncGeneration=>({fence:{...fence},signal:new AbortController().signal,barrier:{ready:vi.fn(),fail:vi.fn()}})
test('reopening the same journal fences old stream baselines and immediately blocks writes',()=>{
  const hold=vi.fn(()=>({ready:vi.fn(),fail:vi.fn()})),generation=new NativeGeneration(hold)
  generation.select('a');generation.begin(context())
  const first=generation.follow('a')
  for(const topic of ['workspaces','sessions','interactions'] as const)generation.baseline(first,topic)
  generation.snapshot(first,1);generation.stop(first,'old');expect(generation.action('a').stopToken).toBe('old')
  const second=generation.follow('a')
  expect(()=>generation.action('a')).toThrow('SYNC_REQUIRED')
  generation.snapshot(first,2);generation.stop(first,'stale')
  expect(()=>generation.action('a')).toThrow('SYNC_REQUIRED')
  generation.snapshot(second,3);generation.stop(first,'stale')
  expect(()=>generation.action('a')).toThrow('SYNC_REQUIRED')
  generation.stop(second,'new');expect(generation.action('a').stopToken).toBe('new')
  generation.failed(first,new Error('obsolete'))
  expect(generation.action('a').stopToken).toBe('new');generation.dispose()
})
test('selection changes cancel prepared actions; replacement snapshots hold the visible synchronization barrier',()=>{
  const hold=vi.fn(()=>({ready:vi.fn(),fail:vi.fn()})),generation=new NativeGeneration(hold)
  generation.select('a');generation.begin(context());const ticket=generation.capture('a')
  for(const topic of ['workspaces','sessions','interactions'] as const)generation.baseline(ticket,topic)
  generation.snapshot(ticket,1);generation.stop(ticket,'first')
  const action=generation.action('a')
  generation.snapshot(ticket,2)
  expect(hold).toHaveBeenCalledOnce()
  expect(()=>generation.action('a')).toThrow('SYNC_REQUIRED')
  generation.stop(ticket,'second')
  generation.select('b')
  expect(action.signal.aborted).toBe(true)
  generation.dispose()
})
test('global, selected snapshot and stop baselines gate writes; stale selections and generations cannot ready them',()=>{
  const barriers:{ready:ReturnType<typeof vi.fn>;fail:ReturnType<typeof vi.fn>}[]=[]
  const generation=new NativeGeneration(()=>{const b={ready:vi.fn(),fail:vi.fn()};barriers.push(b);return b})
  generation.select('a');const first=context();generation.begin(first);const globals=generation.capture();const a=generation.capture('a')
  for(const topic of ['workspaces','sessions','interactions'] as const)generation.baseline(globals,topic)
  expect(()=>generation.assertWritable('a')).toThrow('SYNC_REQUIRED')
  generation.snapshot(a,2);generation.stop(a,'t');expect(first.barrier.ready).toHaveBeenCalledOnce()
  expect(generation.action('a')).toMatchObject({fence,stopToken:'t'})
  generation.select('b');generation.snapshot(a,3);generation.stop(a,'old');expect(barriers[0].ready).not.toHaveBeenCalled()
  const b=generation.capture('b');generation.snapshot(b,4);generation.stop(b,null);expect(barriers[0].ready).toHaveBeenCalledOnce()
  const second=context();generation.begin(second);generation.baseline(globals,'workspaces');generation.snapshot(b,5);expect(second.barrier.ready).not.toHaveBeenCalled()
  generation.dispose()
})
class Socket extends EventTarget {
  readyState=0;binaryType='';bufferedAmount=0;sent:any[]=[]
  send(value:string){this.sent.push(JSON.parse(value))} close(){this.readyState=3}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'))}
  message(value:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}))}
  closed(){this.readyState=3;this.dispatchEvent(Object.assign(new Event('close'),{code:1006,reason:''}))}
}
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()}
function transportFixture(native=true, selected=profile){
  const sockets:Socket[]=[]
  const transport=new BrowserTransport({origin:'https://relay.test',reconnect:false,uiProfile:native?selected:undefined,fetch:vi.fn(async()=>Response.json({hostOnline:true,remoteConnected:false})),socket:()=>{const s=new Socket();sockets.push(s);return s as unknown as WebSocket},storage:{getItem:()=>null,setItem(){}} as unknown as Storage})
  transport.registerSynchronizer(c=>c.barrier.ready())
  const attach=(s:Socket,p:unknown=profile)=>{
    s.message({v:1,type:'relay.config',limits:DEFAULT_LIMITS,heartbeatMs:10000,leaseTtlMs:30000})
    s.message({v:1,type:'browser.lease',id:crypto.randomUUID(),resumeSecret:'A'.repeat(43),fence,expiresAt:Date.now()+30000})
    s.message({v:1,type:'ready',fence,...(p?{uiProfile:p}:{})})
  }
  return {transport,sockets,attach}
}
test('native ready must match selected immutable profile before synchronizer or writes',async()=>{
  for(const bad of [null,{...profile,uiRevision:'b'.repeat(64)}]){
    const f=transportFixture();try{
      const p=f.transport.connect(fence.instanceId);void p.catch(()=>{});await flush();const s=f.sockets[0];s.open()
      expect(s.sent[0]).toMatchObject({uiApi:1,takeover:true});f.attach(s,bad)
      await expect(p).rejects.toThrow('PROTOCOL_UNSUPPORTED');expect(f.transport.getSnapshot().phase).toBe('error')
    }finally{f.transport.dispose()}
  }
})
test('resume coalesces with in-flight recovery, never claims, and stops after replacement',async()=>{
  const f=transportFixture();try{
    const p=f.transport.connect(fence.instanceId);await flush();const s=f.sockets[0];s.open();f.attach(s);await p
    await f.transport.resume();expect(f.sockets).toHaveLength(1)
    s.closed();const a=f.transport.resume(),b=f.transport.resume();await flush();expect(f.sockets).toHaveLength(2)
    const next=f.sockets[1];next.open();expect(next.sent[0]).toMatchObject({uiApi:1,resume:expect.any(Object)});expect(next.sent[0]).not.toHaveProperty('takeover')
    f.attach(next);await Promise.all([a,b]);next.message({v:1,type:'fault',error:{code:'REMOTE_REPLACED',message:'REMOTE_REPLACED',retryable:false}})
    await expect(f.transport.resume()).rejects.toThrow('REMOTE_REPLACED');expect(f.sockets).toHaveLength(2)
  }finally{f.transport.dispose()}
})
test('native RPC waits for current generation; disposal aborts pending original retries without any claim or stop',async()=>{
  const call=vi.fn(),watch=vi.fn(),retry=vi.fn(),resume=vi.fn(),holdSync=vi.fn()
  const owner=createNativeRpc({transport:{call,watch,retry,resume,holdSync} as unknown as BrowserTransport,profile})
  const result=owner.rpc.call('/api','session/list',{args:{_request:{}}})
  await owner.dispose();expect((await result).ok).toBe(false);expect(call).not.toHaveBeenCalled();expect(retry).not.toHaveBeenCalled();expect(resume).not.toHaveBeenCalled()
})
test('closing an obsolete session stream cannot fail the replacement selection; dispose drains all readers',async()=>{
  const endings=new Map<string,()=>void>(),closed:string[]=[], barriers:{ready:ReturnType<typeof vi.fn>;fail:ReturnType<typeof vi.fn>}[]=[]
  const transport={
    call:vi.fn(async()=>({home:'/fixture'})),
    watch:vi.fn(async function*(watch:any,signal:AbortSignal):AsyncIterable<any>{
      const key=watch.sessionId??watch.topic
      try {
        if(watch.topic==='session')yield {kind:'dsh',value:{type:'snapshot',header:{id:watch.sessionId},cursor:0}}
        else if(watch.topic==='interactions')yield {kind:'interactions-ready'}
        else yield {kind:'dsh',value:{type:'baseline',value:{}}}
        await new Promise<void>(resolve=>{endings.set(key,resolve);if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})})
      } finally {closed.push(key)}
    }),
    holdSync:vi.fn(()=>{const b={ready:vi.fn(),fail:vi.fn()};barriers.push(b);return b}),
  }
  const owner=createNativeRpc({transport:transport as unknown as BrowserTransport,profile}), first=context()
  owner.begin(first);owner.select('a')
  const a=owner.rpc.open!('/api','session/follow',{args:{request:{address:{kind:'session',sessionId:'a'}}}},new AbortController().signal)[Symbol.asyncIterator]()
  await a.next();const end=a.next();await flush()
  owner.select('b');endings.get('a')!();await end
  expect(barriers.at(-1)!.fail).not.toHaveBeenCalled()
  const workers=['workspace/follow','session/control','$events'].map(async endpoint=>{
    try{for await(const _ of owner.rpc.open!('/api',endpoint,{args:{}},new AbortController().signal)){} }catch{}
  })
  await flush();await owner.dispose();await Promise.all(workers)
  expect(closed.sort()).toEqual(['a','interactions','sessions','workspaces'])
  expect(transport.call.mock.calls).toEqual([[{op:'ui.read',view:'host-facts'},expect.any(AbortSignal)]])
})

test('native capability addition or removal invalidates the selected composition',async()=>{
  const extended={...profile,host:{...profile.host,capabilities:[...profile.host.capabilities,'workspace-management']}}
  for(const [selected,received] of [[profile,extended],[extended,profile]]){
    const f=transportFixture(true,selected)
    try{
      const pending=f.transport.connect(fence.instanceId);void pending.catch(()=>{})
      await flush();const socket=f.sockets[0];socket.open();f.attach(socket,received)
      await expect(pending).rejects.toThrow('PROTOCOL_UNSUPPORTED')
      expect(f.transport.getSnapshot().phase).toBe('error')
    }finally{f.transport.dispose()}
  }
})
