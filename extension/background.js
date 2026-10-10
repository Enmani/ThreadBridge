import {pageRequest} from './page-client.js';
import {providerPageRequest} from './provider-client.js';
import {ArchiveOutbox} from './archive-outbox.js';

const outbox=new ArchiveOutbox();let archiveEnabled=false,inflight=null,flushing=false;
const settingsReady=chrome.storage.local.get('browserArchiveEnabled').then(value=>{archiveEnabled=value.browserArchiveEnabled===true;void broadcastArchiveSettings();});
async function broadcastArchiveSettings(){
  const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
  await Promise.allSettled(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:'archive-settings'})));
}
async function flushArchive(){
  if(!port||!archiveEnabled||inflight||flushing)return;flushing=true;
  try{
    const entry=await outbox.first();if(!entry||!port||!archiveEnabled)return;
    inflight={key:entry.key,timer:setTimeout(()=>{inflight=null;void flushArchive();},20000)};
    port.postMessage({type:'capture',id:entry.key,payload:entry.payload});
  }catch{if(inflight)clearTimeout(inflight.timer);inflight=null;}
  finally{flushing=false;}
}
async function archiveAck(message){
  if(message.id!==inflight?.key)return;
  clearTimeout(inflight.timer);inflight=null;
  if(message.ok)await outbox.remove(message.id);
  else if(message.state!=='disabled')await outbox.defer(message.id);
  if(message.state!=='disabled')void flushArchive();
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||!sender.tab||!sender.url?.startsWith('https://chatgpt.com/'))return;
  if(message?.type==='archive-settings'){reply({enabled:archiveEnabled});return;}
  if(message?.type==='archive-state'&&['waiting-account','unrecognized-page'].includes(message.state)){
    if(archiveEnabled&&port)port.postMessage({type:'archive-state',state:message.state});return;
  }
  if(message?.type!=='archive-capture')return;
  if(!archiveEnabled){reply({queued:false,state:'disabled'});return;}
  const route=/\/c\/([A-Za-z0-9_-]{1,160})\/?$/.exec(new URL(sender.url).pathname);
  if(!route||route[1]!==message.payload?.id){reply({queued:false,state:'invalid-capture'});return;}
  void outbox.enqueue(message.payload).then(()=>{reply({queued:true});void flushArchive();}).catch(error=>{
    const state=['local-queue-full','capture-too-large'].includes(error.message)?error.message:'local-storage-failed';
    if(port)port.postMessage({type:'archive-state',state});reply({queued:false,state});
  });return true;
});

