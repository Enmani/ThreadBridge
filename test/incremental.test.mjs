import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {summary,snapshot} from '../src/model.mjs';
import {discover} from '../src/discovery.mjs';
import {sync} from '../src/sync.mjs';
import {BrowserTransport} from '../src/browser-transport.mjs';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {ApiError,HttpTransport} from '../src/transport.mjs';
import {fixture,tree} from './fixtures.mjs';

test('assistant timestamp alone detects a changed stable thread ID and puts the newest reply first',async t=>{
  const f=await fixture(t);await sync(f.api,f.store);const before=f.store.status().threads,raw=f.records.get('chat-59');
  raw.latest_assistant_turn_created_at=new Date(Date.now()+5000).toISOString();raw.mapping.answer.message.content.parts=['new assistant response'];
  const base=f.api.request.bind(f.api);f.api.request=async p=>{const data=await base(p);
    if(p.startsWith('/backend-api/conversations?'))for(const item of data.items){const r=f.records.get(item.id);if(r.latest_assistant_turn_created_at)item.latest_assistant_turn_created_at=r.latest_assistant_turn_created_at;}return data;};
  const run=await sync(f.api,f.store);assert.equal(run.fetched,1);assert.equal(run.changedMessages,1);assert.equal(f.store.status().threads,before);
  assert.equal(f.store.thread('chat-59').synced_assistant,raw.latest_assistant_turn_created_at);assert.equal((await sync(f.api,f.store)).fetched,0);
  f.store.discover(summary({id:'older',update_time:1,latest_assistant_turn_created_at:Date.now()/1000+30},'active'));
  f.store.discover(summary({id:'newer',update_time:Date.now()/1000},'active'));assert.equal(f.store.pending()[0].id,'older');
});

test('repeated last message IDs do not hide edits; last message and assistant cursors persist',async t=>{
  const f=await fixture(t),raw=tree('cursor');f.store.save(snapshot(raw,'cursor'));assert.equal(f.store.thread('cursor').last_message_id,'a');
  assert.equal(f.store.thread('cursor').last_assistant_id,'a');raw.mapping.answer.message.content.parts=['same ID, edited text'];
  const change=f.store.save(snapshot(raw,'cursor'));assert.equal(change.changed,1);assert.equal(change.revision,2);
  const reopened=new Store(f.db,'test');try{assert.equal(reopened.thread('cursor').last_message_id,'a');assert.equal(reopened.read('cursor').revision,2);}finally{reopened.close();}
});

test('an old inactive thread rises to the front on update and merges into its original thread',async t=>{
  const f=await fixture(t);for(const r of f.records.values())r.update_time-=864000;await sync(f.api,f.store);const count=f.store.status().threads;
  const raw=f.records.get('chat-59');raw.update_time=Date.now()/1000+1;raw.mapping.answer.message.content.parts=['revived old thread'];
  const run=await sync(f.api,f.store);assert.equal(run.fetched,1);assert.equal(f.store.status().threads,count);assert.equal(f.store.read('chat-59').revision,2);
  assert.equal(run.discovery.scopes.find(x=>x.scope==='active').stopReason,'time-boundary');
});

test('a cached first row does not stop discovery of another changed row in the same page',async t=>{
  const f=await fixture(t);await sync(f.api,f.store);const raw=f.records.get('chat-1');raw.update_time+=0.1;raw.mapping.answer.message.content.parts=['changed second'];
  const run=await sync(f.api,f.store);assert.equal(run.fetched,1);assert.equal(f.store.read('chat-1').revision,2);assert.ok(run.discovery.unchanged>0);
});

test('unordered pages disable the time boundary so a newer thread on a later page is not missed',async t=>{
  const f=await fixture(t);for(const r of f.records.values())r.update_time-=864000;await sync(f.api,f.store);
  const original=f.api.request.bind(f.api);f.records.get('chat-59').mapping.answer.message.content.parts=['late page update'];
  f.records.get('chat-59').update_time+=0.1;
  f.api.request=async p=>{const data=await original(p);if(p.includes('is_archived=false')&&p.includes('offset=0&'))data.items.reverse();return data;};
  const run=await sync(f.api,f.store);assert.equal(run.fetched,1);const scope=run.discovery.scopes.find(x=>x.scope==='active');
  assert.equal(scope.ordered,false);assert.equal(scope.stopReason,'empty-page');assert.equal(f.store.read('chat-59').revision,2);
});

test('missing list timestamps use a daily fallback rather than downloading on every scan',async t=>{
  const f=await fixture(t),raw=tree('no-version');f.store.discover(summary({id:'no-version'},'active'));f.store.save(snapshot(raw,'no-version'));
  f.store.discover(summary({id:'no-version'},'active'));assert.equal(f.store.thread('no-version').pending,0);
  f.store.db.prepare('UPDATE threads SET last_checked_at=? WHERE id=?').run(new Date(Date.now()-90000000).toISOString(),'no-version');
  f.store.discover(summary({id:'no-version'},'active'));assert.equal(f.store.thread('no-version').pending,1);
});

