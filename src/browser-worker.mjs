import {BrowserTransport} from './browser-transport.mjs';
import {sync} from './sync.mjs';
import {SyncPaused,pauseRequested,syncMode,syncCommand,syncComplete,watchNewRequested,setSyncPaused,rateLimitUntil} from './sync-control.mjs';
import {browserArchiveEnabled} from './browser-archive.mjs';
import {providerId} from './providers.mjs';

export function workerConfig(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid browser host configuration');
  const number=(name,fallback,min,max)=>{const n=value[name] ?? fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('Invalid '+name);return n;};
  if(typeof value.account!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value.account))throw new Error('Invalid account namespace');
  if(typeof value.db!=='string'||!value.db)throw new Error('Database path required');
  if(typeof value.extensionId!=='string'||!/^[a-p]{32}$/.test(value.extensionId))throw new Error('Invalid extension ID');
  if(value.workspace!=null&&(typeof value.workspace!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(value.workspace)))throw new Error('Invalid workspace');
  return {account:value.account,db:value.db,extensionId:value.extensionId,workspace:value.workspace ?? null,provider:providerId(value.provider),authuser:number('authuser',0,0,99),
    paceMs:number('paceMs',90000,0,3600000),directoryIntervalMs:number('directoryIntervalMs',900000,1000,86400000),
    projectIntervalMs:number('projectIntervalMs',3600000,0,86400000),maxDirectoryPages:number('maxDirectoryPages',3,1,100000),
    auditIntervalMs:number('auditIntervalMs',86400000,1000,2592000000),auditAgeMs:number('auditAgeMs',604800000,1000,31536000000),
    pendingIntervalMs:number('pendingIntervalMs',15000,1000,3600000),maxPerRun:number('maxPerRun',5,1,1000),
    cooldownMs:number('cooldownMs',120000,1000,86400000)};
}
export class BrowserWorker {
  constructor(rpc,store,config,{now=Date.now}={}){
    const requested=pauseRequested(store);Object.assign(this,{rpc,store,config,now,busy:false,timer:null,closed:false,paused:requested,pauseDesired:requested,
      mode:syncMode(store),command:syncCommand(store),archiveEnabled:browserArchiveEnabled(store)});
    store.meta('directory_interval_ms',config.directoryIntervalMs);
    this.pulse=setInterval(()=>store.meta('worker_heartbeat_at',this.now()),10000);this.pulse.unref();
    this.control=setInterval(()=>this.checkControl(),1000);this.control.unref();
  }
  checkControl(resume=true){
    const archiveEnabled=browserArchiveEnabled(this.store);
    if(this.archiveEnabled!==archiveEnabled){this.archiveEnabled=archiveEnabled;this.status(this.store.meta('worker_state') ?? 'paused');}
    const command=syncCommand(this.store),changed=command!==this.command;
    if(changed){this.command=command;this.mode=syncMode(this.store);clearTimeout(this.timer);this.currentApi?.pause();}
    const value=pauseRequested(this.store);if(value!==this.pauseDesired)this.pause(value,{resume});
    else if(changed&&resume&&!this.paused)void this.run();
  }
  status(state,extra={}){
    if(this.pauseDesired)state=syncComplete(this.store)?'directory-complete':'paused';
    this.store.meta('worker_state',state);this.store.meta('worker_heartbeat_at',this.now());
    const s=this.store.status();const notice={type:'status',provider:this.store.provider,state:state==='directory-complete'?'paused':state==='watching-new'?'waiting':state,mode:this.mode,complete:syncComplete(this.store),threads:s.threads,fullTrees:s.fullTrees,pending:s.pending,messages:s.messages,
      nextRunAt:Number(this.store.meta('next_run_at') ?? 0),browserArchiveEnabled:browserArchiveEnabled(this.store),...extra};
    if(!this.rpc.closed)this.rpc.send(notice);return notice;
  }
  schedule(at){if(this.closed)return;clearTimeout(this.timer);this.store.meta('next_run_at',at);if(!this.paused)this.timer=setTimeout(()=>void this.run(),Math.min(2147483647,Math.max(0,at-this.now())));}
  rateLimited(error){
    const strikes=Number(this.store.meta('rate_limit_strikes') ?? 0)+1;this.store.meta('rate_limit_strikes',strikes);
    const delay=Math.max(this.config.cooldownMs*Math.min(16,2**(strikes-1)),(error?.retryAt ?? 0)-this.now());
    this.store.meta('effective_pace_ms',Math.min(3600000,Math.max(this.config.paceMs,Number(this.store.meta('effective_pace_ms') ?? this.config.paceMs))*2));
    const until=this.now()+delay;this.store.meta('rate_limit_until',until);
    this.schedule(until);this.status('rate-limited',{status:429});
  }
  async run(){
    if(this.closed||this.busy)return;this.checkControl(false);const verifying=this.store.meta('connection_requested')==='1';
    if(this.paused&&!verifying){this.status(this.pauseDesired?'paused':'account-changed');return;}
    const due=Math.max(Number(this.store.meta('next_run_at') ?? 0),rateLimitUntil(this.store));if(due>this.now()){this.status('waiting');this.schedule(due);return;}
    this.busy=true;let api,interrupted=false,checkingConnection=verifying;const command=this.command,directoryOnly=this.mode==='ids',watching=watchNewRequested(this.store);
    try{
      this.store.meta('connection_state','connecting');this.status('connecting');const paceMs=Math.max(this.config.paceMs,Number(this.store.meta('effective_pace_ms') ?? this.config.paceMs));
      this.store.meta('effective_pace_ms',paceMs);api=new BrowserTransport(this.rpc,{...this.config,paceMs,successPaceMs:this.config.paceMs,
        onBeforeRequest:()=>{if(!checkingConnection&&(pauseRequested(this.store)||syncCommand(this.store)!==command))throw new SyncPaused();},
        nextRequestAt:Number(this.store.meta('next_request_at') ?? 0),onRequestStart:at=>this.store.meta('next_request_at',at),
        onHistorySuccess:()=>{this.store.meta('effective_pace_ms',this.config.paceMs);this.store.meta('rate_limit_strikes',0);this.store.meta('rate_limit_until',0);},
        onExchange:request=>this.store.meta('last_request',JSON.stringify(request))});
      const immediateHistory=this.store.meta('sync_resume_pending')==='1';
      this.store.meta('sync_resume_pending',0);
      this.currentApi=api;await api.initialize({immediateHistory});
      const identity=api.user+':'+(api.workspace ?? 'personal'),previous=this.store.meta('source_identity');
      if(previous&&previous!==identity){this.store.meta('connection_state','account-changed');this.store.meta('connection_requested',0);this.status('account-changed');this.paused=true;return;}this.store.meta('source_identity',identity);
      this.store.meta('connection_state','connected');this.store.meta('connection_requested',0);checkingConnection=false;
      if(api.workspace)this.store.meta('source_workspace',api.workspace);
      if(verifying){this.checkControl(false);if(this.paused){this.status('paused');return;}if(syncCommand(this.store)!==command)throw new SyncPaused();}
      let auditQueued=0;if(!directoryOnly&&Number(this.store.meta('next_audit_at') ?? 0)<=this.now()){
        auditQueued=this.store.audit(new Date(this.now()-this.config.auditAgeMs).toISOString());this.store.meta('next_audit_at',this.now()+this.config.auditIntervalMs);
      }
      const nextDirectory=Number(this.store.meta('next_directory_at') ?? 0),scan=JSON.parse(this.store.meta('directory_scan') ?? 'null');
      const forceFull=this.store.meta('sync_force_full')==='1';
      const skipDiscovery=!directoryOnly&&!forceFull&&!scan&&nextDirectory>this.now()&&Boolean(this.store.meta('discovery'));
      this.status('syncing',{phase:skipDiscovery?'details':'directory'});
      const result=await sync(api,this.store,{concurrency:1,max:this.config.maxPerRun,skipDiscovery,directoryOnly,newOnly:watching,full:directoryOnly&&!watching||forceFull,
        maxDirectoryPages:this.config.maxDirectoryPages,projectIntervalMs:this.config.projectIntervalMs,directoryIntervalMs:this.config.directoryIntervalMs});
      result.auditQueued=auditQueued;this.store.meta('last_run',JSON.stringify(result));
      if(!skipDiscovery&&result.discovery.complete&&syncCommand(this.store)===command){
        this.store.meta('next_directory_at',this.now()+this.config.directoryIntervalMs);this.store.meta('sync_force_full',0);
      }
      let delay;
      this.checkControl(false);
      if(this.command!==command){interrupted=true;this.status(this.paused?'paused':'pending');}
      else if(result.paused?.reason==='user-pause'){interrupted=true;this.status(this.paused?'paused':'pending');}
      else if(result.paused?.status===429){this.rateLimited(api.stopped);}
      else if(result.paused){const state=result.paused.status>=500?'connection-error':'login-required';this.store.meta('connection_state',state);this.schedule(this.now()+this.config.cooldownMs);this.status(state,{status:result.paused.status});}
      else if(directoryOnly&&!watching&&result.ok){
        const completed=this.store.transaction(()=>{
          if(syncCommand(this.store)!==command)return false;
          this.store.meta('sync_completed_command',command);this.store.meta('sync_finished_at',new Date(this.now()).toISOString());this.store.meta('sync_paused',1);return true;
        });
        if(completed){this.pause(true);this.status('directory-complete');}else{this.checkControl(false);interrupted=true;}
      }
      else{delay=(directoryOnly?result.discovery.pendingScopes:result.pending||result.discovery.pendingScopes)?this.config.pendingIntervalMs:this.config.directoryIntervalMs;
        this.schedule(this.now()+delay);this.status(result.ok?(watching?'watching-new':'up-to-date'):'pending',{fetched:result.fetched,changedMessages:result.changedMessages,elapsedMs:result.elapsedMs});}
    }catch(e){
      if(!this.closed){this.checkControl(false);if(e.code==='SYNC_PAUSED'){interrupted=true;this.status(this.paused?'paused':'pending');}
        else{const status=e.status ?? null,state=[401,403].includes(status)?'login-required':'connection-error';
          this.store.meta('connection_state',status===429?'rate-limited':state);if(status===429)this.rateLimited(e);else{this.schedule(this.now()+this.config.cooldownMs);this.status(state,{status});}}}
    }finally{api?.close();this.currentApi=null;this.busy=false;if(this.closed)this.onIdle?.();else if(interrupted&&!this.paused)this.schedule(Math.max(this.now(),Number(this.store.meta('next_run_at') ?? 0)));}
  }
  pause(value,{resume=true}={}){setSyncPaused(this.store,Boolean(value),this.now());this.pauseDesired=this.paused=Boolean(value);clearTimeout(this.timer);
    if(this.paused){this.currentApi?.pause();this.status('paused');}else if(resume)void this.run();}
  close(){if(this.closed)return;this.closed=true;clearTimeout(this.timer);clearInterval(this.pulse);clearInterval(this.control);this.store.meta('worker_heartbeat_at',0);this.currentApi?.close();if(!this.busy)this.onIdle?.();}
}
