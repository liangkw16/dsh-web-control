import { expect,test,vi } from 'vitest'
import { NativeInteractions } from '../src/native-ui/interaction-routes.ts'
const signal=new AbortController().signal
const event={kind:'interaction',sessionId:'s',deliveryId:'host-delivery',event:'approval/request',request:{toolName:'test',reason:'fixture'}}
test('native event identities map to one current delivery, no Host IDs are accepted',async()=>{
  const call=vi.fn(async(_command: unknown)=>({accepted:true})),events=new NativeInteractions(call)
  const ready=events.begin({home:'/fixture'}),frame=events.accept(event) as any
  expect(frame.eventId).not.toBe('host-delivery')
  expect((await events.answer({args:{clientId:'host-client',eventId:'host-delivery',outcome:{kind:'result',value:'allowed-once'}}},signal)).ok).toBe(false)
  expect((await events.answer({args:{clientId:ready.clientId,eventId:frame.eventId,outcome:{kind:'result',value:'allowed-once'}}},signal)).ok).toBe(true)
  expect(call).toHaveBeenCalledExactlyOnceWith({op:'interaction.answer',deliveryId:'host-delivery',answer:'allowed-once'},signal)
})
test('local answer, old generation and unsupported approval values cannot submit',async()=>{
  const call=vi.fn(),events=new NativeInteractions(call),ready=events.begin({home:'/fixture'}),frame=events.accept(event) as any
  const reply=(value:string)=>events.answer({args:{clientId:ready.clientId,eventId:frame.eventId,outcome:{kind:'result',value}}},signal)
  expect((await reply('always-allow')).ok).toBe(false)
  expect(events.accept({kind:'interaction-cancel',deliveryId:'host-delivery'})).toEqual({type:'cancel',eventId:frame.eventId})
  expect((await reply('allowed-once')).ok).toBe(false)
  events.begin({home:'/fixture'});events.accept(event);expect((await reply('allowed-once')).ok).toBe(false);expect(call).not.toHaveBeenCalled()
})
test('delegation releases only the pending delivery and never fabricates an approval answer',async()=>{
  const call=vi.fn(async(_command: unknown)=>({accepted:true})),events=new NativeInteractions(call),ready=events.begin({home:'/fixture'}),frame=events.accept(event) as any
  expect((await events.answer({args:{clientId:ready.clientId,eventId:frame.eventId,outcome:{kind:'next'}}},signal)).ok).toBe(true)
  expect(call.mock.calls[0][0]).toEqual({op:'interaction.delegate',deliveryId:'host-delivery'})
})
