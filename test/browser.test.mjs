import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {frame,FrameReader,BrowserRpc} from '../src/browser-frames.mjs';
import {BrowserTransport} from '../src/browser-transport.mjs';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {Store} from '../src/store.mjs';
import {retryDelay} from '../src/transport.mjs';
import {pageRequest} from '../extension/page-client.js';
import {fixture,tree} from './fixtures.mjs';

const extensionId='a'.repeat(32);
function config(db,extra={}){return workerConfig({db,account:'test',extensionId,paceMs:0,maxDirectoryPages:100000,projectIntervalMs:0,...extra});}
function browserRpc(f,identity='test-user'){
  return {closed:false,identity,notices:[],paths:[],send(value){this.notices.push(value);},async request(p){this.paths.push(p);
    if(p==='/api/auth/session')return {status:200,identity:this.identity};
    try{return {status:200,identity:this.identity,data:await f.api.request(p)};}catch(e){return {status:e.status ?? 503,identity:this.identity};}}};
}

test('native messaging frames preserve Unicode, split headers and multi-megabyte responses; reject malformed frames',async()=>{
  const input=new PassThrough(),output=new PassThrough(),rpc=new BrowserRpc(input,output,{timeout:1000});let request;
  output.once('data',b=>request=JSON.parse(b.subarray(4).toString()));const waiting=rpc.request('/backend-api/conversation/large');
  const content='分支原文'.repeat(300000),bytes=frame({type:'response',id:request.id,result:{status:200,data:content}},64*1024*1024);
  for(let i=0;i<bytes.length;i+=65537)input.write(bytes.subarray(i,i+65537));assert.equal((await waiting).data,content);rpc.close();
  const received=[],reader=new FrameReader(v=>received.push(v));const joined=Buffer.concat([frame({a:'中文'}),frame({b:2})]);
  for(const byte of joined)reader.push(Buffer.from([byte]));assert.deepEqual(received,[{a:'中文'},{b:2}]);reader.end();
  const tooBig=Buffer.alloc(4);tooBig.writeUInt32LE(65*1024*1024);assert.throws(()=>new FrameReader(()=>{}).push(tooBig),/length/);
  assert.throws(()=>new FrameReader(()=>{}).push(Buffer.from([1,0,0,0,123])),/JSON/);
  const incomplete=new FrameReader(()=>{});incomplete.push(Buffer.from([1]));assert.throws(()=>incomplete.end(),/Incomplete/);
  assert.throws(()=>frame({text:'x'.repeat(1024*1024)}),/limit/);
});

test('isolated browser client permits only history GETs, keeps tokens in browser and preserves Retry-After',async()=>{
  const calls=[];let status=200,user='user-one';const context=vm.createContext({location:{origin:'https://chatgpt.com'},AbortSignal,TextEncoder,
    async fetch(url,options){calls.push({url,method:options.method,credentials:options.credentials});
      if(url==='/api/auth/session')return {ok:true,json:async()=>({accessToken:'browser-only-secret',user:{id:user}})};
      assert.equal(options.headers.Authorization,'Bearer browser-only-secret');
      return {ok:status===200,status,headers:{get:name=>name==='content-type'?'application/json':name==='retry-after'?'3600':null},text:async()=>JSON.stringify(tree('real-shape'))};}});
  const request=vm.runInContext('('+pageRequest.toString()+')',context);
  const success=await request('/backend-api/conversation/real-shape');assert.equal(success.data.mapping.descendant.parent,'alternate');
  assert.equal(JSON.stringify(success).includes('browser-only-secret'),false);assert.equal(success.identity,'user-one');
  user='user-two';status=429;const limited=await request('/backend-api/conversations?offset=0');assert.equal(limited.identity,'user-two');assert.equal(limited.retry,'3600');
  const count=calls.length;assert.equal((await request('/backend-api/accounts/delete')).status,403);assert.equal(calls.length,count);
  assert.equal((await request('/api/auth/session','bad/header')).status,403);assert.equal(calls.length,count);
});