test('bounded discovery commits page cursors and resumes the next page after reopening SQLite',async t=>{
  const f=await fixture(t);const first=await sync(f.api,f.store,{maxDirectoryPages:1,max:2});
  assert.equal(first.fetched,2);assert.equal(first.discovery.budgetExhausted,true);assert.equal(f.store.meta('watermark'),null);
  const reopened=new Store(f.db,'test'),at=f.requests.length;try{
    const second=await sync(f.api,reopened,{maxDirectoryPages:1,max:2});assert.equal(second.discovery.resuming,true);
    assert.equal(f.requests[at].includes('offset=7&'),true);assert.equal(second.fetched,2);
    assert.equal(JSON.parse(reopened.meta('directory_scan')).jobs.find(j=>j.scope==='active').offset,14);
    assert.equal(reopened.status().activeScan.scopes.find(j=>j.scope==='active').nextOffset,14);
  }finally{reopened.close();}
});

test('a directory 429 retains the failed page cursor; a new process does not repeat completed pages',async t=>{
  const f=await fixture(t),original=f.api.request.bind(f.api);f.api.request=async p=>{
    if(p.includes('is_archived=false')&&p.includes('offset=7&')){const e=new ApiError(429,p);f.api.stopped=e;throw e;}return original(p);};
  const first=await sync(f.api,f.store);assert.equal(first.paused.status,429);assert.equal(f.store.meta('watermark'),null);
  assert.equal(JSON.parse(f.store.meta('directory_scan')).jobs[0].offset,7);
  const fresh=new HttpTransport({base:f.api.base,pace:0,retries:0}),at=f.requests.length;
  try{await sync(fresh,f.store,{maxDirectoryPages:1,max:1});assert.equal(f.requests[at].includes('offset=7&'),true);}finally{fresh.close();}
});

test('project directories are deferred until due while new ordinary threads remain discoverable',async t=>{
  const f=await fixture(t);await sync(f.api,f.store);f.records.set('new-ordinary',tree('new-ordinary'));f.active.unshift('new-ordinary');
  const at=f.requests.length,run=await sync(f.api,f.store,{projectIntervalMs:3600000});assert.equal(run.fetched,1);
  assert.equal(f.requests.slice(at).some(p=>/\/gizmos\/g-p-.*\/conversations/.test(p)),false);assert.ok(run.discovery.deferredProjects>0);
  f.records.set('new-project',tree('new-project'));f.projects.get('g-p-empty').push('new-project');
  f.store.meta('directory_scope:project:g-p-empty',JSON.stringify({watermark:new Date(Date.now()-7200000).toISOString()}));
  assert.equal((await sync(f.api,f.store,{projectIntervalMs:3600000})).fetched,1);assert.ok(f.store.read('new-project'));
});

test('recent-head checks find new threads while an initial history page cursor remains unfinished',async t=>{
  const f=await fixture(t);await sync(f.api,f.store,{maxDirectoryPages:1,max:1});
  f.store.meta('directory_head:active',new Date(Date.now()-1200000).toISOString());
  f.records.set('urgent-new',tree('urgent-new',undefined,Date.now()/1000+2));f.active.unshift('urgent-new');
  const at=f.requests.length,run=await sync(f.api,f.store,{maxDirectoryPages:1,max:1,directoryIntervalMs:900000});
  assert.equal(f.requests[at].includes('offset=0&'),true);assert.ok(f.store.read('urgent-new'));
  const state=JSON.parse(f.store.meta('directory_scan'));assert.equal(state.jobs.find(j=>j.scope==='active').offset,7);
  assert.ok(run.discovery.scopes.some(s=>s.scope==='active:recent'));
});

test('request pacing survives transport replacement and long queued waits can be cancelled',async t=>{
  const f=await fixture(t),starts=[];const rpc={async request(){starts.push(Date.now());return {status:200,identity:'user',data:{items:[]}};}};
  const settings={paceMs:30,onRequestStart:at=>f.store.meta('next_request_at',at)};
  const first=await new BrowserTransport(rpc,settings).initialize();await first.request('/backend-api/projects');first.close();
  const due=Number(f.store.meta('next_request_at')),second=await new BrowserTransport(rpc,{...settings,nextRequestAt:due}).initialize();
  assert.ok(starts.at(-1)>=due);second.close();
  const cancelled=new BrowserTransport(rpc,{paceMs:90000,nextRequestAt:Date.now()+90000});const pending=cancelled.initialize();cancelled.close();
  await assert.rejects(pending,/closed/);assert.equal(starts.length,3);
});

