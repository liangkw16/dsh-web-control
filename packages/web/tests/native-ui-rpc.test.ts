import { expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dispatchRead, openRead } from '../src/native-ui/read-routes.ts'
import { ProtocolError, type Json } from '../../protocol/src/index.ts'
const signal = new AbortController().signal
const golden = JSON.parse(readFileSync(new URL('../../plugin/tests/fixtures/session-opening-rc2.json', import.meta.url), 'utf8'))
test('unknown endpoint, channel, extra fields and foreign addresses never reach transport', async () => {
  const transport = { call: vi.fn(), watch: vi.fn() }
  for (const [channel, endpoint, payload] of [['/api','credentials/describe',{args:{}}], ['/other','session/list',{args:{_request:{}}}], ['/api','session/list',{args:{_request:{},secret:'x'}}], ['/api','session/page',{args:{request:{address:{kind:'subagent',childSessionId:'s'},throughSeq:1}}}]]) {
    expect((await dispatchRead(transport, channel as string, endpoint as string, payload, signal)).ok).toBe(false)
  }
  expect(transport.call).not.toHaveBeenCalled(); expect(transport.watch).not.toHaveBeenCalled()
})
test('native null-prototype args are accepted while getters/prototypes are refused without execution', async () => {
  const transport = { call: vi.fn(async () => ({records:[],hasMore:false})), watch: vi.fn() }
  const args = Object.assign(Object.create(null), { request: { address: { kind:'session', sessionId:'s' }, throughSeq:4 } })
  expect((await dispatchRead(transport,'/api','session/page',{args},signal)).ok).toBe(true)
  let reads=0
  const bad=Object.defineProperty({},'args',{enumerable:true,get(){reads++;return args}})
  expect((await dispatchRead(transport,'/api','session/page',bad,signal)).ok).toBe(false)
  expect((await dispatchRead(transport,'/api','session/page',Object.create({args}),signal)).ok).toBe(false)
  expect(reads).toBe(0); expect(transport.call).toHaveBeenCalledTimes(1)
})
test('page preserves original opening cursor, optional before and turn minima; errors have native details', async () => {
  const transport = { call: vi.fn(async () => ({records:[],hasMore:true})), watch: vi.fn() }
  const request = { address:{kind:'session',sessionId:'s'}, throughSeq:100, beforeSeq:50, maxMessages:32,turnWindow:{minMessages:8,minTurns:2} }
  expect(await dispatchRead(transport,'/api','session/page',{args:{request}},signal)).toEqual({ok:true,value:{records:[],hasMore:true}})
  expect(transport.call).toHaveBeenCalledWith({op:'session.page',sessionId:'s',throughSeq:100,beforeSeq:50,maxMessages:32,turnWindow:{minMessages:8,minTurns:2}},signal)
  transport.call.mockRejectedValueOnce(new ProtocolError('OUT_OF_SCOPE'))
  expect(await dispatchRead(transport,'/api','session/page',{args:{request}},signal)).toEqual({ok:false,error:{code:'OUT_OF_SCOPE',message:'OUT_OF_SCOPE',details:{}}})
})
test('follow keeps exact native assistant revisions and records, excluding remote stop tokens', async () => {
  const delta={type:'assistant-stream',frame:{type:'start',attemptId:'a',revision:1,startedAfterSeq:2,turn:0,step:0}}
  const transport={call:vi.fn(),watch:vi.fn(async function*(_watch: unknown, _signal: AbortSignal): AsyncIterable<Json>{yield {kind:'dsh',value:golden};yield {kind:'stop-token',sessionId:golden.header.id,token:'stop'};yield {kind:'dsh',value:delta}})}
  const request={address:{kind:'session',sessionId:golden.header.id},assistantStream:true,maxMessages:32,turnWindow:{minMessages:8,minTurns:2}}
  const frames=[];for await(const frame of openRead(transport,'/api','session/follow',{args:{request}},signal)) frames.push(frame)
  expect(frames).toEqual([golden,delta]);expect(transport.watch.mock.calls[0]).toEqual([{topic:'session',sessionId:golden.header.id,maxMessages:32,turnWindow:request.turnWindow},signal])
})
test('list joins only selected workspace lists and disposes the temporary baseline watch', async () => {
  let closed=false
  const transport={call:vi.fn(async ()=>({items:[{sessionId:'s'}]})),watch:vi.fn(async function*(_watch:unknown,linked:AbortSignal){try{yield {kind:'dsh',value:{type:'baseline',value:{items:[{workspaceId:'w'}],archivedSessionIds:[],pinnedSessionIds:[]}}} as Json;await new Promise(r=>linked.addEventListener('abort',r,{once:true}))}finally{closed=true}})}
  expect(await dispatchRead(transport,'/api','session/list',{args:{_request:{}}},signal)).toEqual({ok:true,value:{items:[{sessionId:'s'}]}})
  expect(transport.call).toHaveBeenCalledWith({op:'session.list',workspaceId:'w'},signal);expect(closed).toBe(true)
})

