export class SyncPaused extends Error {
  constructor(){super('Sync paused by user');this.code='SYNC_PAUSED';}
}
export const pauseRequested=store=>store.meta('sync_paused')==='1';
export const syncMode=store=>store.meta('sync_mode')==='ids'?'ids':'full';
export const syncCommand=store=>Number(store.meta('sync_command') ?? 0);
export const syncComplete=store=>store.meta('sync_completed_command')===String(syncCommand(store));
export const watchNewRequested=store=>syncMode(store)==='ids'&&store.meta('sync_watch_new')==='1';

// Older databases kept the 429 deadline only in next_run_at. Preserve it until
// the first resume or rate-limit response records the separate cooldown field.
export const rateLimitUntil=store=>Number(store.meta('rate_limit_until') ??
  (Number(store.meta('rate_limit_strikes') ?? 0)>0?store.meta('next_run_at') ?? 0:0));

export function setSyncPaused(store,paused,now=Date.now()){
  store.transaction(()=>{
    const wasPaused=pauseRequested(store);
    store.meta('sync_paused',paused?1:0);
    if(paused)store.meta('sync_resume_pending',0);
    else if(wasPaused){
      const cooldown=rateLimitUntil(store),due=Math.max(now,cooldown);
      store.meta('rate_limit_until',cooldown);
      store.meta('next_run_at',due);store.meta('next_request_at',due);
      store.meta('sync_resume_pending',1);
      // Wake the worker even if pause and resume happen between control polls.
      store.meta('sync_command',syncCommand(store)+1);
    }
  });
}
export function startSync(store,mode,now=Date.now(),{watchNew=watchNewRequested(store)}={}){
  if(!['ids','full'].includes(mode))throw new Error('Invalid sync mode');
  store.transaction(()=>{
    const watching=mode==='ids'&&watchNew;
    const scan=JSON.parse(store.meta('directory_scan') ?? 'null');
    if(scan&&Boolean(scan.newOnly)!==watching)store.meta('directory_scan','null');
    store.meta('sync_mode',mode);store.meta('sync_command',syncCommand(store)+1);
    store.meta('sync_watch_new',watching?1:0);
    store.meta('sync_completed_command','');store.meta('sync_finished_at','');store.meta('sync_force_full',watching?0:1);
    store.meta('next_directory_at',0);store.meta('sync_paused',0);
    const cooldown=rateLimitUntil(store);
    store.meta('next_run_at',Math.max(now,cooldown));
  });
}
export function watchNewThreads(store,enabled,now=Date.now()){
  if(enabled){startSync(store,'ids',now,{watchNew:true});return;}
  store.transaction(()=>{store.meta('sync_watch_new',0);store.meta('sync_paused',1);store.meta('sync_command',syncCommand(store)+1);
    store.meta('sync_completed_command','');});
}
