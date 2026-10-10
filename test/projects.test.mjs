import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {fixture} from './fixtures.mjs';
import {discover} from '../src/discovery.mjs';

test('project names from nested sidebar metadata join both existing and newly discovered directory rows without body reads',async t=>{
  const f=await fixture(t);f.store.discover({id:'old-project-thread',title:'old',project:'g-p-main',scope:'active',updated:null});
  const api={async request(path){
    if(path.startsWith('/backend-api/gizmos/snorlax/sidebar'))return {items:[{gizmo:{gizmo:{id:'g-p-main',display:{name:'Main Project'}}}}],cursor:null};
    return f.api.request(path);
  }};
  await discover(api,f.store,{full:true,directoryOnly:true,newOnly:true});
  const old=f.store.listThreads({query:'old-project-thread'}).items[0],created=f.store.listThreads({query:'project-0'}).items[0];
  assert.equal(old.projectId,'g-p-main');assert.equal(old.projectName,'Main Project');assert.equal(created.projectName,'Main Project');
  assert.equal(f.requests.some(p=>p.startsWith('/backend-api/conversation/')),false);
});

test('project names are account-scoped, survive reopening and update on rename without rewriting chat payloads',async t=>{
  const f=await fixture(t);f.store.discover({id:'named',title:'named',project:'g-p-known',scope:'active',updated:null});
  f.store.rememberProject('g-p-known','Original Name');const reopened=new Store(f.db,'test'),other=new Store(f.db,'other');
  try{
    assert.equal(reopened.listThreads().items[0].projectName,'Original Name');assert.equal(other.meta('project_names'),null);
    reopened.rememberProject('g-p-known','Renamed');assert.equal(f.store.listThreads().items[0].projectName,'Renamed');
    assert.equal(f.store.status().messages,0);assert.equal(f.store.thread('named').revision,0);
  }finally{other.close();reopened.close();}
});

test('unknown project names retain their IDs and workspace or custom-GPT IDs are not labelled as projects',async t=>{
  const f=await fixture(t);for(const [id,project] of [['unknown','g-p-unknown'],['workspace','workspace-id'],['custom','g-custom'],['ordinary',null]])
    f.store.discover({id,title:id,project,scope:'active',updated:null});
  f.store.rememberProject('g-custom','Not a project');f.store.rememberProject('g-p-unknown',null);
  const rows=new Map(f.store.listThreads().items.map(x=>[x.id,x]));assert.equal(rows.get('unknown').projectId,'g-p-unknown');assert.equal(rows.get('unknown').projectName,null);
  for(const id of ['workspace','custom','ordinary'])assert.equal(rows.get(id).projectId,null);
});
