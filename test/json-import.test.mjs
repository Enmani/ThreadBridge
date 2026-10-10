import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {snapshot} from '../src/model.mjs';
import {importJson} from '../src/json-import.mjs';
import {createDashboard} from '../src/dashboard-server.mjs';
import {fixture,tree} from './fixtures.mjs';

const reply=(text,time='2026/10/3 19:35:55',role='Response')=>({role,say:text,time,model:'model'});
const exported=(id='chat-id',messages=[reply('Research answer $$x^2$$')],title='Research')=>({
  metadata:{title,link:'https://chatgpt.com/c/'+id,dates:{exported:'10/3/2026 20:12:21'}},messages});

test('matching is by thread ID, duplicate imports and changed export metadata add no duplicate messages',async t=>{
  const f=await fixture(t);f.store.discover({id:'chat-id',title:'Current title',project:'g-p-main',scope:'active',updated:'2026-10-03T18:00:00Z'});
  f.store.meta('sync_paused',1);const first=importJson(f.store,exported());
  assert.equal(first.matchedThreads,1);assert.equal(first.newThreads,0);assert.equal(first.addedMessages,1);
  const again=exported();again.metadata.dates.exported='new export';again.metadata.title='Older title';
  const repeated=importJson(f.store,again);assert.equal(repeated.addedMessages,0);assert.equal(repeated.duplicateMessages,1);
  assert.equal(f.store.thread('chat-id').title,'Current title');assert.equal(f.store.thread('chat-id').pending,1);
  assert.equal(f.store.listThreads().items[0].projectId,'g-p-main');assert.equal(f.store.meta('sync_paused'),'1');assert.equal(f.requests.length,0);
  const read=f.store.read('chat-id');assert.equal(read.coverage,'export-text');assert.equal(read.raw.messages.length,1);
  assert.equal(read.raw.messages[0].time,'2026-10-03T19:35:55');assert.equal(read.raw.timeZone,null);assert.equal(read.raw.messages[0].idSource,'local-import');
  assert.equal(f.store.search('Research answer')[0].coverage,'export-text');assert.equal(f.store.read('chat-id',1),null);
  const reopened=new Store(f.db,'test');try{assert.equal(reopened.read('chat-id').raw.messages.length,1);}finally{reopened.close();}
});

test('overlapping and reordered exports merge, different times retain distinct messages, and titles never merge different threads',async t=>{
  const f=await fixture(t),one=reply('first','2026/10/3 01:00:00'),two=reply('second','2026/10/3 02:00:00');
  importJson(f.store,exported('old-chat',[one,two]));
  const result=importJson(f.store,exported('old-chat',[two,one,reply('third','2026/10/3 03:00:00'),reply('first','2026/10/3 04:00:00')]));
  assert.equal(result.addedMessages,2);assert.equal(result.duplicateMessages,2);assert.equal(f.store.read('old-chat').raw.messages.length,4);
  assert.equal(importJson(f.store,exported('new-chat',[one])).newThreads,1);assert.equal(f.store.status().threads,2);
  const different=new Store(f.db,'other');try{assert.equal(importJson(different,exported('old-chat',[one])).addedMessages,1);}finally{different.close();}
});

test('text imports preserve full trees, skip exact existing replies and remain searchable after a full capture arrives',async t=>{
  const f=await fixture(t),raw=tree('full','question',200000);f.store.save(snapshot(raw,'full'));const before=f.store.read('full').raw;
  const same=importJson(f.store,exported('full',[reply('main answer')]));assert.equal(same.duplicateMessages,1);assert.equal(same.addedMessages,0);
  importJson(f.store,exported('full',[reply('A new result')]));assert.deepEqual(f.store.read('full').raw,before);
  assert.equal(f.store.read('full').importedArchive.raw.messages.length,1);assert.equal(f.store.status().fullTrees,1);
  const later=tree('full','question',300000);later.mapping.answer.message.content.parts=['A new result'];f.store.save(snapshot(later,'full'));
  assert.equal(f.store.search('A new result').length,1);assert.equal(f.store.listThreads({query:'full'}).items[0].importedArchive.additionalMessages,0);
});

