import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {snapshot} from './model.mjs';

// The installed codex-app-tools adapter uses length-prefixed JSON-RPC over this pipe.
// This adapter only permits read_thread; it never dispatches actions to other chats.
export class NativePipe {
  static async connect(caller,pipe=process.env.CODEX_APP_TOOLS_PIPE_PATH) {
    if (!pipe || !caller) throw new Error('Native mode requires CODEX_APP_TOOLS_PIPE_PATH and --caller');
    const obj=new NativePipe(); obj.caller=caller;obj.sequence=0;obj.pending=new Map();obj.buffer=Buffer.alloc(0);
    obj.socket=net.createConnection(pipe);
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{obj.socket.destroy();reject(new Error('Native pipe connection timed out'));},5000);
      obj.socket.once('connect',()=>{clearTimeout(timer);resolve();});
      obj.socket.once('error',()=>{clearTimeout(timer);reject(new Error('Native pipe unavailable'));});
    });
    obj.socket.on('data',data=>obj.receive(data));
    obj.socket.on('error',()=>obj.rejectPending('Native pipe error'));
    obj.socket.on('close',()=>obj.rejectPending('Native pipe closed'));
    try {
      const catalog=await obj.request('tools/list',{threadStartKind:'all'});
      obj.tool=catalog.tools?.find(t=>t.name==='read_thread');
      if (!obj.tool) throw new Error('Native read_thread is unavailable');
      return obj;
    } catch(e){obj.close();throw e;}
  }
  rejectPending(message) {
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(message));}this.pending.clear();
  }
  receive(data) {
    this.buffer=Buffer.concat([this.buffer,data]);
    while(this.buffer.length>=4) {
      const length=this.buffer.readUInt32LE();
      if(length>8*1024*1024){this.rejectPending('Native frame exceeds limit');this.close();return;}
      if(this.buffer.length<length+4)return;
      let reply;
      try{reply=JSON.parse(this.buffer.subarray(4,length+4).toString('utf8'));}
      catch{this.rejectPending('Invalid native JSON');this.close();return;}
      this.buffer=this.buffer.subarray(length+4);
      const p=this.pending.get(reply.id);if(!p)continue;
      this.pending.delete(reply.id);clearTimeout(p.timer);
      reply.error?p.reject(new Error('Native RPC rejected the read')):p.resolve(reply.result);
    }
  }
  request(method,params) {
    const id=++this.sequence,body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,method,params}));
    const header=Buffer.alloc(4);header.writeUInt32LE(body.length);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Native read timed out'));},60000);
      this.pending.set(id,{resolve,reject,timer});this.socket.write(Buffer.concat([header,body]));
    });
  }
  async read(id,{maxPages=100}={}) {
    let cursor;const pages=[],seen=new Set();
    for(let n=0;n<maxPages;n++) {
      const response=await this.request('tools/call',{namespace:this.tool.namespace,tool:this.tool.name,
        arguments:{threadId:id,turnLimit:10,maxOutputCharsPerItem:20000,includeOutputs:true,...(cursor?{cursor}:{})},
        callerSource:'codex',threadId:this.caller,callId:`mcp-call-${randomUUID()}`,turnId:`mcp-turn-${randomUUID()}`});
      if(!response.success){const error=new Error('Native read failed');if(/\b429\b/.test(JSON.stringify(response)))error.status=429;throw error;}
      const block=response.contentItems?.find(x=>x.type==='inputText');
      const page=JSON.parse(block?.text ?? 'null');
      if(!page || page.thread?.id!==id || !Array.isArray(page.turns))throw new Error('Invalid native chat response');
      pages.push(page);cursor=page.page?.nextCursor;
      if(!cursor)break;
      if(seen.has(cursor))throw new Error('Native pagination did not advance');seen.add(cursor);
    }
    return nativeSnapshot(id,pages);
  }
  close(){this.socket?.destroy();}
}
export function nativeSnapshot(id,pages) {
  const mapping={root:{id:'root',parent:null,children:[],message:null}};let parent='root';let n=0;
  for(const page of [...pages].reverse())for(const turn of [...page.turns].reverse())for(const item of turn.items ?? []) {
    if(!['userMessage','agentMessage'].includes(item.type))continue;
    const key=item.id ?? `native-${n++}`;if(mapping[key])continue;
    const text=typeof item.text==='string'?item.text:(item.content ?? []).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    mapping[parent].children.push(key);
    mapping[key]={id:key,parent,children:[],message:{id:key,author:{role:item.type==='userMessage'?'user':'assistant'},content:{content_type:'text',parts:[text]}}};
    parent=key;
  }
  const raw={conversation_id:id,title:pages[0]?.thread?.title ?? '',mapping,current_node:parent,
    native:{pages,hasMore:Boolean(pages.at(-1)?.page?.nextCursor),coverage:'bounded-text'}};
  return snapshot(raw,id,'bounded-text');
}
export async function syncNative(pipe,store,ids,{concurrency=1,maxPages=100}={}) {
  const start=performance.now(),result={source:'native',coverage:'bounded-text',fetched:0,changedMessages:0,failures:[]};
  const owner=randomUUID();store.acquire(owner);let next=0,stopped=false,leaseError;
  const pulse=setInterval(()=>{try{store.acquire(owner);}catch(e){leaseError=e;stopped=true;}},30000);
  try{await Promise.all(Array.from({length:Math.min(concurrency,ids.length)},async()=>{
    while(next<ids.length&&!stopped){const id=ids[next++],observed=store.thread(id);try{
      const snap=await pipe.read(id,{maxPages});if(JSON.parse(snap.raw).native.hasMore)throw new Error('Native pagination incomplete');
      if(leaseError)throw leaseError;const change=store.save(snap,observed?.source_updated,observed?.source_assistant);result.fetched++;result.changedMessages+=change.changed;
    }catch(e){result.failures.push({id,error:e.message});if(e.status===429){stopped=true;result.paused={status:429,reason:'rate-limit'};}}}
  }));}finally{clearInterval(pulse);store.release(owner);}
  return {...result,ok:!result.failures.length,elapsedMs:Math.round(performance.now()-start)};
}
