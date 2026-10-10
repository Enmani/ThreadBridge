import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {labels} from '../web/labels.mjs';

const source=name=>readFileSync(new URL('../web/'+name,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
function page(t,name){
  const dom=new JSDOM(readFileSync(new URL('../web/'+name,import.meta.url),'utf8'),{url:'http://127.0.0.1:17331',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
  const w=dom.window;w.testLabels=labels;w.setInterval=()=>0;w.matchMedia=()=>({matches:false});w.AbortSignal=AbortSignal;
  // jsdom has no native popovers. This shim permits event/async checks only, not visual validation.
  const proto=w.HTMLElement.prototype,matches=proto.matches;
  proto.showPopover=function(){this.dataset.open='true';};proto.hidePopover=function(){delete this.dataset.open;};
  proto.matches=function(selector){return selector===':popover-open'?this.dataset.open==='true':matches.call(this,selector);};
  return w;
}
async function until(check){for(let i=0;i<50;i++){if(check())return;await new Promise(r=>setImmediate(r));}assert.fail('UI update did not complete');}
const response=value=>({ok:true,json:async()=>value});

test('changing a column while a previous list is loading discards stale rows and requests the chosen global order',async t=>{
  const w=page(t,'index.html'),requests=[];let finish;
  const status={runtime:{connected:false,paused:false,mode:'full',watchNew:false},background:{state:'connecting',paceMs:90000},capabilities:{browserArchive:true,jsonImport:true},threads:1,fullTrees:0,textArchives:0,browserArchives:0,importedArchives:0,pending:1};
  const list=title=>({total:1,pages:1,items:[{id:'c_example',title,provider:'gemini',providerName:'Gemini',scope:'active',coverage:'not-read',messages:0,pending:1}]});
  w.fetch=async path=>{requests.push(path);if(path.startsWith('/api/status'))return response(status);
    if(requests.filter(p=>p.startsWith('/api/threads')).length===1)return new Promise(r=>finish=()=>r(response(list('stale'))));
    return response(list('chosen'));};
  w.eval('const l=window.testLabels;'+['theme.mjs','floating-ui.mjs','sort-ui.mjs','import-ui.mjs','app.mjs'].map(source).join('\n'));
  w.document.querySelector('[data-sort="title"]').click();w.document.querySelector('[data-order="asc"]').click();finish();
  await until(()=>w.document.getElementById('rows').textContent.includes('chosen'));
  assert.equal(w.document.getElementById('rows').textContent.includes('stale'),false);
  const query=new URL(requests.filter(p=>p.startsWith('/api/threads')).at(-1),'http://local').searchParams;
  assert.equal(query.get('sort'),'title');assert.equal(query.get('order'),'asc');assert.equal(query.get('page'),'1');assert.equal(query.has('provider'),false);
  assert.equal(w.document.querySelector('[data-sort="title"]').closest('th').getAttribute('aria-sort'),'ascending');
  w.document.getElementById('sort-direction').value='desc';w.document.getElementById('sort-direction').dispatchEvent(new w.Event('change'));
  await until(()=>requests.filter(p=>p.startsWith('/api/threads')).length===3);assert.match(requests.at(-1),/order=desc/);
});

test('Settings preserves existing platforms and waits for verified connection instead of labeling a successful add as connected',async t=>{
  const w=page(t,'settings.html');let added=false,verified=false,poll;
  w.setInterval=callback=>{poll=callback;return 0;};
  w.fetch=async(path,options)=>{
    if(path==='/api/models')return response({items:[],settings:{connection:null,model:null,running:false,dailyLimit:200,completed:0},usage:{requests:0,input_tokens:0,output_tokens:0},indexEnabled:true});
    if(path==='/api/index')return response({enabled:true,eligible:0,indexed:0,pending:0,errors:0,pendingSummaries:0,updated:null});
    assert.equal(path,'/api/connections');if(options?.method==='POST'){assert.deepEqual(JSON.parse(options.body),{provider:'claude'});added=true;return response({added:true,connected:false});}
    return response({items:[{name:'ChatGPT',status:'connected'},...(added?[{name:'Claude',status:verified?'connected':'connecting'}]:[])],available:added?[{id:'gemini',name:'Gemini'}]:[{id:'claude',name:'Claude'},{id:'gemini',name:'Gemini'}]});
  };
  w.eval('const l=window.testLabels;'+source('theme.mjs')+'\n'+source('index-settings.mjs')+'\n'+source('model-settings.mjs')+'\n'+source('settings.mjs'));
  await until(()=>!w.document.getElementById('show-add').disabled);w.document.getElementById('show-add').click();
  w.document.getElementById('add-form').dispatchEvent(new w.Event('submit',{cancelable:true}));
  await until(()=>w.document.getElementById('connections').textContent.includes('Claude'));
  const rows=w.document.querySelectorAll('#connections li');assert.equal(rows[0].textContent,'ChatGPT已连接');assert.equal(rows[1].textContent,'Claude连接中…');
  verified=true;poll();await until(()=>w.document.querySelectorAll('#connections li')[1].textContent==='Claude已连接');
  assert.equal(w.document.getElementById('add-form').hidden,true);assert.equal(w.document.getElementById('add-provider').value,'gemini');
});

test('index Settings keeps a successful pause when an older poll finishes and shows rebuild failures',async t=>{
  const w=page(t,'settings.html');let poll,finishOld,gets=0,enabled=true,fail=false;
  const state=()=>({enabled,eligible:2,indexed:2,pending:0,errors:0,pendingSummaries:9,updated:null});
  w.setInterval=callback=>{poll=callback;return 0;};
  w.fetch=async(path,options)=>{
    assert.equal(path,'/api/index');
    if(options?.method==='POST'){const value=JSON.parse(options.body);if(fail)return {ok:false};if(value.enabled!==undefined)enabled=value.enabled;return response(state());}
    gets++;if(gets===2)return new Promise(r=>finishOld=()=>r(response({...state(),enabled:true})));return response(state());
  };
  w.eval('const l=window.testLabels;'+source('index-settings.mjs')+'\nsetupIndexSettings();');
  const toggle=w.document.getElementById('index-enabled');await until(()=>!toggle.disabled);assert.equal(toggle.checked,true);
  poll();toggle.click();await until(()=>!toggle.disabled);assert.equal(toggle.checked,false);finishOld();
  await until(()=>w.document.getElementById('index-state').textContent===labels.indexPaused);assert.equal(toggle.checked,false);
  toggle.click();await until(()=>!toggle.disabled);assert.equal(toggle.checked,true);
  fail=true;w.document.getElementById('index-rebuild').click();await until(()=>!w.document.getElementById('index-error').hidden);
  assert.equal(w.document.getElementById('index-error').textContent,labels.indexSettingsError);assert.equal(toggle.checked,true);assert.equal(w.document.getElementById('index-rebuild').disabled,false);
});
