import { expect, test, vi } from 'vitest'
import { NativeManagementRoutes } from '../src/native-ui/management-routes.ts'
import { NativeGeneration } from '../src/native-ui/generation.ts'
import { dispatchRead } from '../src/native-ui/read-routes.ts'
import { ProtocolError } from '../../protocol/src/index.ts'
const fence={instanceId:crypto.randomUUID(),runtimeId:crypto.randomUUID(),controlId:crypto.randomUUID(),authEpoch:1}
test('row management targets need not be the selected conversation and survive navigation',async()=>{
  const generation=new NativeGeneration(()=>({ready(){},fail(){}})),life=new AbortController()
  generation.begin({fence,signal:life.signal,barrier:{ready(){},fail(){}}})
  const ticket=generation.capture();for(const topic of ['workspaces','sessions','interactions'] as const) generation.baseline(ticket,topic)
  const pending=Promise.withResolvers<any>(),call=vi.fn((_command:unknown,_signal:AbortSignal)=>pending.promise)
  const routes=new NativeManagementRoutes({enabled:true,call,action:()=>generation.managementAction()})
  const result=routes.call('/api','session/rename',{args:{request:{sessionId:'other',title:'changed'}}},life.signal)
  generation.select('another');expect(call.mock.calls[0][1].aborted).toBe(false)
  pending.resolve({ok:true,value:{title:'changed',seq:1}})
  expect(await result).toEqual({ok:true,value:{title:'changed',seq:1}})
  expect(call.mock.calls[0][0]).toEqual({op:'ui.manage',action:{kind:'session.rename',sessionId:'other',title:'changed'}})
  generation.dispose()
})
test('original archive confirmation receives activity and no auto-retry or auto-stop',async()=>{
  const refusal={ok:false,error:{code:'workspace/session-active',message:'workspace/session-active',details:{sessionId:'s',activity:[{kind:'turn'}]}}}
  const call=vi.fn(async()=>refusal),routes=new NativeManagementRoutes({enabled:true,call,action:()=>({fence,signal:new AbortController().signal})})
  expect(await routes.call('/api','workspace/archiveSession',{args:{request:{sessionId:'s'}}},new AbortController().signal)).toEqual(refusal)
  expect(call).toHaveBeenCalledOnce()
})
test('legacy hosts, arbitrary RPCs and stale action failures send no mutations',async()=>{
  const call=vi.fn(),signal=new AbortController().signal
  const routes=new NativeManagementRoutes({enabled:false,call,action:()=>({fence,signal})})
  expect(await routes.call('/api','session/fork',{args:{request:{sessionId:'s'}}},signal)).toMatchObject({ok:false,error:{code:'PROTOCOL_UNSUPPORTED'}})
  const enabled=new NativeManagementRoutes({enabled:true,call,action:()=>{throw new ProtocolError('STALE_CONTROL')}})
  expect(await enabled.call('/api','workspace/delete',{args:{request:{workspaceId:'w'}}},signal)).toMatchObject({ok:false,error:{code:'STALE_CONTROL'}})
  expect(await enabled.call('/api','workspace/create',{args:{request:{path:'/tmp'}}},signal)).toMatchObject({ok:false,error:{code:'PROTOCOL_UNSUPPORTED'}})
  expect(call).not.toHaveBeenCalled()
})
test('profile catalog keeps original ungrouped sessions without synthesizing workspace memberships',async()=>{
  const value={items:[{sessionId:'ungrouped',title:'original'}]},call=vi.fn(async()=>value),watch=vi.fn()
  expect(await dispatchRead({call,watch},'/api','session/list',{args:{_request:{}}},new AbortController().signal,true)).toEqual({ok:true,value})
  expect(call).toHaveBeenCalledWith({op:'ui.catalog'},expect.any(AbortSignal));expect(watch).not.toHaveBeenCalled()
})
