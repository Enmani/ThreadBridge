import {indexStatus,updateIndex} from './chat-index.mjs';

export function dashboardIndex(stores){
  const items=stores.map(indexStatus),sum=key=>items.reduce((n,s)=>n+s[key],0);
  return {enabled:items.every(s=>s.enabled),eligible:sum('eligible'),indexed:sum('indexed'),pending:sum('pending'),errors:sum('errors'),
    pendingSummaries:sum('pendingSummaries'),updated:items.map(s=>s.updated).filter(Boolean).sort().at(-1)??null};
}
export function configureIndex(root,providers,value){
  if(!value||Array.isArray(value)||Object.keys(value).length!==1||!(typeof value.enabled==='boolean'||value.rebuild===true))throw Object.assign(new Error('Invalid index settings'),{status:400});
  root.transaction(()=>{
    for(const provider of providers){const store=root.scope(provider);
      if(typeof value.enabled==='boolean')store.meta('chat_index_enabled',Number(value.enabled));
      else store.db.prepare(`INSERT OR REPLACE INTO chat_index_dirty(account,thread) SELECT account,thread FROM snapshots WHERE account=?
        UNION SELECT account,thread FROM browser_snapshots WHERE account=? UNION SELECT account,thread FROM imported_snapshots WHERE account=?`)
        .run(store.account,store.account,store.account);
    }
  });
}
export function startIndexing(server,getStores){
  let timer;const reported=new Set();
  const tick=()=>{for(const store of getStores()){
    try{updateIndex(store,{limit:1});reported.delete(store.provider);}
    catch(error){if(!reported.has(store.provider)){
      process.stderr.write(`Chat index update failed (${store.provider}, ${error.code??'database error'}); pending work retained.\n`);reported.add(store.provider);
    }}
  }};
  server.once('listening',()=>{timer=setInterval(tick,1000);timer.unref();});
  server.once('close',()=>clearInterval(timer));
}
