import {expect,test,vi} from 'vitest'
import {bindPageLifecycle} from '../src/page-lifecycle.ts'
function fixture(){
 const view=new EventTarget(),nodes:any[]=[],dispose=vi.fn(async()=>{}),reload=vi.fn()
 const document={createElement:()=>({append:vi.fn(),textContent:'',onclick:undefined})}
 const container={ownerDocument:document,inert:true,replaceChildren:vi.fn((...children:any[])=>nodes.splice(0,nodes.length,...children))} as unknown as HTMLElement
 const event=(name:string)=>{const e=new Event(name);Object.assign(e,{persisted:true});view.dispatchEvent(e)}
 return{view:view as unknown as Window,container,dispose,reload,nodes,event}
}
test('persisted restoration shows an explicit reconnect without booting or claiming again',async()=>{
 const f=fixture();bindPageLifecycle(f.view,f.container,Promise.resolve({dispose:f.dispose}),f.reload)
 f.event('pagehide');f.event('pageshow');await vi.waitFor(()=>expect(f.container.replaceChildren).toHaveBeenCalled())
 expect(f.dispose).toHaveBeenCalledOnce();expect(f.reload).not.toHaveBeenCalled();expect(f.container.inert).toBe(false)
 const children=f.nodes[0].append.mock.calls[0];expect(children[0].textContent).toBe('页面已恢复');expect(children[2].textContent).toBe('重新接管')
 children[2].onclick();expect(f.reload).toHaveBeenCalledOnce()
})
test('pagehide during startup disposes the eventual owner before showing restored UI',async()=>{
 const f=fixture(),owner=Promise.withResolvers<{dispose():Promise<void>}>();bindPageLifecycle(f.view,f.container,owner.promise,f.reload)
 f.event('pagehide');f.event('pageshow');expect(f.dispose).not.toHaveBeenCalled()
 owner.resolve({dispose:f.dispose});await vi.waitFor(()=>expect(f.dispose).toHaveBeenCalledOnce());await vi.waitFor(()=>expect(f.container.replaceChildren).toHaveBeenCalledOnce())
 expect(f.reload).not.toHaveBeenCalled()
})
