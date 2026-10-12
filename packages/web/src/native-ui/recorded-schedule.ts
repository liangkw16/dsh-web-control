/** Keep the stock journal projection and creation card without granting scheduler
 * management. Its optional detail opens a clearly labelled historical record in
 * the original sidebar; it never presents the recorded result as live task state. */
import type { BrowserTransport } from '../transport.ts'

export async function registerRecordedSchedule(ctx:any,require:(id:string)=>any,transport:BrowserTransport):Promise<void>{
  const React=require('react'),slots=ctx.slots,id='remote-schedule-record',records=new Map<string,Record<string,unknown>>()
  let version=0,lastFence=JSON.stringify(transport.getSnapshot().fence)
  const listeners=new Set<()=>void>(),publish=()=>{version++;for(const fn of listeners)fn()}
  const subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)},getSnapshot=()=>version
  ctx.effect(()=>transport.subscribe(()=>{
    const state=transport.getSnapshot(),fence=JSON.stringify(state.fence)
    if(state.phase!=='ready'||fence!==lastFence){lastFence=fence;if(records.size){records.clear();publish()}}
  }))
  const t=ctx.locale.bind('webControl')
  const catalog={getSnapshot:()=>historical,subscribe:()=>()=>{}}
  const historical={records:[],status:'ready',settled:false,readRequest:0,readSettled:0,deleting:[]}
  const prefix='dsh-resource://remote-schedule/'
  ctx.effect(()=>ctx.sidebarRightTabs.register({id,kind:id,patterns:[prefix+'**'],title:()=>t('scheduleRecord')}))
  slots.inject('sidebar.right.pane.tab',()=>slots.register({name:'sidebar.right.pane.tab',key:id,locale:'webControl'},(props:any)=>{
    React.useSyncExternalStore(subscribe,getSnapshot,getSnapshot)
    const {tab}=props.useTabInfo(),record=records.get(tab.contentId)
    return React.createElement('section',{className:'dsh-remote-record', 'aria-label':props.t('scheduleRecord')},
      React.createElement('h3',null,typeof record?.title==='string'?record.title:props.t('scheduleRecord')),
      React.createElement('p',{role:'note'},props.t('scheduleRecordedOnly')),
      !record&&React.createElement('p',{role:'status'},props.t('scheduleReopen')),
      typeof record?.scheduledAt==='string'&&React.createElement('p',null,record.scheduledAt),
      typeof record?.prompt==='string'&&React.createElement('p',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},record.prompt))
  }))
  const scope=ctx.isolate('slots').isolate('remote.schedule').isolate('sidebarRightTabs')
  const provider=scope.plugin({name:'remote-recorded-schedule',apply(owner:any){
    owner.provide('remote.schedule',Object.freeze({}))
    owner.provide('sidebarRightTabs',{register:()=>()=>{}})
    owner.provide('slots',{
      inject:(key:string,callback:()=>unknown)=>key==='conversation.chat.turnTail'?slots.inject(key,callback):()=>{},
      register:(options:any,Component:any)=>{
        if(options.name!=='conversation.chat.turnTail'||options.id!=='schedule-created')throw new Error('Unsupported schedule contribution')
        return slots.register({...options,inject:()=>({hooks:{catalog},onRetry:async()=>{}})},function Recorded(props:any){
          const openTaskDetail=(taskId:string)=>{
            if(transport.getSnapshot().phase!=='ready')return
            const created=props.turn.data.get('schedule-created')?.created??[]
            for(const block of created){
              const part=block.content?.find((part:any)=>part.type==='text')
              if(!part)continue
              let record:Record<string,unknown>;try{record=JSON.parse(part.text)}catch{continue}
              if(!record||record.id!==taskId)continue
              const address=prefix+encodeURIComponent(props.sessionId)+'/'+encodeURIComponent(taskId)
              records.set(address,record);publish();ctx.sidebarRight.openResource(address);return
            }
          }
          return React.createElement(Component,{...props,openTaskDetail})
        })
      },
    })
  }})
  await provider.await()
  const plugin=scope.plugin(ctx.loader.unwrapExports(require('@deepseek-ai/dsh-client-ui-schedule/client')))
  await plugin.await()

  if(plugin.state!==2)throw new Error('Native recorded schedule unavailable')
  ctx.effect(()=>()=>{records.clear();return plugin.dispose()})
}