test('invalid input and a later database failure roll back the complete file; HTML and LaTeX remain literal data',async t=>{
  const f=await fixture(t);assert.throws(()=>importJson(f.store,[exported('first'),exported('second',[{role:'__proto__',say:'bad'}])]),/invalid-message/);
  assert.equal(f.store.status().threads,0);
  for(const link of ['https://evil.example/c/first','https://chatgpt.com/share/shared-id','']){
    const value=exported();value.metadata.link=link;assert.throws(()=>importJson(f.store,value),/missing-thread-id/);
  }
  const conflict={...exported(),id:'different'};assert.throws(()=>importJson(f.store,conflict),/conflicting-thread-id/);
  f.store.db.exec(`CREATE TRIGGER fail_later BEFORE INSERT ON imported_messages WHEN NEW.thread='second' BEGIN SELECT RAISE(ABORT,'injected'); END;`);
  assert.throws(()=>importJson(f.store,[exported('first'),exported('second')]),/injected/);assert.equal(f.store.status().threads,0);
  assert.equal(f.store.meta('last_json_import'),null);assert.equal(f.store.changes('reader').items.length,0);
  const text='<script>alert(1)</script>\n\\frac{1}{2}';importJson(f.store,exported('safe',[reply(text)]));assert.equal(f.store.read('safe').raw.messages[0].text,text);
});

test('raw exports retain real IDs and branches, are idempotent, and do not roll back newer complete content',async t=>{
  const f=await fixture(t),raw=tree('raw','latest',200000);
  assert.equal(importJson(f.store,[raw]).addedMessages,4);assert.equal(importJson(f.store,[raw]).duplicateMessages,4);
  assert.equal(f.store.read('raw').raw.mapping.descendant.parent,'alternate');
  const older=importJson(f.store,tree('raw','older',100000));assert.equal(older.items[0].older,true);
  assert.equal(f.store.read('raw').raw.mapping.user.message.content.parts[0],'latest');
});

test('imported text is readable as the primary archive while different browser representations retain their provenance',async t=>{
  const f=await fixture(t);f.store.discover({id:'source',title:'Source',updated:null,scope:'browser'});
  f.store.db.prepare('INSERT INTO browser_archives VALUES(?,?,?,?,?,?,?)').run('test','source','Source','https://chatgpt.com/c/source',null,1,new Date().toISOString());
  f.store.db.prepare('INSERT INTO browser_snapshots VALUES(?,?,?,?,?)').run('test','source',1,JSON.stringify({messages:[{id:'original-id',text:'Browser rendering'}]}),new Date().toISOString());
  importJson(f.store,exported('source',[reply('Export text')]));
  const read=f.store.read('source');assert.equal(read.coverage,'export-text');assert.equal(read.raw.messages[0].text,'Export text');
  assert.equal(read.browserArchive.raw.messages[0].id,'original-id');
});

test('local import endpoint is same-origin, bounded, UTF-8 only, and invalid requests cannot write data',async t=>{
  const f=await fixture(t),server=createDashboard(f.store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));const base='http://127.0.0.1:'+server.address().port;
  const post=(body,extra={})=>fetch(base+'/api/import',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...extra},body});
  assert.equal((await post(JSON.stringify(exported()),{Origin:'https://foreign.example'})).status,403);
  assert.equal((await fetch(base+'/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await post('{}',{'Content-Type':'text/plain'})).status,415);assert.equal((await post('broken')).status,400);
  assert.equal((await post(Buffer.from([0x7b,0x22,0xff,0x22,0x3a,0x31,0x7d]))).status,400);
  assert.equal(f.store.status().threads,0);
  const response=await post('\uFEFF'+JSON.stringify(exported()));assert.equal(response.status,200);assert.equal((await response.json()).addedMessages,1);
  assert.equal((await post(JSON.stringify(exported()))).status,200);assert.equal(f.store.read('chat-id').raw.messages.length,1);
  const control=await fetch(base+'/api/control',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({paused:true})});assert.equal(control.status,200);
});

test('provided exporter file imports all 35 replies once and preserves the formula source',{skip:!process.env.THREADBRIDGE_IMPORT_FIXTURE},()=>{
  const file=process.env.THREADBRIDGE_IMPORT_FIXTURE;
  const store=new Store(':memory:','fixture');try{
    const raw=JSON.parse(readFileSync(file,'utf8')),first=importJson(store,raw),again=importJson(store,raw);
    assert.equal(first.addedMessages,35);assert.equal(again.addedMessages,0);assert.equal(again.duplicateMessages,35);
    const archive=store.read(first.items[0].id);assert.equal(archive.raw.messages.length,35);
    assert.ok(archive.raw.messages.some(m=>m.text.includes('$$')));assert.equal(store.status().fullTrees,0);
  }finally{store.close();}
});
