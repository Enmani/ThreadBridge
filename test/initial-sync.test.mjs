import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {BrowserTransport} from '../src/browser-transport.mjs';
import {sync} from '../src/sync.mjs';
import {initialSyncPending,successfulRequest,readyPayloads} from '../src/sync-policy.mjs';
import {dashboardStatus} from '../src/dashboard-server.mjs';
import {pageRequest} from '../extension/page-client.js';
import {fixture,tree} from './fixtures.mjs';

const settings=(f,extra={})=>workerConfig({db:f.db,account:'test',extensionId:'a'.repeat(32),paceMs:90000,
  initialPaceMs:0,initialMinPaceMs:0,initialMaxPerRun:12,initialDirectoryPages:3,...extra});
const rpcFor=f=>({closed:false,paths:[],send(){},async request(path){this.paths.push(path);
  if(path==='/api/auth/session')return {status:200,identity:'user'};
  try{return {status:200,identity:'user',data:await f.api.request(path)};}catch(e){return {status:e.status??503,identity:'user'};}
}});

test('initial download resumes all directory scopes and each raw tree, then switches to slow maintenance',async t=>{
  const f=await fixture(t),rpc=rpcFor(f);let worker=new BrowserWorker(rpc,f.store,settings(f));
  try{
    // The clamped active/archived pages expose 7 + 4 unique threads in this turn.
    assert.ok(initialSyncPending(f.store));await worker.run();assert.equal(f.store.status().fullTrees,11);
    assert.ok(Number(f.store.meta('next_run_at'))<=Date.now());assert.equal(f.store.meta('initial_sync_completed_at'),null);
    await worker.close();worker=new BrowserWorker(rpc,f.store,settings(f));
    for(let i=0;i<30&&initialSyncPending(f.store);i++){f.store.meta('next_run_at',0);await worker.run();}
    assert.equal(f.store.status().fullTrees,68);assert.equal(f.store.status().pending,0);
    assert.equal(f.store.meta('sync_phase'),'maintenance');assert.ok(f.store.meta('initial_sync_completed_at'));
    assert.equal(f.store.meta('effective_pace_ms'),'90000');assert.ok(Number(f.store.meta('next_run_at'))>=Date.now()+899000);
    assert.equal(rpc.paths.filter(p=>p.includes('offset=0&')&&p.includes('is_archived=false')).length,1);
    const bodies=rpc.paths.filter(p=>p.startsWith('/backend-api/conversation/'));assert.equal(bodies.length,68);assert.equal(new Set(bodies).size,68);
    assert.deepEqual(f.store.read('chat-0').raw.mapping.descendant,tree('chat-0').mapping.descendant);
  }finally{await worker.close();}
});

test('failed newest payload waits while other threads finish; retry and scope failures cannot declare completion',async t=>{
  const f=await fixture(t);f.records.get('chat-0').update_time=Date.now()/1000+100;await sync(f.api,f.store,{max:0});const rpc=rpcFor(f),original=rpc.request.bind(rpc);let fail=true;
  rpc.request=async path=>path==='/backend-api/conversation/chat-0'&&fail?{status:404,identity:'user'}:original(path);
  const worker=new BrowserWorker(rpc,f.store,settings(f,{initialMaxPerRun:1,initialDirectoryPages:100000}));
  try{
    await worker.run();assert.equal(f.store.thread('chat-0').pending,1);assert.equal(readyPayloads(f.store,1)[0].id,'archive-0');
    for(let i=0;i<67;i++){f.store.meta('next_run_at',0);await worker.run();}
    assert.equal(f.store.status().fullTrees,67);assert.ok(initialSyncPending(f.store));assert.equal(dashboardStatus(f.store).runtime.failedThreads,1);
    assert.equal(f.store.meta('initial_sync_completed_at'),null);fail=false;
    f.store.meta('payload_retry:chat-0','null');f.store.meta('next_run_at',0);await worker.run();
    assert.equal(f.store.status().fullTrees,68);assert.equal(f.store.meta('sync_phase'),'maintenance');
  }finally{await worker.close();}
});

test('an unreadable mandatory project remains unfinished after saving every known payload',async t=>{
  const f=await fixture(t),rpc=rpcFor(f),request=rpc.request.bind(rpc);
  rpc.request=path=>path.includes('/g-p-hidden/conversations')?Promise.resolve({status:404,identity:'user'}):request(path);
  const worker=new BrowserWorker(rpc,f.store,settings(f,{initialMaxPerRun:100,initialDirectoryPages:100000}));
  try{await worker.run();assert.equal(f.store.status().pending,0);assert.ok(initialSyncPending(f.store));
    assert.equal(f.store.meta('initial_sync_completed_at'),null);assert.ok(dashboardStatus(f.store).runtime.scopeIssues.some(s=>s.scope==='project:g-p-hidden'&&!s.done));
  }finally{await worker.close();}
});

