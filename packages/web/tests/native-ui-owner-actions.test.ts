import { expect,test,vi } from 'vitest'
import { createNativeRpc } from '../src/native-ui/rpc-rc2.ts'
import type { BrowserTransport } from '../src/transport.ts'
import { RC2_UI_PROFILE, ProtocolError } from '../../protocol/src/index.ts'
const fence={instanceId:crypto.randomUUID(),runtimeId:crypto.randomUUID(),controlId:crypto.randomUUID(),authEpoch:1}
const profile={host:RC2_UI_PROFILE,runtimeId:fence.runtimeId,uiRevision:'a'.repeat(64)}
test('carrier loss uses the original RemoteStream carrier error class for recovery',async()=>{
  const life=new AbortController()
  const watch=vi.fn(async function*(_request:unknown,signal:AbortSignal):AsyncIterable<any>{
    yield {kind:'dsh',value:{type:'baseline',value:{}}}
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
    throw new ProtocolError('TRANSFER_CLOSED')
  })
  const owner=createNativeRpc({transport:{watch,holdSync:()=>({ready(){},fail(){}})} as unknown as BrowserTransport,profile})
  class StockCarrierError extends Error {}
  owner.useCarrierError(cause=>new StockCarrierError('carrier lost',{cause}))
  owner.begin({fence,signal:life.signal,barrier:{ready(){},fail(){}}})
  const stream=owner.rpc.open!('/api','session/control',{args:{}},new AbortController().signal)[Symbol.asyncIterator]()
  await stream.next();const next=stream.next();life.abort(new ProtocolError('REMOTE_REPLACED'))
  await expect(next).rejects.toBeInstanceOf(StockCarrierError)
  await owner.dispose()
})
test('native owner routes original writes, delivery replies and byte uploads through one fenced transport',async()=>{
  const call=vi.fn(async(command:any)=>command.op==='ui.read'?{home:'/fixture'}:{accepted:true})
  const upload=vi.fn(async(_session:string,file:File)=>({receiptId:'receipt',file:{attachmentId:'attachment',name:file.name,bytes:file.size}}))
  const watch=vi.fn(async function*(request:any,signal:AbortSignal):AsyncIterable<any>{
    if(request.topic==='session'){yield {kind:'dsh',value:{type:'snapshot',header:{id:'s'},cursor:0}};yield {kind:'stop-token',sessionId:'s',token:'turn-1'}}
    else if(request.topic==='interactions'){yield {kind:'interactions-ready'};yield {kind:'interaction',sessionId:'s',deliveryId:'delivery',event:'approval/request',request:{toolName:'fixture'}}}
    else yield {kind:'dsh',value:{type:'baseline',value:{}}}
    await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})})
  })
  const owner=createNativeRpc({transport:{call,watch,upload,holdSync:()=>({ready(){},fail(){}})} as unknown as BrowserTransport,profile})
  const ready=vi.fn(),life=new AbortController(),frames:any[]=[]
  owner.select('s');owner.begin({fence,signal:life.signal,barrier:{ready,fail(){}}})
  const readers=['workspace/follow','session/control','$events','session/follow'].map(async endpoint=>{
    try{for await(const frame of owner.rpc.open!('/api',endpoint,endpoint==='session/follow'?{args:{request:{address:{kind:'session',sessionId:'s'}}}}:{args:{}},life.signal))frames.push(frame)}catch{}
  })
  await vi.waitFor(()=>expect(ready).toHaveBeenCalledOnce())
  expect(await owner.rpc.call('/api','session/cancel',{args:{request:{sessionId:'s'}}})).toEqual({ok:true,value:{accepted:true}})
  expect(call).toHaveBeenCalledWith({op:'session.stop',sessionId:'s',stopToken:'turn-1'},expect.any(AbortSignal))
  const opening=frames.find(f=>f.type==='ready'),delivery=frames.find(f=>f.type==='waterfall')
  expect(delivery).toBeDefined()
  expect(await owner.rpc.call('/api','$events/result',{args:{clientId:opening.clientId,eventId:delivery.eventId,outcome:{kind:'result',value:'allowed-once'}}})).toEqual({ok:true,value:null})
  expect(call).toHaveBeenCalledWith({op:'interaction.answer',deliveryId:'delivery',answer:'allowed-once'},expect.any(AbortSignal))
  expect(await owner.rpc.call('/api','fileUploads/upload',{args:{agentId:'s',request:{data:btoa('abc'),name:'native.bin'}}})).toMatchObject({ok:true,value:{receiptId:'receipt'}})
  expect(upload).toHaveBeenCalledOnce()
  life.abort();await owner.dispose();await Promise.all(readers)
  expect(call.mock.calls.filter(([c])=>c.op==='session.stop')).toHaveLength(1)
})
