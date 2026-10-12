import {expect,test} from 'vitest'
import {NativeCleanup} from '../src/native-ui/cleanup.ts'
test('cleanup drains every owned resource after a native disposer fails and concurrent callers await the same drain',async()=>{
  const clean=new NativeCleanup(),stages:string[]=[],gate=Promise.withResolvers<void>()
  clean.add(async()=>{stages.push('native');await gate.promise;throw new Error('native failed')})
  clean.add(()=>{stages.push('carrier')})
  const first=clean.dispose(),second=clean.dispose()
  expect(first).toBe(second);expect(stages).toEqual(['native'])
  gate.resolve();await expect(first).rejects.toThrow(/cleanup/i)
  expect(stages).toEqual(['native','carrier'])
  await expect(clean.dispose()).rejects.toThrow(/cleanup/i)
})
