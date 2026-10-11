// Policy state belongs to the same account/provider namespace as its history.
export const initialSyncPending=store=>store.meta('sync_phase')==='initial'&&store.meta('sync_mode')!=='ids';
export function initializePhase(store){
  if(store.meta('sync_phase'))return;
  const discovery=JSON.parse(store.meta('discovery')??'null');
  const completed=Boolean(store.meta('last_full_scan')&&discovery?.complete&&!JSON.parse(store.meta('directory_scan')??'null')&&!store.pending(1).length);
  store.meta('sync_phase',completed?'maintenance':'initial');
  if(completed)store.meta('initial_sync_completed_at',store.meta('last_full_scan'));
}
export function basePace(store,config){return initialSyncPending(store)?config.initialPaceMs:config.paceMs;}
export function successfulRequest(store,config){
  if(Number(store.meta('rate_limit_until')??0)<=Date.now())store.meta('rate_limit_until',0);
  const base=basePace(store,config),floor=initialSyncPending(store)?config.initialMinPaceMs:base;
  const current=Math.max(floor,Number(store.meta('effective_pace_ms')??base));
  const count=Number(store.meta('pace_successes')??0)+1;
  // A single success says little about a sustainable request rate.
  if(count<20){store.meta('pace_successes',count);return current;}
  store.meta('pace_successes',0);store.meta('rate_limit_strikes',Math.max(0,Number(store.meta('rate_limit_strikes')??0)-1));
  const pace=Math.max(floor,Math.ceil(current*0.8));store.meta('effective_pace_ms',pace);return pace;
}
export function finishInitialSync(store,result,now){
  if(!initialSyncPending(store)||!result.ok||!result.discovery.full||store.pending(1).length)return false;
  store.transaction(()=>{store.meta('sync_phase','maintenance');store.meta('initial_sync_completed_at',new Date(now).toISOString());store.meta('pace_successes',0);});
  return true;
}
export function deferPayload(store,id,now=Date.now(),random=Math.random){
  const key='payload_retry:'+id,previous=JSON.parse(store.meta(key)??'null'),attempts=(previous?.attempts??0)+1;
  const delay=Math.min(3600000,30000*2**Math.min(7,attempts-1));
  store.meta(key,JSON.stringify({attempts,at:now+Math.ceil(delay*(1+random()*0.1))}));
}
export function readyPayloads(store,limit,now=Date.now()){
  // Fresh work always precedes retries, even when the failed thread is newest.
  return store.pending(100000).filter(item=>Number(JSON.parse(store.meta('payload_retry:'+item.id)??'null')?.at??0)<=now)
    .sort((a,b)=>Number(Boolean(a.error))-Number(Boolean(b.error))).slice(0,limit);
}
export function nextPayloadRetry(store,now=Date.now()){
  const deadlines=store.pending(100000).map(item=>Number(JSON.parse(store.meta('payload_retry:'+item.id)??'null')?.at??0));
  return deadlines.length?Math.max(now,Math.min(...deadlines)):null;
}
