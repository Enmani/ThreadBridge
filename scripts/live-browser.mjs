import {readFile,writeFile,unlink} from 'node:fs/promises';
import {prepareCapture,cleanupCapture} from './encrypted-authsession.mjs';
import {encryptJson,decryptJson} from '../src/secure-transfer.mjs';
import {discover} from '../src/discovery.mjs';
import {summary,timestamp,snapshot} from '../src/model.mjs';
import {Store} from '../src/store.mjs';

// Serialized into a normal authenticated ChatGPT tab. Diagnostics exclude account and chat contents.
export async function browserScan(publicKey,seed,key,filename) {
  if(location.origin!=='https://chatgpt.com')throw new Error('Expected ChatGPT');
  const job=window[key]={state:'running',requests:0,discovered:0,read:0,failures:0};
  try {
    const started=new Date().toISOString(),session=await fetch('/api/auth/session',{credentials:'include'}).then(r=>r.json());
    if(!session.accessToken||!session.user?.id)throw new Error('Sign in to ChatGPT');
    if(seed.identity&&seed.identity!==session.user.id)throw new Error('Authenticated account changed');
    const metas=new Map(Object.entries(seed.meta ?? {})),items=new Map(),totals={},scopes={},known=new Map(seed.known ?? []);
    let next=0,blocked=false,stoppedStatus=null;
    const api={async request(path){
      if(blocked)throw Object.assign(new Error('Session requests paused'),{status:stoppedStatus});
      for(let attempt=0;attempt<3;attempt++){
        const start=Math.max(Date.now(),next);next=start+1000;await new Promise(r=>setTimeout(r,Math.max(0,start-Date.now())));if(blocked)throw Object.assign(new Error('Session requests paused'),{status:stoppedStatus});job.requests++;
        const response=await fetch(path,{credentials:'include',headers:{Authorization:'Bearer '+session.accessToken},signal:AbortSignal.timeout(30000)});
        if(response.ok){const data=await response.json();if(path.includes('/conversations?offset='))totals[path.includes('is_archived=true')?'archived':'active']=data.total ?? null;return data;}
        if([401,403].includes(response.status)){blocked=true;stoppedStatus=response.status;}
        if([429,500,502,503,504].includes(response.status)&&attempt<2){await new Promise(r=>setTimeout(r,Math.min(10000,1000*2**attempt)));continue;}
        if(response.status===429){blocked=true;stoppedStatus=429;}
        throw Object.assign(new Error('HTTP '+response.status+' '+path.split('?')[0]),{status:response.status});
      }
    }};
    const store={meta(k,v){if(v===undefined)return metas.get(k) ?? null;metas.set(k,v);},projectIds(){return JSON.parse(metas.get('projects') ?? '[]');},
      discover(item){items.set(item.id,item);(scopes[item.scope]??=new Set()).add(item.id);job.discovered=items.size;}};
    const directory=await discover(api,store,{full:seed.full,projectIds:seed.projects ?? []});
    const pending=[...items.values()].filter(s=>seed.refresh||!known.has(s.id)||!s.updated||known.get(s.id)!==s.updated);
    const details=[],failures=[];let index=0;
    await Promise.all(Array.from({length:Math.min(1,pending.length)},async()=>{while(index<pending.length&&!blocked){const item=pending[index++];
      try{details.push({id:item.id,raw:await api.request('/backend-api/conversation/'+encodeURIComponent(item.id))});job.read++;}
      catch(e){failures.push({id:item.id,error:e.message});job.failures++;if(blocked)break;}
    }}));
    const envelope={version:1,identity:session.user.id,started,directory,items:[...items.values()],projects:JSON.parse(metas.get('projects') ?? '[]'),details,failures,
      stats:{requests:job.requests,totals,scopes:Object.fromEntries(Object.entries(scopes).map(([s,ids])=>[s,ids.size])),unique:items.size,pending:pending.length,fetched:details.length,elapsedMs:Date.now()-Date.parse(started),pausedStatus:stoppedStatus}};
    const packet=await encryptJson(envelope,publicKey,{compress:true});job.packet=JSON.stringify(packet);job.state='ready';job.filename=filename;
    job.report={directory,stats:envelope.stats,packetBytes:job.packet.length,failures:failures.map(({error})=>({error}))};
  }catch(e){job.state='failed';job.error=e.message;}
}

