import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {snapshot} from '../src/model.mjs';
import {providerSnapshot,providerDirectory,accountKey} from '../src/providers.mjs';
import {sync} from '../src/sync.mjs';
import {discoverProvider} from '../src/provider-discovery.mjs';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {hostConfigs} from '../src/browser-config.mjs';
import {BrowserTransport} from '../src/browser-transport.mjs';
import {frame,FrameReader} from '../src/browser-frames.mjs';
import {createDashboard} from '../src/dashboard-server.mjs';
import {addConnection} from '../src/connections.mjs';
import {fixture,tree} from './fixtures.mjs';
import {claudeDirectory,claudeDetail,geminiDirectory,geminiDetail} from './provider-fixtures.mjs';

const connections=new WeakMap();
async function providerFixture(t){
  const stores=[];connections.set(t,stores);
  // Windows cannot remove SQLite files until all provider connections close.
  t.after(()=>{for(const store of stores)store.close();});return fixture(t);
}
function open(t,db,provider){const s=new Store(db,'test',provider);connections.get(t).push(s);return s;}
const extensionId='a'.repeat(32);
const settings=(db,provider)=>workerConfig({db,provider,account:'test',extensionId,paceMs:0,maxDirectoryPages:100,maxPerRun:10});
function rpcFor(provider,{failure=null}={}){
  return {closed:false,paths:[],notices:[],send(v){this.notices.push(v);},async request(p,workspace,actual){
    assert.equal(actual,provider);this.paths.push(p);
    if(failure)return {status:failure,identity:null,retry:'3600'};
    const common={status:200,identity:provider+'-user',...(provider==='claude'?{workspace:'org-one'}:{})};
    if(p==='/api/auth/session')return common;
    if(p.startsWith('/history/list?'))return {...common,data:provider==='claude'?[claudeDirectory()]:geminiDirectory()};
    return {...common,data:provider==='claude'?claudeDetail():geminiDetail()};
  }};
}

test('provider namespaces preserve legacy ChatGPT data and isolate messages, revisions, cursors and leases',async t=>{
  const f=await providerFixture(t),claude=open(t,f.db,'claude'),gemini=open(t,f.db,'gemini');
  f.store.save(snapshot(tree('same-id'),'same-id'));claude.save(providerSnapshot('claude',claudeDetail(),'same-id'));
  gemini.save(providerSnapshot('gemini',geminiDetail(),'c_example','Gemini example'));
  assert.equal(f.store.account,'test');assert.notEqual(claude.account,gemini.account);assert.equal(claude.status().account,'test');
  assert.equal(f.store.search('Claude').length,0);assert.equal(claude.search('Gemini').length,0);assert.equal(gemini.search('Claude').length,0);
  assert.equal(claude.search('searchable')[0].text,'Claude searchable reply');assert.equal(gemini.search('searchable').length,1);
  f.store.meta('sync_paused',1);assert.equal(claude.meta('sync_paused'),null);
  for(const store of [f.store,claude,gemini])store.acquire(store.provider);assert.throws(()=>claude.acquire('other'),/already running/);
  for(const store of [f.store,claude,gemini])store.release(store.provider);
  const changes=claude.changes('reader');claude.ack('reader',changes.through);assert.equal(gemini.changes('reader').after,0);
  const reopen=new Store(f.db,'test','claude');assert.equal(reopen.read('same-id').raw.chat_messages[2].parent_message_uuid,'u');reopen.close();
  assert.throws(()=>accountKey('chatgpt',claude.account),/namespace/);assert.throws(()=>accountKey('unknown','test'),/provider/);
});

