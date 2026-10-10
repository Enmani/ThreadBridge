import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {ArchiveOutbox} from '../extension/archive-outbox.js';
import {acceptBrowserCapture} from '../src/browser-archive.mjs';
import {snapshot} from '../src/model.mjs';
import {Store} from '../src/store.mjs';
import {frame,FrameReader} from '../src/browser-frames.mjs';
import {createDashboard} from '../src/dashboard-server.mjs';
import {fixture,tree} from './fixtures.mjs';

const settings={workspace:null};
const page=(id,messages)=>({id,url:'https://chatgpt.com/c/'+id,title:id,kind:'page',project:null,identity:'user-test',workspace:null,messages});
const message=(id,text)=>({id,role:'assistant',text,html:'<p>'+text+'</p>',ordinal:null});
const bind=store=>store.meta('source_identity','user-test:personal');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('scroll fragments merge by original IDs, survive reopening, remain partial and never replace a complete tree',async t=>{
  const f=await fixture(t);bind(f.store);
  assert.equal(acceptBrowserCapture(f.store,page('visible',[message('one','new message')]),settings).ok,true);
  assert.equal(acceptBrowserCapture(f.store,page('visible',[message('old','older loaded text')]),settings).ok,true);
  assert.equal(f.store.read('visible').coverage,'page-text');assert.equal(f.store.read('visible').raw.messages.length,2);
  assert.equal(f.store.status().fullTrees,0);assert.equal(f.store.thread('visible').pending,1);
  assert.equal(acceptBrowserCapture(f.store,page('visible',[message('one','new message')]),settings).changed,0);
  assert.equal(f.store.read('visible',1),null); // Page and tree revision namespaces are independent.
  f.store.save(snapshot(tree('visible'),'visible'));
  const complete=f.store.read('visible').raw;
  acceptBrowserCapture(f.store,page('visible',[message('one','changed message')]),settings);
  assert.deepEqual(f.store.read('visible').raw,complete);assert.equal(f.store.read('visible').browserArchive.raw.messages.length,2);
  assert.equal(f.store.listThreads().items[0].browserArchive.messages,2);
  assert.equal(f.store.search('changed message')[0].coverage,'page-text');
  const reopened=new Store(f.db,'test');try{assert.equal(reopened.read('visible').browserArchive.raw.messages.length,2);}finally{reopened.close();}
});

test('wrong account/workspace, disabled capture and malformed routes cannot write chat data',async t=>{
  const f=await fixture(t),capture=page('guarded',[message('one','private text')]);
  assert.equal(acceptBrowserCapture(f.store,capture,settings).state,'account-not-bound');bind(f.store);
  assert.equal(acceptBrowserCapture(f.store,{...capture,identity:'user-other'},settings).state,'account-mismatch');
  assert.equal(acceptBrowserCapture(f.store,{...capture,workspace:'team'},settings).state,'workspace-mismatch');
  assert.equal(acceptBrowserCapture(f.store,{...capture,workspace:undefined},settings).state,'waiting-account');
  assert.equal(acceptBrowserCapture(f.store,{...capture,url:'https://evil.example/c/guarded'},settings).state,'invalid-capture');
  f.store.meta('browser_archive_enabled',0);assert.equal(acceptBrowserCapture(f.store,capture,settings).state,'disabled');
  assert.equal(f.store.status().threads,0);assert.equal(JSON.stringify(f.store.status()).includes('private text'),false);
});

test('passive complete response preserves branches, rejects late older responses, and capture metadata commits atomically',async t=>{
  const f=await fixture(t);bind(f.store);
  const capture={...page('complete',[]),project:'g-p-design',kind:'tree',raw:tree('complete','newest',200000)};
  assert.equal(acceptBrowserCapture(f.store,capture,settings).ok,true);
  assert.equal(f.store.read('complete').raw.mapping.descendant.parent,'alternate');
  assert.equal(f.store.listThreads().items[0].projectId,'g-p-design');
  assert.equal(acceptBrowserCapture(f.store,{...capture,raw:tree('complete','older',100000)},settings).state,'older');
  assert.equal(f.store.read('complete').raw.mapping.user.message.content.parts[0],'newest');
  const before=f.store.meta('last_browser_capture');
  f.store.db.exec(`CREATE TRIGGER reject_browser_metadata BEFORE INSERT ON meta WHEN NEW.key='last_browser_capture'
    BEGIN SELECT RAISE(ABORT,'test failure'); END;`);
  assert.equal(acceptBrowserCapture(f.store,{...page('atomic',[]),kind:'tree',raw:tree('atomic')},settings).state,'save-failed');
  assert.equal(f.store.read('atomic'),null);assert.equal(f.store.meta('last_browser_capture'),before);
});

