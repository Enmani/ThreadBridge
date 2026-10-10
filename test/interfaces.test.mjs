import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {fixture,tree} from './fixtures.mjs';
import {snapshot} from '../src/model.mjs';
import {NativePipe,syncNative} from '../src/native.mjs';
import {HttpTransport,CdpTransport} from '../src/transport.mjs';
import {integer,ids,importTrees} from '../src/service.mjs';

test('CLI imports raw exports, reads historical branches and retrieves changes',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'conversations.json');writeFileSync(file,JSON.stringify([tree('cli-chat')]));
  const run=(args)=>{const p=spawnSync(process.execPath,['src/cli.mjs',...args,'--db',f.db,'--account','cli'],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
  assert.equal(run(['import','--input',file]).imported,1);assert.equal(run(['status']).messages,4);
  assert.equal(run(['read','--id','cli-chat']).raw.mapping.descendant.parent,'alternate');assert.equal(run(['search','--query','独立']).length,1);
  const delta=run(['changes','--consumer','cli-reader']);assert.equal(delta.items.length,4);run(['ack','--consumer','cli-reader','--through',String(delta.through)]);
  assert.equal(run(['changes','--consumer','cli-reader']).items.length,0);
  const failed=spawnSync(process.execPath,['src/cli.mjs','sync','--db',f.db,'--account','unauthenticated'],{encoding:'utf8',env:{...process.env,CHATGPT_BEARER_TOKEN:'',CHATGPT_CDP_URL:''}});
  assert.equal(failed.status,1);assert.match(failed.stderr,/logged-in CDP session/);
});
test('MCP stdio negotiates, discovers tools, searches and rejects malformed calls without losing state',async t=>{
  const f=await fixture(t);f.store.save(snapshot(tree('mcp-chat'),'mcp-chat'));
  const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/list'},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'search_history',arguments:{query:'branch descendant'}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'ack_changes',arguments:{consumer:'new',through:999}}},
    {jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'fetch_threads',arguments:{ids:['mcp-chat']}}},
    {jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'sync_history',arguments:{concurrency:0}}}];
  const replies=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['src/cli.mjs','serve','--db',f.db,'--account','test']);let output='',errors='';
    child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>errors+=x);child.on('error',reject);child.on('close',code=>code?reject(new Error(errors)):resolve(output.trim().split('\n').map(JSON.parse)));
    child.stdin.end(requests.map(x=>JSON.stringify(x)).join('\n')+'\n');});
  assert.equal(replies.length,6);assert.equal(replies[0].result.protocolVersion,'2025-06-18');assert.equal(replies[1].result.tools.length,8);assert.ok(replies[1].result.tools.some(t=>t.name==='chat_index'));
  assert.equal(JSON.parse(replies[2].result.content[0].text)[0].thread,'mcp-chat');assert.equal(replies[3].result.isError,true);
  assert.ok(JSON.parse(replies[4].result.content[0].text)[0].raw.mapping.descendant);assert.equal(replies[5].result.isError,true);
});
test('native framed pipe supports split frames, unique call IDs, paginated text and bounded coverage',async t=>{
  const f=await fixture(t);const address=process.platform==='win32'?`\\\\.\\pipe\\threadbridge-test-${randomUUID()}`:path.join(f.dir,'pipe.sock');const callIds=new Set();
  const server=net.createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('data',data=>{buffer=Buffer.concat([buffer,data]);
    while(buffer.length>=4 && buffer.length>=4+buffer.readUInt32LE()){
      const length=buffer.readUInt32LE(),request=JSON.parse(buffer.subarray(4,length+4));buffer=buffer.subarray(length+4);let result;
      if(request.method==='tools/list')result={tools:[{name:'read_thread',namespace:'codex_app'}]};
      else{assert.equal(request.params.tool,'read_thread');assert.ok(!callIds.has(request.params.callId));callIds.add(request.params.callId);
        const args=request.params.arguments,id=args.threadId,older=Boolean(args.cursor);
        result={success:true,contentItems:[{type:'inputText',text:JSON.stringify({thread:{id,title:id},turns:[{items:[{type:older?'userMessage':'agentMessage',id:older?'user-old':'answer-new',...(older?{content:[{type:'text',text:'older question'}]}:{text:'newer answer'})}]}],page:{nextCursor:older?null:'older-page',hasMore:!older}})}]};}
      const payload=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));const frame=Buffer.alloc(4+payload.length);frame.writeUInt32LE(payload.length);payload.copy(frame,4);
      socket.write(frame.subarray(0,2));socket.write(frame.subarray(2));
    }});});
  await new Promise(resolve=>server.listen(address,resolve));const pipe=await NativePipe.connect('caller-test',address);
  try{const run=await syncNative(pipe,f.store,['native-1','native-2']);assert.equal(run.fetched,2);assert.equal(run.changedMessages,4);assert.equal(run.ok,true);
    assert.equal(f.store.read('native-1').coverage,'bounded-text');assert.equal(f.store.read('native-1').raw.mapping['answer-new'].parent,'user-old');
    const slice=await pipe.read('native-partial',{maxPages:1});assert.equal(JSON.parse(slice.raw).native.hasMore,true);assert.equal(callIds.size,5);
  }finally{pipe.close();await new Promise(resolve=>server.close(resolve));}
});
test('input and account boundaries reject unsafe values; imports refuse flattened exports',async t=>{
  const f=await fixture(t);assert.throws(()=>integer('NaN',3,1,8));assert.throws(()=>ids('../private'));assert.throws(()=>ids([]));
  assert.throws(()=>new HttpTransport({base:'https://example.org',token:'do-not-send'}),/Unsupported API origin/);
  await assert.rejects(CdpTransport.connect('http://example.org:9333'),/localhost/);
  const report=importTrees(f.store,[{id:'flat',messages:[{text:'missing branch tree'}]}]);assert.equal(report.ok,false);assert.equal(f.store.status().threads,0);
});
