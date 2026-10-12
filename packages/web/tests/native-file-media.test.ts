import { test, expect, vi } from 'vitest'
import { NativeFileMedia } from '../src/native-ui/file-media.ts'
import { mediaResponse } from '../src/native-ui/media-response.ts'
import type { BrowserTransport } from '../src/transport.ts'
function fixture() {
  const bytes = new Uint8Array(150000).fill(7), listeners = new Set<() => void>()
  const call = vi.fn(async () => ({ ok: true, value: { absolutePath:'/w/image.png',relativePath:'image.png',bytes:bytes.length,version:'v1' } }))
  const readFileRange = vi.fn(async (args:any) => ({ blob: new Blob([bytes.slice(args.offset,args.offset+args.length)]),metadata:{offset:args.offset,bytes:args.length,eof:args.offset+args.length===bytes.length} }))
  let state:any = {phase:'ready',fence:{controlId:'a'}}
  const media = new NativeFileMedia({call,readFileRange,getSnapshot:()=>state,subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)}} as unknown as BrowserTransport)
  const close = media.retain('s','/w/docs/a.md')
  const request = (path='/w/docs/../image.png') => mediaResponse(new Request('https://relay.test/connect/api/file?path='+encodeURIComponent(path)), port=>media.respond(path,port))
  return {media,close,request,call,readFileRange,bytes,revoke:()=>{state={phase:'offline'};for(const fn of listeners)fn()}}
}
test('stock media URL streams exact bounded versioned ranges through the owning document scope',async()=>{
  const f=fixture()
  try {
    const response=await f.request()
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.bytes)
    expect((f.call.mock.calls[0] as unknown[])[0]).toMatchObject({op:'file.stat',sessionId:'s',path:'../image.png',baseFile:'/w/docs/a.md'})
    expect(f.readFileRange.mock.calls.map(([args])=>[args.offset,args.length,args.version])).toEqual([[0,65536,'v1'],[65536,65536,'v1'],[131072,18928,'v1']])
  } finally {f.close();f.media.dispose()}
})
test.each(['close','revoke'] as const)('media %s aborts an unread response and does not read a body',async action=>{
  const f=fixture()
  try {
    const response=await f.request();f[action]()
    await expect(response.arrayBuffer()).rejects.toThrow()
    expect(f.readFileRange).not.toHaveBeenCalled()
  } finally {f.media.dispose()}
})
test('media refuses unknown types, missing owners, and Host-denied outside paths',async()=>{
  const f=fixture()
  try {
    expect((await f.request('/w/secret.txt')).status).toBe(404)
    expect(f.call).not.toHaveBeenCalled()
    f.call.mockResolvedValue({ok:false,code:'outside'} as any)
    expect((await f.request('/elsewhere/private.png')).status).toBe(404)
    expect(f.readFileRange).not.toHaveBeenCalled()
    f.close();expect((await f.request()).status).toBe(404)
  } finally {f.media.dispose()}
})
test('media never returns a successful mixed-version body',async()=>{
  const f=fixture()
  try {
    const read=f.readFileRange.getMockImplementation()!
    f.readFileRange.mockImplementationOnce(read).mockRejectedValueOnce(new Error('changed'))
    const response=await f.request(),reader=response.body!.getReader()
    expect((await reader.read()).value).toHaveLength(65536)
    await expect(reader.read()).rejects.toThrow()
    expect(f.readFileRange).toHaveBeenCalledTimes(2)
  } finally {f.close();f.media.dispose()}
})
test('slow media consumers hold at most two slots and cancelling one admits the next',async()=>{
  const f=fixture()
  try{
    const one=await f.request(),two=await f.request(),pending=f.request()
    await new Promise(resolve=>setTimeout(resolve,20));expect(f.call).toHaveBeenCalledTimes(2)
    expect(f.readFileRange).not.toHaveBeenCalled()
    await one.body!.cancel();const three=await pending
    expect(three.status).toBe(200);expect(f.call).toHaveBeenCalledTimes(3)
    await two.body!.cancel();await three.body!.cancel()
  }finally{f.close();f.media.dispose()}
})
