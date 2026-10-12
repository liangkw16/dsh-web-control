import {expect,test,vi,beforeEach} from 'vitest'
const mocks=vi.hoisted(()=>({boot:vi.fn(),transport:vi.fn()}))
vi.mock('../src/native-ui/bootstrap.ts',()=>({bootNativeUi:mocks.boot}))
vi.mock('../src/transport.ts',()=>({BrowserTransport:class{constructor(options:unknown){mocks.transport(options)}dispose(){}}}))
import {startRemotePage} from '../src/entry.ts'
import {RC2_UI_PROFILE} from '../../protocol/src/index.ts'
const id='11111111-1111-4111-8111-111111111111',runtimeId='22222222-2222-4222-8222-222222222222',revision='a'.repeat(64),legacy='b'.repeat(64)
const profile={runtimeId,host:RC2_UI_PROFILE,uiRevision:revision}
function setup(selection:any,key=true){
 const nodes:any[]=[],history={state:null,replaceState:vi.fn()},dispose=vi.fn(async()=>{})
 const view={history,setInterval:vi.fn((_callback:()=>void,_delay:number)=>1),clearInterval:vi.fn()},document={defaultView:view,createElement:vi.fn((name:string)=>({name,style:{},remove:vi.fn(),setAttribute:vi.fn()}))}
 const container={id:'root',ownerDocument:document,replaceChildren:vi.fn((...children:any[])=>nodes.splice(0,nodes.length,...children))} as unknown as HTMLElement
 const storage={} as Storage,href=`https://relay.test/connect/${id}${key?'#key='+'S'.repeat(43):''}`,calls:string[]=[]
 const fetch=vi.fn(async(url:any)=>{calls.push(String(url));
  if(String(url).endsWith('/login'))return Response.json({ok:true})
  if(String(url).endsWith('/ui-profile'))return Response.json(selection)
  if(url==='/ui-release.json')return Response.json({schema:1,native:[{dshVersion:'0.2.0-rc.2',adapter:'rc2-native-1',revision,manifest:`ui/${revision}/ui-artifact-manifest.json`}],legacy:{revision:legacy,html:'legacy.html'}})
  if(url===`/ui/${revision}/ui-artifact-manifest.json`)return Response.json({schema:1,dshVersion:'0.2.0-rc.2',uiRevision:revision})
  return new Response('',{status:404})
 }) as unknown as typeof globalThis.fetch
 mocks.boot.mockResolvedValue({dispose})
 return{container,storage,href,fetch,calls,nodes,history,dispose,view}
}
beforeEach(()=>{vi.clearAllMocks()})
test('injected browser fetch never receives an authorization or transport object as receiver',async()=>{
 const f=setup({kind:'native',profile}),request=f.fetch
 f.fetch=function(this:unknown,...args:Parameters<typeof fetch>){expect(this).toBeUndefined();return request(...args)}
 await startRemotePage(f)
})
test('secret is removed before login; native selection creates exactly one owner with a fixed resource base',async()=>{
 const f=setup({kind:'native',profile}),owner=await startRemotePage(f)
 expect(String(f.history.replaceState.mock.calls[0][2])).not.toContain('#')
 expect(f.calls).toEqual([`/v1/instances/${id}/login`,`/v1/instances/${id}/ui-profile`,'/ui-release.json',`/ui/${revision}/ui-artifact-manifest.json`])
 expect(mocks.transport).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({origin:'https://relay.test',uiProfile:profile}))
 expect(mocks.boot).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({assetBase:`/ui/${revision}/`,storage:f.storage}))
 await expect(startRemotePage(f)).rejects.toThrow();expect(mocks.transport).toHaveBeenCalledTimes(1)
 await owner.dispose();await owner.dispose();expect(f.dispose).toHaveBeenCalledOnce()
})
test('refresh uses cookie; expiry or incompatible profile fails before any controller or UI is mounted',async()=>{
 const f=setup({kind:'native',profile},false);await startRemotePage(f);expect(f.calls.some(c=>c.endsWith('/login'))).toBe(false)
 for(const selected of [{kind:'unavailable',code:'HOST_OFFLINE'},{kind:'unavailable',code:'PROTOCOL_UNSUPPORTED'}]){
  const bad=setup(selected,false);mocks.transport.mockClear();await expect(startRemotePage(bad)).rejects.toThrow();expect(mocks.transport).not.toHaveBeenCalled();expect(bad.nodes).toEqual([])
 }
 const expired=setup({kind:'native',profile},false);expired.fetch=vi.fn(async()=>Response.json({error:{code:'AUTH_EXPIRED'}},{status:401}));mocks.transport.mockClear()
 await expect(startRemotePage(expired)).rejects.toThrow('Keep the original authorization link');expect(mocks.transport).not.toHaveBeenCalled()
})
test('frozen legacy owns one same-instance child document, no parent controller, and public unload disposal',async()=>{
 const f=setup({kind:'legacy',runtimeId}),owner=await startRemotePage(f)
 expect(mocks.transport).not.toHaveBeenCalled();expect(mocks.boot).not.toHaveBeenCalled();expect(f.nodes).toHaveLength(1)
 expect(f.nodes[0].src).toBe(`/connect/${id}?legacy=${legacy}`);expect(f.nodes[0].src).not.toContain('#')
 await owner.dispose();expect(f.nodes[0].remove).toHaveBeenCalledOnce()
})
test('a changed legacy Host unloads the old document and requests reload without claiming control',async()=>{
 const selection={kind:'legacy',runtimeId},f=setup(selection)
 await startRemotePage(f);const frame=f.nodes[0]
 selection.runtimeId='33333333-3333-4333-8333-333333333333'
 f.view.setInterval.mock.calls[0][0]()
 await vi.waitFor(()=>expect(frame.remove).toHaveBeenCalledOnce())
 expect(f.nodes[0].textContent).toContain('刷新页面');expect(mocks.transport).not.toHaveBeenCalled();expect(mocks.boot).not.toHaveBeenCalled()
})
