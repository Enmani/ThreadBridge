import {summary} from './model.mjs';

const ledgerKey=scope=>'directory_scope:'+scope;
const readLedger=(store,scope)=>JSON.parse(store.meta(ledgerKey(scope)) ?? 'null');
function job(store,scope,kind,started,full,overlapMs,extra={}){
  const watermark=readLedger(store,scope)?.watermark ?? store.meta('watermark');
  return {scope,kind,started,full,cutoff:!full&&watermark?Date.parse(watermark)-overlapMs:null,
    cursor:kind==='project'?'0':null,offset:0,pages:0,done:false,ordered:true,previous:null,lastIds:null,seenCursors:[],...extra};
}
function directoryPath(j,pageSize){
  if(j.kind==='chats')return `/backend-api/conversations?offset=${j.offset}&limit=${pageSize}&order=updated&is_archived=${j.archived}`;
  if(j.kind==='sidebar')return '/backend-api/gizmos/snorlax/sidebar?owned_only=false&conversations_per_gizmo=0'+(j.cursor?'&cursor='+encodeURIComponent(j.cursor):'');
  if(j.kind==='optional')return j.endpoint+(j.cursor?'?cursor='+encodeURIComponent(j.cursor):'');
  return `/backend-api/gizmos/${encodeURIComponent(j.project)}/conversations?cursor=${encodeURIComponent(j.cursor)}`;
}
// Validate observed page and cross-page timestamps before trusting a time boundary.
function checkOrder(j,items){
  for(const s of items){if(!s.updated){j.ordered=false;continue;}
    if(j.previous&&s.updated>j.previous)j.ordered=false;j.previous=s.updated;}
}
function nextCursor(j,data){
  const next=data.cursor ?? null;if(next!=null){const key=String(next);if(j.seenCursors.includes(key))throw new Error('Directory cursor did not advance');j.seenCursors.push(key);}
  j.cursor=next;return next==null;
}