test('background defaults and rate-limit slowdowns are durable and do not start another request early',async t=>{
  const f=await fixture(t),defaults=workerConfig({db:f.db,account:'test',extensionId:'a'.repeat(32)});
  assert.equal(defaults.paceMs,90000);assert.equal(defaults.directoryIntervalMs,900000);assert.equal(defaults.projectIntervalMs,3600000);
  assert.equal(defaults.maxDirectoryPages,3);assert.equal(defaults.maxPerRun,5);
  assert.equal(defaults.cooldownMs,120000);
  const rpc={closed:false,send(){},async request(p){return p==='/api/auth/session'?{status:200,identity:'user'}:{status:429,identity:'user'};}};
  const before=Date.now(),worker=new BrowserWorker(rpc,f.store,{...defaults,paceMs:20,initialPaceMs:20,initialMinPaceMs:20});try{
    await worker.run();assert.equal(f.store.meta('effective_pace_ms'),'40');assert.equal(f.store.meta('worker_state'),'rate-limited');
    assert.ok(Number(f.store.meta('next_run_at'))>=before+120000);
    const again=Date.now();worker.rateLimited({});assert.equal(f.store.meta('effective_pace_ms'),'80');
    assert.ok(Number(f.store.meta('next_run_at'))>=again+240000);
  }finally{worker.close();}
});

test('low-frequency audits read one stale full thread and detect edits with unchanged version metadata',async t=>{
  const f=await fixture(t);await sync(f.api,f.store);const raw=f.records.get('chat-59');raw.mapping.answer.message.content.parts=['silent edit found by audit'];
  f.store.db.prepare('UPDATE threads SET last_checked_at=? WHERE id=?').run(new Date(Date.now()-864000000).toISOString(),'chat-59');
  assert.equal(f.store.audit(new Date(Date.now()-604800000).toISOString()),1);
  const result=await sync(f.api,f.store);assert.equal(result.fetched,1);assert.equal(result.changedMessages,1);assert.equal(f.store.read('chat-59').revision,2);
});

test('legacy database migration preserves snapshots and acknowledgements and backfills last check times',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'legacy.sqlite'),db=new DatabaseSync(file),raw=tree('legacy');
  db.exec(`CREATE TABLE threads(account TEXT,id TEXT,title TEXT,summary TEXT,source_updated TEXT,synced_updated TEXT,pending INTEGER DEFAULT 1,
    coverage TEXT DEFAULT 'not-read',revision INTEGER DEFAULT 0,error TEXT,PRIMARY KEY(account,id));
    CREATE TABLE snapshots(account TEXT,thread TEXT,revision INTEGER,raw TEXT,coverage TEXT,created TEXT,PRIMARY KEY(account,thread,revision));
    CREATE TABLE consumers(account TEXT,name TEXT,ack INTEGER DEFAULT 0,offered INTEGER DEFAULT 0,PRIMARY KEY(account,name));`);
  const at=new Date().toISOString();db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run('test','legacy','legacy','{}',at,at,0,'full-tree',1,null);
  db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?)').run('test','legacy',1,JSON.stringify(raw),'full-tree',at);
  db.prepare('INSERT INTO consumers VALUES(?,?,?,?)').run('test','codex',17,17);db.close();
  const migrated=new Store(file,'test');try{assert.equal(migrated.read('legacy').raw.conversation_id,'legacy');assert.equal(migrated.thread('legacy').last_checked_at,at);
    assert.equal(migrated.db.prepare('SELECT ack FROM consumers WHERE name=?').get('codex').ack,17);
    migrated.save(snapshot(raw,'legacy'),at);assert.equal(migrated.thread('legacy').last_message_id,'a');
  }finally{migrated.close();}
});

test('bounded background batches interleave history pages and details, then finish after worker replacement',async t=>{
  const f=await fixture(t),paths=[],rpc={closed:false,send(){},async request(p){paths.push(p);
    return p==='/api/auth/session'?{status:200,identity:'user'}:{status:200,identity:'user',data:await f.api.request(p)};}};
  const settings=workerConfig({db:f.db,account:'test',extensionId:'a'.repeat(32),paceMs:0,initialPaceMs:0,initialMinPaceMs:0,initialMaxPerRun:5,initialDirectoryPages:3});
  let worker=new BrowserWorker(rpc,f.store,settings);
  try{
    await worker.run();assert.equal(f.store.status().fullTrees,5);
    assert.ok(JSON.parse(f.store.meta('directory_scan')).jobs.some(j=>!j.done));
    worker.close();worker=new BrowserWorker(rpc,f.store,settings);
    for(let i=0;i<20&&f.store.status().fullTrees<68;i++){f.store.meta('next_run_at',0);await worker.run();}
    assert.equal(f.store.status().fullTrees,68);assert.equal(f.store.status().pending,0);
    assert.equal(f.store.meta('directory_scan'),'null');assert.ok(f.store.meta('watermark'));
    assert.equal(f.store.status().activeScan,null);
    const details=paths.filter(p=>p.startsWith('/backend-api/conversation/'));
    assert.equal(details.length,68);assert.equal(new Set(details).size,68);
    assert.equal(paths.filter(p=>p.includes('offset=0&')&&p.includes('is_archived=false')).length,1);
  }finally{worker.close();}
});
