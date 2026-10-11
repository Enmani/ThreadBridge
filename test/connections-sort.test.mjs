import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {connections,addConnection,connectionStatus} from '../src/connections.mjs';
import {combinedThreads} from '../src/history-view.mjs';
import {createDashboard} from '../src/dashboard-server.mjs';
import {BrowserWorker,workerConfig} from '../src/browser-worker.mjs';
import {snapshot} from '../src/model.mjs';
import {providerSnapshot} from '../src/providers.mjs';
import {tree} from './fixtures.mjs';
import {claudeDetail} from './provider-fixtures.mjs';

function stores(t){const root=new Store(':memory:','test');t.after(()=>root.close());return new Map(['chatgpt','claude','gemini'].map(p=>[p,root.scope(p)]));}
async function dashboard(t,map){const server=createDashboard(map);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return 'http://127.0.0.1:'+server.address().port;}
const post=(base,path,value)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(value)});

test('adding a platform persists it without claiming connection; a paused worker verifies login without reading history',async t=>{
  const map=stores(t),root=map.get('chatgpt'),c=map.get('claude'),base=await dashboard(t,map);
  root.meta('sync_paused',1);root.meta('rate_limit_until',Date.now()+60000);
  const response=await post(base,'/api/connections',{provider:'claude'});assert.equal(response.status,202);assert.equal((await response.json()).connected,false);
  assert.equal(c.meta('sync_paused'),'1');assert.equal(c.meta('rate_limit_until'),null);
  assert.equal(connections(root).length,2);assert.equal(connectionStatus(c).connected,false);
  assert.equal((await post(base,'/api/connections',{provider:'claude'})).status,409);
  assert.equal((await post(base,'/api/connections',{provider:'gemini',workspace:'wrong'})).status,400);
  const calls=[],rpc={closed:false,send(){},async request(path){calls.push(path);return {status:200,identity:'claude-user',workspace:'org'};}};
  const worker=new BrowserWorker(rpc,c,workerConfig({initialPaceMs:0,initialMinPaceMs:0,initialMaxPerRun:5,initialDirectoryPages:3,db:':memory:',account:'test',provider:'claude',extensionId:'a'.repeat(32),paceMs:0}));
  try{await worker.run();assert.deepEqual(calls,['/api/auth/session']);assert.equal(c.meta('connection_requested'),'0');assert.equal(c.meta('worker_state'),'paused');
    assert.equal(connectionStatus(c).connected,true);assert.equal((await fetch(base+'/api/connections').then(r=>r.json())).items[1].status,'connected');
  }finally{worker.close();}
  assert.equal(connectionStatus(c).connected,false);
});

test('failed login stays unconnected and newly added platforms remain listed on retry',async t=>{
  const map=stores(t),root=map.get('chatgpt'),c=map.get('claude');addConnection(root,{provider:'claude'},c);
  const worker=new BrowserWorker({closed:false,send(){},async request(){return {status:401};}},c,workerConfig({initialPaceMs:0,initialMinPaceMs:0,initialMaxPerRun:5,initialDirectoryPages:3,db:':memory:',account:'test',provider:'claude',extensionId:'a'.repeat(32),paceMs:0}));
  try{await worker.run();assert.equal(connectionStatus(c).status,'login-required');assert.equal(connectionStatus(c).connected,false);assert.equal(connections(root).length,2);}
  finally{worker.close();}
});

test('each column sorts the complete merged history before pagination and keeps provider identity',t=>{
  const map=stores(t),[chat,c,g]=map.values();
  chat.discover({id:'shared',title:'Gamma',scope:'archived',project:'g-p-test',updated:'2026-10-02',assistantUpdated:null});chat.save(snapshot({...tree('shared'),title:'Gamma'},'shared'));
  c.discover({id:'shared',title:'Alpha',scope:'pinned',project:'p-test',updated:'2026-10-01',assistantUpdated:null});c.save(providerSnapshot('claude',{...claudeDetail('shared'),name:'Alpha'},'shared'));
  g.discover({id:'c_example',title:'Beta',scope:'active',project:'p-test',updated:'2026-10-03',assistantUpdated:null});
  chat.rememberProject('g-p-test','B project');c.rememberProject('p-test','C project');g.rememberProject('p-test','A project');
  for(const [s,date] of [[chat,'2026-10-03'],[c,'2026-10-02'],[g,'2026-10-01']])s.db.prepare('UPDATE threads SET last_checked_at=? WHERE account=?').run(date,s.account);
  const expected={title:['claude','gemini','chatgpt'],provider:['chatgpt','claude','gemini'],scope:['gemini','chatgpt','claude'],project:['gemini','chatgpt','claude'],coverage:['claude','chatgpt','gemini'],messages:['gemini','claude','chatgpt'],source_updated:['claude','chatgpt','gemini'],last_checked_at:['gemini','claude','chatgpt']};
  const list=[...map.values()];
  for(const [sort,asc] of Object.entries(expected))for(const order of ['asc','desc']){
    const rows=[1,2,3].map(page=>combinedThreads(list,{sort,order,page,limit:1}).items[0]);
    assert.deepEqual(rows.map(r=>r.provider),order==='asc'?asc:asc.toReversed(),sort+' '+order);assert.equal(rows.filter(r=>r.id==='shared').length,2);
  }
  assert.throws(()=>combinedThreads(list,{sort:'title; DELETE FROM threads'}),/parameters/);assert.throws(()=>combinedThreads(list,{order:'random'}),/parameters/);
  assert.equal(combinedThreads([c],{query:'shared'}).total,1);assert.equal(combinedThreads(list,{query:'%_'}).total,0);
  assert.equal(JSON.stringify(combinedThreads(list)).includes('searchable'),false);
});

test('global controls change every added platform atomically while preserving independent cooldowns',async t=>{
  const map=stores(t),root=map.get('chatgpt'),c=map.get('claude'),g=map.get('gemini'),base=await dashboard(t,map);
  addConnection(root,{provider:'claude'},c);addConnection(root,{provider:'gemini'},g);c.meta('rate_limit_until',9999999999999);
  assert.equal((await post(base,'/api/control',{paused:true})).status,200);for(const store of map.values())assert.equal(store.meta('sync_paused'),'1');
  assert.equal((await post(base,'/api/control',{mode:'ids'})).status,200);for(const store of map.values()){assert.equal(store.meta('sync_mode'),'ids');assert.equal(store.meta('sync_paused'),'0');}
  assert.equal(c.meta('rate_limit_until'),'9999999999999');
  root.db.exec(`CREATE TRIGGER reject_control BEFORE INSERT ON meta WHEN NEW.account LIKE '@threadbridge/gemini/%' AND NEW.key='sync_paused' BEGIN SELECT RAISE(ABORT,'control failure'); END;`);
  assert.equal((await post(base,'/api/control',{paused:true})).status,500);for(const store of map.values())assert.equal(store.meta('sync_paused'),'0');
  assert.equal((await fetch(base+'/api/threads?sort=invalid')).status,400);
});
