import {providerDirectory} from './providers.mjs';

export async function discoverProvider(api,store,{full=false,refresh=false,newOnly=false,maxDirectoryPages=100000}={}){
  const provider=store.provider,started=new Date().toISOString();
  const saved=JSON.parse(store.meta('directory_scan')??'null');
  if(saved&&(saved.provider!==provider||saved.version!==1))throw new Error('Invalid provider scan checkpoint');
  const state=saved??{version:1,provider,started,full,refresh,newOnly,jobs:(provider==='claude'?['active']:['pinned','active']).map(scope=>
    ({scope,kind:'provider',pages:0,offset:0,cursor:null,done:false,seenCursors:[],lastIds:null}))};
  const result={complete:false,full:state.full,started:state.started,mode:state.newOnly?'new-only':'all',resuming:Boolean(saved),pages:0,attempts:0,seen:0,new:0,changed:0,unchanged:0,projects:0,scopes:[],errors:[]};
  const checkpoint=()=>store.meta('directory_scan',JSON.stringify(state));checkpoint();
  for(const job of state.jobs){
    if(job.done)continue;
    while(!job.done&&result.attempts<maxDirectoryPages&&!api.stopped){
      result.attempts++;
      try{
        if(job.pages>=10000)throw new Error('Provider directory page safety limit reached');
        const params=new URLSearchParams({scope:job.scope,offset:String(job.offset)});if(job.cursor)params.set('cursor',job.cursor);
        const page=providerDirectory(provider,await api.request('/history/list?'+params),job.scope);
        const signature=JSON.stringify(page.items.map(i=>i.id));
        if(page.items.length&&job.lastIds===signature)throw new Error('Provider directory repeated a page');
        if(page.next&&(page.next===job.cursor||job.seenCursors.includes(page.next)))throw new Error('Provider directory repeated a cursor');
        const exhausted=provider==='gemini'||(page.total!=null?job.offset+page.items.length>=page.total:page.items.length<100);
        const done=page.next==null&&exhausted;
        if(!page.items.length&&!done)throw new Error('Empty provider page has more history');
        const nextJob={...job,pages:job.pages+1,offset:job.offset+page.items.length,lastIds:signature,done,cursor:page.next,seenCursors:page.next?[...job.seenCursors,page.next]:job.seenCursors};
        const counts={seen:0,new:0,changed:0,unchanged:0};
        store.transaction(()=>{
          for(const item of page.items){
            const old=store.thread(item.id);counts.seen++;
            if(!old||!state.newOnly){store.discover(item,state.refresh);if(item.projectName)store.rememberProject(item.project,item.projectName);}
            if(!old)counts.new++;else if(store.thread(item.id).pending)counts.changed++;else counts.unchanged++;
          }
          store.meta('directory_scan',JSON.stringify({...state,jobs:state.jobs.map(value=>value===job?nextJob:value)}));
        });Object.assign(job,nextJob);for(const key of Object.keys(counts))result[key]+=counts[key];result.pages++;
      }catch(e){result.errors.push({scope:job.scope,status:e.status??null,error:e.message});break;}
    }
    result.scopes.push({scope:job.scope,complete:job.done,pages:job.pages});
    if(api.stopped||result.attempts>=maxDirectoryPages)break;
  }
  result.pendingScopes=state.jobs.filter(j=>!j.done).length;result.complete=result.pendingScopes===0&&!result.errors.length;
  result.budgetExhausted=result.attempts>=maxDirectoryPages&&!result.complete;
  store.meta('directory_scan',result.complete?'null':JSON.stringify(state));store.meta('discovery',JSON.stringify(result));return result;
}
