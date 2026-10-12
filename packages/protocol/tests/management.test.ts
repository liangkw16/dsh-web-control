import { expect, test } from 'vitest'
import { DEFAULT_LIMITS, parseController, hostUiProfileFromCapabilities, parseHostUiProfile, RC2_UI_PROFILE, NATIVE_UI_MARKER } from '../src/index.ts'
const id = '11111111-1111-4111-8111-111111111111'
const call = (action: unknown) => parseController(JSON.stringify({v:1,type:'call',id,fence:{instanceId:id,runtimeId:id,controlId:id,authEpoch:1},command:{op:'ui.manage',action}}), DEFAULT_LIMITS)
test('management is a finite strict set of native actions', () => {
  for(const action of [
    {kind:'session.rename',sessionId:'s',title:'new'}, {kind:'session.fork',sessionId:'s',atSeq:0},
    {kind:'workspace.rename',workspaceId:'w',title:'new'}, {kind:'workspace.delete',workspaceId:'w'},
    {kind:'workspace.insertBefore',workspaceId:'w',beforeWorkspaceId:'v'},
    ...['archiveSession','unarchiveSession','pinSession','unpinSession'].map(k=>({kind:'workspace.'+k,sessionId:'s'})),
    {kind:'workspace.archiveSession',sessionId:'s',stopActivity:true},
  ]) expect(call(action)).toHaveProperty('command.action', action)
  for(const action of [{kind:'exec',command:'rm'}, {kind:'workspace.create',path:'/tmp'}, {kind:'session.fork',sessionId:'s',atSeq:-1}, {kind:'workspace.unarchiveSession',sessionId:'s',stopActivity:true}, {kind:'session.rename',sessionId:'s',title:''}, {kind:'workspace.delete',workspaceId:'w',deleteFiles:true}]) expect(()=>call(action)).toThrow()
})
test('new hosts advertise management explicitly; baseline hosts stay compatible', () => {
  const capabilities=[...RC2_UI_PROFILE.capabilities,'workspace-management']
  expect(parseHostUiProfile({...RC2_UI_PROFILE,capabilities}).capabilities).toEqual(capabilities)
  expect(hostUiProfileFromCapabilities([...capabilities,NATIVE_UI_MARKER])?.capabilities).toEqual(capabilities)
  expect(hostUiProfileFromCapabilities([...RC2_UI_PROFILE.capabilities,NATIVE_UI_MARKER])).toEqual(RC2_UI_PROFILE)
  expect(()=>parseHostUiProfile({...RC2_UI_PROFILE,capabilities:[...capabilities,'exec']})).toThrow()
})
