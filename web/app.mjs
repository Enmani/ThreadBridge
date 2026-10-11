import {labels as l} from './labels.mjs';
import {setupImport} from './import-ui.mjs';
import {setupTheme} from './theme.mjs';
import {setupSort} from './sort-ui.mjs';
import {setupHelp} from './floating-ui.mjs';
const $=id=>document.getElementById(id),settings={language:'zh-CN'},state={page:1,pages:1,query:'',sort:'source_updated',order:'desc',busy:false,controlBusy:false,error:false,status:null,serial:0};
const apiUrl=(path,params={})=>path+'?'+new URLSearchParams(params);
document.documentElement.lang=settings.language;document.querySelectorAll('[data-label]').forEach(e=>e.textContent=l[e.dataset.label]);$('search').placeholder=l.placeholder;$('state').textContent=l.loading;
const date=value=>value?new Date(value).toLocaleString(settings.language,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):l.none;
const set=(id,value)=>$(id).textContent=value;
document.querySelectorAll('[data-aria]').forEach(e=>e.setAttribute('aria-label',l[e.dataset.aria]));setupTheme($('theme'));setupHelp();
setupSort(sort=>{Object.assign(state,sort,{page:1});state.serial++;void refresh();},state);
function nextRequest(){
  if(state.error){set('next-request',l.unavailable);set('countdown','');return;}
  const data=state.status,worker=data?.background,at=data?.runtime.nextAt;
  if(data?.runtime.complete){set('next-request',l.idsComplete);set('countdown','');return;}
  if(data?.runtime.paused){set('next-request',l.states.paused);set('countdown','');return;}
  if(!data?.runtime.connected){set('next-request',l.waiting);set('countdown','');return;}
  if(['paused','account-changed'].includes(worker.state)){set('next-request',l.states[worker.state]);set('countdown','');return;}
  const inflight=data.lastRequest&&!data.lastRequest.finishedAt;
  set('next-request',inflight?l.inflight:date(at));
  set('countdown',inflight?'':at>Date.now()?l.remaining(Math.ceil((at-Date.now())/1000)):l.due);
}
function showControl(){const runtime=state.status?.runtime,paused=runtime?.paused,disabled=!state.status||state.error||state.controlBusy;
  $('pause').disabled=disabled||Boolean(runtime?.complete);set('pause',paused?l.resume:l.pause);
  $('watch-new').disabled=disabled;$('watch-new').checked=Boolean(runtime?.watchNew);
  $('browser-archive').disabled=disabled;$('browser-archive').checked=Boolean(runtime?.browserArchive);
  for(const [id,mode] of [['sync-ids','ids'],['sync-full','full']]){
    $(id).disabled=disabled||runtime?.mode===mode&&!paused;$(id).setAttribute('aria-pressed',String(runtime?.mode===mode));
  }
}
function showStatus(data){
  state.status=data;const worker=data.background;
  $('browser-controls').hidden=data.capabilities?.browserArchive===false;$('import-json').hidden=data.capabilities?.jsonImport===false;
  set('state',data.runtime.complete?l.idsComplete:data.runtime.paused?l.states.paused:data.runtime.connected?(l.states[worker.state] ?? worker.state):l.disconnected);
  set('mode',data.runtime.watchNew?l.watchingMode:data.runtime.mode==='full'&&data.runtime.phase?data.runtime.phase==='initial'?l.initialSync:l.maintenanceSync:l.modes[data.runtime.mode]);
  set('pace',data.runtime.connected?l.pace(Math.round(worker.paceMs/1000)):'');
  set('connection-note',data.runtime.complete?l.idsCompleteNote:data.runtime.paused?l.pauseNote:data.runtime.connected?
    (data.runtime.watchNew?l.watchingNote(Math.round(data.runtime.directoryIntervalMs/60000))+' ':data.runtime.mode==='ids'?l.idsNote+' ':'')+l.pace(Math.round(worker.paceMs/1000)):l.connectNote);showControl();
  const r=data.lastRequest;set('last-request',r?l.request(l.requestKind(r.path),r.finishedAt?`HTTP ${r.status}`:l.inflight,date(r.finishedAt ?? r.startedAt)):l.none);
  const saved=data.lastCapture;set('last-saved',saved?l.savedEntry(saved.title||l.untitled,date(saved.at)):l.none);
  const browserSaved=data.lastBrowserCapture;
  const browserNote=!data.runtime.browserArchive?l.browserOff:!data.runtime.browserArchiveReady?l.browserReload:
    l.browserErrors[data.browserCaptureState] ?? (browserSaved?l.browserSaved(browserSaved.title||l.untitled,date(browserSaved.at)):l.browserWaiting);
  set('browser-archive-detail',browserNote);set('browser-archive-status',l.browserErrors[data.browserCaptureState]??'');$('browser-archive-status').hidden=!data.runtime.browserArchive||!l.browserErrors[data.browserCaptureState];
  for(const [id,key] of [['discovered','threads'],['full-trees','fullTrees'],['text-archives','textArchives'],['browser-archives','browserArchives'],['imported-archives','importedArchives'],['pending','pending']])set(id,data[key]);
  const scan=data.activeScan,issues=data.runtime.scopeIssues??[];
  const warning=l.syncIssues(issues.filter(s=>!s.done).length,data.runtime.failedThreads??0,issues.filter(s=>s.stopReason==='unavailable').length);
  set('scan',[scan?l.scan(scan.scopes.reduce((n,s)=>n+s.pages,0),scan.pendingScopes):'',warning].filter(Boolean).join(' · '));
  if(data.runtime.phase==='initial'&&data.runtime.mode==='full')$('connection-note').textContent+=' '+l.initialSyncNote;
  if(warning)$('connection-note').textContent+=' '+warning+'：'+[...new Set(issues.map(s=>s.projectName??l.scopes[s.scope]??(s.scope==='projects'?'项目列表':s.scope.startsWith('project:')?'项目聊天':'补充项目目录')))].join('、');nextRequest();
}
function cell(row,label,value){const td=document.createElement('td');td.dataset.label=label;td.textContent=value;row.append(td);return td;}
function showThreads(data){
  state.pages=data.pages;set('result-count',l.result(data.total,Boolean(state.query)));set('page',l.page(state.page,data.pages));
  $('previous').disabled=state.page<=1;$('next').disabled=state.page>=data.pages;$('empty').hidden=Boolean(data.items.length);set('empty',state.query?l.noResults:l.empty);
  const fragment=document.createDocumentFragment();for(const thread of data.items){
    const row=document.createElement('tr'),title=cell(row,l.thread,thread.title||l.untitled),id=document.createElement('span');id.className='thread-id';id.textContent=thread.id;title.append(id);
    cell(row,l.provider,thread.providerName??'ChatGPT');
    cell(row,l.scope,l.scopes[thread.scope] ?? (thread.scope?.startsWith('project:')?'项目聊天':thread.scope ?? '—'));
    const project=cell(row,l.project,thread.projectName ?? thread.projectId ?? l.noProject);if(thread.projectId)project.title=thread.projectId;
    const archived=thread.importedArchive&&thread.coverage==='not-read'?l.importPartial:thread.browserArchive&&thread.coverage==='not-read'?l.browserPartial:thread.error?l.failed:thread.pending?thread.coverage==='full-tree'?l.updatePending:thread.coverage==='bounded-text'?thread.provider==='chatgpt'||!thread.provider?l.fullPending:l.updatePending:l.readPending:l.archive[thread.coverage] ?? thread.coverage;
    const status=cell(row,l.archiveState,archived);if(thread.error)status.className='error';
    const sources=[];
    if(thread.messages)sources.push(l.messageCount(l.storedMessages,thread.messages));
    if(thread.browserArchive)sources.push(l.messageCount(l.browserArchives,thread.browserArchive.messages));
    if(thread.importedArchive)sources.push(l.messageCount(l.importedArchives,thread.importedArchive.messages));
    cell(row,l.messages,sources.length>1?sources.join(' · '):sources.length?(thread.messages||thread.browserArchive?.messages||thread.importedArchive?.messages):0);
    cell(row,l.updated,date([thread.source_updated,thread.source_assistant].filter(Boolean).sort().at(-1)));cell(row,l.saved,date([thread.last_checked_at,thread.browserArchive?.updated,thread.importedArchive?.updated].filter(Boolean).sort().at(-1)));fragment.append(row);
  }$('rows').replaceChildren(fragment);
}
async function refresh(){
  if(state.busy||state.controlBusy)return;state.busy=true;const serial=state.serial;
  try{
    const responses=await Promise.all([fetch(apiUrl('/api/status'),{cache:'no-store'}),fetch(apiUrl('/api/threads',{q:state.query,page:state.page,sort:state.sort,order:state.order}),{cache:'no-store'})]);
    if(responses.some(r=>!r.ok))throw new Error('Request failed');const [status,threads]=await Promise.all(responses.map(r=>r.json()));
    if(serial!==state.serial)return;if(state.page>threads.pages){state.page=threads.pages;state.serial++;return;}
    state.error=false;showStatus(status);showThreads(threads);$('error').hidden=true;
  }catch{if(serial!==state.serial)return;state.error=true;set('error',l.error);$('error').hidden=false;set('state',l.error);showControl();nextRequest();}
  finally{state.busy=false;if(serial!==state.serial)void refresh();}
}
async function control(command){
  if(!state.status||state.controlBusy||state.error)return;state.controlBusy=true;state.serial++;showControl();$('control-error').hidden=true;
  try{const response=await fetch(apiUrl('/api/control'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('Control failed');showStatus(await response.json());
  }catch{set('control-error',l.controlError);$('control-error').hidden=false;}
  finally{state.controlBusy=false;showControl();void refresh();}
}
$('pause').addEventListener('click',()=>void control({paused:!state.status.runtime.paused}));
for(const [id,mode] of [['sync-ids','ids'],['sync-full','full']])$(id).addEventListener('click',()=>void control({mode}));
$('watch-new').addEventListener('change',()=>void control({watchNew:$('watch-new').checked}));
$('browser-archive').addEventListener('change',()=>void control({browserArchive:$('browser-archive').checked}));
$('refresh').addEventListener('click',()=>void refresh());
$('search-form').addEventListener('submit',event=>{event.preventDefault();state.query=$('search').value.trim();state.page=1;state.serial++;void refresh();});
$('search').addEventListener('search',()=>{if(!$('search').value){state.query='';state.page=1;state.serial++;void refresh();}});
for(const [id,delta] of [['previous',-1],['next',1]])$(id).addEventListener('click',()=>{state.page+=delta;state.serial++;void refresh();});
setupImport(()=>{state.serial++;return refresh();});
setInterval(()=>{if(!document.hidden)void refresh();},5000);setInterval(nextRequest,1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});void refresh();