test('legacy complete archives keep payloads, consumer positions and connections without another initial download',async t=>{
  const f=await fixture(t);await sync(f.api,f.store);f.store.meta('source_identity','user:personal');f.store.meta('connected_providers','[{"provider":"chatgpt","workspace":null,"authuser":0}]');
  // A later successful incremental scan must not erase proof of the earlier full scan.
  const latest=JSON.parse(f.store.meta('discovery'));latest.full=false;f.store.meta('discovery',JSON.stringify(latest));
  const offered=f.store.changes('existing-client',10);f.store.ack('existing-client',offered.through);const before=f.store.read('chat-0');
  const worker=new BrowserWorker(rpcFor(f),f.store,settings(f));
  try{assert.equal(f.store.meta('sync_phase'),'maintenance');assert.deepEqual(f.store.read('chat-0'),before);
    assert.equal(f.store.changes('existing-client',10).after,offered.through);assert.equal(f.store.meta('source_identity'),'user:personal');assert.match(f.store.meta('connected_providers'),/chatgpt/);
  }finally{await worker.close();}
});

test('initial defaults accelerate only first sync and successful windows gradually reach the minimum',async t=>{
  const f=await fixture(t),config=workerConfig({db:f.db,account:'test',extensionId:'a'.repeat(32)});
  assert.equal(config.initialPaceMs,3000);assert.equal(config.initialMinPaceMs,2000);assert.equal(config.initialMaxPerRun,100);assert.equal(config.initialDirectoryPages,10);
  f.store.meta('sync_phase','initial');f.store.meta('effective_pace_ms',6000);f.store.meta('rate_limit_strikes',2);
  for(let i=0;i<19;i++)assert.equal(successfulRequest(f.store,config),6000);
  assert.equal(successfulRequest(f.store,config),4800);assert.equal(f.store.meta('rate_limit_strikes'),'1');
  for(let i=0;i<200;i++)successfulRequest(f.store,config);assert.equal(f.store.meta('effective_pace_ms'),'2000');
  f.store.meta('sync_phase','maintenance');assert.equal(successfulRequest(f.store,config),90000);
});

test('account lease covers login as well as directory/body dispatches, preventing overlapping native workers',async t=>{
  const f=await fixture(t);let entered,release;const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r),rpc=rpcFor(f),request=rpc.request.bind(rpc);
  rpc.request=async path=>{if(path==='/api/auth/session'){entered();await hold;}return request(path);};
  const first=new BrowserWorker(rpc,f.store,settings(f)),secondRpc=rpcFor(f),second=new BrowserWorker(secondRpc,f.store,settings(f));
  try{const running=first.run();await ready;await second.run();assert.equal(secondRpc.paths.length,0);release();await running;assert.equal(f.store.status().fullTrees,11);}
  finally{release();await first.close();await second.close();}
});

test('isolated login cache reduces auth calls and invalidates on TTL, scope, focus and authorization failures',async()=>{
  let now=1000,user='one',status=200;const calls=[],events={},document={cookie:'_account=personal'};
  const context=vm.createContext({document,location:{origin:'https://chatgpt.com'},AbortSignal,TextEncoder,Date:class extends Date{static now(){return now;}},
    addEventListener:(name,fn)=>events[name]=fn,async fetch(path){calls.push(path);
      if(path==='/api/auth/session')return {ok:true,json:async()=>({accessToken:'secret-'+user,user:{id:user}})};
      return {ok:status===200,status,headers:{get:key=>key==='content-type'?'application/json':null},text:async()=>JSON.stringify(tree('x'))};}});
  const request=vm.runInContext('('+pageRequest.toString()+')',context);
  await request('/backend-api/conversation/x');await request('/backend-api/conversation/x');assert.equal(calls.filter(p=>p==='/api/auth/session').length,1);
  now+=30001;await request('/backend-api/conversation/x');assert.equal(calls.filter(p=>p==='/api/auth/session').length,2);
  user='two';document.cookie='_account=another';assert.equal((await request('/backend-api/conversation/x')).identity,'two');
  await request('/backend-api/conversation/x','workspace');events.focus();await request('/backend-api/conversation/x','workspace');
  assert.equal(calls.filter(p=>p==='/api/auth/session').length,5);
  status=401;await request('/backend-api/conversation/x','workspace');status=200;await request('/backend-api/conversation/x','workspace');
  assert.equal(calls.filter(p=>p==='/api/auth/session').length,6);
  const api=await new BrowserTransport({request},{paceMs:0,workspace:'workspace'}).initialize();user='three';events.storage();
  await assert.rejects(api.request('/backend-api/conversation/x'),{status:403});api.close();
  assert.equal(JSON.stringify(await request('/api/auth/session')).includes('secret-'),false);
});

test('scope changes while a cached request is in flight discard its payload before storage',async()=>{
  const document={cookie:'_account=first'};
  const context=vm.createContext({document,location:{origin:'https://chatgpt.com'},AbortSignal,TextEncoder,async fetch(path){
    if(path==='/api/auth/session')return {ok:true,json:async()=>({accessToken:'secret',user:{id:'user'}})};
    document.cookie='_account=second';return {ok:true,status:200,headers:{get:()=> 'application/json'},text:async()=>JSON.stringify(tree('x'))};}});
  const request=vm.runInContext('('+pageRequest.toString()+')',context),response=await request('/backend-api/conversation/x');
  assert.equal(response.status,403);assert.equal(response.data,undefined);
});
