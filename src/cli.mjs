#!/usr/bin/env node
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {Store} from './store.mjs';
import {ids,integer,runSync,importTrees} from './service.mjs';
import {NativePipe,syncNative} from './native.mjs';
import {serve} from './mcp.mjs';

const spec={};for(const key of ['provider','sort','order','db','account','input','query','id','revision','consumer','limit','page','through','ids','caller','max-pages','concurrency','max','projects','cdp'])spec[key]={type:'string'};
for(const key of ['full','refresh','batch','help','local-only','pending'])spec[key]={type:'boolean'};
let store;
try {
  const {values:o,positionals:[command]}=parseArgs({options:spec,allowPositionals:true,strict:true});
  if(o.help || !command){console.log('ThreadBridge | Node >=24\nCommands: sync, import, native, threads, status, search, read, changes, ack, serve\nRequired: --account NAME | Default DB: data/history.sqlite\nSee README.md for examples.');process.exit(0);}
  if(!['sync','import','native','threads','status','search','read','changes','ack','serve'].includes(command))throw new Error('Unknown command');
  store=new Store(o.db ?? 'data/history.sqlite',o.account ?? process.env.THREADBRIDGE_ACCOUNT,o.provider);
  let result;
  switch(command) {
    case 'sync':result=await runSync(store,o);break;
    case 'import':{
      if(!o.input)throw new Error('--input raw JSON file or directory required');
      const target=path.resolve(o.input);let files;
      try{files=readdirSync(target).filter(x=>x.endsWith('.json')).map(x=>path.join(target,x));}catch(e){if(e.code!=='ENOTDIR')throw e;files=[target];}
      result={ok:true,imported:0,changedMessages:0,errors:[]};
      for(const file of files){const r=importTrees(store,JSON.parse(readFileSync(file,'utf8')));result.ok&&=r.ok;result.imported+=r.imported;result.changedMessages+=r.changedMessages;result.errors.push(...r.errors);}break;
    }
    case 'native':{
      if(store.provider!=='chatgpt')throw new Error('Codex native reads are only available for ChatGPT');
      if(o.pending&&o.ids)throw new Error('Choose --pending or --ids');
      const targets=o.pending?store.nativePending(integer(o.max,5,1,1000)).map(x=>x.id):ids(o.ids);
      if(!targets.length){result={ok:true,fetched:0,changedMessages:0,failures:[]};break;}
      const pipe=await NativePipe.connect(o.caller ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_CALLER_THREAD_ID);
      try{result=await syncNative(pipe,store,targets,{concurrency:integer(o.concurrency,1,1,8),maxPages:integer(o['max-pages'],100,1,10000)});}finally{pipe.close();}break;
    }
    case 'threads':result=store.listThreads({query:o.query ?? '',page:integer(o.page,1,1,1000000),limit:integer(o.limit,50,1,200),sort:o.sort,order:o.order});break;
    case 'status':result=store.status();break;
    case 'search':result=store.search(o.query,integer(o.limit,20,1,100));break;
    case 'read':result=store.read(ids(o.id)[0],integer(o.revision,undefined,1,Number.MAX_SAFE_INTEGER));break;
    case 'changes':result=store.changes(o.consumer,integer(o.limit,100,1,500));break;
    case 'ack':result=store.ack(o.consumer,integer(o.through,undefined,0,Number.MAX_SAFE_INTEGER));break;
    case 'serve':await serve(store,{...o,localOnly:o['local-only']===true});break;
  }
  if(command!=='serve'){console.log(JSON.stringify(result,null,2));if(result?.ok===false)process.exitCode=2;}
} catch(e){console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
finally{store?.close();}
