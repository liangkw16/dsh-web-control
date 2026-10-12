import {expect,test} from 'vitest'
import {NativeBlocks} from '../src/native-ui/blocks.ts'
test('authority loss disables the native root and composer; readiness restores only its own block',()=>{
  const values=new Map<string,{reason:string}>(),root={inert:false},previous={reason:'another plugin'}
  values.set('s',previous)
  const blocks=new NativeBlocks(root,{set:(id,value)=>{if(value)values.set(id,value);else values.delete(id)},storeFor:id=>({getSnapshot:()=>values.get(id)})})
  blocks.update(['s'],false,'正在重新连接');expect(root.inert).toBe(true);expect(values.get('s')?.reason).toBe('正在重新连接')
  blocks.update(['s'],true,'');expect(root.inert).toBe(false);expect(values.get('s')).toBe(previous)
  blocks.update(['s'],false,'被接管');values.set('s',{reason:'new owner'});blocks.dispose();expect(values.get('s')?.reason).toBe('new owner')
})
test('changing offline reason preserves an absent previous block',()=>{
  const values=new Map<string,{reason:string}>(),blocks=new NativeBlocks({inert:false},{set:(id,value)=>{if(value)values.set(id,value);else values.delete(id)},storeFor:id=>({getSnapshot:()=>values.get(id)})})
  blocks.update(['s'],false,'syncing');blocks.update(['s'],false,'offline');blocks.update(['s'],true,'')
  expect(values.has('s')).toBe(false)
})