function observedPage(t,html='',responses={}) {
  const dom=new JSDOM(html,{url:'https://chatgpt.com/c/open-chat',runScripts:'outside-only'}),w=dom.window;
  Object.assign(w,{Headers,Response,TextDecoder,TextEncoder});
  const captures=[],calls=[];
  w.addEventListener('message',event=>{if(event.data?.type==='capture')captures.push(event.data.payload);});
  w.fetch=(input)=>{
    calls.push(String(input));
    const body=responses[String(input)] ?? (String(input)==='/api/auth/session'?{user:{id:'user-test'},accessToken:'never-persist-this'}:
      String(input).startsWith('/backend-api/accounts/check')?{accounts:{'personal-id':{account:{structure:'personal'}}}}:tree('open-chat'));
    return Promise.resolve(new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}}));
  };
  w.eval(readFileSync(new URL('../extension/archive-observer.js',import.meta.url),'utf8'));
  w.dispatchEvent(new w.MessageEvent('message',{source:w,origin:w.location.origin,data:{channel:'threadbridge-browser-archive-v1',type:'settings',enabled:true}}));
  t.after(()=>w.close());return {dom,w,captures,calls};
}

test('observer reuses existing website responses with zero additional fetches and never posts auth tokens',async t=>{
  const f=observedPage(t);
  await f.w.fetch('/api/auth/session');await wait(20);
  await f.w.fetch('/backend-api/accounts/check/v4-2023-04-27');await wait(20);
  const response=await f.w.fetch('/backend-api/conversation/open-chat',{headers:{'chatgpt-account-id':'personal-id'}});
  assert.ok((await response.json()).mapping.descendant);await wait(60);
  assert.equal(f.calls.length,3);assert.equal(f.captures.length,1);assert.equal(f.captures[0].workspace,null);
  assert.equal(f.captures[0].raw.mapping.alternate.children[0],'descendant');
  assert.equal(JSON.stringify(f.captures).includes('never-persist-this'),false);
  f.dom.reconfigure({url:'https://chatgpt.com/c/another-chat'});
  await f.w.fetch('/backend-api/conversation/open-chat');await wait(60);
  assert.equal(f.captures.length,1); // A late old response cannot attach itself to a newly opened chat.
});

test('accounts dictionary alias default resolves to its actual personal account ID',async t=>{
  const f=observedPage(t,'',{'/backend-api/accounts/check/v4-2023-04-27':{
    accounts:{default:{account:{account_id:'actual-personal-id',structure:'personal'}}}}});
  await f.w.fetch('/api/auth/session');await wait(20);
  await f.w.fetch('/backend-api/accounts/check/v4-2023-04-27');await wait(20);
  await f.w.fetch('/backend-api/conversation/open-chat',{headers:{'chatgpt-account-id':'actual-personal-id'}});await wait(60);
  assert.equal(f.captures[0].workspace,null);assert.equal(f.calls.length,3);
});

const embeddedSession=(user='user-test',account='personal-id',structure='personal')=>
  '<script type="application/json">'+JSON.stringify({authStatus:'logged_in',session:{
    user:{id:user,email:'must-not-be-posted@example.test'},account:{id:account,structure},accessToken:'never-persist-this'}})+'</script>';

test('an accounts default alias cannot overwrite a known personal account ID',async t=>{
  const f=observedPage(t,embeddedSession(),{'/backend-api/accounts/check/v4-2023-04-27':{
    accounts:{default:{account:{structure:'personal'}}}}});
  await f.w.fetch('/backend-api/accounts/check/v4-2023-04-27');await wait(20);
  await f.w.fetch('/backend-api/conversation/open-chat',{headers:{'chatgpt-account-id':'personal-id'}});await wait(60);
  assert.equal(f.captures.length,1);assert.equal(f.captures[0].workspace,null);
  const storeFixture=await fixture(t);bind(storeFixture.store);
  assert.equal(acceptBrowserCapture(storeFixture.store,f.captures[0],settings).ok,true);
});

test('late personal account metadata retries unchanged page messages under the corrected workspace',async t=>{
  const f=observedPage(t,'<div data-message-author-role="assistant" data-message-id="one">Existing reply</div>');
  await f.w.fetch('/api/auth/session');await wait(20);
  await f.w.fetch('/backend-api/profile',{headers:{'chatgpt-account-id':'personal-id'}});await wait(1400);
  assert.equal(f.captures.length,1);assert.equal(f.captures[0].workspace,'personal-id');
  await f.w.fetch('/backend-api/accounts/check/v4-2023-04-27');await wait(1400);
  assert.equal(f.captures.length,2);assert.equal(f.captures[1].workspace,null);
  assert.equal(f.captures[1].messages[0].id,'one');
  assert.equal(f.calls.length,3);
});

