import {randomUUID} from 'node:crypto';
import {modelConnection,modelSettings} from './model-connections.mjs';
import {revealCredential} from './model-credentials.mjs';
import {generateSummary} from './model-transport.mjs';
import {summaryTasks,saveSummary,indexStatus} from './chat-index.mjs';

export async function summarizeNext(root,stores,{signal,generate=generateSummary,isClosed=()=>false}={}){
  if(signal?.aborted)return;
  if(stores.some(s=>s.accountName!==root.accountName||s.db!==root.db))throw new Error('Summary stores must share the account and database');
  const owner=randomUUID(),account=root.accountName,day=new Date().toISOString().slice(0,10);
  const work=root.transaction(()=>{
    const settings=modelSettings(root);if(!settings.running)return null;
    const row=modelConnection(root,settings.connection);if(!row||row.kind==='client'||row.status!=='connected')return null;
    if(stores.some(s=>!indexStatus(s).enabled))return null;
    const lease=root.db.prepare('SELECT * FROM model_index_leases WHERE account=?').get(account);
    if(lease?.expires>Date.now())return null;
    const usage=root.db.prepare('SELECT requests FROM model_index_usage WHERE account=? AND day=?').get(account,day);
    if((usage?.requests??0)>=settings.daily_limit){
      root.db.prepare("UPDATE model_index_settings SET running=0,error='model-daily-limit',version=version+1 WHERE account=?").run(account);return null;
    }
    // Rotate platforms so a long archive cannot starve another connected platform.
    const cursor=Number(root.meta('model_summary_cursor')??0);let task,store;
    for(let n=0;n<stores.length;n++){
      const at=(cursor+n)%stores.length,candidate=stores[at];task=summaryTasks(candidate,{limit:1}).tasks[0];
      if(task){store=candidate;root.meta('model_summary_cursor',(at+1)%stores.length);break;}
    }
    if(!task){const states=stores.map(indexStatus);
      if(states.some(s=>s.errors)&&states.every(s=>s.pending===s.errors))root.db.prepare("UPDATE model_index_settings SET running=0,error='model-index-error' WHERE account=?").run(account);
      return null;
    }
    root.db.prepare('INSERT OR REPLACE INTO model_index_leases VALUES(?,?,?)').run(account,owner,Date.now()+90000);
    root.db.prepare(`INSERT INTO model_index_usage(account,day,requests) VALUES(?,?,1)
      ON CONFLICT(account,day) DO UPDATE SET requests=requests+1`).run(account,day);
    return {settings,row,task,store};
  });
  if(!work)return;
  const current=()=>{const s=modelSettings(root),r=modelConnection(root,work.row.id),l=root.db.prepare('SELECT * FROM model_index_leases WHERE account=?').get(account);
    return Boolean(s.running&&s.version===work.settings.version&&r?.version===work.row.version&&l?.owner===owner&&l.expires>Date.now());};
  try{
    const result=await generate(work.row,revealCredential(root,work.row),work.settings.model,work.task,{signal});
    if(signal?.aborted)return;
    root.transaction(()=>{
      root.db.prepare('UPDATE model_index_usage SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE account=? AND day=?')
        .run(result.inputTokens,result.outputTokens,account,day);
      if(!current())return;
      const node=root.db.prepare('SELECT generation,summary FROM chat_index_nodes WHERE account=? AND id=?').get(work.store.account,work.task.node.id);
      if(!node||node.generation!==work.task.node.generation||node.summary)return;
      try{saveSummary(work.store,{id:work.task.node.id,generation:work.task.node.generation,summary:result.summary});}
      catch(e){if(/paused|Index changed|updates pending|children first/.test(e.message))return;throw e;}
      root.db.prepare('UPDATE model_index_settings SET completed=completed+1,error=NULL WHERE account=?').run(account);
    });
  }catch(e){
    if(signal?.aborted)return;
    root.transaction(()=>{
      if(e.usage)root.db.prepare('UPDATE model_index_usage SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE account=? AND day=?').run(e.usage.inputTokens,e.usage.outputTokens,account,day);
      if(!current())return;const code=e.code??'model-summary-failed';
      root.db.prepare('UPDATE model_index_settings SET running=0,error=?,version=version+1 WHERE account=?').run(code,account);
      if(['model-auth','model-network','model-http','credential-store'].includes(code))root.db.prepare("UPDATE model_connections SET status='connection-error',error=? WHERE account=? AND id=?").run(code,account,work.row.id);
    });
  }finally{
    // A shutdown caller may immediately close SQLite; the bounded lease also expires independently.
    if(!isClosed())root.db.prepare('DELETE FROM model_index_leases WHERE account=? AND owner=?').run(account,owner);
  }
}
export function startSummaries(server,root,getStores){
  let timer,busy=false,closed=false,controller;
  const cancel=()=>controller?.abort();
  const tick=async()=>{
    if(busy||closed)return;busy=true;controller=new AbortController();
    try{await summarizeNext(root,getStores(),{signal:controller.signal,isClosed:()=>closed});}
    catch(e){if(!closed)process.stderr.write(`Summary worker failed (${e.code??'database error'}); pending summaries retained.\n`);}
    finally{busy=false;}
  };
  server.once('listening',()=>{timer=setInterval(()=>void tick(),2000);timer.unref();});
  server.once('close',()=>{closed=true;clearInterval(timer);cancel();});
  return {cancel};
}
