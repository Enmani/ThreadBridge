import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,tree} from './fixtures.mjs';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {startSync,syncComplete} from '../src/sync-control.mjs';
import {dashboardStatus,createDashboard} from '../src/dashboard-server.mjs';
import {sync} from '../src/sync.mjs';
import {snapshot} from '../src/model.mjs';
import {syncNative,nativeSnapshot} from '../src/native.mjs';

const config=f=>workerConfig({db:f.db,account:'test',extensionId:'a'.repeat(32),paceMs:0,maxDirectoryPages:1,maxPerRun:2,pendingIntervalMs:1000});
const rpcFor=f=>({closed:false,send(){},async request(path){
  if(path==='/api/auth/session')return {status:200,identity:'user'};
  try{return {status:200,identity:'user',data:await f.api.request(path)};}catch(e){return {status:e.status??503,identity:'user',data:{}};}
}});
const native=(id,text='native answer')=>nativeSnapshot(id,[{thread:{id,title:id},turns:[{items:[{type:'agentMessage',id:'native-answer',text}]}],page:{hasMore:false,nextCursor:null}}]);

test('ID mode exhausts active, archived and project pagination across runs, then stops with all bodies pending',async t=>{
  const f=await fixture(t);f.store.meta('sync_paused',1);
  f.store.meta('watermark',new Date(Date.now()+86400000).toISOString());
  const worker=new BrowserWorker(rpcFor(f),f.store,config(f));
  try{
    startSync(f.store,'ids');let runs=0;
    while(!syncComplete(f.store)&&runs++<50){f.store.meta('next_run_at',0);await worker.run();}
    assert.ok(runs>1&&runs<50);assert.equal(f.store.status().threads,68);assert.equal(f.store.status().messages,0);
    assert.equal(f.store.status().pending,68);assert.equal(f.store.meta('directory_scan'),'null');
    assert.equal(worker.paused,true);assert.equal(f.store.meta('worker_state'),'directory-complete');
    assert.equal(dashboardStatus(f.store).runtime.complete,true);assert.equal(dashboardStatus(f.store).runtime.nextAt,null);
    assert.ok(f.requests.some(p=>p.includes('is_archived=true')));assert.ok(f.requests.some(p=>p.includes('g-p-hidden/conversations')));
    assert.equal(f.requests.some(p=>p.startsWith('/backend-api/conversation/')),false);
    const count=f.requests.length;await worker.run();assert.equal(f.requests.length,count);
  }finally{worker.close();}
  const restarted=new BrowserWorker(rpcFor(f),f.store,config(f));try{await restarted.run();assert.equal(restarted.paused,true);}finally{restarted.close();}
});

test('switching modes retains an unfinished full directory cursor and full mode subsequently saves into the same table',async t=>{
  const f=await fixture(t);startSync(f.store,'ids');const worker=new BrowserWorker(rpcFor(f),f.store,config(f));
  try{
    await worker.run();const before=JSON.parse(f.store.meta('directory_scan'));const offset=before.jobs.find(j=>j.scope==='active').offset;
    assert.equal(offset,7);startSync(f.store,'full');f.store.meta('next_run_at',0);await worker.run();
    const after=JSON.parse(f.store.meta('directory_scan'));assert.equal(after.jobs.find(j=>j.scope==='active').offset,14);
    assert.equal(f.store.status().fullTrees,2);assert.equal(f.store.status().threads,14);
    assert.equal(dashboardStatus(f.store).runtime.mode,'full');assert.equal(f.store.read('chat-0').coverage,'full-tree');
  }finally{worker.close();}
});

