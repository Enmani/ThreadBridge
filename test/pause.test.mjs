import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {createDashboard,dashboardStatus} from '../src/dashboard-server.mjs';
import {sync} from '../src/sync.mjs';
import {setSyncPaused} from '../src/sync-control.mjs';
import {fixture} from './fixtures.mjs';

const config=(f,extra={})=>workerConfig({db:f.db,account:'test',extensionId:'a'.repeat(32),paceMs:0,maxDirectoryPages:1,maxPerRun:1,...extra});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('pause control is same-origin JSON only, bounded, idempotent, account-scoped and visible after reopening',async t=>{
  const f=await fixture(t),server=createDashboard(f.store);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const post=(body,headers={})=>fetch(base+'/api/control',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},body});
  assert.equal((await post('{"paused":true}',{Origin:'https://foreign.example'})).status,403);
  assert.equal((await post('{"paused":true}',{Origin:''})).status,403);
  assert.equal((await post('{"paused":true}',{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await post('{"paused":true}',{'Content-Type':'text/plain'})).status,415);
  for(const value of ['{}','null','{"paused":1}','{"paused":true,"account":"other"}','invalid'])assert.equal((await post(value)).status,400);
  assert.equal((await post('x'.repeat(1025))).status,413);assert.equal(f.store.meta('sync_paused'),null);
  const due=Date.now()+3600000;f.store.meta('next_run_at',due);
  for(let i=0;i<2;i++){const state=await post('{"paused":true}').then(r=>r.json());assert.equal(state.runtime.paused,true);assert.equal(state.runtime.nextAt,null);}
  const reopened=new Store(f.db,'test'),other=new Store(f.db,'other');try{
    assert.equal(dashboardStatus(reopened).runtime.paused,true);assert.equal(other.meta('sync_paused'),null);
    const before=Date.now();assert.equal((await post('{"paused":false}').then(r=>r.json())).runtime.paused,false);
    assert.ok(Number(reopened.meta('next_run_at'))>=before);assert.ok(Number(reopened.meta('next_run_at'))<=Date.now());
    assert.equal(reopened.meta('next_request_at'),reopened.meta('next_run_at'));
    const resumedAt=reopened.meta('next_run_at'),command=reopened.meta('sync_command');
    await post('{"paused":false}');assert.equal(reopened.meta('next_run_at'),resumedAt);assert.equal(reopened.meta('sync_command'),command);
  }finally{other.close();reopened.close();}
});

test('pause before directory dispatch retains the page cursor without recording a failed read',async t=>{
  const f=await fixture(t),calls=[];
  const rpc={closed:false,send(){},async request(p){calls.push(p);f.store.meta('sync_paused',1);return {status:200,identity:'user'};}};
  const worker=new BrowserWorker(rpc,f.store,config(f));try{
    await worker.run();assert.deepEqual(calls,['/api/auth/session']);assert.equal(worker.paused,true);
    assert.equal(f.store.meta('worker_state'),'paused');assert.equal(JSON.parse(f.store.meta('last_run')).paused.reason,'user-pause');
    assert.equal(JSON.parse(f.store.meta('discovery')).errors.length,0);assert.equal(JSON.parse(f.store.meta('directory_scan')).jobs[0].offset,0);
    assert.equal(f.store.status().errors,0);
  }finally{worker.close();}
  const restarted=new BrowserWorker(rpc,f.store,config(f));try{await restarted.run();assert.equal(calls.length,1);assert.equal(restarted.paused,true);}finally{restarted.close();}
});

test('pause finishes and saves an in-flight body, leaves remaining bodies pending, then resumes from saved progress',async t=>{
  const f=await fixture(t);await sync(f.api,f.store,{max:0});f.store.meta('next_directory_at',Date.now()+900000);
  let release,started;const entered=new Promise(r=>started=r),blocked=new Promise(r=>release=r),calls=[];
  const rpc={closed:false,send(){},async request(p){calls.push(p);if(p==='/api/auth/session')return {status:200,identity:'user'};
    if(calls.length===2){started();await blocked;}return {status:200,identity:'user',data:await f.api.request(p)};}};
  const worker=new BrowserWorker(rpc,f.store,config(f,{maxPerRun:5}));
  try{
    const running=worker.run();await entered;worker.pause(true);release();await running;
    assert.equal(calls.length,2);assert.equal(f.store.status().fullTrees,1);assert.equal(f.store.status().pending,67);assert.equal(f.store.status().errors,0);
    const result=JSON.parse(f.store.meta('last_run'));assert.equal(result.fetched,1);assert.equal(result.failures.length,0);assert.equal(result.paused.reason,'user-pause');
    const due=Date.now()+3600000;f.store.meta('next_run_at',due);worker.pause(false,{resume:false});await worker.run();
    assert.equal(f.store.status().fullTrees,6);assert.equal(f.store.status().pending,62);
    const details=calls.filter(p=>p.startsWith('/backend-api/conversation/'));assert.equal(new Set(details).size,details.length);
  }finally{release();worker.close();}
});

test('database control polling cancels a long queued wait and resumes without browser interaction',async t=>{
  const f=await fixture(t),writer=new Store(f.db,'test');let started;const entered=new Promise(r=>started=r),calls=[];
  const rpc={closed:false,send(){},async request(p){calls.push(p);started();return p==='/api/auth/session'?{status:200,identity:'user'}:{status:200,identity:'user',data:await f.api.request(p)};}};
  const worker=new BrowserWorker(rpc,f.store,config(f,{paceMs:90000}));
  try{
    const running=worker.run();await entered;writer.meta('sync_paused',1);await running;
    assert.equal(worker.busy,false);assert.equal(worker.paused,true);assert.equal(calls.length,1);assert.equal(f.store.status().errors,0);
    const due=Date.now()+3600000;writer.meta('next_run_at',due);setSyncPaused(writer,false);
    const deadline=Date.now()+2500;while(calls.length<3&&Date.now()<deadline)await sleep(25);
    assert.equal(worker.paused,false);assert.equal(calls.length,3);assert.ok(calls[2].startsWith('/backend-api/conversations?'));
    assert.ok(Number(f.store.meta('next_run_at'))<due);
  }finally{worker.close();writer.close();}
});

test('an in-flight 429 still persists its server cooldown while the user has paused',async t=>{
  const f=await fixture(t);await sync(f.api,f.store,{max:0});f.store.meta('next_directory_at',Date.now()+900000);let worker,calls=0;
  const rpc={closed:false,send(){},async request(p){calls++;if(p==='/api/auth/session')return {status:200,identity:'user'};
    worker.pause(true);return {status:429,identity:'user',retry:'3600'};}};
  worker=new BrowserWorker(rpc,f.store,config(f,{paceMs:10}));const before=Date.now();
  try{
    await worker.run();assert.equal(f.store.meta('worker_state'),'paused');assert.ok(Number(f.store.meta('next_run_at'))>=before+3600000);
    worker.pause(false,{resume:false});await worker.run();assert.equal(calls,2);assert.equal(f.store.meta('rate_limit_strikes'),'1');
  }finally{worker.close();}
});
