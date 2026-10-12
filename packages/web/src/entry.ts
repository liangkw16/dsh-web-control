import {BrowserAuthorization,readUiProfile} from './connect.ts'
import {BrowserTransport} from './transport.ts'
import {bootNativeUi,type UiArtifactManifest,type NativeUiInspection} from './native-ui/bootstrap.ts'
import {ProtocolError,validateId} from '../../protocol/src/index.ts'
const started=new WeakSet<HTMLElement>(),revision=/^[a-f0-9]{64}$/
interface ReleaseIndex{schema:1;native:{dshVersion:string;adapter:string;revision:string;manifest:string}[];legacy:{revision:string;html:string}}
/** A page selects once. Only its selected UI creates a controller. */
export async function startRemotePage(options:{href:string;container:HTMLElement;fetch:typeof fetch;storage:Storage}):Promise<{dispose():Promise<void>;inspection?:()=>NativeUiInspection}>{
 const {href,container,fetch:suppliedFetch,storage}=options
 const request:typeof fetch=(...args)=>suppliedFetch(...args)
 if(started.has(container))throw new ProtocolError('PROTOCOL_UNSUPPORTED')
 started.add(container)
 const url=new URL(href),match=/^\/connect\/([^/]+)\/?$/.exec(url.pathname)
 if(!match)throw new ProtocolError('AUTH_REQUIRED')
 const instanceId=match[1];validateId(instanceId)
 const view=container.ownerDocument.defaultView;if(!view)throw new ProtocolError('PROTOCOL_UNSUPPORTED')
 const authorization=new BrowserAuthorization({href,history:view.history,fetch:request})
 if(authorization.hasLink)await authorization.authorize(instanceId)
 const selected=await readUiProfile(instanceId,request)
 if(selected.kind==='unavailable')throw new ProtocolError(selected.code)
 const json=async(path:string)=>{const response=await request(path,{credentials:'same-origin',redirect:'error',cache:'no-store'});if(!response.ok)throw new ProtocolError('PROTOCOL_UNSUPPORTED');return response.json()}
 const release=await json('/ui-release.json') as ReleaseIndex
 if(release.schema!==1||!Array.isArray(release.native)||!release.legacy||!revision.test(release.legacy.revision))throw new ProtocolError('PROTOCOL_UNSUPPORTED')
 if(selected.kind==='legacy'){
  // Frozen compat.5 exports no unmount handle. A same-origin, same-instance child
  // document gives it a public unload lifecycle without changing its JS bytes.
  const frame=container.ownerDocument.createElement('iframe');frame.title='DSH 远程会话';frame.className='remote-legacy-frame';frame.src=`/connect/${instanceId}?legacy=${release.legacy.revision}`
  container.replaceChildren(frame)
  let disposed=false,checking=false
  const dispose=async()=>{if(disposed)return;disposed=true;view.clearInterval(timer);frame.remove()}
  const timer=view.setInterval(()=>{if(checking||disposed)return;checking=true;void readUiProfile(instanceId,request).then(current=>{
   if(disposed||current.kind==='unavailable')return
   if(current.kind!=='legacy'||current.runtimeId!==selected.runtimeId){void dispose();const notice=container.ownerDocument.createElement('p');notice.className='remote-entry-message';notice.textContent='主机会话环境已更新，请刷新页面重新连接。';container.replaceChildren(notice)}
  }).catch(()=>{}).finally(()=>{checking=false})},2000)
  return{dispose}
 }
 const ui=release.native.find(row=>row.dshVersion===selected.profile.host.dshVersion&&row.adapter===selected.profile.host.adapter&&row.revision===selected.profile.uiRevision)
 const assetBase=`/ui/${selected.profile.uiRevision}/`
 if(!ui||ui.manifest!==`ui/${selected.profile.uiRevision}/ui-artifact-manifest.json`)throw new ProtocolError('PROTOCOL_UNSUPPORTED')
 const manifest=await json('/'+ui.manifest) as UiArtifactManifest
 const transport=new BrowserTransport({origin:url.origin,uiProfile:selected.profile,fetch:request})
 try{
  const owner=await bootNativeUi({container,instanceId,profile:selected.profile,transport,manifest,assetBase,storage,extensionUrl:import.meta.url})
  let disposing:Promise<void>|undefined
  return{dispose:()=>disposing??=owner.dispose(),inspection:owner.inspection}
 }catch(error){transport.dispose();throw error}
}
