import {providerNames} from './providers.mjs';
import {threadOrder} from './thread-order.mjs';

// Each provider retains its own store, rate limits and consumer cursors.
// The dashboard merges only metadata; message payloads never cross namespaces.
export function combinedThreads(stores,{query='',page=1,limit=50,sort='source_updated',order='desc'}={}){
  if(typeof query!=='string'||query.length>200||!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error('Invalid thread list parameters');
  const db=stores[0].db,accounts=stores.map(s=>s.account),owners=new Map(stores.map(s=>[s.account,s]));
  const term='%'+query.replace(/[\\%_]/g,'\\$&')+'%',where=`t.account IN (${accounts.map(()=>'?').join(',')}) AND (t.title LIKE ? ESCAPE '\\' OR t.id LIKE ? ESCAPE '\\')`,params=[...accounts,term,term];
  const total=db.prepare('SELECT COUNT(*) AS n FROM threads t WHERE '+where).get(...params).n;
  const rows=db.prepare(`SELECT t.*,(SELECT COUNT(*) FROM messages m WHERE m.account=t.account AND m.thread=t.id) AS messages FROM threads t WHERE ${where}
    ORDER BY ${threadOrder(sort,order)} LIMIT ? OFFSET ?`).all(...params,limit,(page-1)*limit);
  return {total,page,limit,pages:Math.max(1,Math.ceil(total/limit)),items:rows.map(({account,...row})=>{
    const owner=owners.get(account);return {...owner.threadViews([row])[0],provider:owner.provider,providerName:providerNames[owner.provider]};
  })};
}
export function combinedStatus(statuses){
  if(!statuses.length)throw new Error('No connected platforms');
  const first=statuses[0],sum=key=>statuses.reduce((n,s)=>n+(s[key]??0),0),recent=key=>statuses.map(s=>s[key]).filter(Boolean).sort((a,b)=>(b.finishedAt??b.startedAt??Date.parse(b.at))-(a.finishedAt??a.startedAt??Date.parse(a.at)))[0]??null;
  const active=statuses.filter(s=>s.runtime.connected&&!s.runtime.paused),priority=['account-changed','login-required','connection-error','rate-limited','syncing','connecting','pending','waiting','up-to-date'];
  const state=priority.find(value=>active.some(s=>s.background?.state===value))??first.background?.state??'paused';
  const next=active.map(s=>s.runtime.nextAt).filter(v=>v!=null);
  return {...first,provider:'all',platforms:statuses.map(s=>({provider:s.provider,threads:s.threads,state:s.background?.state??null})),
    ...Object.fromEntries(['threads','fullTrees','pending','errors','messages','browserArchives','importedArchives','textArchives'].map(key=>[key,sum(key)])),
    lastRequest:recent('lastRequest'),lastCapture:recent('lastCapture'),activeScan:statuses.some(s=>s.activeScan)?{scopes:statuses.flatMap(s=>s.activeScan?.scopes??[]),pendingScopes:statuses.reduce((n,s)=>n+(s.activeScan?.pendingScopes??0),0)}:null,
    background:{...(first.background??{}),state,paceMs:Math.max(...active.map(s=>s.background?.paceMs??0),0)},
    runtime:{...first.runtime,connected:statuses.some(s=>s.runtime.connected),paused:statuses.every(s=>s.runtime.paused),complete:statuses.every(s=>s.runtime.complete),nextAt:next.length?Math.min(...next):null,
      phase:statuses.some(s=>s.runtime.phase==='initial'&&s.runtime.mode==='full')?'initial':first.runtime.phase,
      scopeIssues:statuses.flatMap(s=>s.runtime.scopeIssues.map(issue=>({...issue,provider:s.provider}))),failedThreads:sum('errors'),
      mode:statuses.every(s=>s.runtime.mode===first.runtime.mode)?first.runtime.mode:'mixed',watchNew:statuses.every(s=>s.runtime.watchNew)}};
}
