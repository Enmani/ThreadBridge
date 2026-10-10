import {HttpTransport,ApiError,retryDelay} from './transport.mjs';
import {SyncPaused} from './sync-control.mjs';
import {providerId} from './providers.mjs';
export class BrowserTransport extends HttpTransport {
  constructor(rpc,{provider='chatgpt',authuser=0,paceMs=90000,successPaceMs=paceMs,workspace=null,nextRequestAt=0,onBeforeRequest=()=>{},onRequestStart=()=>{},onExchange=()=>{},onHistorySuccess=()=>{}}={}){
    super({base:'http://127.0.0.1',pace:paceMs,retries:0});Object.assign(this,{rpc,successPaceMs,workspace,onBeforeRequest,onRequestStart,onExchange,onHistorySuccess,next:nextRequestAt,user:null});
    this.abort=new AbortController();this.metrics={requests:0,queueMs:0,roundTripMs:0};
    this.provider=providerId(provider);this.authuser=authuser;
  }
  allowsPath(path){return this.provider==='chatgpt'?super.allowsPath(path):typeof path==='string'&&(/^\/history\/list\?[^#]*$/.test(path)||/^\/history\/conversation\/[A-Za-z0-9_-]{1,160}$/.test(path));}
  async gate(){
    const start=performance.now(),before=this.tail;let release;this.tail=new Promise(r=>release=r);await before;
    try{if(this.abort.signal.aborted)throw this.stopped?.code==='SYNC_PAUSED'?this.stopped:new Error('Browser transport closed');this.onBeforeRequest();
      const delay=Math.max(0,this.next-Date.now());if(delay)await new Promise((resolve,reject)=>{
        const done=()=>{clearTimeout(timer);this.abort.signal.removeEventListener('abort',cancel);resolve();};
        const cancel=()=>{clearTimeout(timer);this.abort.signal.removeEventListener('abort',cancel);reject(this.stopped?.code==='SYNC_PAUSED'?this.stopped:new Error('Browser transport closed'));};
        const timer=setTimeout(done,delay);this.abort.signal.addEventListener('abort',cancel,{once:true});});
      this.onBeforeRequest();this.next=Date.now()+this.pace;this.onRequestStart(this.next);
    }finally{release();this.metrics.queueMs+=Math.round(performance.now()-start);}
  }
  async exchange(path){
    this.onBeforeRequest();
    const start=performance.now(),request={path,startedAt:Date.now(),finishedAt:null,status:null};this.lastStartedAt=request.startedAt;this.onExchange(request);
    try{this.metrics.requests++;const result=await this.rpc.request(path,this.workspace,this.provider,this.authuser);this.onExchange({...request,finishedAt:Date.now(),status:result.status});return result;}
    catch(e){this.onExchange({...request,finishedAt:Date.now(),status:e.status ?? 503});throw e;}
    finally{this.metrics.roundTripMs+=Math.round(performance.now()-start);}
  }
  async initialize({immediateHistory=false}={}){
    // On resume, checking the account must not restart the history countdown.
    // The worker checks the persisted 429 cooldown before reaching this point.
    if(!immediateHistory)await this.gate();
    const result=await this.exchange('/api/auth/session');this.validate(result);
    if(result.status!==200||typeof result.identity!=='string'||!result.identity){const error=new ApiError(result.status===200?401:result.status,'/api/auth/session');error.retryAt=Date.now()+retryDelay(result.retry);throw error;}
    if(this.provider==='claude'){
      if(typeof result.workspace!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(result.workspace)||this.workspace&&result.workspace!==this.workspace)throw new ApiError(403,'workspace-changed');
      this.workspace=result.workspace;
    }
    this.user=result.identity;return this;
  }
  validate(result){if(!result||!Number.isInteger(result.status)||result.status<100||result.status>599)throw new Error('Invalid browser response');}
  async once(path,method,body){
    if(method!=='GET'||body!==undefined)throw new Error('Browser sync permits read-only GET requests');
    const result=await this.exchange(path);this.validate(result);
    if((result.identity!=null&&result.identity!==this.user)||(result.status===200&&(!result.identity||this.provider==='claude'&&result.workspace!==this.workspace))){const error=new ApiError(403,'account-changed');this.stopped=error;throw error;}
    return {status:result.status,data:result.data,retry:result.retry ?? null};
  }
  async request(path,options){try{
    const data=await super.request(path,options);
    if(this.pace!==this.successPaceMs){this.pace=this.successPaceMs;this.next=Math.max(Date.now(),this.lastStartedAt+this.pace);this.onRequestStart(this.next);}
    this.onHistorySuccess();return data;
  }catch(e){if(e.code==='SYNC_PAUSED'){this.stopped=e;throw e;}if(e.status>=500||!e.status){this.stopped=e.status?e:new ApiError(503,path);throw this.stopped;}throw e;}}
  pause(){this.stopped=new SyncPaused();this.abort.abort();}
  close(){this.user=null;this.abort.abort();}
}
