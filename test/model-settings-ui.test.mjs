import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {labels} from '../web/labels.mjs';

async function until(check){for(let i=0;i<80;i++){if(check())return;await new Promise(r=>setImmediate(r));}assert.fail('UI update did not complete');}
function setup(t){
  const dom=new JSDOM(readFileSync(new URL('../web/settings.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:17331',runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());const w=dom.window;w.testLabels=labels;w.AbortSignal=AbortSignal;w.setInterval=()=>0;
  return w;
}
const source=readFileSync(new URL('../web/model-settings.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
const initial=()=>({items:[],settings:{connection:null,model:null,running:false,dailyLimit:200,completed:0,error:null},usage:{requests:0,input_tokens:0,output_tokens:0},indexEnabled:true});
const item={id:'local',name:'My local service',kind:'local',protocol:'compatible',endpoint:'http://127.0.0.1:11434/v1',status:'connected',models:['small','large']};
const response=value=>({ok:true,json:async()=>structuredClone(value)});

test('Settings adds a local connection, selects a verified model, and starts and pauses real server operations',async t=>{
  const w=setup(t),data=initial(),writes=[];w.fetch=async(path,options)=>{
    assert.equal(path,'/api/models');if(options?.method==='POST'){
      const value=JSON.parse(options.body);writes.push(value);
      if(value.action==='save')data.items=[item];
      if(value.action==='select'){data.settings.connection=value.connection;data.settings.model=value.model;}
      if(value.action==='run')data.settings.running=value.running;
    }return response(data);
  };
  w.eval('const l=window.testLabels;'+source+'\nsetupModelSettings();');const get=id=>w.document.getElementById(id);
  await until(()=>!get('show-model').disabled);assert.equal(get('summary-status').textContent,labels.summaryNoModel);
  get('summary-run').click();assert.equal(get('model-form').hidden,false);get('model-kind').value='local';get('model-kind').dispatchEvent(new w.Event('change'));
  assert.equal(get('model-key').required,false);assert.equal(get('model-endpoint').required,true);assert.equal(get('model-protocol-field').hidden,true);
  get('model-name').value='My local service';get('model-endpoint').value=item.endpoint;get('model-key').value='synthetic-key';
  get('model-form').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(get('model-key').value,'');
  await until(()=>get('model-form').hidden);assert.equal(get('model-connections').textContent.includes('已连接'),true);
  assert.deepEqual(writes[0],{action:'save',name:'My local service',kind:'local',protocol:'compatible',endpoint:item.endpoint,apiKey:'synthetic-key'});
  get('summary-model').value=JSON.stringify(['local','small']);get('summary-model').dispatchEvent(new w.Event('change'));await until(()=>!get('summary-model').disabled);
  get('summary-run').click();await until(()=>get('summary-run').textContent===labels.pauseSummary);
  assert.match(get('summary-destination').textContent,/127\.0\.0\.1/);get('summary-run').click();await until(()=>get('summary-run').textContent===labels.startSummary);
  assert.deepEqual(writes.slice(1),[{action:'select',connection:'local',model:'small'},{action:'run',running:true},{action:'run',running:false}]);
});

test('an older poll cannot undo selected model state and a failed model change restores the saved choice',async t=>{
  const w=setup(t),data=initial();data.items=[item];data.settings.connection='local';data.settings.model='small';let poll,finishOld,gets=0,fail=false;
  w.setInterval=callback=>{poll=callback;return 0;};w.fetch=async(path,options)=>{
    if(options?.method==='POST'){if(fail)return {ok:false,json:async()=>({code:'model-unavailable'})};const value=JSON.parse(options.body);data.settings.model=value.model;return response(data);}
    if(++gets===2)return new Promise(r=>finishOld=()=>r(response({...data,settings:{...data.settings,model:'small'}})));return response(data);
  };
  w.eval('const l=window.testLabels;'+source+'\nsetupModelSettings();');const select=w.document.getElementById('summary-model');await until(()=>!select.disabled);
  poll();select.value=JSON.stringify(['local','large']);select.dispatchEvent(new w.Event('change'));await until(()=>!select.disabled);finishOld();
  await until(()=>select.value===JSON.stringify(['local','large']));fail=true;select.value=JSON.stringify(['local','small']);select.dispatchEvent(new w.Event('change'));
  await until(()=>!w.document.getElementById('model-error').hidden);assert.equal(select.value,JSON.stringify(['local','large']));
  assert.equal(w.document.getElementById('model-error').textContent,labels.modelErrors['model-unavailable']);
  fail=false;poll();await until(()=>!select.disabled);await new Promise(r=>setImmediate(r));
  assert.equal(w.document.getElementById('model-error').hidden,false);
});

test('client mode displays MCP setup and on-demand state, never starts background generation or stores credentials',async t=>{
  const w=setup(t),data=initial(),client={id:'client',name:'Existing AI',kind:'client',protocol:'mcp',endpoint:'',status:'waiting-client',models:['client-current'],config:{mcpServers:{test:{command:'node',args:['serve']}}}};
  data.items=[client];data.settings.connection='client';data.settings.model='client-current';let posts=0;
  w.fetch=async(path,options)=>{if(options?.method==='POST')posts++;return response(data);};
  w.eval('const l=window.testLabels;'+source+'\nsetupModelSettings();');const get=id=>w.document.getElementById(id);await until(()=>!get('summary-model').disabled);
  assert.equal(get('summary-status').textContent,labels.summaryClient);get('summary-run').click();assert.equal(get('client-setup').hidden,false);assert.match(get('client-config').textContent,/mcpServers/);assert.equal(posts,0);
  assert.equal(get('summary-quota').hidden,true);
  get('show-model').click();get('model-kind').value='client';get('model-kind').dispatchEvent(new w.Event('change'));
  assert.equal(get('model-key-field').hidden,true);assert.equal(get('model-endpoint').required,false);
  w.document.dispatchEvent(new w.CustomEvent('index-settings-updated',{detail:{enabled:false}}));assert.equal(get('summary-status').textContent,labels.summaryIndexPaused);
  assert.equal(w.localStorage.length,0);
});
