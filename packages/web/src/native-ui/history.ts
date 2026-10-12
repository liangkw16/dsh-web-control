import type { BrowserTransport } from '../transport.ts'
import { object, nativeJson } from './read-routes.ts'
import { MAX_LOGICAL_JSON_BYTES, ProtocolError, type Json } from '../../../protocol/src/index.ts'

function snapshot<T>(initial:T){
  let value=initial
  const listeners=new Set<()=>void>()
  return {getSnapshot:()=>value,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)},set(next:T){value=next;for(const fn of listeners)fn()}}
}
const constant=<T>(value:T)=>({getSnapshot:()=>value,subscribe:()=>()=>{}})
const route=(type:'summary'|'diff',sessionId:string,seq:number,index?:number)=>`api/changes.${type}?${new URLSearchParams({sessionId,seq:String(seq),...(index===undefined?{}:{index:String(index)})})}`
type RecordState=Json|'loading'|'error'|'missing'

/** rc.2's public slot-injection contract consumes URL-keyed observable records.
 * No stock fetch/global is replaced: only these two injected read faces use the
 * authenticated recorded-file protocol. UI array offsets are NOT Host indices.
 */
export class NativeHistory {
  readonly summaries=snapshot<Record<string,RecordState>>({})
  readonly diffs=snapshot<Record<string,RecordState>>({})
  private indices=new Map<string,number[]>()
  private pending=new Map<string,Promise<void>>()
  private lifetime=new AbortController()
  private fence:string|undefined
  private ready=false
  private readonly unsubscribe:()=>void
  constructor(private readonly transport:Pick<BrowserTransport,'call'|'subscribe'|'getSnapshot'>){
    const update=()=>{
      const state=transport.getSnapshot(),fence=JSON.stringify(state.fence),ready=state.phase==='ready'
      if(fence!==this.fence||ready!==this.ready){this.fence=fence;this.ready=ready;this.reset()}
    }
    update();this.unsubscribe=transport.subscribe(update)
  }
  private reset(){this.lifetime.abort();this.lifetime=new AbortController();this.pending.clear();this.indices.clear();this.summaries.set({});this.diffs.set({})}
  dispose(){this.unsubscribe();this.reset();this.lifetime.abort()}
  private async load(type:'summary'|'diff',sessionId:string,seq:number,index?:number):Promise<void>{
    if(this.lifetime.signal.aborted)return
    const key=route(type,sessionId,seq,index),store=type==='summary'?this.summaries:this.diffs
    // A stock selector observes one entry, not the identity of the whole map.
    // Publish a waiting state so ready's reset changes loading -> undefined and
    // its original effect retries a read mounted during synchronization.
    if(!this.ready){if(store.getSnapshot()[key]!=='loading')store.set({...store.getSnapshot(),[key]:'loading'});return}
    if(this.pending.has(key))return this.pending.get(key)
    const cached=store.getSnapshot()[key]
    if(cached!==undefined&&cached!=='error')return
    const signal=this.lifetime.signal
    store.set({...store.getSnapshot(),[key]:'loading'})
    const run=(async()=>{
      let result:RecordState=type==='summary'?'missing':'error'
      try{
        if(!Number.isSafeInteger(seq)||seq<0)throw new ProtocolError('INVALID_MESSAGE')
        if(type==='summary'){
          const value=object(nativeJson(await this.transport.call({op:'file.changes',sessionId,seq},signal),MAX_LOGICAL_JSON_BYTES))
          signal.throwIfAborted()
          if(value.status==='unavailable')result='missing'
          else{
            if(!Array.isArray(value.files))throw new ProtocolError('INVALID_MESSAGE')
            const indices:number[]=[]
            const files=value.files.map(raw=>{
              const row=object(raw)
              if(!Number.isSafeInteger(row.index)||(row.index as number)<0||indices.includes(row.index as number)||typeof row.path!=='string'||typeof row.display!=='string'||!Number.isSafeInteger(row.added)||!Number.isSafeInteger(row.deleted))throw new ProtocolError('INVALID_MESSAGE')
              indices.push(row.index as number)
              const {index:_,...file}=row;return file
            })
            this.indices.set(route('summary',sessionId,seq),indices)
            result={...value,files}
          }
        }else{
          await this.loadSummary(sessionId,seq);signal.throwIfAborted()
          const hostIndex=index===undefined?undefined:this.indices.get(route('summary',sessionId,seq))?.[index]
          if(!Number.isSafeInteger(index)||(index as number)<0||hostIndex===undefined)throw new ProtocolError('OUT_OF_SCOPE')
          const value=object(nativeJson(await this.transport.call({op:'file.diff',sessionId,seq,index:hostIndex},signal),MAX_LOGICAL_JSON_BYTES))
          signal.throwIfAborted();result=value.status==='unavailable'?'missing':value
        }
      }catch{/* The stock component renders its original retry/missing state. */}
      if(!signal.aborted)store.set({...store.getSnapshot(),[key]:result})
    })()
    this.pending.set(key,run)
    try{await run}finally{if(this.pending.get(key)===run)this.pending.delete(key)}
  }
  readonly loadSummary=(sessionId:string,seq:number)=>this.load('summary',sessionId,seq)
  readonly loadDiff=(sessionId:string,seq:number,index:number)=>this.load('diff',sessionId,seq,index)
  readonly injected={
    hooks:{changesSummary:this.summaries,changesDiff:this.diffs,presentedOpen:constant({}),presentedHost:constant({available:false})},
    loadChangesSummary:this.loadSummary,loadChangesDiff:this.loadDiff,reloadPresentedHost:async()=>{},
    openPresented:async()=> 'nativeUnavailable',openChanged:async()=> 'nativeUnavailable',
  }
}