test('an oversized turn opening is completed with cursor-bound pages before native rendering',async()=>{
  const event=(seq:number,type:string,data:Json)=>({type:'event',event:{seq,time:seq*1000,type,data}})
  const start=event(1,'turn/start',{turn:1}),end=event(71,'turn/end',{turn:1,reason:{kind:'completed'}})
  const snapshot={...golden,cursor:71,hasMore:true,records:[event(70,'assistant/message',{turn:1}),end]}
  const transport={call:vi.fn(async()=>({records:[start,event(2,'step/start',{turn:1,step:0})],hasMore:false})),watch:vi.fn(async function*(){yield {kind:'dsh',value:snapshot} as Json})}
  const frames=[];for await(const f of openRead(transport,'/api','session/follow',{args:{request:{address:{kind:'session',sessionId:golden.header.id}}}},signal))frames.push(f)
  expect(frames).toEqual([{...snapshot,hasMore:false,records:[start,event(2,'step/start',{turn:1,step:0}),...snapshot.records]}])
  expect(transport.call).toHaveBeenCalledWith({op:'session.page',sessionId:golden.header.id,throughSeq:71,beforeSeq:70,maxMessages:64},signal)
})

test('supplemental turn pages are bounded, abortable, and reject a non-decreasing cursor',async()=>{
  const record=(seq:number)=>({type:'event',event:{seq,time:seq,type:'assistant/message',data:{turn:1}}})
  const opening={...golden,cursor:100,hasMore:true,records:[record(100)]}
  const transport={call:vi.fn(async(command:any)=>({records:[record(command.beforeSeq-1)],hasMore:true})),watch:vi.fn(async function*(){yield {kind:'dsh',value:opening} as Json})}
  const read=async(s=signal)=>{const frames=[];for await(const f of openRead(transport,'/api','session/follow',{args:{request:{address:{kind:'session',sessionId:golden.header.id}}}},s))frames.push(f);return frames as any[]}
  expect((await read())[0].records).toHaveLength(17)
  expect(transport.call).toHaveBeenCalledTimes(16)
  transport.call.mockImplementationOnce(async()=>({records:[record(100)],hasMore:true}))
  await expect(read()).rejects.toMatchObject({code:'INVALID_MESSAGE'})
  const life=new AbortController()
  transport.call.mockImplementationOnce(async()=>{life.abort();return{records:[record(99)],hasMore:true}})
  await expect(read(life.signal)).rejects.toBeDefined()
})

test.each([null,[], 'ignored',42])('ignorable event JSON data %j cannot break opening completion',async data=>{
  const start={type:'event',event:{seq:1,time:1,type:'turn/start',data:{turn:1}}}
  const unknown={type:'event',event:{seq:3,time:3,type:'extension/event',data,ignorable:true}}
  const end={type:'event',event:{seq:4,time:4,type:'turn/end',data:{turn:1}}}
  const opening={...golden,cursor:4,hasMore:true,records:[unknown,end]}
  const transport={call:vi.fn(async()=>({records:[start],hasMore:false})),watch:vi.fn(async function*(){yield {kind:'dsh',value:opening} as Json})}
  const frames=[];for await(const f of openRead(transport,'/api','session/follow',{args:{request:{address:{kind:'session',sessionId:golden.header.id}}}},signal))frames.push(f)
  expect(frames).toEqual([{...opening,hasMore:false,records:[start,unknown,end]}])
})
