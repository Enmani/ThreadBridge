import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {snapshot} from '../src/model.mjs';
import {providerSnapshot} from '../src/providers.mjs';
import {saveImportedText} from '../src/imported-archive.mjs';
import {acceptBrowserCapture} from '../src/browser-archive.mjs';
import {indexStatus,updateIndex,indexWake,indexZoom,indexSearch,summaryTasks,saveSummary} from '../src/chat-index.mjs';
import {createDashboard} from '../src/dashboard-server.mjs';
import {fixture,tree} from './fixtures.mjs';

test('the binary index keeps old edits, removed branches, exact chunk offsets and all archive sources',async t=>{
  const {store}=await fixture(t),raw=tree('history','旧版问题 '+ '😀'.repeat(4200),1);
  store.save(snapshot(raw,'history'));const next=structuredClone(raw);next.update_time=2;next.mapping.user.message.content.parts=['新版问题'];
  delete next.mapping.descendant;next.mapping.alternate.children=[];store.save(snapshot(next,'history'));
  store.meta('source_identity','owner:personal');
  assert.equal(acceptBrowserCapture(store,{kind:'page',id:'history',url:'https://chatgpt.com/c/history',title:'history',identity:'owner',workspace:null,
    messages:[{id:'page1',role:'assistant',text:'浏览补充',html:'',ordinal:0}]},{workspace:null}).ok,true);
  saveImportedText(store,{id:'history',title:'history',url:'https://chatgpt.com/c/history',project:null,
    messages:[{role:'assistant',text:'导出补充',time:'2026-10-10',model:null}]});
  const status=updateIndex(store);assert.equal(status.errors,0);assert.equal(status.pending,0);assert.equal(status.indexed,1);
  const old=indexSearch(store,{query:'旧版问题'}).items[0];assert.equal(old.reference.revision,1);assert.equal(old.reference.start,0);assert.ok([...old.text].length<=2048);
  const rows=store.db.prepare('SELECT text,reference FROM chat_index_chunks WHERE account=? ORDER BY ordinal').all(store.account);
  const parts=rows.filter(r=>JSON.parse(r.reference).source==='native'&&JSON.parse(r.reference).node==='user'&&JSON.parse(r.reference).revision===1);
  assert.equal(parts.map(r=>r.text).join(''),raw.mapping.user.message.content.parts[0]);assert.equal(parts.length,3);
  assert.equal(indexSearch(store,{query:'branch descendant'}).items.length,1);
  assert.equal(indexSearch(store,{query:'新版问题'}).items.length,1);
  assert.equal(indexSearch(store,{query:'浏览补充'}).items[0].reference.coverage,'page-text');
  assert.equal(indexSearch(store,{query:'导出补充'}).items[0].reference.coverage,'export-text');
  for(const n of store.db.prepare('SELECT * FROM chat_index_nodes WHERE account=?').all(store.account))assert.ok([n.left_id,n.right_id].filter(Boolean).length<=2);
  assert.equal(store.read('history',1).raw.mapping.user.message.metadata.attachments[0].name,'sample.pdf');
  assert.ok(indexWake(store,{budget:3}).nodes.length<=3);assert.ok(Buffer.byteLength(JSON.stringify(indexWake(store,{budget:1})))<2048);
});

test('AI tasks work bottom-up, preserve summaries on rebuild and reject stale or concurrent writes',async t=>{
  const {store}=await fixture(t);store.save(snapshot(tree('summary','source text',1),'summary'));updateIndex(store);
  const stale=summaryTasks(store).tasks[0];saveSummary(store,{id:stale.node.id,generation:stale.node.generation,summary:'first summary'});
  assert.throws(()=>saveSummary(store,{id:stale.node.id,generation:stale.node.generation,summary:'second summary'}),/Index changed/);
  let rounds=0;
  while(indexStatus(store).pendingSummaries){const tasks=summaryTasks(store).tasks;assert.ok(tasks.length);for(const task of tasks){assert.ok(task.children.every(c=>c.summary));saveSummary(store,{id:task.node.id,generation:task.node.generation,summary:'摘要 '+task.node.id});}assert.ok(++rounds<30);}
  const root=indexZoom(store,{id:'library'}).node;assert.equal(root.summaryState,'ready');
  updateIndex(store,{rebuild:true});assert.equal(indexZoom(store,{id:'library'}).node.generation,root.generation);assert.equal(indexStatus(store).pendingSummaries,0);
  const next=tree('summary','changed source',2);store.save(snapshot(next,'summary'));
  assert.throws(()=>saveSummary(store,{id:root.id,generation:root.generation,summary:'outdated'}),/Index changed/);
  assert.ok(indexStatus(store).pendingSummaries>0);
  assert.throws(()=>saveSummary(store,{id:'library',generation:indexZoom(store,{id:'library'}).node.generation,summary:'too early'}),/children first/);
});

test('provider and account namespaces isolate trees and disabled indexing retains archives',async t=>{
  const {store,db}=await fixture(t),claude=store.scope('claude');
  store.save(snapshot(tree('same','ChatGPT only'),'same'));
  claude.save(providerSnapshot('claude',{uuid:'same',name:'Claude',chat_messages:[{uuid:'m',sender:'human',text:'Claude only'}]},'same'));
  updateIndex(store);updateIndex(claude);assert.equal(indexSearch(store,{query:'Claude only'}).items.length,0);assert.equal(indexSearch(claude,{query:'Claude only'}).items.length,1);
  const other=new Store(db,'another');try{assert.equal(indexStatus(other).eligible,0);assert.deepEqual(indexWake(other).nodes,[]);}finally{other.close();}
  store.meta('chat_index_enabled',0);store.save(snapshot(tree('same','new text',3),'same'));
  const before=indexStatus(store);assert.equal(updateIndex(store).pending,before.pending);assert.equal(indexStatus(store).indexed,1);
  assert.throws(()=>saveSummary(store,{id:'library',generation:1,summary:'summary'}),/paused/);assert.equal(store.read('same').raw.mapping.user.message.content.parts[0],'new text');
  store.meta('chat_index_enabled',1);assert.equal(updateIndex(store).pending,0);
});

