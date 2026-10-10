import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserTransport} from '../src/browser-transport.mjs';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {fixture} from './fixtures.mjs';

test('a successful history request immediately restores the base interval and its persisted deadline',async()=>{
  const starts=[],deadlines=[];let successes=0;
  const rpc={async request(p){return {status:200,identity:'user',data:{items:[]}};}};
  // Deadlines use the transport's recorded start, before callbacks and RPC dispatch.
  // A separate Date.now() in the RPC mock can cross a millisecond boundary.
  const api=new BrowserTransport(rpc,{paceMs:60,successPaceMs:30,onRequestStart:at=>deadlines.push(at),
    onExchange:request=>{if(request.finishedAt===null)starts.push(request.startedAt);},onHistorySuccess:()=>successes++});
  try{
    await api.initialize();assert.equal(api.pace,60);assert.equal(successes,0);
    await api.request('/backend-api/conversations?offset=0');assert.equal(api.pace,30);assert.equal(successes,1);
    assert.equal(api.next,starts[1]+30);assert.equal(deadlines.at(-1),api.next);
    const due=api.next;await api.request('/backend-api/conversation/example');assert.ok(starts[2]>=due);
    assert.equal(successes,2);
  }finally{api.close();}
});

test('login success, failed history requests and account changes do not reset the slowed interval',async()=>{
  for(const response of [{status:429,identity:'user'},{status:503,identity:'user'},
    {status:404,identity:'user'},{status:200,identity:'another-user'},{status:200},{status:0,identity:'user'}]){
    let successes=0;
    const rpc={async request(p){return p==='/api/auth/session'?{status:200,identity:'user'}:response;}};
    const api=new BrowserTransport(rpc,{paceMs:5,successPaceMs:0,onHistorySuccess:()=>successes++});
    try{
      await api.initialize();assert.equal(api.pace,5);assert.equal(successes,0);
      await assert.rejects(api.request('/backend-api/projects'));assert.equal(api.pace,5);assert.equal(successes,0);
    }finally{api.close();}
  }
});

test('worker resets durable backoff within a batch; a later 429 starts from the base interval again',async t=>{
  const f=await fixture(t),config=workerConfig({db:f.db,account:'test',extensionId:'a'.repeat(32),paceMs:10,maxDirectoryPages:1,maxPerRun:1});
  f.store.meta('effective_pace_ms',40);f.store.meta('rate_limit_strikes',2);let histories=0;
  const rpc={closed:false,send(){},async request(p){
    if(p==='/api/auth/session'){assert.equal(f.store.meta('effective_pace_ms'),'40');assert.equal(f.store.meta('rate_limit_strikes'),'2');return {status:200,identity:'user'};}
    histories++;assert.equal(f.store.meta('effective_pace_ms'),histories===1?'40':'10');
    if(histories>1)assert.equal(f.store.meta('rate_limit_strikes'),'0');
    return {status:200,identity:'user',data:await f.api.request(p)};
  }};
  const worker=new BrowserWorker(rpc,f.store,config);
  try{
    await worker.run();assert.ok(histories>=2);assert.equal(f.store.meta('effective_pace_ms'),'10');assert.equal(f.store.meta('rate_limit_strikes'),'0');
    worker.rateLimited({retryAt:Date.now()+3600000});assert.equal(f.store.meta('effective_pace_ms'),'20');assert.equal(f.store.meta('rate_limit_strikes'),'1');
    assert.ok(Number(f.store.meta('next_run_at'))>=Date.now()+3599000);
    const before=histories;await worker.run();assert.equal(histories,before);
    worker.rateLimited({});assert.equal(f.store.meta('effective_pace_ms'),'40');assert.equal(f.store.meta('rate_limit_strikes'),'2');
  }finally{worker.close();}
});
