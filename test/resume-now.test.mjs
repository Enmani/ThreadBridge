import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {createDashboard} from '../src/dashboard-server.mjs';
import {setSyncPaused} from '../src/sync-control.mjs';
import {sync} from '../src/sync.mjs';
import {fixture} from './fixtures.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const config=f=>workerConfig({db:f.db,account:'test',extensionId:'a'.repeat(32),paceMs:90000,maxPerRun:1});
async function dashboard(t,store){
  const server=createDashboard(store);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  return paused=>fetch(base+'/api/control',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({paused})});
}
async function pendingFixture(t){
  const f=await fixture(t);await sync(f.api,f.store,{max:0});
  f.store.meta('next_directory_at',Date.now()+900000);setSyncPaused(f.store,true);
  f.store.meta('next_run_at',Date.now()+900000);f.store.meta('next_request_at',Date.now()+90000);
  return f;
}
function rpcFor(f,starts=[]){return {closed:false,send(){},async request(path){
  starts.push({path,at:Date.now()});return path==='/api/auth/session'?{status:200,identity:'user'}:
    {status:200,identity:'user',data:await f.api.request(path)};
}};}

test('the dashboard resume starts one history read immediately; later reads keep the normal interval',async t=>{
  const f=await pendingFixture(t),starts=[],watermark=f.store.meta('watermark'),post=await dashboard(t,f.store);
  const worker=new BrowserWorker(rpcFor(f,starts),f.store,config(f));
  try{
    await worker.run();assert.equal(starts.length,0);
    const clicked=Date.now();assert.equal((await post(false)).status,200);
    const deadline=clicked+2500;while((worker.busy||f.store.status().fullTrees===0)&&Date.now()<deadline)await sleep(20);
    assert.equal(f.store.status().fullTrees,1);assert.equal(starts.length,2);
    assert.ok(starts[1].at-clicked<2500);assert.ok(starts[1].path.startsWith('/backend-api/conversation/'));
    assert.equal(f.store.meta('watermark'),watermark);assert.equal(f.store.status().pending,67);
    // The gate records its start before local callbacks hand the request to RPC.
    const due=Number(f.store.meta('next_request_at'));assert.ok(due>=clicked+90000);
    await post(false);await worker.run();assert.equal(starts.length,2);assert.equal(Number(f.store.meta('next_request_at')),due);
  }finally{worker.close();}
});

test('a pending immediate resume survives reopening the database and starting a new worker',async t=>{
  const f=await pendingFixture(t);setSyncPaused(f.store,false);const reopened=new Store(f.db,'test'),starts=[];
  const worker=new BrowserWorker(rpcFor(f,starts),reopened,config(f));
  try{
    const before=Date.now();await worker.run();assert.equal(reopened.status().fullTrees,1);
    assert.equal(starts.length,2);assert.ok(starts[1].at-before<2500);
    assert.equal(reopened.meta('sync_resume_pending'),'0');assert.equal(reopened.status().pending,67);
  }finally{worker.close();reopened.close();}
});

test('resume retains the legacy 429 deadline but ignores an expired cooldown and ordinary countdown',async t=>{
  const f=await pendingFixture(t),post=await dashboard(t,f.store),starts=[];
  const until=Date.now()+3600000;f.store.meta('rate_limit_strikes',1);f.store.meta('next_run_at',until);
  const worker=new BrowserWorker(rpcFor(f,starts),f.store,config(f));
  try{
    await post(false);await worker.run();assert.equal(starts.length,0);
    assert.equal(Number(f.store.meta('rate_limit_until')),until);assert.equal(Number(f.store.meta('next_run_at')),until);
    assert.equal(f.store.meta('sync_resume_pending'),'1');
    worker.pause(true);f.store.meta('rate_limit_until',Date.now()-1);f.store.meta('next_run_at',Date.now()+900000);
    worker.pause(false,{resume:false});await worker.run();
    assert.equal(f.store.status().fullTrees,1);assert.equal(starts.length,2);assert.equal(f.store.meta('rate_limit_until'),'0');
  }finally{worker.close();}
});

test('rapid pause and resume wake a worker between polls without overlapping an in-flight history read',async t=>{
  const f=await pendingFixture(t),post=await dashboard(t,f.store),starts=[];
  let release,entered;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  let active=0,maxActive=0,details=0;
  const rpc=rpcFor(f,starts),original=rpc.request.bind(rpc);
  rpc.request=async path=>{
    active++;maxActive=Math.max(maxActive,active);
    try{if(path.startsWith('/backend-api/conversation/')&&++details===1){entered();await blocked;}return await original(path);}
    finally{active--;}
  };
  const worker=new BrowserWorker(rpc,f.store,config(f));
  try{
    setSyncPaused(f.store,false);const running=worker.run();await started;
    await post(true);await post(false);worker.checkControl();assert.equal(details,1);assert.equal(worker.busy,true);
    release();await running;
    const deadline=Date.now()+2500;while((worker.busy||f.store.status().fullTrees<2)&&Date.now()<deadline)await sleep(20);
    assert.equal(f.store.status().fullTrees,2);assert.equal(details,2);assert.equal(maxActive,1);
    const paths=starts.filter(s=>s.path.startsWith('/backend-api/conversation/')).map(s=>s.path);
    assert.equal(new Set(paths).size,2);assert.equal(f.store.status().errors,0);
  }finally{release();worker.close();}
});
