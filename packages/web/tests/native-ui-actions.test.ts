import { expect, test, vi } from 'vitest'
import { NativePromptAttempts } from '../src/native-ui/prompt-attempts.ts'
import { NativeWriteRoutes } from '../src/native-ui/write-routes.ts'
import { ProtocolError, type Command } from '../../protocol/src/index.ts'
type Prompt=Extract<Command,{op:'session.prompt'}>
const prompt=():Prompt=>({op:'session.prompt',sessionId:'s',requestId:crypto.randomUUID(),mode:'queue',content:[{kind:'text',text:'synthetic'}]})
test('same native request only reconciles uncertainty and never resends, conflicting content is refused',async()=>{
  const call=vi.fn().mockRejectedValue(new ProtocolError('RESULT_UNCERTAIN')),attempts=new NativePromptAttempts(call),p=prompt()
  await expect(attempts.submit(p)).rejects.toThrow('RESULT_UNCERTAIN');await expect(attempts.submit(p)).rejects.toThrow('RESULT_UNCERTAIN')
  expect(call.mock.calls.map(([c])=>c.reconcileOnly===true)).toEqual([false,true])
  await expect(attempts.submit({...p,mode:'steer'})).rejects.toThrow('INVALID_MESSAGE');expect(call).toHaveBeenCalledTimes(2)
})
test('simultaneous same-ID calls join, terminal acknowledgement is stable and new IDs are new actions',async()=>{
  const pending=Promise.withResolvers<any>(),call=vi.fn(()=>pending.promise),attempts=new NativePromptAttempts(call),p=prompt()
  const a=attempts.submit(p),b=attempts.submit(p);await vi.waitFor(()=>expect(call).toHaveBeenCalledOnce());pending.resolve({accepted:true})
  expect(await a).toEqual({accepted:true});expect(await b).toEqual({accepted:true});expect(await attempts.submit(p)).toEqual({accepted:true});expect(call).toHaveBeenCalledOnce()
  await attempts.submit(prompt());expect(call).toHaveBeenCalledTimes(2)
})
test('capture stop token before any await and never substitute the next turn; unmount is not stop',async()=>{
  const call=vi.fn(async(_command: unknown)=>({accepted:true})),life=new AbortController();let token='first'
  const writes=new NativeWriteRoutes({call,action:()=>({fence:{instanceId:'i',runtimeId:'r',controlId:'c',authEpoch:1},signal:life.signal,stopToken:token}),content:async()=>[]})
  const stop=writes.call('/api','session/cancel',{args:{request:{sessionId:'s'}}},life.signal);token='second';await stop
  expect(call.mock.calls[0]?.[0]).toEqual({op:'session.stop',sessionId:'s',stopToken:'first'})
  writes.dispose();expect(call).toHaveBeenCalledOnce()
})
test('native queue mapping retains item and action, never retries an uncertain write',async()=>{
  const call=vi.fn().mockRejectedValue(new ProtocolError('RESULT_UNCERTAIN')),life=new AbortController()
  const writes=new NativeWriteRoutes({call,action:()=>({fence:{instanceId:'i',runtimeId:'r',controlId:'c',authEpoch:1},signal:life.signal,stopToken:'current'}),content:async()=>[]})
  const result=await writes.call('/api','session/updateQueue',{args:{request:{sessionId:'s',itemId:'item',action:{kind:'steer'}}}},life.signal)
  expect(result).toMatchObject({ok:false,error:{code:'RESULT_UNCERTAIN'}});expect(call.mock.calls[0][0]).toEqual({op:'session.queue',sessionId:'s',itemId:'item',action:{kind:'steer'},stopToken:'current'});expect(call).toHaveBeenCalledOnce()
})

test('long-lived native owner retires terminal preparation records and preserves uncertain ones',async()=>{
  const call=vi.fn(async(_command:Command)=>({accepted:true})),life=new AbortController()
  const content=vi.fn(async()=>[{kind:'text' as const,text:'synthetic'}])
  const writes=new NativeWriteRoutes({call,action:()=>({fence:{instanceId:'i',runtimeId:'r',controlId:'c',authEpoch:1},signal:life.signal,stopToken:null}),content})
  let last:any
  for(let i=0;i<270;i++){
    last={args:{request:{sessionId:'s',requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'synthetic'}]}}}
    expect(await writes.call('/api','session/prompt',last,life.signal)).toEqual({ok:true,value:{accepted:true}})
  }
  expect(await writes.call('/api','session/prompt',last,life.signal)).toEqual({ok:true,value:{accepted:true}})
  expect(call).toHaveBeenCalledTimes(270);expect(content).toHaveBeenCalledTimes(270)
  writes.dispose()
})
test('aborted authority during image preparation cannot send a prompt under later authority',async()=>{
  const life=new AbortController(),pending=Promise.withResolvers<any>(),call=vi.fn(),content=vi.fn(()=>pending.promise)
  const writes=new NativeWriteRoutes({call,action:()=>({fence:{instanceId:'i',runtimeId:'r',controlId:'c',authEpoch:1},signal:life.signal,stopToken:null}),content})
  const result=writes.call('/api','session/prompt',{args:{request:{sessionId:'s',requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:'synthetic'}]}}},new AbortController().signal)
  await vi.waitFor(()=>expect(content).toHaveBeenCalledOnce());life.abort();pending.resolve([{kind:'text',text:'synthetic'}])
  expect((await result).ok).toBe(false);expect(call).not.toHaveBeenCalled();writes.dispose()
})
test('original create may omit ID; the adapter allocates one fixed identity before dispatch',async()=>{
  const life=new AbortController(),call=vi.fn(async(_c:Command)=>({sessionId:'created'}))
  const writes=new NativeWriteRoutes({call,action:()=>({fence:{instanceId:'i',runtimeId:'r',controlId:'c',authEpoch:1},signal:life.signal,stopToken:null}),content:async()=>[]})
  expect((await writes.call('/api','session/create',{args:{request:{workspaceId:'w'}}},life.signal)).ok).toBe(true)
  expect(call.mock.calls[0][0]).toMatchObject({op:'session.create',workspaceId:'w',sessionId:expect.stringMatching(/^session-/)})
  expect(call).toHaveBeenCalledOnce();writes.dispose()
})
