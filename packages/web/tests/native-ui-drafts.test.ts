import {expect,test,vi} from 'vitest'
import {DraftStore} from '../src/drafts.ts'
import {NativeDraftBinding} from '../src/native-ui/draft-binding.ts'
function fixture(blocked=false){
  const data=new Map<string,string>(),storage={getItem:(k:string)=>{if(blocked)throw new Error('blocked');return data.get(k)??null},setItem:(k:string,v:string)=>{if(blocked)throw new Error('blocked');data.set(k,v)}} as Storage
  const store=new DraftStore(storage),binding=new NativeDraftBinding('instance',store)
  return{store,binding,data,storage}
}
function input(){
  let value={draft:'',draftRev:0,phase:'plain' as 'plain'|'adjudicating'|'submitting'};const listeners=new Set<()=>void>()
  const change=(draft:string,phase=value.phase)=>{value={draft,draftRev:value.draftRev+Number(draft!==value.draft),phase};for(const f of listeners)f()}
  return{state:{getSnapshot:()=>value,subscribe:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f)}},setDraft:(s:string)=>change(s),change}
}
test('old text imports into the original input and optimistic clearing retains it until acknowledged',()=>{
  const f=fixture(),a=input();f.store.write('instance','s','saved');f.binding.bind('s',a)
  expect(a.state.getSnapshot().draft).toBe('saved')
  a.change('saved','adjudicating');a.change('','plain')
  const done=f.binding.submission('s','request-1')
  expect(f.store.read('instance','s')).toBe('saved')
  a.change('new draft');done(true)
  expect(a.state.getSnapshot().draft).toBe('new draft');expect(f.store.read('instance','s')).toBe('new draft')
  f.binding.dispose();expect(new DraftStore(f.storage).read('instance','s')).toBe('new draft')
})
test('uncertain result, switch and replacement retain draft, manual deletion remains a real deletion',()=>{
  const f=fixture(),a=input(),b=input();f.binding.bind('a',a);a.change('pending');a.change('pending','adjudicating');a.change('','plain')
  const done=f.binding.submission('a','request-a');f.binding.bind('b',b);b.change('other');done(false)
  expect(f.store.read('instance','a')).toBe('pending');expect(b.state.getSnapshot().draft).toBe('other')
  f.binding.dispose();const restored=input(),next=new NativeDraftBinding('instance',new DraftStore(f.storage));next.bind('a',restored)
  expect(restored.state.getSnapshot().draft).toBe('pending');restored.change('');expect(new DraftStore(f.storage).read('instance','a')).toBe('');next.dispose()
})
test('storage rejection leaves editing usable, old request cannot capture a newer draft on retry',()=>{
  const f=fixture(true),a=input();f.binding.bind('s',a);a.change('first');const old=f.binding.submission('s','same')
  a.change('second');const retry=f.binding.submission('s','same');old(true);retry(true)
  expect(f.store.read('instance','s')).toBe('second');expect(f.store.persistenceWarning).toBe(true);f.binding.dispose()
})
test('uncertain draft references are bounded and confirmed rejection frees capacity without clearing text',()=>{
  const f=fixture(),a=input();f.binding.bind('s',a);a.change('keep')
  const pending=Array.from({length:128},(_,i)=>f.binding.submission('s','r'+i))
  for(const done of pending)done(false)
  expect(()=>f.binding.submission('s','overflow')).toThrow('BACKPRESSURE')
  pending[0](false,true)
  expect(()=>f.binding.submission('s','after-rejection')).not.toThrow()
  expect(f.store.read('instance','s')).toBe('keep')
})
test('published submission echo captures before a plain-phase optimistic clear and deferred RPC',()=>{
  const f=fixture(),a=input(),listeners=new Set<()=>void>();let pending:{requestId:string}[]=[]
  const source={getSnapshot:()=>({pendingSubmissions:pending}),subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn)}}
  f.binding.bind('s',a,source);a.change('original draft')
  pending=[{requestId:'early'}];for(const fn of listeners)fn()
  a.change('','plain')
  expect(f.store.read('instance','s')).toBe('original draft')
  a.change('newer draft');const done=f.binding.submission('s','early');done(true)
  expect(f.store.read('instance','s')).toBe('newer draft')
  a.change('');expect(f.store.read('instance','s')).toBe('')
  f.binding.dispose();expect(listeners.size).toBe(0)
})
test('abandoned pre-RPC echoes release capacity and never clear persisted text',()=>{
  const f=fixture(),a=input(),listeners=new Set<()=>void>();let pending:{requestId:string}[]=[]
  f.binding.bind('s',a,{getSnapshot:()=>({pendingSubmissions:pending}),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}});a.change('keep')
  for(let i=0;i<270;i++){
    pending=[{requestId:'abandoned-'+i}];for(const fn of listeners)fn()
    pending=[];for(const fn of listeners)fn()
  }
  expect(()=>f.binding.submission('s','new')).not.toThrow()
  expect(f.store.read('instance','s')).toBe('keep')
})
