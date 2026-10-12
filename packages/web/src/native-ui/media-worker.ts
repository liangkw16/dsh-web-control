import { mediaResponse } from './media-response.ts'
const worker=globalThis as any
worker.addEventListener('install',(event:any)=>event.waitUntil(worker.skipWaiting()))
worker.addEventListener('activate',(event:any)=>event.waitUntil(worker.clients.claim()))
worker.addEventListener('fetch',(event:any)=>{
  const request=event.request as Request,url=new URL(request.url)
  if(url.origin!==worker.location.origin||!/^\/connect\/(?:[^/]+\/)?api\/file$/.test(url.pathname))return
  event.respondWith((async()=>{
    const denied=()=>new Response(null,{status:404,headers:{'Cache-Control':'no-store'}})
    const client=await worker.clients.get(event.clientId)
    if(request.method!=='GET'||request.destination!=='image'||!client||client.type!=='window'||client.frameType!=='top-level')return denied()
    const page=new URL(client.url)
    if(!/^\/connect\/[a-f0-9-]{36}\/?$/.test(page.pathname)||url.pathname!==new URL('api/file',page).pathname||[...url.searchParams.keys()].join(',')!=='path')return denied()
    const path=url.searchParams.get('path');if(!path||path.length>4096)return denied()
    return mediaResponse(request,port=>client.postMessage({type:'native-file-media',path},[port]))
  })())
})
