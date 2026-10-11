import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,tree} from './fixtures.mjs';
import {Store} from '../src/store.mjs';
import {sync} from '../src/sync.mjs';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {watchNewThreads,watchNewRequested,startSync} from '../src/sync-control.mjs';
import {createDashboard,dashboardStatus} from '../src/dashboard-server.mjs';

const rpcFor=f=>({closed:false,send(){},async request(path){
  if(path==='/api/auth/session')return {status:200,identity:'user'};
  try{return {status:200,identity:'user',data:await f.api.request(path)};}catch(e){return {status:e.status??503,identity:'user',data:{}};}
}});
const config=f=>workerConfig({initialPaceMs:0,initialMinPaceMs:0,initialMaxPerRun:5,initialDirectoryPages:100000,db:f.db,account:'test',extensionId:'a'.repeat(32),paceMs:0,maxDirectoryPages:100000,projectIntervalMs:0});

test('new-ID watch skips the old body backlog and old edits, discovers new IDs once and waits for another poll',async t=>{
  const f=await fixture(t);await sync(f.api,f.store,{max:0});const old=f.store.thread('chat-0');
  f.records.get('chat-0').title='Changed existing title';f.records.get('chat-0').update_time=Date.now()/1000+10;
  f.records.set('new-watch',tree('new-watch',undefined,Date.now()/1000+20));f.active.unshift('new-watch');
  const before=f.requests.length;watchNewThreads(f.store,true);const worker=new BrowserWorker(rpcFor(f),f.store,config(f));
  try{
    await worker.run();assert.equal(f.store.status().threads,69);assert.equal(f.store.status().messages,0);
    assert.deepEqual(f.store.thread('chat-0'),old);assert.equal(worker.paused,false);assert.equal(f.store.meta('worker_state'),'watching-new');
    assert.equal(dashboardStatus(f.store).runtime.watchNew,true);assert.equal(dashboardStatus(f.store).runtime.complete,false);
    const count=f.requests.length;await worker.run();assert.equal(f.requests.length,count);
    f.store.meta('next_run_at',0);await worker.run();assert.equal(f.store.status().threads,69);
    assert.equal(JSON.parse(f.store.meta('last_run')).discovery.newThreads,0);
    assert.equal(f.requests.slice(before).some(p=>p.startsWith('/backend-api/conversation/')),false);
  }finally{worker.close();}
});

test('new-ID watch discovers archived and project IDs and persists across worker replacement',async t=>{
  const f=await fixture(t);await sync(f.api,f.store,{max:0});
  for(const id of ['archive-new','project-new'])f.records.set(id,tree(id,undefined,Date.now()/1000+1));
  f.archived.unshift('archive-new');f.projects.get('g-p-main').unshift('project-new');watchNewThreads(f.store,true);
  const worker=new BrowserWorker(rpcFor(f),f.store,config(f));try{await worker.run();assert.equal(f.store.status().threads,70);}finally{worker.close();}
  const reopened=new Store(f.db,'test');try{
    assert.equal(watchNewRequested(reopened),true);assert.equal(reopened.meta('sync_paused'),'0');
    const restarted=new BrowserWorker(rpcFor(f),reopened,config(f));const before=f.requests.length;
    try{await restarted.run();assert.equal(f.requests.length,before);assert.equal(restarted.paused,false);}finally{restarted.close();}
  }finally{reopened.close();}
});

test('watch can be paused, disabled and replaced by a full sync without inheriting the new-only directory filter',async t=>{
  const f=await fixture(t);await sync(f.api,f.store,{max:0});watchNewThreads(f.store,true);
  const worker=new BrowserWorker(rpcFor(f),f.store,config(f));try{
    await worker.run();watchNewThreads(f.store,false);await worker.run();assert.equal(worker.paused,true);assert.equal(watchNewRequested(f.store),false);
    startSync(f.store,'full');f.store.meta('next_run_at',0);await worker.run();assert.equal(watchNewRequested(f.store),false);assert.ok(f.store.status().fullTrees>0);
  }finally{worker.close();}
});

test('watch control is exact, same-origin, preserves cooldown and creates no remote requests by itself',async t=>{
  const f=await fixture(t),due=Date.now()+3600000;f.store.meta('rate_limit_strikes',1);f.store.meta('next_run_at',due);
  const server=createDashboard(f.store);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const post=(value,origin=base)=>fetch(base+'/api/control',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await post({watchNew:true},'https://other.example')).status,403);
  for(const value of [{watchNew:1},{watchNew:true,mode:'ids'},{watchNew:true,account:'other'}])assert.equal((await post(value)).status,400);
  const state=await post({watchNew:true}).then(r=>r.json());assert.equal(state.runtime.watchNew,true);assert.equal(state.runtime.mode,'ids');
  assert.equal(f.store.meta('next_run_at'),String(due));assert.equal(f.requests.length,0);
  assert.equal((await post({watchNew:false}).then(r=>r.json())).runtime.paused,true);
});

test('daily directory reconciliation discovers an old-timestamp new ID without reading any body',async t=>{
  const f=await fixture(t);await sync(f.api,f.store,{max:0});watchNewThreads(f.store,true);
  f.records.set('old-stamp-new',tree('old-stamp-new',undefined,1));f.active.push('old-stamp-new');
  f.store.meta('last_full_scan',new Date(Date.now()-2*86400000).toISOString());const before=f.requests.length;
  const worker=new BrowserWorker(rpcFor(f),f.store,config(f));try{
    await worker.run();assert.ok(f.store.thread('old-stamp-new'));assert.equal(JSON.parse(f.store.meta('last_run')).discovery.full,true);
    assert.equal(f.requests.slice(before).some(p=>p.startsWith('/backend-api/conversation/')),false);
  }finally{worker.close();}
});