test('native provider snapshots preserve Claude branches/tools and every Gemini candidate without claiming full trees',()=>{
  const c=providerSnapshot('claude',claudeDetail(),'same-id'),g=providerSnapshot('gemini',geminiDetail(),'c_example','Title');
  assert.equal(c.coverage,'bounded-text');assert.equal(c.messages.length,3);assert.ok(JSON.parse(c.raw).chat_messages[1].content[1].input);
  assert.equal(g.coverage,'bounded-text');assert.equal(g.messages.length,5);assert.equal(g.messages[0].text,'first question');assert.equal(g.lastAssistantId,'r_new:rc_new');
  const wrong=geminiDetail();wrong.body[0][0][0][0]='c_other';assert.throws(()=>providerSnapshot('gemini',wrong,'c_example'),/identity/);
  const duplicate=claudeDetail();duplicate.chat_messages.push(duplicate.chat_messages[0]);assert.throws(()=>providerSnapshot('claude',duplicate,'same-id'),/duplicate/);
  const tooMany=geminiDetail();tooMany.body[0]=Array(10000).fill(tooMany.body[0][0]);assert.throws(()=>providerSnapshot('gemini',tooMany,'c_example'),/window/);
  const more=geminiDetail();more.body[1]='more';assert.throws(()=>providerSnapshot('gemini',more,'c_example'),/window/);
  assert.throws(()=>providerSnapshot('claude',{...claudeDetail(),has_more:true},'same-id'),/truncated/);
  assert.throws(()=>providerDirectory('gemini',{},'active'),/directory/);
});

test('Claude offset pagination saves checkpoints and resumes old history before discovering newer versions',async t=>{
  const f=await providerFixture(t),store=open(t,f.db,'claude'),calls=[];
  const page=Array.from({length:100},(_,i)=>claudeDirectory('claude-'+i));
  const api={async request(p){calls.push(p);return new URL(p,'https://local').searchParams.get('offset')==='0'?page:[claudeDirectory('old-history')];}};
  let report=await discoverProvider(api,store,{maxDirectoryPages:1});assert.equal(report.complete,false);assert.equal(store.status().threads,100);
  assert.equal(JSON.parse(store.meta('directory_scan')).jobs[0].offset,100);
  report=await discoverProvider(api,store,{maxDirectoryPages:1});assert.equal(report.complete,true);assert.match(calls[1],/offset=100/);assert.equal(store.status().threads,101);
  store.save(providerSnapshot('claude',claudeDetail('claude-0'),'claude-0'),'2026-10-01T00:00:00.000Z');
  store.discover({id:'claude-0',title:'Title',updated:'2026-10-01T00:00:00.000Z',assistantUpdated:null});assert.equal(store.thread('claude-0').pending,0);
  store.discover({id:'claude-0',title:'Title',updated:'2026-10-02T00:00:00.000Z',assistantUpdated:null});assert.equal(store.thread('claude-0').pending,1);
});

test('Gemini pinned and ordinary directories paginate independently, deduplicate and retain a failed cursor',async t=>{
  const f=await providerFixture(t),store=open(t,f.db,'gemini'),calls=[];let fail=true;
  const api={async request(p){calls.push(p);const q=new URL(p,'https://local').searchParams;
    if(q.get('scope')==='pinned')return geminiDirectory('c_pinned');
    if(!q.get('cursor'))return geminiDirectory('c_pinned','next-page');
    if(fail)throw Object.assign(new Error('temporary limit'),{status:429});return geminiDirectory('c_old');}};
  let report=await discoverProvider(api,store);assert.equal(report.complete,false);assert.equal(store.status().threads,1);
  assert.equal(JSON.parse(store.meta('directory_scan')).jobs[1].cursor,'next-page');fail=false;
  const before=calls.length;report=await discoverProvider(api,store);assert.equal(report.complete,true);assert.equal(calls.length-before,1);assert.match(calls.at(-1),/cursor=next-page/);
  assert.equal(store.status().threads,2);
});

test('malformed or looping provider directories cannot advance a successful watermark or lose the pending page',async t=>{
  const f=await providerFixture(t),store=open(t,f.db,'gemini');let bad=false;
  const api={async request(){return bad?{}:geminiDirectory('c_loop','repeated');}};
  const report=await discoverProvider(api,store);assert.equal(report.complete,false);assert.match(report.errors[0].error,/repeated/);
  const cursor=store.meta('directory_scan');bad=true;const run=await sync(api,store,{directoryOnly:true});assert.equal(run.ok,false);assert.equal(store.meta('watermark'),null);
  assert.equal(store.meta('directory_scan'),cursor);assert.equal(store.status().threads,1);
});

