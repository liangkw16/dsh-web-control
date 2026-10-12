import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DshQueueAdapter } from '../src/adapter/queue-rc2.ts'
import { SessionScope } from '../src/adapter/scope.ts'
const signal=new AbortController().signal
function fixture(){
  let live:any={inbox:{nextTurn:[{id:'item'}],nextStep:[]}},allowed=true,valid=true,token='turn-1'
  const updateQueue=vi.fn(async()=>({accepted:true})),resolveAgent=vi.fn(async()=>({agent:live}))
  const ctx={agents:{get:()=>live},sessionController:{updateQueue,resolveAgent}} as unknown as Context
  const scope=new SessionScope(()=>[{workspaceId:'w',sessionIds:allowed?['s']:[]}])
  return {adapter:new DshQueueAdapter(ctx,scope,()=>token),updateQueue,resolveAgent,admit:()=>{if(!valid)throw new Error('STALE_CONTROL')},scope:()=>{allowed=false},revoke:()=>{valid=false},cold:()=>{live=undefined},attach:(agent:any)=>{live=agent},turn:()=>{token='turn-2'},agent:()=>live}
}
test('queue actions reach only the scoped existing item and invoke public native method once',async()=>{
  const f=fixture()
  for(const action of [{kind:'edit',content:[{type:'text',text:'edited'}]},{kind:'remove'},{kind:'steer'}] as const){
    const request={op:'session.queue',sessionId:'s',itemId:'item',action,...(action.kind==='steer'?{stopToken:'turn-1'}:{})}
    expect(await f.adapter.update(request as any,signal,f.admit)).toEqual({accepted:true})
  }
  expect(f.updateQueue).toHaveBeenCalledTimes(3);expect(f.resolveAgent).not.toHaveBeenCalled()
  await expect(f.adapter.update({op:'session.queue',sessionId:'private',itemId:'item',action:{kind:'remove'}},signal,f.admit)).rejects.toThrow('OUT_OF_SCOPE')
  await expect(f.adapter.update({op:'session.queue',sessionId:'s',itemId:'gone',action:{kind:'remove'}},signal,f.admit)).rejects.toThrow('STALE_ACTION')
  expect(f.updateQueue).toHaveBeenCalledTimes(3)
})
test('cold resolution rechecks fence, scope, signal and actual Agent before any queue mutation',async()=>{
  for(const reason of ['fence','scope','abort','agent']){
    const f=fixture(),controller=new AbortController(),pending=Promise.withResolvers<any>(),agent=f.agent();f.cold();f.resolveAgent.mockReturnValue(pending.promise)
    const result=f.adapter.update({op:'session.queue',sessionId:'s',itemId:'item',action:{kind:'remove'}},controller.signal,f.admit)
    f.attach(agent)
    if(reason==='fence')f.revoke();if(reason==='scope')f.scope();if(reason==='abort')controller.abort();if(reason==='agent')f.attach({})
    pending.resolve({agent});await expect(result).rejects.toThrow();expect(f.updateQueue).not.toHaveBeenCalled()
  }
})
test('late steer cannot affect a later turn; local consumption and native rejection remain real failures',async()=>{
  const f=fixture();f.turn()
  await expect(f.adapter.update({op:'session.queue',sessionId:'s',itemId:'item',stopToken:'turn-1',action:{kind:'steer'}},signal,f.admit)).rejects.toThrow('STALE_ACTION')
  expect(f.updateQueue).not.toHaveBeenCalled()
  f.updateQueue.mockRejectedValueOnce({code:'session/queue-item-not-found'})
  await expect(f.adapter.update({op:'session.queue',sessionId:'s',itemId:'item',action:{kind:'remove'}},signal,f.admit)).rejects.toThrow('STALE_ACTION')
})
