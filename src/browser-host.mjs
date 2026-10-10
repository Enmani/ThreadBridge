import {readFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {Store} from './store.mjs';
import {BrowserRpc} from './browser-frames.mjs';
import {BrowserWorker,workerConfig} from './browser-worker.mjs';
import {acceptBrowserCapture} from './browser-archive.mjs';

// stdout is exclusively framed protocol data. Never print account/chat data or tokens.
let store,rpc,worker;
try{
  const {values,positionals}=parseArgs({options:{config:{type:'string'}},allowPositionals:true,strict:false});
  if(!values.config)throw new Error('Native host configuration required');
  const source=readFileSync(values.config,'utf8');if(source.length>32768)throw new Error('Native host configuration too large');
  const config=workerConfig(JSON.parse(source));if(!path.isAbsolute(config.db))throw new Error('Use an absolute database path');
  const origin=positionals.find(x=>x.startsWith('chrome-extension://'));
  if(origin?.replace(/\/$/,'')!==`chrome-extension://${config.extensionId}`)throw new Error('Extension origin is not allowed');
  store=new Store(config.db,config.account);rpc=new BrowserRpc(process.stdin,process.stdout);worker=new BrowserWorker(rpc,store,config);
  let started=false,disposed=false;
  const close=()=>{if(disposed)return;disposed=true;store.close();process.stdin.destroy();};
  worker.onIdle=close;rpc.onClose=()=>worker.close();
  rpc.onCommand=message=>{
    if(message?.type==='hello'&&message.version===1){if(!started){started=true;store.meta('browser_archive_version',message.archiveVersion===1?1:0);void worker.run();}}
    else if(started&&message?.type==='capture'&&Number.isSafeInteger(message.id)){
      const result=acceptBrowserCapture(store,message.payload,config);rpc.send({type:'capture-ack',id:message.id,...result});
    }
    else if(started&&message?.type==='archive-state'&&['waiting-account','unrecognized-page','local-queue-full','capture-too-large','local-storage-failed'].includes(message.state))store.meta('browser_capture_state',message.state);
    else if(started&&message?.type==='sync')void worker.run();
    else if(started&&message?.type==='pause'&&typeof message.value==='boolean')worker.pause(message.value);
    else if(message?.type==='shutdown'){rpc.close();worker.close();}
  };
  process.on('SIGTERM',()=>{rpc.close();worker.close();});
}catch{process.stderr.write('ThreadBridge native host could not start. Check installation/configuration.\n');process.exitCode=1;store?.close();}