test('a provider checkpoint write failure rolls back discoveries and retains the exact next page',async t=>{
  const f=await providerFixture(t),store=open(t,f.db,'claude'),page=Array.from({length:100},(_,i)=>claudeDirectory('id-'+i));
  store.db.exec(`CREATE TRIGGER reject_page BEFORE INSERT ON meta WHEN NEW.key='directory_scan' AND json_extract(NEW.value,'$.jobs[0].pages')>0 BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END;`);
  const report=await discoverProvider({async request(){return page;}},store,{maxDirectoryPages:1});
  assert.equal(report.complete,false);assert.equal(report.seen,0);assert.equal(store.status().threads,0);assert.equal(JSON.parse(store.meta('directory_scan')).jobs[0].offset,0);
  store.db.exec('DROP TRIGGER reject_page');await discoverProvider({async request(){return page;}},store,{maxDirectoryPages:1});
  assert.equal(store.status().threads,100);assert.equal(JSON.parse(store.meta('directory_scan')).jobs[0].offset,100);
});

test('each provider background worker resumes bodies, detects edits and persists rate limits independently',async t=>{
  const f=await providerFixture(t),c=open(t,f.db,'claude'),g=open(t,f.db,'gemini'),crpc=rpcFor('claude'),grpc=rpcFor('gemini',{failure:429});
  const cw=new BrowserWorker(crpc,c,settings(f.db,'claude')),gw=new BrowserWorker(grpc,g,settings(f.db,'gemini'));
  try{
    await Promise.all([cw.run(),gw.run()]);assert.equal(c.status().pending,0);assert.equal(c.status().messages,3);assert.equal(g.status().threads,0);
    assert.equal(gw.rpc.notices.at(-1).state,'rate-limited');assert.ok(Number(g.meta('rate_limit_until'))>Date.now()+3590000);assert.equal(c.meta('rate_limit_until'),'0');
    const before=grpc.paths.length;gw.close();const resumed=new BrowserWorker(grpc,g,settings(f.db,'gemini'));await resumed.run();resumed.close();assert.equal(grpc.paths.length,before);
    c.meta('next_run_at',0);await cw.run();assert.equal(c.status().messages,3);assert.equal(c.read('same-id').revision,1);
    assert.equal(crpc.paths.filter(p=>p.startsWith('/history/list')).length,1);
  }finally{cw.close();gw.close();}
});

test('Claude transport binds the organization and rejects a changed identity before ingestion',async()=>{
  let workspace='one',identity='first';const rpc={async request(p,w,provider){assert.equal(provider,'claude');return {status:200,identity,workspace,data:{}};}};
  const api=await new BrowserTransport(rpc,{provider:'claude',paceMs:0}).initialize();assert.equal(api.workspace,'one');workspace='two';
  await assert.rejects(api.request('/history/list?scope=active&offset=0'),{status:403});assert.equal(api.stopped.status,403);api.close();
  const googleRpc={async request(){return {status:200,identity,data:[]};}};
  const other=await new BrowserTransport(googleRpc,{provider:'gemini',paceMs:0}).initialize();identity='second';
  await assert.rejects(other.request('/history/list?scope=active&offset=0'),{status:403});other.close();
});

test('multi-provider native configuration rejects duplicates and does not inherit another platform workspace',()=>{
  const base=settings('C:/test.sqlite','chatgpt');
  const list=hostConfigs({...base,workspace:'chatgpt-workspace',providers:[{provider:'chatgpt',workspace:'chatgpt-workspace'},{provider:'claude'},{provider:'gemini',authuser:1}]});
  assert.equal(list[1].workspace,null);assert.equal(list[2].authuser,1);assert.equal(hostConfigs(base)[0].provider,'chatgpt');
  assert.throws(()=>hostConfigs({...base,providers:[{provider:'claude'},{provider:'claude'}]}),/Duplicate/);
  assert.throws(()=>hostConfigs({...base,providers:[{provider:'claude',db:'C:/other.sqlite'}]}),/configuration/);
});

