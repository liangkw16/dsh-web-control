import { registerNativeFiles } from './files.ts'
import { registerRecordedSchedule } from './recorded-schedule.ts'
import { registerNativeHistory } from './history.ts'
import { registerNativeWorkspace } from './workspace-rc2.ts'
import type { PreferenceStore } from './preferences.ts'
import { NativeBlocks } from './blocks.ts'
import { nativeLocales } from './locales.ts'
import type { BrowserTransport } from '../transport.ts'
import type { NativeDraftBinding } from './draft-binding.ts'
import type { NativeRpcOwner } from './rpc-rc2.ts'
import type { DraftStore } from '../drafts.ts'
// Client modules are preloaded unchanged; only this finite set is activated.
export const nativePluginIds=new Set([
  'modules','connection','locale','shortcuts','file-upload','resources',
  'ui-settings','ui-theme','ui-layout','ui-session','ui-sidebar','ui-sidebar-right',
  'ui-chat','ui-input-trigger','ui-tool','ui-trajectory','ui-attachment','ui-approval','ui-user-questions','ui-brand-official',
].map(id=>'@deepseek-ai/dsh-client-'+id).concat(['@deepseek-ai/dsh-api-gateway','@deepseek-ai/dsh-api-remotes','@deepseek-ai/dsh-api-session-controller','@deepseek-ai/dsh-api-workspace-controller','@deepseek-ai/dsh-typert-registry']))
// Document preview is composed separately with its public static-HTML setting.
export const nativeFilePluginIds=new Set(['@deepseek-ai/dsh-api-workspace-files'])
export function registerNativeExtension(options:{canFiles?:boolean;canManage?:boolean;transport:BrowserTransport;rpc:NativeRpcOwner;preferences:PreferenceStore;instanceId:string;container:HTMLElement;drafts:NativeDraftBinding;draftStore:DraftStore;mounted:PromiseWithResolvers<void>;configured:PromiseWithResolvers<void>;signal:AbortSignal;verifyRuntime(require:(id:string)=>unknown):void}):void{
  const globals=globalThis as any
  globals.__ModuleLoader__.load({id:'dsh-remote-native',factory:(require:(id:string)=>any)=>{
    options.verifyRuntime(require)
    const {RemoteStreamCarrierError}=require('@deepseek-ai/dsh-api-gateway/client')
    options.rpc.useCarrierError(cause=>new RemoteStreamCarrierError('Remote carrier closed',{cause}))
    return {
    inject:['configForms','connection','modules','loader'],
    async apply(ctx:any){
      const rendererScope=ctx.isolate('uiRenderer')
      const rendererFiber=rendererScope.plugin(ctx.loader.unwrapExports(require('@deepseek-ai/dsh-client-ui-renderer/client')))
      await rendererFiber.await()
      const renderer=rendererScope.get('uiRenderer');if(!renderer)throw new Error('Native renderer unavailable')
      let unmount:(()=>void)|undefined
      ctx.provide('uiRenderer',{mount(container:HTMLElement){
        // Boot may finish after its remote lease was lost. Do not hydrate an already-disposed owner.
        if(options.signal.aborted)return()=>{}
        if(unmount)throw new Error('Duplicate native UI root')
        unmount=renderer.mount(container)
        options.mounted.resolve()
        return()=>{unmount?.();unmount=undefined}
      }})
      const source=options.preferences,stockForms=ctx.configForms
      let snapshot:unknown
      const update=()=>{snapshot=Object.freeze(source.value?{status:'ready',mode:'host',writable:false,value:{busyEnter:source.value.busyEnter},revision:source.value.revision}:{status:'loading',mode:'host',writable:false})}
      update();const disposePreference=source.subscribe(update)
      const form={getSnapshot:()=>snapshot,subscribe:source.subscribe,async set(){return false},async unset(){return false},async mutate(){return false}}
      const scoped=ctx.isolate('configForms'),provider=scoped.plugin({name:'dsh-remote-readonly-preference',apply(owner:any){owner.provide('configForms',{get:(ns:string)=>ns==='ui-conversation'?form:stockForms.get(ns),describe:()=>stockForms.describe(),whileServed:(ns:string,register:unknown)=>stockForms.whileServed(ns,register),developerTools:stockForms.developerTools})}})
      await provider.await()
      // Conversation depends on uiWorkspace. Compose its public providers first;
      // waiting until after conversation activation would create a service cycle.
      await new Promise<void>((resolve,reject)=>{
        ctx.inject(['slots','locale','sessions','workspaces','layout','shortcuts','remote.directoryPicker'],(workspaceCtx:any)=>{
          workspaceCtx.effect(()=>workspaceCtx.locale.register('webControl',nativeLocales))
          void registerNativeWorkspace(workspaceCtx,require,options.canManage).then(resolve,reject)
        })
      })
      const conversation=scoped.plugin(ctx.loader.unwrapExports(require('@deepseek-ai/dsh-client-ui-conversation/client')))
      await conversation.await()
      if(conversation.state!==2)throw new Error('Native conversation unavailable')
      ctx.inject(['locale','slots','shortcuts','conversation','uiConversation','sessions','sidebarRightTabs','sidebarRight','remote.session'],(ctx:any)=>{void (async()=>{
      const React=require('react'),ReactDOM=require('react-dom')
      // Subscribe before asynchronous renderer/media setup: a retained session can
      // already open and finish its baseline while those dependencies initialize.
      const blocks=new NativeBlocks(options.container,ctx.conversation.blocks)
      const sessions=ctx.get('sessions')
      const selection=()=>{const rows=Object.values(sessions.list.getSnapshot().byId) as any[],selected=rows.find(row=>(row.retainedBy.mainView??0)>0);options.rpc.select(selected?.id??null);const binding=selected?sessions.binding(selected.id):undefined;if(binding)options.drafts.bind(selected.id,ctx.conversation.input.for(binding.ctx),binding.session);else options.drafts.unbind()}
      const authority=()=>{const state=options.transport.getSnapshot();const ids=Object.values(sessions.list.getSnapshot().byId).filter((row:any)=>(row.retainedBy.mainView??0)>0).map((row:any)=>row.id);blocks.update(ids as string[],state.phase==='ready',ctx.locale.bind('webControl')(state.phase==='busy'?'connecting':state.phase))}
      selection();authority();const disposeSelection=sessions.list.subscribe(()=>{selection();authority()}),disposeAuthority=options.transport.subscribe(authority)
      ctx.effect(()=>()=>{disposePreference();disposeSelection();disposeAuthority();blocks.dispose()})
      await registerNativeHistory(ctx,require,options.transport,options.canFiles)
      await registerNativeFiles(ctx,require,options.transport,!!options.canFiles)
      await registerRecordedSchedule(ctx,require,options.transport)
      const Status=({t,overlay}:any)=>{
        const state=React.useSyncExternalStore(options.transport.subscribe,options.transport.getSnapshot)
        const storageWarning=React.useSyncExternalStore(options.draftStore.subscribeWarning,()=>options.draftStore.persistenceWarning)
        const [retrying,setRetrying]=React.useState(false)
        const retry=async()=>{setRetrying(true);try{await options.transport.retry()}catch{/* The transport publishes the failure. */}finally{setRetrying(false)}}
        if(overlay!==(state.phase!=='ready'||storageWarning))return null
        const content=React.createElement('div',{role:'status','aria-label':t('status'),className:overlay?'dsh-remote-status':'dsh-remote-connected'},t(state.phase==='busy'?'connecting':state.phase),storageWarning&&React.createElement('span',null,t('draftStorageWarning')),['replaced','error','offline'].includes(state.phase)&&React.createElement(require('@deepseek-ai/dsh-client-ui-primitives').Button,{size:'sm',disabled:retrying,onClick:()=>void retry()},t('retry')))
        return overlay?ReactDOM.createPortal(content,document.body):content
      }
      ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'remote-control-status',locale:'webControl'},(props:any)=>React.createElement(Status,{...props,overlay:true})))
      ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'remote-control-connected',locale:'webControl'},(props:any)=>React.createElement(Status,{...props,overlay:false})))
      options.configured.resolve()
      })().catch(options.configured.reject)})
      return()=>conversation.dispose()
    },
  }}})
}
