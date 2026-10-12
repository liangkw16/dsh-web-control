import { DraftStore, type DraftRevision } from '../drafts.ts'
import { ProtocolError } from '../../../protocol/src/index.ts'
export interface NativeInputPort {
  state:{getSnapshot():{draft:string;draftRev:number;phase:string};subscribe(listener:()=>void):()=>void}
  setDraft(text:string):void
}
export interface NativeSubmissionSource {
  getSnapshot():{pendingSubmissions:readonly {requestId:string}[]}
  subscribe(listener:()=>void):()=>void
}
/** Mirrors public input and pending-submission stores; replies never write into an editor. */
export class NativeDraftBinding {
  private active?:{sessionId:string;input:NativeInputPort;release():void}
  private readonly submissions=new Map<string,{draft:DraftRevision;done:boolean;sent:boolean}>()
  constructor(private readonly instanceId:string,private readonly store:DraftStore){}
  bind(sessionId:string,input:NativeInputPort,source?:NativeSubmissionSource):void{
    if(this.active?.input===input&&this.active.sessionId===sessionId)return
    this.active?.release()
    const saved=this.store.read(this.instanceId,sessionId)
    if(!input.state.getSnapshot().draft&&saved)input.setDraft(saved)
    let previous=input.state.getSnapshot()
    if(previous.draft!==saved)this.store.write(this.instanceId,sessionId,previous.draft)
    // A normal stock send remains in phase=plain and clears before the RPC runs.
    // Its public echo is synchronous and already carries the eventual requestId.
    let seen=new Set(source?.getSnapshot().pendingSubmissions.map(row=>row.requestId))
    const commits=new Set<number>()
    const releaseEcho=source?.subscribe(()=>{
      const rows=source.getSnapshot().pendingSubmissions
      const fresh=rows.filter(row=>!seen.has(row.requestId))
      const current=new Set(rows.map(row=>row.requestId))
      for(const id of seen)if(!current.has(id)){
        const record=this.submissions.get(JSON.stringify([sessionId,id]))
        if(record&&!record.sent)record.done=true
      }
      this.prune();seen=current
      for(const row of fresh){
        try{this.capture(sessionId,row.requestId)}catch(error){
          // The RPC boundary will return BACKPRESSURE and the original editor
          // will restore the rejected submission. Do not break store dispatch.
          if(error instanceof ProtocolError&&error.code==='BACKPRESSURE')continue
          throw error
        }
        commits.add(input.state.getSnapshot().draftRev)
        if(commits.size>128)commits.delete(commits.values().next().value!)
      }
    })
    const releaseInput=input.state.subscribe(()=>{
      const current=input.state.getSnapshot()
      if(current.draft!==previous.draft){
        const committed=commits.delete(previous.draftRev)
        const optimistic=current.draft===''&&(committed||previous.phase==='adjudicating'||previous.phase==='submitting'||current.phase==='adjudicating'||current.phase==='submitting')
        if(!optimistic)this.store.write(this.instanceId,sessionId,current.draft)
      }
      previous=current
    })
    this.active={sessionId,input,release(){releaseInput();releaseEcho?.()}}
  }
  unbind():void{this.active?.release();this.active=undefined}
  private capture(sessionId:string,requestId:string){
    const key=JSON.stringify([sessionId,requestId])
    let record=this.submissions.get(key)
    if(!record){
      if([...this.submissions.values()].filter(row=>!row.done).length>=128)throw new ProtocolError('BACKPRESSURE')
      record={draft:this.store.capture(this.instanceId,sessionId),done:false,sent:false};this.submissions.set(key,record)
    }
    return record
  }
  submission(sessionId:string,requestId:string):(accepted:boolean,terminal?:boolean)=>void{
    const captured=this.capture(sessionId,requestId)
    captured.sent=true
    return (accepted,terminal=false)=>{
      if(captured.done)return
      if(accepted){captured.done=true;this.store.clearAccepted(captured.draft)}
      else if(terminal)captured.done=true
      this.prune()
    }
  }
  private prune():void{
    const done=[...this.submissions].filter(([,row])=>row.done)
    for(const[id]of done.slice(0,Math.max(0,done.length-128)))this.submissions.delete(id)
  }
  dispose():void{this.unbind();this.submissions.clear()}
}