test('dashboard routes controls and lists to the selected platform and rejects unsupported imports',async t=>{
  const f=await providerFixture(t),c=open(t,f.db,'claude'),g=open(t,f.db,'gemini');c.save(providerSnapshot('claude',claudeDetail(),'same-id'));
  const server=createDashboard(new Map([['chatgpt',f.store],['claude',c],['gemini',g]]));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  const get=p=>fetch(base+p).then(r=>r.json()),write=(provider,command)=>fetch(base+'/api/control?provider='+provider,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(command)});
  assert.equal((await get('/api/threads?provider=claude')).total,1);assert.equal((await get('/api/threads?provider=chatgpt')).total,0);
  const status=await get('/api/status?provider=claude');assert.equal(status.provider,'claude');assert.equal(status.capabilities.jsonImport,false);
  const added=await get('/api/connections');assert.equal(added.items.length,1);assert.equal(added.available.length,2);
  assert.equal((await write('claude',{paused:true})).status,200);assert.equal(c.meta('sync_paused'),'1');assert.equal(g.meta('sync_paused'),null);
  assert.equal((await write('gemini',{browserArchive:true})).status,400);
  assert.equal((await fetch(base+'/api/import?provider=gemini',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'})).status,400);
  assert.equal((await fetch(base+'/api/status?provider=unknown')).status,400);
});

test('native host multiplexes three providers to disk while one login is unavailable',async t=>{
  const f=await providerFixture(t),db=path.join(f.dir,'multi.sqlite'),config=path.join(f.dir,'multi.json');
  writeFileSync(config,JSON.stringify({...settings(db,'chatgpt'),providers:[{provider:'chatgpt'},{provider:'claude'},{provider:'gemini'}]}));
  const results=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['src/browser-host.mjs','--config',config,`chrome-extension://${extensionId}/`]),notices=new Map();let error='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Provider native host timed out'));},15000);
    const reader=new FrameReader(message=>{
      if(message.type==='request'){
        const provider=message.provider;
        let reply;
        if(provider==='chatgpt')reply={status:401,identity:null};
        else if(message.path==='/api/auth/session')reply={status:200,identity:provider+'-user',...(provider==='claude'?{workspace:'org'}:{})};
        else reply={status:200,identity:provider+'-user',...(provider==='claude'?{workspace:'org'}:{}),data:message.path.startsWith('/history/list?')?
          provider==='claude'?[claudeDirectory()]:geminiDirectory():provider==='claude'?claudeDetail():geminiDetail()};
        child.stdin.write(frame({type:'response',id:message.id,result:reply},64*1024*1024));
      }else if(message.type==='status'&&['login-required','up-to-date'].includes(message.state)){
        notices.set(message.provider,message);if(notices.size===3)child.stdin.end(frame({type:'shutdown'}));
      }
    });
    child.stdout.on('data',b=>reader.push(b));child.stderr.on('data',b=>error+=b);child.on('error',reject);
    child.on('close',code=>{clearTimeout(timer);code===0&&notices.size===3?resolve(notices):reject(new Error('Native host failed: '+error));});
    child.stdin.write(frame({type:'hello',version:1}));
  });
  assert.equal(results.get('chatgpt').state,'login-required');assert.equal(results.get('claude').messages,3);assert.equal(results.get('gemini').messages,5);
  const c=open(t,db,'claude'),g=open(t,db,'gemini');assert.equal(c.search('Gemini').length,0);assert.equal(g.read('c_example').raw.body[0].length,2);
});

test('a running native host discovers a Settings addition without restarting or reading history while paused',async t=>{
  const f=await providerFixture(t),db=path.join(f.dir,'dynamic.sqlite'),config=path.join(f.dir,'dynamic.json'),root=new Store(db,'test');connections.get(t).push(root);
  root.meta('sync_paused',1);writeFileSync(config,JSON.stringify({...settings(db,'chatgpt'),providers:[{provider:'chatgpt'}]}));
  const calls=[];
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['src/browser-host.mjs','--config',config,`chrome-extension://${extensionId}/`]);let added=false,error='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('Dynamic provider timed out'));},10000);
    const reader=new FrameReader(message=>{
      if(message.type==='request'){
        calls.push([message.provider,message.path]);child.stdin.write(frame({type:'response',id:message.id,result:{status:200,identity:'claude-user',workspace:'org'}}));
      }else if(message.type==='status'&&message.provider==='chatgpt'&&!added){
        added=true;addConnection(root,{provider:'claude'},root.scope('claude'));
      }else if(message.type==='status'&&message.provider==='claude'&&root.scope('claude').meta('connection_state')==='connected')child.stdin.end(frame({type:'shutdown'}));
    });
    child.stdout.on('data',bytes=>reader.push(bytes));child.stderr.on('data',bytes=>error+=bytes);child.on('error',reject);
    child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Dynamic native host failed: '+error));});child.stdin.write(frame({type:'hello',version:1}));
  });
  assert.deepEqual(calls,[['claude','/api/auth/session']]);assert.equal(root.scope('claude').status().threads,0);assert.equal(root.scope('claude').meta('connection_state'),'connected');
});