const HOST='com.threadbridge.history',ALARM='threadbridge-reconnect';let port=null,connecting=false;
const tabPromises=new Map(),statuses=new Map();
const surfaces={chatgpt:{origin:'https://chatgpt.com',url:'https://chatgpt.com/'},claude:{origin:'https://claude.ai',url:'https://claude.ai/'},gemini:{origin:'https://gemini.google.com',url:'https://gemini.google.com/app'}};
async function paint(state,pending=0){
  const labels={'connecting':'连接','syncing':'同步','pending':String(Math.min(pending,999)),'up-to-date':'✓','waiting':'等待',
    'rate-limited':'限流','login-required':'登录','account-changed':'账号','connection-error':'错误','paused':'暂停','directory-complete':'✓','host-unavailable':'安装'};
  await chrome.action.setBadgeText({text:labels[state] ?? '错误'});
  await chrome.action.setTitle({title:'ThreadBridge · '+(labels[state] ?? state)+(pending?' · 待读取 '+pending:'')});
}
async function syncTab(provider,authuser){
  if(!Object.hasOwn(surfaces,provider))throw new Error('Unsupported provider');
  const key=provider==='chatgpt'?'syncTabId':`syncTabId_${provider}_${authuser}`;
  if(tabPromises.has(key))return tabPromises.get(key);
  const task=(async()=>{
    const stored=await chrome.storage.local.get(key),syncTabId=stored[key];
    if(Number.isInteger(syncTabId)){try{const tab=await chrome.tabs.get(syncTabId);if(new URL(tab.url).origin===surfaces[provider].origin)return tab;}catch{}}
    const url=surfaces[provider].url+(provider==='gemini'?'?authuser='+authuser:'');
    const tab=await chrome.tabs.create({url,active:false});await chrome.storage.local.set({[key]:tab.id});return tab;
  })();
  tabPromises.set(key,task);try{return await task;}finally{tabPromises.delete(key);}
}
async function waitLoaded(tab){
  if(tab.status==='complete')return;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{chrome.tabs.onUpdated.removeListener(updated);reject(new Error('Sync tab did not load'));},20000);
    function updated(id,change){if(id===tab.id&&change.status==='complete'){clearTimeout(timer);chrome.tabs.onUpdated.removeListener(updated);resolve();}}
    chrome.tabs.onUpdated.addListener(updated);chrome.tabs.get(tab.id).then(current=>{if(current.status==='complete'){clearTimeout(timer);chrome.tabs.onUpdated.removeListener(updated);resolve();}}).catch(()=>{});
  });
}
async function answer(message,current){
  if(!Number.isSafeInteger(message.id)||typeof message.path!=='string'||message.path.length>4096)return;
  try{
    const provider=message.provider??'chatgpt',authuser=message.authuser??0;
    if(!Number.isSafeInteger(authuser)||authuser<0||authuser>99)throw new Error('Invalid browser account');
    const tab=await syncTab(provider,authuser);await waitLoaded(tab);
    const [reply]=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:provider==='chatgpt'?pageRequest:providerPageRequest,args:[message.path,message.workspace ?? null,provider,authuser]});
    if(port===current)current.postMessage({type:'response',id:message.id,result:reply.result});
  }catch{if(port===current){try{current.postMessage({type:'response',id:message.id,error:'Browser unavailable'});}catch{}}}
}
export async function connect(){
  if(port||connecting)return;connecting=true;
  try{
    await settingsReady;
    const current=chrome.runtime.connectNative(HOST);port=current;
    current.onMessage.addListener(message=>{
      if(message?.type==='request')void answer(message,current);
      else if(message?.type==='capture-ack')void archiveAck(message).catch(()=>{});
      else if(message?.type==='status'){
        // Status has counts only. History awaits commit in IndexedDB; credentials are never persisted.
        const provider=message.provider??'chatgpt';if(!Object.hasOwn(surfaces,provider))return;
        const enabled=provider==='chatgpt'?message.browserArchiveEnabled===true:archiveEnabled;
        if(enabled!==archiveEnabled){archiveEnabled=enabled;void chrome.storage.local.set({browserArchiveEnabled:enabled});void broadcastArchiveSettings();
          if(enabled)void outbox.resetDeferred().then(flushArchive);}
        if(enabled)void flushArchive();
        const states=new Set(['connecting','syncing','pending','up-to-date','waiting','rate-limited','login-required','account-changed','connection-error','paused']);
        if(states.has(message.state)){
          statuses.set(provider,{state:message.state,mode:message.mode,complete:message.complete===true,pending:message.pending,fullTrees:message.fullTrees,nextRunAt:message.nextRunAt});
          const list=[...statuses.values()],priority=['account-changed','login-required','connection-error','rate-limited','syncing','connecting','pending','waiting','paused','up-to-date'];
          const state=priority.find(s=>list.some(v=>v.state===s)),pending=list.reduce((n,v)=>n+(v.pending??0),0);
          void chrome.storage.local.set({status:{state,pending},providerStatuses:Object.fromEntries(statuses)});void paint(list.every(v=>v.complete)?'directory-complete':state,pending);
        }
      }
    });
    current.onDisconnect.addListener(()=>{void chrome.runtime.lastError;if(port===current)port=null;statuses.clear();
      if(inflight)clearTimeout(inflight.timer);inflight=null;void paint('host-unavailable');
      void chrome.alarms.create(ALARM,{delayInMinutes:1});});
    await outbox.resetDeferred();current.postMessage({type:'hello',version:1,archiveVersion:1});await paint('connecting');
  }catch{port=null;await paint('host-unavailable');await chrome.alarms.create(ALARM,{delayInMinutes:1});}
  finally{connecting=false;}
}
chrome.runtime.onStartup.addListener(()=>void connect());chrome.runtime.onInstalled.addListener(()=>void connect());
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)void connect();});
chrome.action.onClicked.addListener(()=>{if(port)port.postMessage({type:'sync'});else void connect();});
void connect();
