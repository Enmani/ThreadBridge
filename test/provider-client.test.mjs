import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {providerPageRequest} from '../extension/provider-client.js';
import {claudeDetail,geminiDirectory,geminiDetail} from './provider-fixtures.mjs';

function response(data,{status=200,type='application/json',retry=null,raw=false}={}){
  return {ok:status===200,status,headers:{get:name=>name==='content-type'?type:name==='retry-after'?retry:null},text:async()=>raw?data:JSON.stringify(data)};
}
function client(origin,fetch){
  const ctx=vm.createContext({location:{origin},fetch,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,Uint8Array});
  return vm.runInContext('('+providerPageRequest.toString()+')',ctx);
}
function batch(rpc,body){const frame=JSON.stringify([['wrb.fr',rpc,JSON.stringify(body),null]]);return ")]}'\n\n"+frame.length+'\n'+frame+'\n';}

test('Claude browser requests bind a selected organization, use history GETs only and keep session details private',async()=>{
  const calls=[];let organizations=['one'],user='claude-user';
  const request=client('https://claude.ai',async(p,options)=>{
    calls.push({p,options});assert.equal(options.credentials,'include');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    return response(p==='/api/account'?{uuid:user,private_session:'browser-only',memberships:organizations.map(uuid=>({organization:{uuid}}))}:claudeDetail());
  });
  const auth=await request('/api/auth/session',null,'claude');assert.equal(auth.workspace,'one');assert.equal(JSON.stringify(auth).includes('browser-only'),false);
  const detail=await request('/history/conversation/same-id',auth.workspace,'claude');assert.equal(detail.identity,user);assert.equal(detail.workspace,'one');assert.equal(detail.data.chat_messages.length,3);
  assert.match(calls.at(-1).p,/tree=True/);
  const before=calls.length;assert.equal((await request('/api/organizations/one/chat_conversations/delete','one','claude')).status,403);assert.equal(calls.length,before);
  assert.equal((await request('/history/list?scope=active&offset=-1',null,'claude')).status,403);assert.equal(calls.length,before);
  organizations=['one','two'];assert.equal((await request('/api/auth/session',null,'claude')).status,403);
  assert.equal((await request('/api/auth/session','two','claude')).workspace,'two');user='switched';assert.equal((await request('/api/auth/session','two','claude')).identity,'switched');
  organizations=['one'];assert.equal((await request('/history/conversation/same-id','two','claude')).status,403);
});

test('Gemini browser constructs only list/read RPCs, parses framed Unicode and never exports bootstrap tokens',async()=>{
  const calls=[],token='browser-only-token';let identity='first@example.test';
  const request=client('https://gemini.google.com',async(p,options)=>{
    calls.push({p,options});assert.equal(options.credentials,'include');
    if(p.startsWith('/app?'))return response('<script>window.WIZ_global_data='+JSON.stringify({SNlM0e:token,oPEP7c:identity,cfb2h:'build',FdrFJe:'session'})+'</script>',{raw:true,type:'text/html'});
    const params=new URLSearchParams(options.body),req=JSON.parse(params.get('f.req')),rpc=req[0][0][0],payload=JSON.parse(req[0][0][1]);
    assert.equal(params.get('at'),token);assert.equal(options.method,'POST');assert.match(p,/authuser=1/);assert.equal(options.redirect,'error');
    if(rpc==='MaZiqc'){assert.equal(payload[0],100);assert.equal(payload[1],'中文游标');assert.equal(payload[2][0],1);const data=geminiDirectory('c_example','下一页');data[2][0][1]='中文😀标题';return response(batch(rpc,data),{raw:true,type:'application/json'});}
    assert.equal(rpc,'hNvQHb');assert.equal(payload[0],'c_example');assert.equal(payload[1],10000);return response(batch(rpc,geminiDetail().body),{raw:true});
  });
  const auth=await request('/api/auth/session',null,'gemini',1);assert.equal(auth.identity,'first@example.test');
  assert.equal(JSON.stringify(auth).includes(token),false);assert.equal(JSON.stringify(auth).includes('session'),false);
  const list=await request('/history/list?scope=pinned&offset=0&cursor='+encodeURIComponent('中文游标'),null,'gemini',1);
  assert.equal(list.data[2][0][1],'中文😀标题');assert.equal(list.data[1],'下一页');assert.equal(JSON.stringify(list).includes(token),false);
  const detail=await request('/history/conversation/c_example',null,'gemini',1);assert.equal(detail.data.conversation_id,'c_example');assert.equal(detail.data.body[0].length,2);
  identity='second@example.test';assert.equal((await request('/api/auth/session',null,'gemini',1)).identity,'second@example.test');
  const before=calls.length;
  for(const path of ['/history/delete/c_example','/history/list?scope=active&offset=0&rpc=delete','/history/list?scope=active&scope=pinned&offset=0'])assert.equal((await request(path,null,'gemini',1)).status,403);
  assert.equal(calls.length,before);
});

test('Gemini malformed frames, missing identities and rate-limited sessions cannot become empty successful archives',async()=>{
  let raw=batch('MaZiqc',geminiDirectory()),authMode='ready',historyStatus=200;
  const request=client('https://gemini.google.com',async p=>{
    if(p.startsWith('/app?')){
      if(authMode==='limited')return response('',{status:429,retry:'7200'});
      return response(JSON.stringify({SNlM0e:'token',...(authMode==='ready'?{oPEP7c:'user@example.test'}:{})}),{raw:true,type:'text/html'});
    }return response(raw,{raw:true,status:historyStatus,retry:'3600'});
  });
  const list=()=>request('/history/list?scope=active&offset=0',null,'gemini');
  for(const invalid of [raw.slice(0,-3),")]}'\n\n1\n{",batch('different',[]),")]}'\n\n2\n[]"]){raw=invalid;await assert.rejects(list());}
  raw=batch('MaZiqc',geminiDirectory());assert.equal((await list()).status,200);
  historyStatus=429;const limited=await list();assert.equal(limited.status,429);assert.equal(limited.retry,'3600');assert.equal(limited.data,undefined);
  authMode='missing';assert.equal((await list()).status,401);authMode='limited';assert.equal((await list()).retry,'7200');
});

test('provider client rejects unexpected origins and cancels oversized streamed responses',async()=>{
  let calls=0,cancelled=false;
  const foreign=client('https://foreign.example',async()=>{calls++;});assert.equal((await foreign('/api/auth/session',null,'gemini')).status,403);assert.equal(calls,0);
  const request=client('https://claude.ai',async()=>({ok:true,status:200,headers:{get:()=> 'application/json'},body:{getReader(){return {
    async read(){return {done:false,value:new Uint8Array(33*1024*1024)};},async cancel(){cancelled=true;},releaseLock(){}};}}}));
  await assert.rejects(request('/api/auth/session',null,'claude'),/too large/);assert.equal(cancelled,true);
});
