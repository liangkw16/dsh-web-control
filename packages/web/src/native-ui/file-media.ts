import { DEFAULT_LIMITS, parseCurrentFileStat } from '../../../protocol/src/index.ts'
import type { BrowserTransport } from '../transport.ts'
interface Owner { sessionId:string; path:string; refs:number; life:AbortController }
const types:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',svg:'image/svg+xml'}
/** Transport for stock Markdown's api/file image URLs. Authority comes only from
 * public document seats and the Host's contained file service, never from a URL. */
export class NativeFileMedia {
  private owners=new Map<string,Owner>()
  private pending=new Set<()=>void>()
  private queue:(()=>void)[]=[]
  private active=0
  private fence:string
  private unsubscribe:()=>void
  constructor(private readonly transport:Pick<BrowserTransport,'call'|'readFileRange'|'getSnapshot'|'subscribe'>){
    this.fence=JSON.stringify(transport.getSnapshot().fence)
    this.unsubscribe=transport.subscribe(()=>{
      const state=transport.getSnapshot(),fence=JSON.stringify(state.fence)
      if(state.phase!=='ready'||fence!==this.fence){this.fence=fence;this.cancelAll()}
    })
  }
  retain(sessionId:string,path:string):()=>void{
    if(!sessionId||!path?.startsWith('/'))return()=>{}
    const key=JSON.stringify([sessionId,path]),owner=this.owners.get(key)??{sessionId,path,refs:0,life:new AbortController()}
    owner.refs++;this.owners.set(key,owner)
    return()=>{if(--owner.refs===0){owner.life.abort();this.owners.delete(key)}}
  }
  respond(path:string,port:MessagePort):void{
    const mime=types[path.split('.').at(-1)?.toLowerCase()??'']
    const candidates=[...this.owners.values()],owner=candidates.sort((a,b)=>b.path.lastIndexOf('/')-a.path.lastIndexOf('/')).find(o=>path.startsWith(o.path.slice(0,o.path.lastIndexOf('/')+1)))??candidates.at(-1)
    if(!mime||!owner||path.length>4096||this.pending.size>=32||this.transport.getSnapshot().phase!=='ready'){
      port.postMessage({type:'error'});port.close();return
    }
    const life=new AbortController(),signal=life.signal
    let ended=false,admitted=false,busy=false,offset=0,timer:ReturnType<typeof setTimeout>,stat:{relativePath:string;version:string;bytes:number}|undefined
    const finish=(error=true)=>{
      if(ended)return;ended=true;life.abort();clearTimeout(timer);owner.life.signal.removeEventListener('abort',cancel)
      if(error)port.postMessage({type:'error'});port.close();this.pending.delete(cancel)
      const index=this.queue.indexOf(start);if(index>=0)this.queue.splice(index,1)
      if(admitted){this.active--;this.queue.shift()?.()}
    }
    const cancel=()=>finish(),progress=()=>{clearTimeout(timer);timer=setTimeout(cancel,30000)}
    const start=()=>{
      if(ended)return;admitted=true;this.active++
      void (async()=>{
        const directory=owner.path.slice(0,owner.path.lastIndexOf('/')+1)
        const relative=path.startsWith(directory)?path.slice(directory.length):path
        const result=parseCurrentFileStat(await this.transport.call({op:'file.stat',sessionId:owner.sessionId,path:relative,baseFile:owner.path},signal))
        signal.throwIfAborted()
        if(!result.ok||result.value.bytes>DEFAULT_LIMITS.fileBytes)throw new Error('Unavailable media')
        stat=result.value;port.postMessage({type:'meta',bytes:stat.bytes,mime});progress()
      })().catch(cancel)
    }
    this.pending.add(cancel);owner.life.signal.addEventListener('abort',cancel,{once:true});progress()
    port.onmessage=event=>{
      if(event.data?.type==='cancel'){finish(false);return}
      if(event.data?.type!=='pull'||!stat||busy||ended){cancel();return}
      busy=true;progress()
      void (async()=>{
        const length=Math.min(65536,stat!.bytes-offset)
        const result=await this.transport.readFileRange({sessionId:owner.sessionId,path:stat!.relativePath,version:stat!.version,offset,length},signal)
        signal.throwIfAborted()
        if(result.metadata.offset!==offset||result.metadata.bytes!==length||result.blob.size!==length||result.metadata.eof!==(offset+length===stat!.bytes))throw new Error('Invalid media range')
        const bytes=await result.blob.arrayBuffer();signal.throwIfAborted();offset+=length
        port.postMessage({type:'chunk',bytes,done:offset===stat!.bytes},[bytes]);busy=false
        if(offset===stat!.bytes)finish(false);else progress()
      })().catch(cancel)
    }
    port.onmessageerror=cancel;port.start()
    if(this.active<2)start();else this.queue.push(start)
  }
  private cancelAll(){this.queue=[];for(const cancel of this.pending)cancel()}
  dispose(){this.unsubscribe();this.cancelAll();for(const owner of this.owners.values())owner.life.abort();this.owners.clear()}
}
