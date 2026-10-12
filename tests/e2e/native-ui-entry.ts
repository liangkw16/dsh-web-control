import { BrowserTransport } from '../../packages/web/src/transport.ts'
import { startRemotePage } from '../../packages/web/src/entry.ts'
import { bindPageLifecycle } from '../../packages/web/src/page-lifecycle.ts'
import { ProtocolError } from '../../packages/protocol/src/index.ts'
import '../../packages/web/src/entry.css'
void (async()=>{
  const calls:{op:string;outcome:string}[]=[]
  const largeFrames:{op:string;bytes:number}[]=[]
  const recordLarge=(op:string,value:unknown)=>{const bytes=new TextEncoder().encode(JSON.stringify(value)).byteLength;if(bytes>256*1024)largeFrames.push({op,bytes})}
  Object.assign(globalThis,{__nativeFixtureLargeFrames__:largeFrames})
  Object.assign(globalThis,{__nativeFixtureCalls__:calls})
  let releaseUpload:(()=>void)|undefined,uploadGate:Promise<void>|undefined,lastPrompt:any,releaseDownload:(()=>void)|undefined,downloadGate:Promise<void>|undefined
  const faults={dropPromptAck:false,uploadWaiting:false,downloadWaiting:false,downloadAborted:false,holdDownloads(){this.downloadWaiting=false;this.downloadAborted=false;downloadGate=new Promise(resolve=>{releaseDownload=resolve})},releaseDownloads(){releaseDownload?.();downloadGate=undefined},holdUploads(){uploadGate=new Promise(resolve=>{releaseUpload=resolve})},releaseUploads(){releaseUpload?.();uploadGate=undefined}}
  const socketSend=WebSocket.prototype.send,heldCredits:{socket:WebSocket,data:string,id:string}[]=[]
  faults.releaseDownloads=()=>{releaseDownload?.();downloadGate=undefined;for(const item of heldCredits.splice(0)){if(item.socket.readyState===WebSocket.OPEN)socketSend.call(item.socket,item.data);else faults.downloadAborted=true}}
  WebSocket.prototype.send=function(data){if(typeof data==='string'){let frame:any;try{frame=JSON.parse(data)}catch{};if(frame?.type==='cancel'&&heldCredits.some(item=>item.id===frame.id))faults.downloadAborted=true;if(frame?.type==='download.credit'&&downloadGate){heldCredits.push({socket:this,data,id:frame.id});faults.downloadWaiting=true;return}}return socketSend.call(this,data)}
  Object.assign(globalThis,{__nativeFixtureFaults__:faults})
  const prototype=BrowserTransport.prototype,originalCall=prototype.call,originalUpload=prototype.upload
  prototype.call=async function(...args){try{const result=await originalCall.apply(this,args);recordLarge(args[0].op,result);calls.push({op:args[0].op,outcome:'ok'});if(args[0].op==='session.prompt'&&faults.dropPromptAck){faults.dropPromptAck=false;throw new ProtocolError('RESULT_UNCERTAIN')}return result}catch(error){calls.push({op:args[0].op,outcome:String(error)});throw error}}
  prototype.upload=async function(...args){try{if(uploadGate){const file=args[1],slice=file.slice.bind(file);file.slice=(...range)=>{const chunk=slice(...range),arrayBuffer=chunk.arrayBuffer.bind(chunk);chunk.arrayBuffer=async()=>{faults.uploadWaiting=true;await uploadGate;return arrayBuffer()};return chunk}}return await originalUpload.apply(this,args)}catch(error){calls.push({op:'upload',outcome:String(error)});throw error}}
  const originalWatch=prototype.watch
  prototype.watch=async function*(...args){const op=`watch:${args[0].topic}`;calls.push({op,outcome:'open'});try{for await(const value of originalWatch.apply(this,args)){recordLarge(op,value);const frame=value as any;if(['interactions-ready','stop-token'].includes(frame.kind)||['baseline','snapshot'].includes(frame.value?.type))calls.push({op,outcome:frame.value?.type??frame.kind});yield value}}catch(error){calls.push({op,outcome:String(error)});throw error}finally{calls.push({op,outcome:'closed'})}}
  const container=document.getElementById('root')!,starting=startRemotePage({href:location.href,container,fetch,storage:localStorage})
  bindPageLifecycle(window,container,starting,()=>location.reload())
  const owner=await starting
  const rpc=(globalThis as any).__DSH_TRANSPORT__.rpc,call=rpc.call.bind(rpc)
  rpc.call=async(...args:any[])=>{if(args[1]==='session/prompt')lastPrompt=structuredClone(args.slice(0,3));const result=await call(...args);calls.push({op:`rpc:${args[1]}`,outcome:result.ok?'ok':JSON.stringify(result.error)});return result}
  Object.assign(globalThis,{__nativeFixtureRetryPrompt__:()=>call(...lastPrompt)})
  // Fixture-owned public lifecycle handle; never inspect the stock runtime.
  Object.assign(globalThis,{__nativeFixtureOwner__:owner})
})().catch(error=>{Object.assign(globalThis,{__nativeFixtureBootError__:String(error)});document.getElementById('root')!.textContent=String(error)})
