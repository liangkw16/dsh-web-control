import { expect, test, vi } from 'vitest'
import { DshManagementAdapter } from '../src/adapter/management-rc2.ts'
import { SessionScope } from '../src/adapter/scope.ts'
import { ProtocolError } from '../../protocol/src/index.ts'
function fixture() {
  const workspaces=[{workspaceId:'w',sessionIds:['s','a']},{workspaceId:'v',sessionIds:[]}]
  const invoke=vi.fn(async (_request:unknown):Promise<unknown>=>({title:'renamed',seq:3}))
  const scope=new SessionScope(()=>workspaces)
  const workspaceController=Object.fromEntries(['rename','delete','insertBefore','archiveSession','unarchiveSession','pinSession','unpinSession'].map(k=>[k,()=>{}]))
  const ctx={get:(key:string)=>key==='workspaceController'?workspaceController:undefined,typertGateway:{invoke},sessionController:{rename(){},fork(){},list(){},search(){}}} as any
  return {invoke,workspaces,adapter:new DshManagementAdapter(ctx,scope),scope,ctx}
}
test('native mutation is admitted once; stale control never reaches the public service',async()=>{
  const f=fixture(), signal=new AbortController(), check=vi.fn()
  expect(await f.adapter.manage({op:'ui.manage',action:{kind:'session.rename',sessionId:'s',title:'renamed'}},signal.signal,check)).toEqual({ok:true,value:{title:'renamed',seq:3}})
  expect(f.invoke).toHaveBeenCalledWith({namespace:'session',method:'rename',args:{request:{sessionId:'s',title:'renamed'}}})
  const stale=()=>{throw new ProtocolError('STALE_CONTROL')}
  await expect(f.adapter.manage({op:'ui.manage',action:{kind:'session.fork',sessionId:'s'}},signal.signal,stale)).rejects.toThrow('STALE_CONTROL')
  expect(f.invoke).toHaveBeenCalledOnce()
})
test('workspace order requires both live workspaces',async()=>{
  const f=fixture(),signal=new AbortController().signal
  for(const action of [{kind:'workspace.delete',workspaceId:'unknown'},{kind:'workspace.insertBefore',workspaceId:'w',beforeWorkspaceId:'unknown'}] as const) await expect(f.adapter.manage({op:'ui.manage',action},signal,()=>{})).rejects.toThrow('OUT_OF_SCOPE')
  expect(f.invoke).not.toHaveBeenCalled()
})
test('running archive refusal preserves native confirmation data without stopping activity',async()=>{
  const f=fixture(),activity=[{kind:'turn'},{kind:'schedule',items:[{id:'job',label:'scheduled task'}]}]
  f.invoke.mockRejectedValue({code:'workspace/session-active',message:'Native running work refusal',details:{sessionId:'s',activity}})
  expect(await f.adapter.manage({op:'ui.manage',action:{kind:'workspace.archiveSession',sessionId:'s'}},new AbortController().signal,()=>{})).toEqual({ok:false,error:{code:'workspace/session-active',message:'Native running work refusal',details:{sessionId:'s',activity}}})
  expect(f.invoke).toHaveBeenCalledOnce()
  expect(f.invoke.mock.calls[0][0]).not.toHaveProperty('args.request.stopActivity')
})
test('accepted native work is never retried or cancelled when its controller disconnects',async()=>{
  const f=fixture(), pending=Promise.withResolvers<unknown>(), signal=new AbortController()
  f.invoke.mockReturnValue(pending.promise)
  const result=f.adapter.manage({op:'ui.manage',action:{kind:'session.fork',sessionId:'s'}},signal.signal,()=>{})
  signal.abort(new ProtocolError('STALE_CONTROL'));pending.resolve({sessionId:'child'})
  await expect(result).rejects.toThrow('STALE_CONTROL');expect(f.invoke).toHaveBeenCalledOnce()
  expect(f.invoke.mock.calls[0][0]).not.toHaveProperty('signal')
})
test('workspace deletion acknowledges native completion without requiring the removed group to still exist',async()=>{
  const f=fixture();f.invoke.mockImplementation(async()=>{f.workspaces.shift();return {deleted:true}})
  expect(await f.adapter.manage({op:'ui.manage',action:{kind:'workspace.delete',workspaceId:'w'}},new AbortController().signal,()=>{})).toEqual({ok:true,value:{deleted:true}})
})
test('host-profile scope preserves ungrouped session IDs, but never changes file or group authority',async()=>{
  const scope=new SessionScope(()=>[],undefined,'host-profile')
  expect(()=>scope.assertSession('known-by-native-api')).not.toThrow()
  expect(()=>scope.assertSession('s','missing-workspace')).toThrow('OUT_OF_SCOPE')
  await expect(scope.bindRecordedWorkspace('s','/tmp')).rejects.toThrow('OUT_OF_SCOPE')
  expect(()=>scope.assertCreate('missing-workspace','s')).toThrow('OUT_OF_SCOPE')
})
test('opted large catalog keeps every native row and projection beyond one wire frame', async () => {
  const f=fixture(), value={items:Array.from({length:40},(_,i)=>({sessionId:`session-${i}`,projections:{asOfSeq:i,values:{title:`Session ${i}`,inbox:{text:'大目录'.repeat(2000)}}}}))}
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(256*1024)
  f.ctx.sessionController.list=async()=>value
  await expect(f.adapter.catalog(new AbortController().signal,()=>{},1024*1024)).resolves.toEqual(value)
})
