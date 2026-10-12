import {startRemotePage} from './entry.ts'
import {bindPageLifecycle} from './page-lifecycle.ts'
import './entry.css'
const container=document.getElementById('root')!
let storage:Storage
try{storage=localStorage}catch{storage={getItem(){throw new Error('Storage unavailable')},setItem(){throw new Error('Storage unavailable')}} as unknown as Storage}
const owner=startRemotePage({href:location.href,container,fetch,storage})
bindPageLifecycle(window,container,owner,()=>location.reload())
void owner.catch(error=>{
 const card=document.createElement('section');card.className='remote-entry-message'
 const title=document.createElement('h1');title.textContent='连接暂不可用'
 const message=document.createElement('p');message.textContent=String(error).includes('AUTH')?'请使用 DSH 中的最新链接打开此页面。':'请确认电脑上的 DSH 保持运行，然后重新连接。'
 const retry=document.createElement('button');retry.type='button';retry.textContent='重新连接';retry.onclick=()=>location.reload()
 card.append(title,message,retry);container.replaceChildren(card)
})
