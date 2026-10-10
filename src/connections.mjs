import {providerId,providerNames} from './providers.mjs';

export function connectionConfig(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['provider','workspace','authuser'].includes(k)))throw Object.assign(new Error('Invalid connection settings'),{status:400});
  if(!Object.hasOwn(providerNames,value.provider))throw Object.assign(new Error('Unsupported history provider'),{status:400});
  const provider=providerId(value.provider);
  if(value.workspace!=null&&(provider==='gemini'||typeof value.workspace!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(value.workspace)))throw Object.assign(new Error('Invalid workspace'),{status:400});
  if(value.authuser!=null&&(provider!=='gemini'||!Number.isSafeInteger(value.authuser)||value.authuser<0||value.authuser>99))throw Object.assign(new Error('Invalid Google account index'),{status:400});
  return {provider,workspace:value.workspace??null,authuser:provider==='gemini'?value.authuser??0:0};
}
export function connections(root,defaults=[{provider:'chatgpt'}]){
  const saved=root.meta('connected_providers');
  const list=saved===null?defaults.map(c=>connectionConfig({provider:c.provider,workspace:c.workspace??null,...(c.provider==='gemini'?{authuser:c.authuser??0}:{})})):JSON.parse(saved);
  if(!Array.isArray(list)||!list.length||list.length>3)throw new Error('Invalid saved connections');
  const checked=list.map(c=>connectionConfig({provider:c.provider,workspace:c.workspace,...(c.provider==='gemini'?{authuser:c.authuser}:{})}));
  if(new Set(checked.map(c=>c.provider)).size!==checked.length)throw new Error('Duplicate saved connections');
  if(saved===null)root.meta('connected_providers',JSON.stringify(checked));return checked;
}
export function addConnection(root,value,target){
  const config=connectionConfig(value);
  if(!target||target.provider!==config.provider)throw Object.assign(new Error('Platform is not available'),{status:400});
  return root.transaction(()=>{
    const list=connections(root);if(list.some(c=>c.provider===config.provider))throw Object.assign(new Error('Platform already added'),{status:409});
    list.push(config);root.meta('connected_providers',JSON.stringify(list));
    const write=root.db.prepare('INSERT OR REPLACE INTO meta(account,key,value) VALUES(?,?,?)');
    for(const [key,value] of Object.entries({connection_requested:'1',sync_paused:root.meta('sync_paused')??'0',sync_mode:root.meta('sync_mode')??'full',sync_watch_new:root.meta('sync_watch_new')??'0'}))write.run(target.account,key,value);
    return config;
  });
}
export function connectionStatus(store,now=Date.now()){
  const verifiedState=store.meta('connection_state'),state=verifiedState??store.meta('worker_state'),heartbeat=Number(store.meta('worker_heartbeat_at')??0),live=heartbeat>0&&now-heartbeat<45000;
  const verified=Boolean(store.meta('source_identity')),blocked=['connecting','login-required','account-changed','connection-error'].includes(state);
  const connected=live&&verified&&(verifiedState?state==='connected':!blocked);
  const status=!live?'browser-offline':['account-changed','login-required','connection-error','rate-limited'].includes(state)?state:connected?'connected':'connecting';
  return {provider:store.provider,name:providerNames[store.provider],connected,status};
}