export async function discover(api,store,{full=false,refresh=false,pageSize=100,overlapMs=3600000,projectIds=[],
  maxDirectoryPages=100000,projectIntervalMs=0,directoryIntervalMs=300000,directoryOnly=false,newOnly=false}={}){
  if(!Number.isSafeInteger(maxDirectoryPages)||maxDirectoryPages<1||maxDirectoryPages>100000)throw new Error('Invalid directory page budget');
  const now=Date.now(),started=new Date(now).toISOString();let state=JSON.parse(store.meta('directory_scan') ?? 'null');
  if(state?.version!==1||(refresh&&!state?.refresh)||(full&&!state?.full)||Boolean(state?.newOnly)!==newOnly)state=null;
  const resuming=Boolean(state);
  const projects=new Set([...store.projectIds(),...projectIds,...(state?.projects ?? [])]);
  const report={complete:false,full:false,started,mode:full?'full-directory':'incremental-directory',resuming,
    pages:0,attempts:0,seen:0,newThreads:0,changedCandidates:0,unchanged:0,projects:0,deferredProjects:0,projectProbes:[],errors:[],scopes:[]};
  const addProject=(p,force=false,name=null)=>{
    if(typeof p!=='string'||!p.startsWith('g-p-'))return;store.rememberProject(p,name);projects.add(p);if(state.jobs.some(j=>j.kind==='project'&&j.project===p))return;
    const last=readLedger(store,'project:'+p);
    if(!force&&last&&now-Date.parse(last.watermark)<projectIntervalMs){report.deferredProjects++;return;}
    state.jobs.push(job(store,'project:'+p,'project',started,true,overlapMs,{project:p}));
  };
  if(!state){state={version:1,started,full,refresh,newOnly,projects:[...projects],jobs:[
    job(store,'active','chats',started,full,overlapMs,{archived:false}),job(store,'archived','chats',started,full,overlapMs,{archived:true}),
    job(store,'projects','sidebar',started,true,overlapMs)]};
    if(full)for(const endpoint of ['/backend-api/projects','/backend-api/gizmos/discovery/mine'])state.jobs.push(job(store,endpoint,'optional',started,true,overlapMs,{endpoint}));
    for(const p of projects)addProject(p,full);
  }else if(!directoryOnly){
    // Refresh recent chats even while the initial project scan is still in progress.
    const urgent=[];for(const [scope,kind,extra] of [['active','chats',{archived:false}],['archived','chats',{archived:true}],['projects','sidebar',{}]]){
      const previous=state.jobs.find(j=>j.scope===scope),last=readLedger(store,scope);
      if(previous?.done&&last&&now-Date.parse(last.watermark)>=directoryIntervalMs){state.jobs=state.jobs.filter(j=>j.scope!==scope);urgent.push(job(store,scope,kind,started,false,overlapMs,extra));}
      else if(previous&&!previous.done&&kind==='chats'){
        const checked=store.meta('directory_head:'+scope),head=state.jobs.find(j=>j.headOf===scope);
        if(checked&&now-Date.parse(checked)>=directoryIntervalMs&&(!head||head.done)){
          state.jobs=state.jobs.filter(j=>j.headOf!==scope);
          urgent.push(job(store,scope+':recent',kind,started,false,overlapMs,{...extra,headOf:scope,cutoff:Date.parse(checked)-overlapMs}));
        }
      }
    }state.jobs.unshift(...urgent);for(const p of projects)addProject(p,false);
  }
  report.full=state.full;report.started=state.started;report.mode=state.full?'full-directory':'incremental-directory';
  const persist=()=>{state.projects=[...projects];store.meta('projects',JSON.stringify([...projects]));store.meta('directory_scan',JSON.stringify(state));};
  const observe=(item,j)=>{
    const s=summary(item,j.headOf ?? j.scope),old=store.thread(s.id);if(!newOnly||!old)store.discover(s,state.refresh);report.seen++;
    if(newOnly&&old){report.unchanged++;addProject(s.project,state.full);return s;}
    if(!old)report.newThreads++;else if(store.thread(s.id).pending&&!old.pending)report.changedCandidates++;else if(!store.thread(s.id).pending)report.unchanged++;
    addProject(s.project,state.full);return s;
  };
  for(let index=0;index<state.jobs.length;index++){
    const j=state.jobs[index];if(j.done)continue;if(api.stopped||report.attempts>=maxDirectoryPages)break;
    if(j.kind==='project')report.projects++;
    try{
      while(!j.done&&report.attempts<maxDirectoryPages&&!api.stopped){
        if(j.pages>=10000)throw new Error('Directory pagination safety limit reached');
        report.attempts++;const data=await api.request(directoryPath(j,pageSize));
        const items=j.kind==='optional'?(data.items ?? data.projects ?? data.list ?? data.gizmos):data.items;
        if(!Array.isArray(items))throw new Error('Invalid directory response');report.pages++;
        let reason;
        if(j.kind==='chats'||j.kind==='project'){
          const normalized=items.map(item=>observe(j.kind==='project'?{...item,gizmo_id:j.project}:item,j));
          if(j.kind==='chats'){
            const ids=items.map(x=>x.id).join('\n');if(items.length&&ids===j.lastIds)throw new Error('Conversation pagination did not advance');
            j.lastIds=ids;checkOrder(j,normalized);
            const boundary=j.cutoff!==null&&j.ordered&&normalized.length>0&&normalized.every(s=>Date.parse(s.updated)<j.cutoff);
            j.done=!items.length||boundary;reason=!items.length?'empty-page':boundary?'time-boundary':null;j.offset+=items.length;
          }else{j.done=nextCursor(j,data);reason=j.done?'cursor-end':null;}
        }else{
          for(const item of items){const g=item.resource ?? item.gizmo?.gizmo ?? item.gizmo ?? item;
            addProject(g.id ?? g.gizmo_id ?? g.short_url,state.full,g.display?.name ?? g.name ?? g.title ?? item.name ?? item.title);}
          j.done=nextCursor(j,data);reason=j.done?'cursor-end':null;
          if(j.kind==='optional')report.projectProbes.push({endpoint:j.endpoint,available:true});
        }
        if(j.kind==='chats'&&j.pages===0)store.meta('directory_head:'+ (j.headOf ?? j.scope),j.started);
        j.pages++;j.lastUpdated=j.previous;if(reason)j.stopReason=reason;
        if(j.done)store.meta(ledgerKey(j.scope),JSON.stringify({watermark:j.started,full:j.full,stopReason:j.stopReason,ordered:j.ordered,lastUpdated:j.lastUpdated,pages:j.pages}));
        persist();
        // Bounded background turns share the page budget across directory scopes.
        if(maxDirectoryPages<100000&&!j.done)break;
      }
    }catch(e){
      if(j.kind==='optional'&&[404,405].includes(e.status)){j.done=true;j.stopReason='unavailable';report.projectProbes.push({endpoint:j.endpoint,available:false,status:e.status});}
      else if(e.code!=='SYNC_PAUSED')report.errors.push({scope:j.scope,error:e.message});persist();
      if(api.stopped||[401,403,429].includes(e.status))break;
    }
  }
  report.scopes=state.jobs.map(j=>({scope:j.scope,done:j.done,pages:j.pages,nextOffset:j.kind==='chats'?j.offset:null,
    nextCursor:j.kind==='chats'?null:j.cursor,cutoff:j.cutoff,lastUpdated:j.lastUpdated ?? null,ordered:j.kind==='chats'?j.ordered:null,stopReason:j.stopReason ?? null}));
  report.pendingScopes=state.jobs.filter(j=>!j.done).length;report.budgetExhausted=report.pendingScopes>0&&report.attempts>=maxDirectoryPages;
  report.complete=report.pendingScopes===0&&report.errors.length===0;
  if(report.complete)store.meta('directory_scan','null');else persist();store.meta('discovery',JSON.stringify(report));return report;
}