test('browser account switching and unavailable network cannot be mistaken for successful reads',async()=>{
  let identity='first',status=200;const rpc={async request(){return {status,identity,data:{items:[]}};}};
  const api=await new BrowserTransport(rpc,{paceMs:0}).initialize();identity='second';await assert.rejects(api.request('/backend-api/projects'),{status:403});assert.ok(api.stopped);
  identity='first';status=200;const fresh=await new BrowserTransport(rpc,{paceMs:0}).initialize();status=503;identity=null;
  await assert.rejects(fresh.request('/backend-api/projects'),{status:503});assert.equal(fresh.stopped.status,503);
});

test('worker writes each batch to SQLite, resumes pending details without rescanning and rejects account changes',async t=>{
  const f=await fixture(t),rpc=browserRpc(f),worker=new BrowserWorker(rpc,f.store,config(f.db,{maxPerRun:2}));
  try{
    await worker.run();assert.equal(f.store.status().fullTrees,2);assert.equal(f.store.status().pending,66);assert.ok(f.store.meta('source_identity'));
    const watermark=f.store.meta('watermark'),firstPages=rpc.paths.filter(p=>p.includes('offset=')).length;
    f.store.meta('next_run_at',0);await worker.run();assert.equal(f.store.status().fullTrees,4);assert.equal(rpc.paths.filter(p=>p.includes('offset=')).length,firstPages);
    assert.equal(f.store.meta('watermark'),watermark);rpc.identity='another-user';f.store.meta('next_run_at',0);await worker.run();
    assert.equal(f.store.status().fullTrees,4);assert.equal(rpc.notices.at(-1).state,'account-changed');assert.equal(worker.paused,true);
    assert.equal(JSON.stringify(rpc.notices).includes('content chat-'),false);
  }finally{worker.close();}
});

test('429 cooldown survives process replacement, honors long Retry-After and makes no premature network requests',async t=>{
  const f=await fixture(t),rpc=browserRpc(f);const original=rpc.request.bind(rpc);let detailCalls=0;
  rpc.request=async p=>p.startsWith('/backend-api/conversation/')&&++detailCalls>1?{status:429,identity:rpc.identity,retry:'3600'}:original(p);
  let now=Date.now();const worker=new BrowserWorker(rpc,f.store,config(f.db),{now:()=>now});
  await worker.run();worker.close();assert.equal(detailCalls,2);assert.equal(f.store.status().fullTrees,1);assert.equal(f.store.status().pending,67);
  assert.ok(Number(f.store.meta('next_run_at'))>=now+3599000);const requests=rpc.paths.length;
  const resumed=new BrowserWorker(rpc,f.store,config(f.db),{now:()=>now});try{await resumed.run();assert.equal(rpc.paths.length,requests);assert.equal(rpc.notices.at(-1).state,'waiting');}finally{resumed.close();}
  assert.equal(retryDelay('3600',now),3600000);assert.equal(retryDelay(new Date(now+60000).toUTCString(),now)>59000,true);
});

test('session endpoint rate limits retain Retry-After and persistent cooldown before directory discovery',async t=>{
  const f=await fixture(t),calls=[];
  const context=vm.createContext({location:{origin:'https://chatgpt.com'},AbortSignal,async fetch(p){calls.push(p);return {ok:false,status:429,headers:{get:()=> '7200'}};}});
  const request=vm.runInContext('('+pageRequest.toString()+')',context),notices=[];
  const rpc={closed:false,send:v=>notices.push(v),request};const worker=new BrowserWorker(rpc,f.store,config(f.db));
  const before=Date.now();try{await worker.run();assert.deepEqual(calls,['/api/auth/session']);assert.equal(notices.at(-1).state,'rate-limited');
    assert.ok(Number(f.store.meta('next_run_at'))>=before+7200000);assert.equal(f.store.meta('rate_limit_strikes'),'1');
  }finally{worker.close();}
  const resumed=new BrowserWorker(rpc,f.store,config(f.db));try{await resumed.run();assert.equal(calls.length,1);}finally{resumed.close();}
});