/** Activate the original plugin unchanged in a public Cordis service scope.
 * Only declared data/action injections are adapted. Components, event definitions,
 * review store, tab registration, locale and CSS remain the published originals.
 */
export async function registerNativeHistory(ctx:any,require:(id:string)=>any,transport:BrowserTransport,canFiles=false):Promise<void>{
  const history=new NativeHistory(transport),slots=ctx.slots
  ctx.effect(()=>()=>history.dispose())
  const scope=ctx.isolate('slots')
  const provider=scope.plugin({name:'remote-recorded-file-reads',apply(owner:any){owner.provide('slots',{
    inject:(key:string,callback:()=>unknown)=>slots.inject(key,callback),
    register:(options:any,component:any)=>{
      const tail=options.name==='conversation.chat.turnTail'&&options.id==='@deepseek-ai/dsh-client-ui-deliverables'
      const review=options.name==='sidebar.right.pane.tab'&&options.key==='@deepseek-ai/dsh-client-ui-deliverables'
      if(!tail&&!review)return slots.register(options,component)
      return slots.register({...options,inject:(...args:any[])=>{
        const original=options.inject(...args)
        return {...original,...history.injected,hooks:{...original.hooks,...history.injected.hooks}}
      }},component)
    },
  })}})
  await provider.await()
  const plugin=scope.plugin(ctx.loader.unwrapExports(require('@deepseek-ai/dsh-client-ui-deliverables/client')))
  await plugin.await()
  if(plugin.state!==2)throw new Error('Native deliverables unavailable')
  ctx.effect(()=>()=>plugin.dispose())
  if(canFiles)return
  // The stock review's whole-file action remains discoverable, with an honest
  // readonly destination until the Host exposes a safe current-file capability.
  const React=require('react'),t=ctx.locale.bind('webControl'),id='remote-file-unavailable'
  ctx.effect(()=>ctx.sidebarRightTabs.register({id,kind:id,patterns:['dsh-resource://file/**'],title:()=>t('filePreview')}))
  ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:id,locale:'webControl'},({t}:any)=>React.createElement('p',{role:'status',style:{padding:24}},t('filesDeferred'))))
}