const [,,command,arg]=process.argv;
if(command==='prepare'){
  const mode=arg ?? 'full',prepared=await prepareCapture(new URL('../data/',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
  const store=new Store(new URL('../data/live-web.sqlite',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),'live-browser');
  const seed={full:mode==='full',refresh:mode==='refresh',identity:store.meta('identity'),meta:{watermark:store.meta('watermark'),projects:store.meta('projects') ?? '[]'},
    known:store.db.prepare("SELECT id,synced_updated FROM threads WHERE account=? AND coverage='full-tree' AND pending=0").all(store.account).map(r=>[r.id,r.synced_updated])};store.close();
  const key='threadbridge_'+prepared.keyFile.match(/([0-9a-f-]{36})\.pem$/)[1].replaceAll('-','');
  const filename=key+'.json';const bundle={...prepared,key,filename,mode};
  await writeFile(new URL('../data/.live-browser-state.json',import.meta.url),JSON.stringify(bundle));
  const expression='(()=>{const timestamp='+timestamp.toString()+';const summary='+summary.toString()+';const discover='+discover.toString()+';const encryptJson='+encryptJson.toString()+';('+browserScan.toString()+')('+[prepared.publicKey,seed,key,filename].map(JSON.stringify).join(',')+');return {started:true};})()';
  console.log(JSON.stringify({key,filename,expression}));
}else if(command==='finish'){
  const bundle=JSON.parse(await readFile(new URL('../data/.live-browser-state.json',import.meta.url),'utf8'));
  try{
    const envelope=decryptJson(JSON.parse(await readFile(bundle.packetFile,'utf8')),await readFile(bundle.keyFile,'utf8'),{maxBytes:256*1024*1024});
    if(envelope.version!==1||!Array.isArray(envelope.items)||!Array.isArray(envelope.details)||typeof envelope.identity!=='string')throw new Error('Invalid browser export');
    const store=new Store(new URL('../data/live-web.sqlite',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),'live-browser');
    try{
      if(store.meta('identity')&&store.meta('identity')!==envelope.identity)throw new Error('Authenticated account changed');store.meta('identity',envelope.identity);
      for(const item of envelope.items){if(typeof item.id!=='string'||typeof item.title!=='string')throw new Error('Invalid export summary');store.discover(item,bundle.mode==='refresh');}
      let changed=0,validated=0;const failures=[...envelope.failures];
      for(const detail of envelope.details){try{const snap=snapshot(detail.raw,detail.id);changed+=store.save(snap,store.thread(detail.id).source_updated).changed;validated++;}catch(e){store.fail(detail.id,e.message);failures.push({id:detail.id,error:e.message});}}
      for(const failure of envelope.failures)store.fail(failure.id,failure.error);
      store.meta('projects',JSON.stringify(envelope.projects));store.meta('discovery',JSON.stringify(envelope.directory));
      if(envelope.directory.complete)store.meta('watermark',envelope.started);
      const status=store.status();const sample=store.db.prepare('SELECT thread,text FROM messages WHERE account=? AND length(text)>=3 LIMIT 1').get(store.account);
      const checks={read:Boolean(sample&&store.read(sample.thread)?.raw.mapping),search:Boolean(sample&&store.search(sample.text.slice(0,20),100).some(r=>r.thread===sample.thread))};
      const report={ok:envelope.directory.complete&&!failures.length&&!status.pending,mode:bundle.mode,stats:envelope.stats,directory:envelope.directory,validated,changed,failures:failures.map(({error})=>({error})),status,checks};
      await writeFile(new URL('../LIVE-'+bundle.mode.toUpperCase()+'-RESULT.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
    }finally{store.close();}
  }finally{await cleanupCapture(bundle.keyFile,bundle.packetFile);await unlink(new URL('../data/.live-browser-state.json',import.meta.url));}
}else if(command==='cleanup'){
  const bundle=JSON.parse(await readFile(new URL('../data/.live-browser-state.json',import.meta.url),'utf8'));await cleanupCapture(bundle.keyFile,bundle.packetFile);await unlink(new URL('../data/.live-browser-state.json',import.meta.url));console.log('{"cleaned":true}');
}
