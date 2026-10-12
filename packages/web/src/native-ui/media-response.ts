/** Service-worker response: one credited 64 KiB range at a time, no body cache. */
export async function mediaResponse(request:Request,post:(port:MessagePort)=>void):Promise<Response>{
  const channel=new MessageChannel(),port=channel.port1
  let stopped=false,received=0,total=0,controller:ReadableStreamDefaultController<Uint8Array>|undefined
  let timer:ReturnType<typeof setTimeout>,pull:(()=>void)|undefined
  let metadata!:(value:{bytes:number;mime:string}|undefined)=>void
  const ready=new Promise<{bytes:number;mime:string}|undefined>(resolve=>{metadata=resolve})
  const stop=(error=false)=>{
    if(stopped)return;stopped=true;clearTimeout(timer);request.signal.removeEventListener('abort',abort)
    port.postMessage({type:'cancel'});port.close();metadata(undefined)
    if(error)controller?.error(new Error('File media unavailable'))
    pull?.();pull=undefined
  }
  const abort=()=>stop(true),progress=()=>{clearTimeout(timer);timer=setTimeout(abort,35000)}
  port.onmessage=event=>{
    const value=event.data
    if(value?.type==='meta'&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=32*1024*1024&&/^image\/(?:png|jpeg|gif|webp|avif|svg\+xml)$/.test(value.mime)){
      total=value.bytes;metadata(value);progress();return
    }
    if(value?.type!=='chunk'||!controller||!pull||!(value.bytes instanceof ArrayBuffer)||value.bytes.byteLength>65536||received+value.bytes.byteLength>total){abort();return}
    received+=value.bytes.byteLength
    if(value.done!==(received===total)){abort();return}
    controller.enqueue(new Uint8Array(value.bytes));pull();pull=undefined
    if(value.done){controller.close();stop()}else progress()
  }
  port.onmessageerror=abort;port.start();progress();request.signal.addEventListener('abort',abort,{once:true})
  if(request.signal.aborted)abort();else post(channel.port2)
  const meta=await ready
  if(!meta||stopped)return new Response(null,{status:404,headers:{'Cache-Control':'no-store'}})
  const body=new ReadableStream<Uint8Array>({
    start(value){controller=value},
    pull(){return new Promise<void>(resolve=>{if(stopped){resolve();return}pull=resolve;port.postMessage({type:'pull'});progress()})},
    cancel(){stop()},
  },{highWaterMark:0})
  return new Response(body,{headers:{'Content-Type':meta.mime,'Content-Length':String(meta.bytes),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})
}
