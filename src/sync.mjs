import {randomUUID} from 'node:crypto';
import {snapshot} from './model.mjs';
import {discover} from './discovery.mjs';
import {discoverProvider} from './provider-discovery.mjs';
import {providerSnapshot,detailPath} from './providers.mjs';

async function workers(items,concurrency,fn,stopped=()=>false) {
  let index=0;
  const results=await Promise.allSettled(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(index<items.length&&!stopped()) {const item=items[index++];await fn(item);}
  }));
  const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
}
export async function sync(api,store,options={}) {
  const owner=randomUUID(); store.acquire(owner);
  let leaseError=null;
  const heartbeat=setInterval(()=>{try{store.acquire(owner);}catch(e){leaseError=e;}},30000);
  const started=new Date().toISOString(); const t0=performance.now();
  const result={mode:options.directoryOnly?'ids':'full',discovery:null,fetched:0,changedMessages:0,failures:[],batchFallbacks:0};
  let stopped=null;
  try {
    if(options.batch&&store.provider!=='chatgpt')throw new Error('Batch sync is only available for ChatGPT');
    const lastFull=store.meta('last_full_scan');
    const full=options.full || options.refresh || !lastFull || Date.now()-Date.parse(lastFull)>=86400000;
    const directoryStarted=performance.now();
    result.discovery=options.skipDiscovery?JSON.parse(store.meta('discovery') ?? 'null'):await (store.provider==='chatgpt'?discover:discoverProvider)(api,store,{...options,full});
    result.timings={directoryMs:Math.round(performance.now()-directoryStarted)};const detailsStarted=performance.now();
    if(!result.discovery)throw new Error('No directory scan to resume');
    stopped=api.stopped ?? null;
    const pending=options.directoryOnly?[]:store.pending(options.max ?? 100000);
    const save=(detail,item)=>{
      if(leaseError)throw leaseError;store.acquire(owner);
      const parsed=providerSnapshot(store.provider,detail,item.id,item.title);
      const change=store.save(parsed,item.source_updated,item.source_assistant); result.fetched++;result.changedMessages+=change.changed;
    };
    const single=async item=>{
      if (leaseError) throw leaseError;
      try {save(await api.request(detailPath(store.provider,item.id)),item);if(api.stopped)stopped=api.stopped;}
      catch(e) {if(e.code==='SYNC_PAUSED'){stopped=e;return;}store.fail(item.id,e.message);result.failures.push({id:item.id,error:e.message});if(api.stopped)stopped=api.stopped;else if([401,403,429].includes(e.status))stopped=e;}
    };
    if (options.batch) {
      for (let i=0;i<pending.length;i+=10) {
        if(stopped)break;
        const group=pending.slice(i,i+10);let candidates=[];
        try {
          const data=await api.request('/backend-api/conversations/batch',{method:'POST',body:{conversation_ids:group.map(x=>x.id)}});
          candidates=Array.isArray(data)?data:Array.isArray(data.conversations)?data.conversations:Object.values(data);
        } catch(e) {
          if(e.code==='SYNC_PAUSED'){stopped=e;break;}
          if ([401,403,429].includes(e.status)) {
            for(const item of group){store.fail(item.id,e.message);result.failures.push({id:item.id,error:e.message});}
            stopped=e;break;
          }
        }
        const fallback=[];
        for (const item of group) {
          const raw=candidates.find(x=>(x?.conversation_id ?? x?.id)===item.id);
          try {
            const parsed=snapshot(raw,item.id), previous=store.read(item.id);
            if (previous && Object.keys(parsed?raw.mapping:{}).length<Object.keys(previous.raw.mapping).length) throw new Error('Batch tree shrank');
            save(raw,item);
          } catch {result.batchFallbacks++;fallback.push(item);}
        }
        await workers(fallback,options.concurrency ?? 3,single,()=>Boolean(stopped));
      }
    } else await workers(pending,options.concurrency ?? 3,single,()=>Boolean(stopped));
    // This is a directory watermark, not a successful-payload watermark. Failed payloads stay pending.
    if (leaseError) throw leaseError;
    if (!options.skipDiscovery && result.discovery.complete) {
      store.meta('watermark',started);
      if(result.discovery.full)store.meta('last_full_scan',result.discovery.started ?? started);
    }
    result.pending=store.pending(100000).length; result.elapsedMs=Math.round(performance.now()-t0);
    result.timings.detailsMs=Math.round(performance.now()-detailsStarted);if(api.metrics)result.transport={...api.metrics};
    if(stopped)result.paused={status:stopped.status ?? null,reason:stopped.code==='SYNC_PAUSED'?'user-pause':stopped.status===429?'rate-limit':stopped.status>=500?'connection':'authorization'};
    result.ok=!stopped && result.discovery.complete && !result.failures.length && (options.directoryOnly || !result.pending);
    store.meta('last_run',JSON.stringify(result)); return result;
  } finally {clearInterval(heartbeat);store.release(owner);}
}
