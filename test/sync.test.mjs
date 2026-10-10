import test from 'node:test';
import assert from 'node:assert/strict';
import {sync} from '../src/sync.mjs';
import {snapshot} from '../src/model.mjs';
import {Store} from '../src/store.mjs';
import {HttpTransport,ApiError} from '../src/transport.mjs';
import {fixture,tree} from './fixtures.mjs';

test('full discovery crosses 50 chats, clamped pages, archive and project cursors; raw branches and long text survive',async t=>{
  const f=await fixture(t),result=await sync(f.api,f.store,{full:true});
  assert.equal(result.ok,true);assert.equal(result.fetched,68);assert.equal(f.store.status().threads,68);assert.equal(f.store.status().messages,272);
  const raw=f.store.read('chat-0').raw;assert.equal(raw.mapping.user.message.content.parts[0].length,25009);
  assert.equal(raw.mapping.user.message.metadata.attachments[0].id,'file-x');assert.ok(raw.mapping.descendant);assert.equal(f.store.search('branch descendant',100).length,68);
  assert.ok(f.requests.some(x=>x.includes('offset=56')));assert.ok(f.requests.some(x=>x.includes('cursor=sidebar-2')));assert.ok(f.requests.some(x=>x.includes('g-p-hidden/conversations')));
  const details=f.requests.filter(x=>x.startsWith('/backend-api/conversation/')).length;
  const rerun=await sync(f.api,f.store);assert.equal(rerun.fetched,0);assert.equal(rerun.changedMessages,0);
  assert.equal(f.requests.filter(x=>x.startsWith('/backend-api/conversation/')).length,details);
});
test('incremental sync detects edits with stable IDs, new chats and new conversations in old projects',async t=>{
  const f=await fixture(t);await sync(f.api,f.store,{full:true});const first=f.store.changes('codex',500);f.store.ack('codex',first.through);
  const changed=f.records.get('chat-59');changed.mapping.answer.message.content.parts=['edited answer'];changed.update_time=Date.now()/1000+1;
  f.records.set('new-chat',tree('new-chat'));f.active.unshift('new-chat');
  f.records.set('new-project-chat',tree('new-project-chat'));f.projects.get('g-p-empty').push('new-project-chat');
  const run=await sync(f.api,f.store);assert.equal(run.ok,true);assert.equal(run.fetched,3);assert.equal(run.changedMessages,9);
  assert.equal(f.store.read('chat-59').revision,2);assert.equal(f.store.read('chat-59',1).raw.mapping.answer.message.content.parts[0],'main answer');
  const delta=f.store.changes('codex',500);assert.equal(delta.items.length,9);assert.equal(delta.items.filter(x=>x.kind==='modified').length,1);
  assert.equal(f.store.changes('codex',500).through,delta.through);assert.throws(()=>f.store.ack('codex',delta.through+1));f.store.ack('codex',delta.through);
  assert.equal(f.store.changes('codex').items.length,0);assert.equal(f.store.changes('second',500).items.length,281);
});
test('failed payload remains pending across process restart; failed directory does not advance watermark',async t=>{
  const f=await fixture(t);f.failDetail.add('chat-10');const initial=await sync(f.api,f.store,{full:true});
  assert.equal(initial.ok,false);assert.equal(initial.pending,1);const watermark=f.store.meta('watermark');assert.ok(watermark);
  f.failDetail.clear();const reopened=new Store(f.db,'test');try{const retry=await sync(f.api,reopened);assert.equal(retry.fetched,1);assert.equal(retry.pending,0);}finally{reopened.close();}
  const before=f.store.meta('watermark');f.directoryFailure=true;const failure=await sync(f.api,f.store);assert.equal(failure.ok,false);assert.equal(f.store.meta('watermark'),before);
});
test('batch responses with incomplete branches fall back to individual raw requests',async t=>{
  const f=await fixture(t);f.batchTruncated=true;const run=await sync(f.api,f.store,{full:true,batch:true});
  assert.equal(run.ok,true);assert.equal(run.batchFallbacks,68);assert.equal(f.store.status().fullTrees,68);assert.ok(f.store.read('project-3').raw.mapping.descendant);
});
test('valid batch responses reduce detail requests and preserve full trees',async t=>{
  const f=await fixture(t);const run=await sync(f.api,f.store,{full:true,batch:true});assert.equal(run.ok,true);assert.equal(run.batchFallbacks,0);
  assert.equal(f.requests.filter(x=>x.startsWith('/backend-api/conversations/batch')).length,7);assert.equal(f.requests.filter(x=>x.startsWith('/backend-api/conversation/')).length,0);
});
test('old changed chat outside overlap is found by full directory reconciliation',async t=>{
  const f=await fixture(t);for(const raw of f.records.values())raw.update_time-=86400*10;await sync(f.api,f.store,{full:true});
  const raw=f.records.get('chat-59');raw.mapping.answer.message.content.parts=['old edit'];raw.update_time+=1;
  assert.equal((await sync(f.api,f.store)).fetched,0);const full=await sync(f.api,f.store,{full:true});assert.equal(full.fetched,1);assert.equal(f.store.read('chat-59').revision,2);
});
test('transactions roll back revision, messages and events; accounts and leases remain isolated',async t=>{
  const f=await fixture(t);const raw=tree('atomic');f.store.save(snapshot(raw,'atomic'));
  const other=new Store(f.db,'other');try{assert.equal(other.read('atomic'),null);assert.equal(other.search('content').length,0);assert.equal(other.changes('consumer').items.length,0);}finally{other.close();}
  f.store.db.exec("CREATE TEMP TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
  raw.mapping.answer.message.content.parts=['changed'];assert.throws(()=>f.store.save(snapshot(raw,'atomic')),/injected failure/);
  assert.equal(f.store.read('atomic').revision,1);assert.equal(f.store.changes('consumer').items.length,4);
  f.store.db.exec('DROP TRIGGER fail_message');f.store.acquire('first');assert.throws(()=>f.store.acquire('second'),/already running/);f.store.release('first');f.store.acquire('second');f.store.release('second');
});
test('bounded reads cannot downgrade full trees; invalid trees fail before ingestion',async t=>{
  const f=await fixture(t);const raw=tree('checked');f.store.save(snapshot(raw,'checked'));
  assert.throws(()=>f.store.save(snapshot(raw,'checked','bounded-text')),/Cannot replace/);delete raw.mapping.descendant;assert.throws(()=>snapshot(raw,'checked'),/missing child/);
  const cycle=tree('cycle');cycle.mapping.root.parent='descendant';cycle.mapping.descendant.children=['root'];assert.throws(()=>snapshot(cycle,'cycle'),/Cyclic/);
});
test('secondary project index discovers chats absent from global lists and sidebar',async t=>{
  const f=await fixture(t);f.optionalProjects=['g-p-extra'];f.projects.set('g-p-extra',['extra-chat']);f.records.set('extra-chat',tree('extra-chat'));
  const run=await sync(f.api,f.store,{full:true});assert.equal(run.ok,true);assert.equal(run.fetched,69);assert.ok(f.store.read('extra-chat'));
  assert.ok(run.discovery.projectProbes.some(x=>x.endpoint==='/backend-api/projects' && x.available));
});
test('refresh finds edits with unchanged timestamps and a bounded run preserves pending work',async t=>{
  const f=await fixture(t);const limited=await sync(f.api,f.store,{max:2});assert.equal(limited.fetched,2);assert.equal(limited.pending,66);assert.equal(limited.ok,false);
  await sync(f.api,f.store);f.records.get('chat-59').mapping.answer.message.content.parts=['silent edit'];
  assert.equal((await sync(f.api,f.store)).fetched,0);const refresh=await sync(f.api,f.store,{refresh:true});assert.equal(refresh.fetched,68);assert.equal(refresh.changedMessages,1);
});
test('daily reconciliation discovers old-timestamp new chats; removals retain historical snapshots',async t=>{
  const f=await fixture(t);for(const record of f.records.values())record.update_time-=864000;
  await sync(f.api,f.store);const raw=tree('old-new',undefined,Date.now()/1000-1728000);f.records.set('old-new',raw);f.active.push('old-new');
  assert.equal((await sync(f.api,f.store)).fetched,0);f.store.meta('last_full_scan',new Date(Date.now()-90000000).toISOString());assert.equal((await sync(f.api,f.store)).fetched,1);
  const before=f.store.changes('removal',500);f.store.ack('removal',before.through);
  raw.mapping.user.children=['answer'];delete raw.mapping.alternate;delete raw.mapping.descendant;f.store.save(snapshot(raw,'old-new'));
  const events=f.store.changes('removal');assert.equal(events.items.filter(x=>x.kind==='removed').length,2);assert.equal(f.store.read('old-new',1).raw.mapping.descendant.id,'descendant');
});
test('HTTP retry recovers a transient failure while wrong-ID payloads never enter the store',async t=>{
  const f=await fixture(t);f.api.retries=1;f.failCounts.set('chat-0',1);assert.equal((await f.api.request('/backend-api/conversation/chat-0')).conversation_id,'chat-0');
  assert.equal(f.requests.filter(x=>x==='/backend-api/conversation/chat-0').length,2);
  f.records.get('chat-5').conversation_id='wrong-chat';const run=await sync(f.api,f.store);assert.equal(run.ok,false);assert.equal(run.pending,1);assert.equal(f.store.read('chat-5'),null);
});
test('persistent HTTP 429 pauses detail enumeration and pending work resumes with a new transport',async t=>{
  const f=await fixture(t),original=f.api.once.bind(f.api);f.api.retries=3;let details=0;
  f.api.once=async(path,...args)=>path.startsWith('/backend-api/conversation/')&&++details>1?{status:429}:original(path,...args);
  const run=await sync(f.api,f.store,{full:true,concurrency:1});
  assert.equal(run.fetched,1);assert.equal(run.pending,67);assert.equal(run.paused.reason,'rate-limit');assert.equal(details,2);
  await assert.rejects(f.api.request('/backend-api/conversation/chat-20'),{status:429});assert.equal(details,2);
  const fresh=new HttpTransport({base:f.api.base,pace:0,retries:0});try{
    const resumed=await sync(fresh,f.store,{concurrency:1});assert.equal(resumed.ok,true);assert.equal(resumed.fetched,67);
  }finally{fresh.close();}
});
test('a rate-limited batch stops later batches without losing pending chats',async t=>{
  const f=await fixture(t),original=f.api.request.bind(f.api);let batches=0;
  f.api.request=async(path,...args)=>{if(path==='/backend-api/conversations/batch'){batches++;throw new ApiError(429,path);}return original(path,...args);};
  const run=await sync(f.api,f.store,{batch:true});assert.equal(batches,1);assert.equal(run.fetched,0);assert.equal(run.pending,68);assert.equal(run.paused.status,429);
});
