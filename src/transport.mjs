const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class ApiError extends Error {
  constructor(status,path) { super(`ChatGPT request failed: HTTP ${status} ${path.split('?')[0]}`); this.status=status; }
}
export function retryDelay(value,now=Date.now()) {
  if(value==null)return 0;const seconds=Number(value);
  if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;
  const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-now):0;
}
export class HttpTransport {
  constructor({base='https://chatgpt.com',token=process.env.CHATGPT_BEARER_TOKEN,workspace=process.env.CHATGPT_ACCOUNT_ID,pace=90000,retries=3}={}) {
    const url=new URL(base);
    if (url.origin!=='https://chatgpt.com' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Unsupported API origin');
    if (url.origin==='https://chatgpt.com' && !token) throw new Error('CHATGPT_BEARER_TOKEN or a logged-in CDP session is required');
    Object.assign(this,{base:url.origin,token,workspace,pace,retries,next:0,tail:Promise.resolve(),stopped:null});
  }
  async gate() {
    const before=this.tail; let release; this.tail=new Promise(r=>release=r);
    await before;
    try { await wait(Math.max(0,this.next-Date.now())); this.next=Date.now()+this.pace; }
    finally { release(); }
  }
  async once(path,method,body) {
    const response=await fetch(this.base+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Accept:'application/json',...(this.token?{Authorization:`Bearer ${this.token}`} : {}),
        ...(this.workspace?{'chatgpt-account-id':this.workspace}:{}),...(body?{'Content-Type':'application/json'}:{})},
      body:body===undefined?undefined:JSON.stringify(body)});
    if (!response.ok) return {status:response.status,retry:response.headers.get('retry-after')};
    if (!response.headers.get('content-type')?.includes('json')) throw new Error('Backend returned non-JSON data');
    return {status:response.status,data:await response.json()};
  }
  async request(path,{method='GET',body}={}) {
    if (!path.startsWith('/backend-api/')) throw new Error('Unsupported backend path');
    for (let attempt=0;attempt<=this.retries;attempt++) {
      if(this.stopped)throw this.stopped;
      await this.gate();if(this.stopped)throw this.stopped;const result=await this.once(path,method,body);
      if (result.status>=200 && result.status<300) return result.data;
      if (![500,502,503,504].includes(result.status) || attempt===this.retries){
        const error=new ApiError(result.status,path);error.retryAt=Date.now()+retryDelay(result.retry);if([401,403,429].includes(result.status))this.stopped=error;throw error;
      }
      const delay=Math.min(30000,Math.max(1000*2**attempt,(Number(result.retry)||0)*1000));
      this.next=Math.max(this.next,Date.now()+delay); await wait(delay);
    }
  }
  close() {}
}
export class CdpTransport extends HttpTransport {
  static async connect(endpoint='http://127.0.0.1:9333',workspace) {
    const origin=new URL(endpoint);
    if (!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)) throw new Error('CDP must be on localhost');
    const targets=await fetch(`${origin.origin}/json/list`,{signal:AbortSignal.timeout(5000)}).then(r=>r.json());
    const target=targets.find(t=>{try{return t.type==='page' && new URL(t.url).origin==='https://chatgpt.com';}catch{return false;}});
    if (!target?.webSocketDebuggerUrl) throw new Error('Open a logged-in ChatGPT tab in the CDP browser');
    const obj=new CdpTransport({base:'http://127.0.0.1',workspace});
    obj.ws=new WebSocket(target.webSocketDebuggerUrl); obj.sequence=0; obj.pending=new Map();
    await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{obj.ws.close();reject(new Error('CDP connection timed out'));},5000);
      obj.ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      obj.ws.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('CDP connection failed'));},{once:true}); });
    obj.ws.addEventListener('message',event=>{ let reply;try{reply=JSON.parse(String(event.data));}catch{obj.ws.close();return;}const p=obj.pending.get(reply.id);
      if (!p) return; obj.pending.delete(reply.id); clearTimeout(p.timer);
      reply.error?p.reject(new Error('CDP request failed')):p.resolve(reply.result); });
    obj.ws.addEventListener('close',()=>{for (const p of obj.pending.values()) {clearTimeout(p.timer);p.reject(new Error('CDP disconnected'));} obj.pending.clear();});
    try {
      const session=await obj.evaluate(`fetch('/api/auth/session',{credentials:'include'}).then(r=>r.json()).then(s=>({token:s.accessToken,user:s.user?.id}))`);
      if (!session?.token) throw new Error('ChatGPT login is required in the CDP browser');
      obj.token=session.token; obj.user=session.user ?? null; return obj;
    } catch(e) {obj.close();throw e;}
  }
  rpc(method,params) {
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP request timed out'));},35000);
      this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});
  }
  async evaluate(expression) {
    const result=await this.rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if (result.exceptionDetails) throw new Error('Browser backend request failed');
    return result.result?.value;
  }
  async once(path,method,body) {
    const headers={Authorization:`Bearer ${this.token}`,Accept:'application/json',
      ...(this.workspace?{'chatgpt-account-id':this.workspace}:{}),...(body?{'Content-Type':'application/json'}:{})};
    return this.evaluate(`(async()=>{const r=await fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},credentials:'include',headers:${JSON.stringify(headers)},body:${JSON.stringify(body===undefined?undefined:JSON.stringify(body))}});return {status:r.status,retry:r.headers.get('retry-after'),data:r.ok?await r.json():null};})()`);
  }
  close() {this.token=null;this.ws?.close();}
}