test('distinct positively identified personal IDs stay personal without accepting a team ID',async t=>{
  const f=observedPage(t,embeddedSession(),{'/backend-api/accounts/check/v4-2023-04-27':{
    accounts:{default:{account:{account_id:'other-personal-id',structure:'personal'}}}}});
  await f.w.fetch('/backend-api/accounts/check/v4-2023-04-27');await wait(20);
  for(const id of ['personal-id','other-personal-id','team-id']){
    await f.w.fetch('/backend-api/conversation/open-chat',{headers:{'chatgpt-account-id':id}});await wait(60);
  }
  assert.deepEqual(f.captures.map(c=>c.workspace),[null,null,'team-id']);
  const storeFixture=await fixture(t);bind(storeFixture.store);
  assert.equal(acceptBrowserCapture(storeFixture.store,f.captures[2],settings).state,'workspace-mismatch');
  assert.equal(storeFixture.store.status().threads,0);
});

test('already loaded server session enables passive DOM capture without another website request',async t=>{
  const f=observedPage(t,embeddedSession()+'<div data-chatgpt-search-message-ids="original-reply"><div data-conversation-role="assistant"></div><p>Existing reply</p></div>');
  await wait(1400);
  assert.equal(f.calls.length,0);assert.equal(f.captures.length,1);
  const capture=f.captures[0];assert.equal(capture.identity,'user-test');assert.equal(capture.workspace,null);
  assert.equal(capture.messages[0].id,'original-reply');
  assert.equal(JSON.stringify(capture).includes('never-persist-this'),false);
  assert.equal(JSON.stringify(capture).includes('must-not-be-posted'),false);
  const storeFixture=await fixture(t);bind(storeFixture.store);
  assert.equal(acceptBrowserCapture(storeFixture.store,capture,settings).ok,true);
  assert.equal(storeFixture.store.read('open-chat').raw.messages[0].text,'Existing reply');
});

test('embedded workspace stays separate and unrelated or stale session JSON cannot establish personal ownership',async t=>{
  const team=observedPage(t,embeddedSession('user-test','team-id','workspace')+
    '<div data-message-author-role="assistant" data-message-id="one">Team reply</div>');
  await wait(1400);assert.equal(team.captures[0].workspace,'team-id');
  const storeFixture=await fixture(t);bind(storeFixture.store);
  assert.equal(acceptBrowserCapture(storeFixture.store,team.captures[0],settings).state,'workspace-mismatch');
  assert.equal(storeFixture.store.status().threads,0);
  const unrelated=observedPage(t,'<script type="application/json">'+JSON.stringify({message:{
    authStatus:'logged_in',session:{user:{id:'user-test'},account:{id:'personal-id',structure:'personal'}}}})+'</script>'+
    '<div data-message-author-role="assistant" data-message-id="one">Reply</div>');
  await wait(1400);assert.equal(unrelated.captures.length,0);
  for(const enabled of [false,true])team.w.dispatchEvent(new team.w.MessageEvent('message',{source:team.w,origin:team.w.location.origin,
    data:{channel:'threadbridge-browser-archive-v1',type:'settings',enabled}}));
  await wait(1400);assert.equal(team.captures.length,1);
});

test('switching users clears the previous personal workspace, including a switch inferred from a request token',async t=>{
  const f=observedPage(t,embeddedSession()+'<div data-message-author-role="assistant" data-message-id="one">Reply</div>');
  await wait(1400);assert.equal(f.captures.length,1);
  const claims={'https://api.openai.com/auth':{user_id:'user-other',chatgpt_account_id:'other-team'}};
  const token='header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature';
  await f.w.fetch('/backend-api/profile',{headers:{authorization:'Bearer '+token}});
  f.w.document.dispatchEvent(new f.w.Event('scroll'));await wait(1400);
  assert.equal(f.captures.length,2);assert.equal(f.captures[1].identity,'user-other');assert.equal(f.captures[1].workspace,'other-team');
});

