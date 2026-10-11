import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Store} from '../src/store.mjs';
import {snapshot,summary} from '../src/model.mjs';
import {createDashboard,dashboardStatus} from '../src/dashboard-server.mjs';
import {sync} from '../src/sync.mjs';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {fixture,tree} from './fixtures.mjs';

test('dashboard lists every archived and pending thread through bounded pages and literal search',async t=>{
  const f=await fixture(t);await sync(f.api,f.store,{max:2});
  assert.equal(f.store.listThreads().total,68);const ids=new Set();
  for(let page=1;page<=4;page++)for(const row of f.store.listThreads({page,limit:20}).items){ids.add(row.id);assert.equal(Object.hasOwn(row,'raw'),false);}
  assert.equal(ids.size,68);assert.equal(f.store.listThreads({query:'chat-0'}).total,1);
  f.store.discover(summary({id:'special',title:'literal %_ title'},'active'));assert.equal(f.store.listThreads({query:'%_'}).total,1);
  assert.throws(()=>f.store.listThreads({page:0}));assert.throws(()=>f.store.listThreads({limit:201}));
});

test('capture status commits with the snapshot and cannot report a rolled-back save as successful',async t=>{
  const f=await fixture(t);f.store.save(snapshot(tree('first'),'first'));const before=f.store.meta('last_capture');
  f.store.db.exec(`CREATE TRIGGER block_capture BEFORE INSERT ON meta WHEN NEW.key='last_capture' BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
  assert.throws(()=>f.store.save(snapshot(tree('second'),'second')),/injected failure/);assert.equal(f.store.read('second'),null);assert.equal(f.store.meta('last_capture'),before);
});

test('dashboard heartbeat and next-request countdown distinguish disconnected and paused workers',async t=>{
  const f=await fixture(t),now=Date.now();f.store.meta('worker_state','syncing');f.store.meta('worker_heartbeat_at',now);f.store.meta('next_request_at',now+90000);
  assert.equal(dashboardStatus(f.store,now).runtime.connected,true);assert.equal(dashboardStatus(f.store,now).runtime.nextAt,now+90000);
  assert.equal(dashboardStatus(f.store,now+45001).runtime.connected,false);f.store.meta('worker_state','paused');assert.equal(dashboardStatus(f.store,now).runtime.nextAt,null);
});

test('local dashboard serves assets and metadata, rejects foreign origins, unsupported writes and unsafe paths',async t=>{
  const f=await fixture(t);f.store.save(snapshot(tree('local'), 'local'));const server=createDashboard(f.store);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  for(const route of ['/','/app.mjs','/labels.mjs','/style.css','/api/status','/api/threads'])assert.equal((await fetch(base+route)).status,200);
  const status=await fetch(base+'/api/status').then(r=>r.json());assert.equal(status.app,'threadbridge');assert.equal(status.fullTrees,1);assert.equal(status.runtime.connected,false);
  const list=await fetch(base+'/api/threads').then(r=>r.json());assert.equal(list.items[0].id,'local');assert.equal(JSON.stringify(list).includes('main answer'),false);
  assert.equal((await fetch(base+'/api/status',{headers:{Origin:'https://foreign.example'}})).status,403);
  const foreignHost=await new Promise((resolve,reject)=>{const request=http.get(base+'/api/status',{headers:{Host:'foreign.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);});
  assert.equal(foreignHost,403);
  assert.equal((await fetch(base+'/api/status',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await fetch(base+'/api/status',{method:'POST'})).status,405);assert.equal((await fetch(base+'/data/authsession.json')).status,404);
  assert.equal((await fetch(base+'/api/threads?page=0')).status,400);
  const policy=(await fetch(base)).headers.get('content-security-policy');
  assert.match(policy, /frame-ancestors http:\/\/127\.0\.0\.1:17322$/);
  assert.equal((await fetch(base+'/api/control',{method:'POST',headers:{Origin:'http://127.0.0.1:17322','Content-Type':'application/json'},body:JSON.stringify({paused:true})})).status,403);
});

test('live request status and each successful save are visible to another database reader before a batch ends',async t=>{
  const f=await fixture(t),reader=new Store(f.db,'test');let sawSave=false,sawRequest=false;
  const rpc={closed:false,send(){},async request(p){
    if(p==='/api/auth/session')return {status:200,identity:'user'};
    const recent=reader.status().lastRequest;if(recent?.path===p&&!recent.finishedAt)sawRequest=true;
    if(p.startsWith('/backend-api/conversation/')&&reader.status().lastCapture)sawSave=true;
    return {status:200,identity:'user',data:await f.api.request(p)};
  }};
  const worker=new BrowserWorker(rpc,f.store,workerConfig({initialPaceMs:0,initialMinPaceMs:0,initialMaxPerRun:2,initialDirectoryPages:100000,db:f.db,account:'test',extensionId:'a'.repeat(32),paceMs:0,maxDirectoryPages:100000,maxPerRun:2}));
  try{await worker.run();assert.equal(sawSave,true);assert.equal(sawRequest,true);assert.equal(reader.status().lastRequest.status,200);assert.equal(reader.status().fullTrees,2);}
  finally{worker.close();worker.close();assert.equal(reader.status().background.heartbeatAt,0);reader.close();}
});