test('imported thread identifiers cannot collide with chunk or branch identifiers',async t=>{
  const {store}=await fixture(t),ids=['a','a/chunk:0','a/0','中文%'];
  for(const id of ids)store.save(snapshot(tree(id,'original '+id,1),id));
  assert.equal(updateIndex(store).indexed,4);
  for(const id of ids){const root=indexZoom(store,{id:'thread:'+encodeURIComponent(id)});assert.equal(root.node.title,id);
    const result=indexSearch(store,{query:'original '+id});assert.ok(result.items.some(r=>r.reference.thread===id));}
});

test('a failed rebuild keeps the previous tree atomically and waits for an explicit retry',async t=>{
  const {store}=await fixture(t);store.save(snapshot(tree('atomic','preserved text',1),'atomic'));updateIndex(store);
  const before=indexZoom(store,{id:'thread:atomic'}).node.generation;
  store.db.exec(`CREATE TRIGGER fail_index BEFORE INSERT ON chat_index_chunks BEGIN SELECT RAISE(ABORT,'injected index failure'); END;`);
  store.save(snapshot(tree('atomic','new text',2),'atomic'));const failed=updateIndex(store);assert.equal(failed.errors,1);assert.equal(failed.pending,1);
  assert.equal(indexZoom(store,{id:'thread:atomic'}).node.generation,before);assert.equal(indexSearch(store,{query:'preserved text'}).items.length,1);
  store.db.exec('DROP TRIGGER fail_index');assert.equal(updateIndex(store).errors,1);assert.equal(updateIndex(store,{rebuild:true}).errors,0);
  assert.equal(indexSearch(store,{query:'new text'}).items.length,1);
});

test('one failed chat does not block summary work for other indexed chats',async t=>{
  const {store}=await fixture(t);store.save(snapshot(tree('good','good text',1),'good'));updateIndex(store);
  store.db.exec(`CREATE TRIGGER fail_one_index BEFORE INSERT ON chat_index_chunks WHEN NEW.thread='bad' BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
  store.save(snapshot(tree('bad','bad text',1),'bad'));assert.equal(updateIndex(store).errors,1);
  const tasks=summaryTasks(store).tasks;assert.ok(tasks.length);assert.ok(tasks.every(t=>t.node.id.startsWith('thread:good')));
  saveSummary(store,{id:tasks[0].node.id,generation:tasks[0].node.generation,summary:'有效聊天摘要'});
  assert.equal(indexStatus(store).errors,1);assert.equal(indexZoom(store,{id:tasks[0].node.id}).node.summary,'有效聊天摘要');
});

test('index settings guard writes and apply across added and future platforms without changing original history',async t=>{
  const f=await fixture(t),stores=new Map(['chatgpt','claude','gemini'].map(p=>[p,f.store.scope(p)])),server=createDashboard(stores);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port,write=(value,origin=base)=>fetch(base+'/api/index',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await fetch(base+'/api/index')).status,200);assert.equal((await fetch(base+'/index-settings.mjs')).status,200);
  const guide=await fetch(base+'/chat-index-guide');assert.equal(guide.status,200);assert.match(await guide.text(),/chat_index/);
  assert.equal((await write({enabled:false},'https://foreign.example')).status,403);
  assert.equal((await write({enabled:false,extra:true})).status,400);assert.equal((await write({rebuild:false})).status,400);
  assert.equal((await write({enabled:false})).status,200);for(const s of stores.values())assert.equal(indexStatus(s).enabled,false);
  assert.equal((await write({enabled:true})).status,200);f.store.save(snapshot(tree('new','local text'),'new'));
  const until=Date.now()+5000;while(indexStatus(f.store).pending&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
  assert.equal(indexStatus(f.store).pending,0);assert.equal(indexStatus(f.store).indexed,1);
});

test('the CLI and local-only MCP expose real search, original chunks and generation-guarded summary writes',async t=>{
  const {store,db}=await fixture(t);store.save(snapshot(tree('protocol','协议测试原文',1),'protocol'));
  const run=args=>{const p=spawnSync(process.execPath,['src/cli.mjs',...args,'--account','test','--db',db],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
  const search=run(['index','--action','search','--query','协议测试']);assert.equal(search.items[0].reference.revision,1);
  const task=run(['index','--action','tasks']).tasks[0],args={id:task.node.id,generation:task.node.generation,summary:'协议检索摘要'};
  const requests=[
    {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'chat_index',arguments:{action:'summary',...args}}},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'chat_index',arguments:{action:'zoom',id:search.items[0].id}}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'chat_index',arguments:{action:'summary',...args}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'chat_index',arguments:{action:'wake',summary:'irrelevant'}}}
  ];
  const p=spawnSync(process.execPath,['src/cli.mjs','serve','--local-only','--account','test','--db',db],{encoding:'utf8',input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n'});
  assert.equal(p.status,0,p.stderr);const replies=p.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies[0].result.isError,undefined);assert.equal(JSON.parse(replies[1].result.content[0].text).text,'协议测试原文');
  assert.equal(replies[2].result.isError,true);assert.equal(replies[3].result.isError,true);
});
