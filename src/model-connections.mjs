import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {modelEndpoint,modelError,discoverModels} from './model-transport.mjs';
import {protectCredential,revealCredential,forgetCredential} from './model-credentials.mjs';
import {indexEnabled,indexStatus} from './chat-index.mjs';

export function modelConnection(store,id){return store.db.prepare('SELECT * FROM model_connections WHERE account=? AND id=?').get(store.accountName,id);}
export function modelSettings(store){
  store.db.prepare('INSERT OR IGNORE INTO model_index_settings(account) VALUES(?)').run(store.accountName);
  return store.db.prepare('SELECT * FROM model_index_settings WHERE account=?').get(store.accountName);
}
export function modelView(store,providers=[store.provider]){
  const items=store.db.prepare('SELECT * FROM model_connections WHERE account=? ORDER BY name,id').all(store.accountName);
  const settings=modelSettings(store),day=new Date().toISOString().slice(0,10);
  const usage=store.db.prepare('SELECT requests,input_tokens,output_tokens FROM model_index_usage WHERE account=? AND day=?').get(store.accountName,day)??{requests:0,input_tokens:0,output_tokens:0};
  return {indexEnabled:providers.every(p=>indexEnabled(store.scope(p))),pendingSummaries:providers.reduce((n,p)=>n+indexStatus(store.scope(p)).pendingSummaries,0),items:items.map(row=>({id:row.id,name:row.name,kind:row.kind,protocol:row.protocol,endpoint:row.base_url,
    status:row.kind==='client'?(store.db.prepare('SELECT 1 FROM model_client_sessions WHERE account=? AND connection=? AND expires>?').get(store.accountName,row.id,Date.now())?'connected':'waiting-client'):row.status,
    models:JSON.parse(row.catalog),checkedAt:row.checked_at,error:row.error,
    ...(row.kind==='client'?{config:{mcpServers:Object.fromEntries(providers.map(provider=>['threadbridge-'+provider,{command:process.execPath,
      args:[fileURLToPath(new URL('cli.mjs',import.meta.url)),'serve','--local-only','--db',store.file,'--account',store.accountName,'--provider',provider,'--model-client',row.id]}]))}}:{})})),
    settings:{connection:settings.connection,model:settings.model,running:Boolean(settings.running),dailyLimit:settings.daily_limit,error:settings.error,completed:settings.completed},usage};
}
function requireRow(store,id){
  if(typeof id!=='string'||!id||id.length>160)throw modelError('model-not-found',404);
  const row=modelConnection(store,id);if(!row)throw modelError('model-not-found',404);return row;
}
function validate(value){
  if(!value||Array.isArray(value)||Object.keys(value).some(k=>!['action','id','name','kind','protocol','endpoint','apiKey'].includes(k)))throw modelError('invalid-model-settings');
  if(typeof value.name!=='string'||!value.name.trim()||value.name.length>80||/[\x00-\x1f]/.test(value.name))throw modelError('invalid-model-settings');
  if(!['api','local','client'].includes(value.kind))throw modelError('invalid-model-settings');
  if(value.id!==undefined&&(typeof value.id!=='string'||!value.id||value.id.length>160))throw modelError('invalid-model-settings');
  if(value.endpoint!==undefined&&typeof value.endpoint!=='string')throw modelError('invalid-model-settings');
  if(value.kind==='client'&&(value.protocol||value.endpoint||value.apiKey))throw modelError('invalid-model-settings');
  if(value.apiKey!==undefined&&(typeof value.apiKey!=='string'||value.apiKey.length>4096||/[\x00-\x20]/.test(value.apiKey)))throw modelError('invalid-model-settings');
}
export async function saveModelConnection(store,value){
  validate(value);const old=value.id?requireRow(store,value.id):null,id=old?.id??randomUUID();
  const row={id,name:value.name.trim(),kind:value.kind,protocol:value.kind==='client'?'mcp':value.protocol,base_url:modelEndpoint(value.kind,value.protocol,value.endpoint)};
  // Credentials never carry across a changed destination or provider.
  const secret=value.apiKey||(old&&old.kind===row.kind&&old.protocol===row.protocol&&old.base_url===row.base_url?revealCredential(store,old):'');
  if(row.kind==='api'&&!secret)throw modelError('model-key-required');
  const catalog=row.kind==='client'?['client-current']:await discoverModels(row,secret);
  const credential=protectCredential(store,id,secret),at=new Date().toISOString();
  store.transaction(()=>{
    if(old&&modelConnection(store,id)?.version!==old.version)throw modelError('model-settings-changed',409);
    store.db.prepare(`INSERT INTO model_connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET
      name=excluded.name,kind=excluded.kind,protocol=excluded.protocol,base_url=excluded.base_url,credential=excluded.credential,
      status=excluded.status,catalog=excluded.catalog,checked_at=excluded.checked_at,error=NULL,version=excluded.version`)
      .run(store.accountName,id,row.name,row.kind,row.protocol,row.base_url,credential,row.kind==='client'?'waiting-client':'connected',JSON.stringify(catalog),row.kind==='client'?null:at,null,(old?.version??0)+1);
    if(old)store.db.prepare('UPDATE model_index_settings SET running=0,version=version+1,error=NULL WHERE account=? AND connection=?').run(store.accountName,id);
  });return id;
}
export async function refreshModelConnection(store,id){
  const row=requireRow(store,id);if(row.kind==='client')return;
  let catalog,error=null;
  try{catalog=await discoverModels(row,revealCredential(store,row));}catch(e){error=e.code??'model-network';}
  store.transaction(()=>{
    if(modelConnection(store,id)?.version!==row.version)throw modelError('model-settings-changed',409);
    store.db.prepare('UPDATE model_connections SET status=?,catalog=?,checked_at=?,error=?,version=version+1 WHERE account=? AND id=?')
      .run(error?'connection-error':'connected',catalog?JSON.stringify(catalog):row.catalog,new Date().toISOString(),error,store.accountName,id);
    store.db.prepare('UPDATE model_index_settings SET running=0,version=version+1,error=? WHERE account=? AND connection=?').run(error,store.accountName,id);
  });if(error)throw modelError(error,502);
}
export function removeModelConnection(store,id){
  requireRow(store,id);store.transaction(()=>{
    store.db.prepare('DELETE FROM model_connections WHERE account=? AND id=?').run(store.accountName,id);
    store.db.prepare('DELETE FROM model_client_sessions WHERE account=? AND connection=?').run(store.accountName,id);
    store.db.prepare('UPDATE model_index_settings SET connection=NULL,model=NULL,running=0,version=version+1,error=NULL WHERE account=? AND connection=?').run(store.accountName,id);
  });
  forgetCredential(store,id);
}
export function configureSummary(store,value){
  if(!value||Array.isArray(value))throw modelError('invalid-model-settings');
  const keys=Object.keys(value);modelSettings(store);
  store.transaction(()=>{
    if(keys.length===3&&keys.every(k=>['action','connection','model'].includes(k))&&value.action==='select'){
      const row=requireRow(store,value.connection);
      if(!JSON.parse(row.catalog).includes(value.model)||row.kind!=='client'&&row.status!=='connected')throw modelError('model-unavailable',409);
      store.db.prepare('UPDATE model_index_settings SET connection=?,model=?,running=0,version=version+1,error=NULL WHERE account=?').run(row.id,value.model,store.accountName);
    }else if(keys.length===2&&value.action==='run'&&typeof value.running==='boolean'){
      if(value.running){const settings=modelSettings(store),row=requireRow(store,settings.connection);
        if(row.kind==='client')throw modelError('model-client-on-demand',409);
        if(row.status!=='connected'||!JSON.parse(row.catalog).includes(settings.model))throw modelError('model-unavailable',409);
      }
      store.db.prepare('UPDATE model_index_settings SET running=?,version=version+1,error=NULL WHERE account=?').run(Number(value.running),store.accountName);
    }else if(keys.length===2&&value.action==='limit'&&Number.isSafeInteger(value.dailyLimit)&&value.dailyLimit>=1&&value.dailyLimit<=10000){
      store.db.prepare('UPDATE model_index_settings SET daily_limit=?,version=version+1 WHERE account=?').run(value.dailyLimit,store.accountName);
    }else throw modelError('invalid-model-settings');
  });
}
export function startModelClient(store,id){
  const row=requireRow(store,id);if(row.kind!=='client')throw modelError('invalid-model-client');
  const session=randomUUID(),beat=()=>{
    if(!modelConnection(store,id))return;
    store.db.prepare('DELETE FROM model_client_sessions WHERE account=? AND expires<?').run(store.accountName,Date.now());
    store.db.prepare('INSERT OR REPLACE INTO model_client_sessions VALUES(?,?,?,?)').run(store.accountName,id,session,Date.now()+45000);
    store.db.prepare('UPDATE model_connections SET checked_at=? WHERE account=? AND id=?').run(new Date().toISOString(),store.accountName,id);
  };
  beat();const timer=setInterval(beat,15000);timer.unref();
  return ()=>{clearInterval(timer);store.db.prepare('DELETE FROM model_client_sessions WHERE account=? AND connection=? AND session=?').run(store.accountName,id,session);};
}