test('DOM fallback preserves code indentation and LaTeX, skips unstable IDs and unfinished replies',async t=>{
  const f=observedPage(t,`<title>Open chat</title><div data-message-author-role="user" data-message-id="original-user"><div class="whitespace-pre-wrap">Question</div></div>
    <div data-message-author-role="assistant" data-message-id="original-answer"><div class="markdown"><p>Answer</p><pre><code>if (x) {\n    run();\n}</code></pre>
    <span class="katex"><span aria-hidden="true">duplicate math</span><annotation encoding="application/x-tex">x^2 + y^2</annotation></span><button>Copy</button></div></div>
    <div data-message-author-role="assistant"><p>No original ID</p></div>
    <div data-is-streaming="true"><div data-message-author-role="assistant" data-message-id="unfinished">not done</div></div>`);
  await f.w.fetch('/api/auth/session');await wait(20);
  await f.w.fetch('/backend-api/accounts/check/v4-2023-04-27');
  await f.w.fetch('/backend-api/profile',{headers:{'chatgpt-account-id':'personal-id'}});await wait(1400);
  const page=f.captures.find(c=>c.kind==='page');assert.equal(page.messages.length,2);
  const answer=page.messages.find(m=>m.id==='original-answer');assert.match(answer.text,/\n    run\(\);/);
  assert.ok(answer.text.includes('\\(x^2 + y^2\\)'));assert.equal(answer.text.includes('Copy'),false);
  assert.equal(answer.text.includes('duplicate math'),false);assert.equal(answer.ordinal,null);
  const before=f.captures.length;f.w.document.dispatchEvent(new f.w.Event('scroll'));await wait(1400);
  assert.equal(f.captures.length,before);
});

test('durable outbox survives service-worker replacement; acknowledgement removes one item and mismatches retain it',async()=>{
  const factory=new IDBFactory(),first=new ArchiveOutbox(factory);
  const key=await first.enqueue(page('pending',[message('one','waiting')]));
  const replacement=new ArchiveOutbox(factory);assert.equal((await replacement.first()).key,key);
  await replacement.defer(key);assert.equal(await replacement.first(),null);
  await replacement.resetDeferred();assert.equal((await replacement.first()).payload.id,'pending');
  await replacement.remove(key);assert.equal(await first.first(),null);
});

test('reenabling capture cannot reuse an identity cached before an account switch while disabled',async t=>{
  const f=observedPage(t,'<div data-message-author-role="assistant" data-message-id="reply">Page text</div>');
  await f.w.fetch('/api/auth/session');await wait(20);
  await f.w.fetch('/backend-api/accounts/check/v4-2023-04-27');
  await f.w.fetch('/backend-api/profile',{headers:{'chatgpt-account-id':'personal-id'}});await wait(1400);
  assert.equal(f.captures.length,1);
  for(const enabled of [false,true])f.w.dispatchEvent(new f.w.MessageEvent('message',{source:f.w,origin:f.w.location.origin,
    data:{channel:'threadbridge-browser-archive-v1',type:'settings',enabled}}));
  await wait(1400);assert.equal(f.captures.length,1);
});

test('native host accepts passive captures while active sync stays paused and sends no remote request',async t=>{
  const f=await fixture(t),db=path.join(f.dir,'passive.sqlite'),config=path.join(f.dir,'passive-host.json'),extensionId='a'.repeat(32);
  const seed=new Store(db,'test');bind(seed);seed.meta('sync_paused',1);seed.close();
  writeFileSync(config,JSON.stringify({db,account:'test',extensionId,workspace:null}));
  const notices=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['src/browser-host.mjs','--config',config,`chrome-extension://${extensionId}/`]);
    const result=[];let sent=false;
    const deadline=setTimeout(()=>{child.kill();reject(new Error('Passive native integration timed out'));},10000);
    const reader=new FrameReader(value=>{
      result.push(value);
      if(value.type==='request')reject(new Error('Paused native host initiated a remote request'));
      if(value.type==='status'&&!sent){sent=true;child.stdin.write(frame({type:'capture',id:1,payload:page('passive',[message('one','saved while paused')])},64*1024*1024));}
      if(value.type==='capture-ack')child.stdin.end(frame({type:'shutdown'}));
    });
    child.stdout.on('data',chunk=>reader.push(chunk));child.stderr.resume();child.on('error',reject);
    child.on('close',code=>{clearTimeout(deadline);code?reject(new Error('Native host failed')):resolve(result);});
    child.stdin.write(frame({type:'hello',version:1,archiveVersion:1}));
  });
  assert.equal(notices.find(n=>n.type==='capture-ack').ok,true);
  assert.equal(JSON.stringify(notices).includes('saved while paused'),false);
  const saved=new Store(db,'test');try{assert.equal(saved.read('passive').raw.messages[0].text,'saved while paused');assert.equal(saved.meta('sync_paused'),'1');}finally{saved.close();}
});

test('dashboard browser switch does not resume a paused sync or alter its schedule',async t=>{
  const f=await fixture(t);f.store.meta('sync_paused',1);f.store.meta('next_run_at',Date.now()+100000);
  const due=f.store.meta('next_run_at'),server=createDashboard(f.store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));const origin='http://127.0.0.1:'+server.address().port;
  for(const enabled of [false,true]){
    const response=await fetch(origin+'/api/control',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({browserArchive:enabled})});
    assert.equal(response.status,200);const data=await response.json();assert.equal(data.runtime.browserArchive,enabled);assert.equal(data.runtime.paused,true);
    assert.equal(f.store.meta('next_run_at'),due);
  }
});