test('real native host subprocess completes framed browser-to-disk flow and resumes after restart',async t=>{
  const f=await fixture(t),db=path.join(f.dir,'native.sqlite'),settings=path.join(f.dir,'native-config.json');
  writeFileSync(settings,JSON.stringify(config(db,{maxPerRun:3})));
  async function cycle(){return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['src/browser-host.mjs','--config',settings,`chrome-extension://${extensionId}/`]);let error='',settled=false,completed=null;
    const deadline=setTimeout(()=>{child.kill();reject(new Error('Native integration timed out'));},15000);
    const finish=value=>{if(completed)return;completed=value;child.stdin.end(frame({type:'shutdown'}));};
    const reader=new FrameReader(message=>{
      if(message.type==='request'){void (async()=>{const result=message.path==='/api/auth/session'?{status:200,identity:'test-user'}:
        await f.api.request(message.path).then(data=>({status:200,identity:'test-user',data}),e=>({status:e.status,identity:'test-user'}));
        if(!child.stdin.destroyed){const bytes=frame({type:'response',id:message.id,result},64*1024*1024);child.stdin.write(bytes.subarray(0,2));child.stdin.write(bytes.subarray(2));}})().catch(reject);}
      else if(message.type==='status'&&['pending','up-to-date'].includes(message.state))finish(message);
    });
    child.stdout.on('data',b=>reader.push(b));child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('close',code=>{if(!settled){settled=true;clearTimeout(deadline);if(code===0&&completed)resolve(completed);else reject(new Error('Native host exited '+code+': '+error));}});
    child.stdin.write(frame({type:'hello',version:1}));
  });}
  const first=await cycle();assert.equal(first.fullTrees,3);const persisted=new Store(db,'test');
  try{assert.ok(persisted.read('chat-0').raw.mapping.descendant);assert.equal(persisted.search('LONGTEXT')[0].text.length,25009);persisted.meta('next_run_at',0);}finally{persisted.close();}
  const before=f.requests.length,second=await cycle();assert.equal(second.fullTrees,6);assert.equal(second.fetched,3);
  assert.equal(f.requests.slice(before).some(p=>p.includes('offset=')),false);
});

test('native host refuses a foreign extension origin before creating its database',async t=>{
  const f=await fixture(t),settings=path.join(f.dir,'host.json'),db=path.join(f.dir,'forbidden.sqlite');writeFileSync(settings,JSON.stringify(config(db)));
  const result=await new Promise(resolve=>{const child=spawn(process.execPath,['src/browser-host.mjs','--config',settings,`chrome-extension://${'b'.repeat(32)}/`]);child.stdin.end();child.on('close',code=>resolve(code));});
  assert.equal(result,1);assert.throws(()=>workerConfig({...config(db),extensionId:'not-an-extension'}),/extension/);
});
test('local-only Codex MCP exposes local tools and refuses online sync even when explicitly called',async t=>{
  const f=await fixture(t),requests=[{jsonrpc:'2.0',id:1,method:'tools/list'},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'sync_history',arguments:{}}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_sync_status',arguments:{}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'list_threads',arguments:{page:1,limit:10}}}];
  const output=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['src/cli.mjs','serve','--local-only','--account','test','--db',f.db]);let text='',errors='';
    child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>errors+=b);child.on('error',reject);child.on('close',code=>code?reject(new Error(errors)):resolve(text));child.stdin.end(requests.map(JSON.stringify).join('\n')+'\n');});
  const replies=output.trim().split('\n').map(JSON.parse);assert.equal(replies[0].result.tools.length,7);assert.equal(replies[0].result.tools.some(t=>t.name==='sync_history'),false);assert.ok(replies[0].result.tools.some(t=>t.name==='chat_index'));
  assert.equal(replies[1].result.isError,true);assert.match(replies[1].result.content[0].text,/local data only/);assert.equal(JSON.parse(replies[2].result.content[0].text).threads,0);
  assert.deepEqual(JSON.parse(replies[3].result.content[0].text).items,[]);assert.equal(f.requests.length,0);
});
