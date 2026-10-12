import workerUrl from './media-worker.ts?worker&url'
import { NativeFileMedia } from './file-media.ts'
import type { BrowserTransport } from '../transport.ts'
/** Only the finite stock media endpoint is intercepted. No fetch cache or Relay
 * file route exists; a closed page has no authority to answer a worker request. */
export async function installNativeMedia(transport:BrowserTransport):Promise<{media:NativeFileMedia;dispose():void}>{
  const media=new NativeFileMedia(transport),workers=navigator.serviceWorker
  const listener=(event:MessageEvent)=>{
    if(event.source!==workers.controller||event.origin!==location.origin||event.data?.type!=='native-file-media'||typeof event.data.path!=='string'||event.ports.length!==1)return
    media.respond(event.data.path,event.ports[0])
  }
  workers.addEventListener('message',listener)
  try{
    const script=new URL(workerUrl,location.origin).href
    await workers.register(script,{scope:'/connect/'})
    if(workers.controller?.scriptURL!==script)await new Promise<void>((resolve,reject)=>{
      const done=()=>{if(workers.controller?.scriptURL===script){cleanup();resolve()}}
      const timer=setTimeout(()=>{cleanup();reject(new Error('Native media transport unavailable'))},10000)
      const cleanup=()=>{clearTimeout(timer);workers.removeEventListener('controllerchange',done)}
      workers.addEventListener('controllerchange',done);done()
    })
    return {media,dispose:()=>{workers.removeEventListener('message',listener);media.dispose()}}
  }catch(error){workers.removeEventListener('message',listener);media.dispose();throw error}
}
