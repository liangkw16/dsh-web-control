import {expect,test,vi} from 'vitest'
import {NativeUploads} from '../src/native-ui/upload-routes.ts'
const action=()=>({signal:new AbortController().signal})
test('owned upload hook preserves bytes and receipt scope through asynchronous stream input',async()=>{
  const chunks=[new Uint8Array([1,2]),new Uint8Array([3])],upload=vi.fn(async(_id:string,file:File)=>{expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1,2,3]);return {receiptId:'r',file:{attachmentId:'a',name:'bytes.bin',bytes:3}}}),owner=new NativeUploads({upload},action)
  const body=new ReadableStream({async pull(c){await Promise.resolve();const next=chunks.shift();if(next)c.enqueue(next);else c.close()}})
  const result=await owner.fetch('api/session/uploadFileBinary?sessionId=s&name=bytes.bin',{method:'POST',body,duplex:'half'} as RequestInit)
  expect(await result.json()).toMatchObject({ok:true,value:{receiptId:'r'}})
  expect(await owner.content('s',[{type:'file',receiptId:'r'}],new AbortController().signal)).toEqual([{kind:'upload',receiptId:'r',name:'bytes.bin',mediaType:'application/octet-stream'}])
  await expect(owner.content('other',[{type:'file',receiptId:'r'}],new AbortController().signal)).rejects.toThrow('OUT_OF_SCOPE')
  await owner.dispose()
})
test('aborting a blocked native upload cancels its source, sends no prompt/stop and cannot retain a receipt',async()=>{
  const upload=vi.fn(),owner=new NativeUploads({upload},action),cancel=vi.fn(),controller=new AbortController()
  const body=new ReadableStream({pull(){return new Promise(()=>{})},cancel})
  const pending=owner.fetch('api/session/uploadFileBinary?sessionId=s',{method:'POST',body,signal:controller.signal});controller.abort()
  await expect(pending).rejects.toThrow();await owner.dispose();expect(cancel).toHaveBeenCalled();expect(upload).not.toHaveBeenCalled()
})
test('inline image becomes a scoped receipt and never rides in a JSON prompt',async()=>{
  const upload=vi.fn(async(_id:string,file:File)=>({receiptId:'image',file:{attachmentId:'a',name:file.name,bytes:file.size}})),owner=new NativeUploads({upload},action)
  const content=await owner.content('s',[{type:'image',mediaType:'image/png',data:'AQID',name:'picture.png'}],new AbortController().signal)
  expect(content).toEqual([{kind:'upload',receiptId:'image',name:'picture.png',mediaType:'image/png'}]);expect(JSON.stringify(content)).not.toContain('AQID')
  await expect(owner.fetch('https://foreign.test/api/session/uploadFileBinary?sessionId=s',{method:'POST',body:new Blob()})).rejects.toThrow();await owner.dispose()
})
