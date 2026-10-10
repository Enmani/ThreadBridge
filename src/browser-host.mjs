import {readFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {Store} from './store.mjs';
import {BrowserRpc} from './browser-frames.mjs';
import {BrowserWorker,workerConfig} from './browser-worker.mjs';
import {hostConfigs} from './browser-config.mjs';
import {connections} from './connections.mjs';
import {acceptBrowserCapture} from './browser-archive.mjs';

// stdout is exclusively framed protocol data. Never print account/chat data or tokens.
let rpc,poll;const stores=[],workers=new Map();
try{
  const {values,positionals}=parseArgs({options:{config:{type:'string'}},allowPositionals:true,strict:false});
  if(!values.config)throw new Error('Native host configuration required');
  const source=readFileSync(values.config,'utf8');if(source.length>32768)throw new Error('Native host configuration too large');
  const configs=hostConfigs(JSON.parse(source)),base=configs[0];if(!path.isAbsolute(base.db))throw new Error('Use an absolute database path');
  const origin=positionals.find(x=>x.startsWith('chrome-extension://'));
  if(origin?.replace(/\/$/,'')!==`chrome-extension://${base.extensionId}`)throw new Error('Extension origin is not allowed');
  const root=new Store(base.db,base.account);stores.push(root);connections(root,configs);
  rpc=new BrowserRpc(process.stdin,process.stdout);let started=false,disposed=false,stopping=false,archiveVersion=0;
  const close=()=>{if(disposed||!stopping||[...workers.values()].some(w=>!w.closed||w.busy))return;disposed=true;for(const s of stores)s.close();process.stdin.destroy();};
  const stop=()=>{if(stopping)return;stopping=true;clearInterval(poll);for(const w of workers.values())w.close();close();};
  function reconcile(){
    if(stopping)return;
    for(const config of connections(root)){
      let worker=workers.get(config.provider);
      if(!worker){
        const store=config.provider==='chatgpt'?root:new Store(base.db,base.account,config.provider);if(store!==root)stores.push(store);
        worker=new BrowserWorker(rpc,store,workerConfig({...base,...config}));worker.onIdle=close;workers.set(config.provider,worker);
        if(config.provider==='chatgpt')store.meta('browser_archive_version',archiveVersion);
        if(started)void worker.run();
      }else if(started&&!worker.busy&&worker.store.meta('connection_requested')==='1'&&Number(worker.store.meta('next_run_at')??0)<=Date.now())void worker.run();
    }
  }
  rpc.onClose=stop;
  rpc.onCommand=message=>{
    if(message?.type==='hello'&&message.version===1){if(!started){started=true;archiveVersion=message.archiveVersion===1?1:0;reconcile();}}
    else if(started&&message?.type==='capture'&&Number.isSafeInteger(message.id)){
      const chat=workers.get('chatgpt'),result=chat?acceptBrowserCapture(root,message.payload,chat.config):{ok:false,state:'disabled'};
      rpc.send({type:'capture-ack',id:message.id,...result});
    }
    else if(started&&message?.type==='archive-state'&&workers.has('chatgpt')&&['waiting-account','unrecognized-page','local-queue-full','capture-too-large','local-storage-failed'].includes(message.state))root.meta('browser_capture_state',message.state);
    else if(started&&message?.type==='sync'){for(const worker of workers.values())if(!message.provider||message.provider===worker.config.provider)void worker.run();}
    else if(started&&message?.type==='pause'&&typeof message.value==='boolean'){for(const worker of workers.values())if(!message.provider||message.provider===worker.config.provider)worker.pause(message.value);}
    else if(message?.type==='shutdown'){rpc.close();stop();}
  };
  poll=setInterval(()=>{try{reconcile();}catch{rpc.close();stop();}},1000);poll.unref();
  process.on('SIGTERM',()=>{rpc.close();stop();});
}catch{process.stderr.write('ThreadBridge native host could not start. Check installation/configuration.\n');process.exitCode=1;clearInterval(poll);rpc?.close();for(const worker of workers.values())worker.close();for(const store of stores)store.close();}
