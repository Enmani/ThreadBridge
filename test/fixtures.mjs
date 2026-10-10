import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {HttpTransport} from '../src/transport.mjs';

export function tree(id,text=`content ${id}`,updated=Date.now()/1000) {
  const mapping={
    root:{id:'root',parent:null,children:['user'],message:null},
    user:{id:'user',parent:'root',children:['answer','alternate'],message:{id:'u',author:{role:'user'},content:{content_type:'text',parts:[text]},metadata:{attachments:[{id:'file-x',name:'sample.pdf'}]}}},
    answer:{id:'answer',parent:'user',children:[],message:{id:'a',author:{role:'assistant'},content:{content_type:'text',parts:['main answer']}}},
    alternate:{id:'alternate',parent:'user',children:['descendant'],message:{id:'b',author:{role:'assistant'},content:{content_type:'text',parts:['alternate answer']}}},
    descendant:{id:'descendant',parent:'alternate',children:[],message:{id:'c',author:{role:'user'},content:{content_type:'text',parts:['branch descendant 独立分支']}}},
  };
  return {conversation_id:id,title:id,update_time:updated,current_node:'answer',mapping};
}
export async function fixture(t) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'threadbridge-test-'));const db=path.join(dir,'test.sqlite');
  const store=new Store(db,'test');const records=new Map();const active=[],archived=[],projects=new Map([['g-p-main',[]],['g-p-empty',[]],['g-p-hidden',[]]]);
  const now=Date.now()/1000;for(let i=0;i<60;i++){const id=`chat-${i}`;active.push(id);records.set(id,tree(id,i===0?'LONGTEXT '+ 'x'.repeat(25000):undefined,now-i));}
  for(let i=0;i<4;i++){const id=`archive-${i}`;archived.push(id);records.set(id,tree(id,undefined,now-i));}
  for(let i=0;i<4;i++){const id=`project-${i}`;projects.get(i===3?'g-p-hidden':'g-p-main').push(id);records.set(id,tree(id,undefined,now-i));}
  const requests=[],failDetail=new Set(),failCounts=new Map();let directoryFailure=false,batchTruncated=false,optionalProjects=[];
  function item(id){const raw=records.get(id);return {id,title:raw.title,update_time:raw.update_time,...(id==='chat-0'?{gizmo_id:'g-p-hidden'}:{})};}
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');requests.push(url.pathname+url.search);res.setHeader('content-type','application/json');
    const send=(value,status=200)=>{res.statusCode=status;res.end(JSON.stringify(value));};
    if(url.pathname==='/backend-api/conversations'){
      if(directoryFailure)return send({},401);
      const list=url.searchParams.get('is_archived')==='true'?archived:active;
      const sorted=[...list].sort((a,b)=>records.get(b).update_time-records.get(a).update_time);
      const offset=Number(url.searchParams.get('offset'));return send({items:sorted.slice(offset,offset+7).map(item),total:sorted.length,limit:7});
    }
    if(url.pathname==='/backend-api/gizmos/snorlax/sidebar')return send(url.searchParams.has('cursor')?{items:[{gizmo:{id:'g-p-empty'}}],cursor:null}:{items:[{gizmo:{gizmo:{id:'g-p-main'}}}],cursor:'sidebar-2'});
    if(url.pathname==='/backend-api/projects' && optionalProjects.length)return send({projects:optionalProjects.map(id=>({resource:{id}}))});
    const project=/^\/backend-api\/gizmos\/(g-p-[^/]+)\/conversations$/.exec(url.pathname);
    if(project){const list=projects.get(project[1]) ?? [];const offset=Number(url.searchParams.get('cursor'));return send({items:list.slice(offset,offset+2).map(item),cursor:offset+2<list.length?String(offset+2):null});}
    if(url.pathname==='/backend-api/conversations/batch'){
      let body='';for await(const part of req)body+=part;const {conversation_ids}=JSON.parse(body);
      return send(conversation_ids.map(id=>{const raw=structuredClone(records.get(id));if(batchTruncated)delete raw.mapping.descendant;return raw;}));
    }
    const detail=/^\/backend-api\/conversation\/([^/]+)$/.exec(url.pathname);
    if(detail){const remaining=failCounts.get(detail[1]) ?? 0;if(remaining){failCounts.set(detail[1],remaining-1);return send({},503);}
      if(failDetail.has(detail[1]))return send({},500);return send(records.get(detail[1]),records.has(detail[1])?200:404);}
    send({},404);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const api=new HttpTransport({base:`http://127.0.0.1:${server.address().port}`,pace:0,retries:0});
  t.after(async()=>{store.close();api.close();await new Promise(resolve=>server.close(resolve));
    const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('threadbridge-test-'))throw new Error('Unsafe temporary cleanup');rmSync(resolved,{recursive:true,force:true});});
  return {dir,db,store,api,records,active,archived,projects,requests,failDetail,failCounts,set optionalProjects(v){optionalProjects=v;},set directoryFailure(v){directoryFailure=v;},set batchTruncated(v){batchTruncated=v;},item};
}