test('switching an in-flight full read to ID mode saves that body and prevents all subsequent body dispatches',async t=>{
  const f=await fixture(t);await sync(f.api,f.store,{max:0});f.store.meta('next_directory_at',Date.now()+900000);
  let release,entered;const ready=new Promise(r=>entered=r),blocked=new Promise(r=>release=r),base=rpcFor(f);let bodies=0;
  const rpc={...base,async request(path){if(path.startsWith('/backend-api/conversation/')){bodies++;entered();await blocked;}return base.request(path);}};
  const worker=new BrowserWorker(rpc,f.store,config(f));
  try{const running=worker.run();await ready;startSync(f.store,'ids');worker.checkControl(false);release();await running;
    assert.equal(bodies,1);assert.equal(f.store.status().fullTrees,1);assert.equal(worker.mode,'ids');
    f.store.meta('next_run_at',0);await worker.run();assert.equal(bodies,1);assert.equal(f.store.status().errors,0);
  }finally{release();worker.close();}
});

test('starting a mode preserves a pending 429 cooldown and resets a completed directory run',async t=>{
  const f=await fixture(t),due=Date.now()+3600000;f.store.meta('rate_limit_strikes',1);f.store.meta('next_run_at',due);f.store.meta('next_request_at',due+5000);
  startSync(f.store,'ids');assert.equal(f.store.meta('next_run_at'),String(due));assert.equal(f.store.meta('next_request_at'),String(due+5000));
  f.store.meta('sync_completed_command',f.store.meta('sync_command'));f.store.meta('sync_paused',1);
  startSync(f.store,'full');assert.equal(syncComplete(f.store),false);assert.equal(f.store.meta('sync_paused'),'0');
  assert.equal(f.store.meta('sync_mode'),'full');assert.equal(f.store.meta('next_run_at'),String(due));
});

test('mode control accepts only same-origin exact commands and shares the local directory endpoint',async t=>{
  const f=await fixture(t),server=createDashboard(f.store);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const post=value=>fetch(base+'/api/control',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(value)});
  for(const value of [{mode:'other'},{mode:'ids',paused:false},{mode:'full',account:'other'}])assert.equal((await post(value)).status,400);
  const ids=await post({mode:'ids'}).then(r=>r.json());assert.equal(ids.runtime.mode,'ids');assert.equal(ids.runtime.paused,false);
  f.store.discover({id:'same-thread',title:'same',updated:null,scope:'active'});
  assert.equal((await post({mode:'full'}).then(r=>r.json())).runtime.mode,'full');
  const list=await fetch(base+'/api/threads').then(r=>r.json());assert.equal(list.total,1);assert.equal(list.items[0].id,'same-thread');
});

test('native pending queue saves observed versions, skips unchanged text and protects full trees',async t=>{
  const f=await fixture(t),updated=new Date().toISOString(),item={id:'native-queued',title:'native-queued',updated,assistantUpdated:null,scope:'active'};
  f.store.discover(item);f.store.save(snapshot(tree('existing-full'),'existing-full'));
  assert.deepEqual(f.store.nativePending().map(x=>x.id),['native-queued']);
  const run=await syncNative({read:async id=>native(id)},f.store,['native-queued']);assert.equal(run.fetched,1);
  assert.equal(f.store.thread('native-queued').synced_updated,updated);f.store.discover(item);assert.equal(f.store.nativePending().length,0);
  assert.equal(f.store.read('existing-full').coverage,'full-tree');
  f.store.discover({...item,updated:new Date(Date.now()+1000).toISOString()});assert.deepEqual(f.store.nativePending().map(x=>x.id),['native-queued']);
});

test('native queue does not mark an unfinished page limit as synced and stops dispatching after 429',async t=>{
  const f=await fixture(t);f.store.discover({id:'partial',title:'partial',updated:null});
  const partial=native('partial');const raw=JSON.parse(partial.raw);raw.native.hasMore=true;partial.raw=JSON.stringify(raw);
  const result=await syncNative({read:async()=>partial},f.store,['partial']);assert.equal(result.ok,false);assert.equal(f.store.thread('partial').revision,0);
  let calls=0;const limited=await syncNative({read:async()=>{calls++;throw Object.assign(new Error('Rate limited'),{status:429});}},f.store,['a','b']);
  assert.equal(calls,1);assert.equal(limited.paused.status,429);assert.equal(f.store.status().messages,0);
});
