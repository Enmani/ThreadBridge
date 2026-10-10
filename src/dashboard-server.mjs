import http from 'node:http';
import {readFileSync} from 'node:fs';
import {pauseRequested,syncMode,syncComplete,startSync,watchNewRequested,watchNewThreads,setSyncPaused} from './sync-control.mjs';
import {browserArchiveEnabled} from './browser-archive.mjs';
import {importJson,importLimit} from './json-import.mjs';
import {readJsonRequest} from './http-json.mjs';
import {providerNames} from './providers.mjs';
import {connections,addConnection,connectionStatus} from './connections.mjs';
import {combinedThreads,combinedStatus} from './history-view.mjs';
import {dashboardIndex,configureIndex,startIndexing} from './chat-index-dashboard.mjs';

const files=new Map([['/',['index.html','text/html']],['/settings',['settings.html','text/html']],['/settings.mjs',['settings.mjs','text/javascript']],['/theme.mjs',['theme.mjs','text/javascript']],['/sort-ui.mjs',['sort-ui.mjs','text/javascript']],['/floating-ui.mjs',['floating-ui.mjs','text/javascript']],['/app.mjs',['app.mjs','text/javascript']],['/import-ui.mjs',['import-ui.mjs','text/javascript']],['/labels.mjs',['labels.mjs','text/javascript']],['/style.css',['style.css','text/css']]]);
files.set('/index-settings.mjs',['index-settings.mjs','text/javascript']);
export function dashboardStatus(store,now=Date.now()){
  const status=store.status(),worker=status.background,connected=Boolean(worker?.heartbeatAt&&now-worker.heartbeatAt<45000);
  const paused=pauseRequested(store),nextAt=connected&&!paused&&!['paused','account-changed'].includes(worker.state)?Math.max(worker.nextRunAt,worker.nextRequestAt):null;
  const textArchives=store.db.prepare("SELECT COUNT(*) AS n FROM threads WHERE account=? AND revision>0 AND coverage='bounded-text'").get(store.account).n;
  return {...status,app:'threadbridge',textArchives,runtime:{connected,paused,nextAt,now,mode:syncMode(store),complete:syncComplete(store),finishedAt:store.meta('sync_finished_at'),
    browserArchive:store.provider==='chatgpt'&&browserArchiveEnabled(store),browserArchiveReady:store.provider==='chatgpt'&&connected&&store.meta('browser_archive_version')==='1',
    watchNew:watchNewRequested(store),directoryIntervalMs:Number(store.meta('directory_interval_ms') ?? 900000)}};
}
async function readControl(request){
  const value=await readJsonRequest(request);
  if(!value||Array.isArray(value)||Object.keys(value).length!==1||!(typeof value.paused==='boolean'||typeof value.watchNew==='boolean'||typeof value.browserArchive==='boolean'||['ids','full'].includes(value.mode)))
    throw Object.assign(new Error('Invalid control request'),{status:400});
  return value;
}
export function createDashboard(source){
  const stores=source instanceof Map?source:new Map([[source.provider,source]]),defaultProvider=stores.keys().next().value;
  if(!stores.size)throw new Error('Dashboard needs a provider');
  const root=stores.get('chatgpt')??stores.values().next().value,unified=source instanceof Map;
  if(unified)connections(root);
  const activeStores=()=>unified?connections(root).map(c=>{const store=stores.get(c.provider);if(!store)throw new Error('Configured platform is unavailable');return store;}):[root];
  const status=store=>({...(store?dashboardStatus(store):combinedStatus(activeStores().map(s=>dashboardStatus(s)))),capabilities:{browserArchive:(store?[store]:activeStores()).some(s=>s.provider==='chatgpt'),jsonImport:stores.has('chatgpt')&&(!store||store.provider==='chatgpt')}});
  const server=http.createServer(async(request,response)=>{
    const address=response.socket.localPort,origin=`http://127.0.0.1:${address}`;
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
    // Only the user's local control console can embed this dashboard; controls remain same-origin.
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors http://127.0.0.1:17322");
    const send=(code,value,type='application/json')=>{response.writeHead(code,{'Content-Type':type+'; charset=utf-8'});response.end(type==='application/json'?JSON.stringify(value):value);};
    if(request.headers.host!==`127.0.0.1:${address}`||request.headers.origin&&request.headers.origin!==origin||request.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Local dashboard only'});
    try{
      const url=new URL(request.url,origin);
      const provider=url.searchParams.get('provider'),store=provider?stores.get(provider):unified?null:stores.get(defaultProvider);
      if(provider&&!store)return send(400,{error:'Provider is not configured'});
      if(url.pathname==='/api/index'){
        if(request.method==='POST'){
          if(request.headers.origin!==origin)return send(403,{error:'Same-origin settings required'});
          if(request.headers['content-type']?.split(';')[0].trim()!=='application/json')return send(415,{error:'JSON settings required'});
          configureIndex(root,store?[store.provider]:[...stores.keys()],await readJsonRequest(request));
        }else if(request.method!=='GET')return send(405,{error:'Unsupported method'});
        return send(200,dashboardIndex(store?[store]:activeStores()));
      }
      if(url.pathname==='/api/connections'){
        if(request.method==='POST'){
          if(request.headers.origin!==origin)return send(403,{error:'Same-origin settings required'});
          if(request.headers['content-type']?.split(';')[0].trim()!=='application/json')return send(415,{error:'JSON settings required'});
          const value=await readJsonRequest(request);addConnection(root,value,stores.get(value?.provider));return send(202,{added:true,provider:value.provider,connected:false});
        }
        if(request.method!=='GET')return send(405,{error:'Unsupported method'});
        const list=unified?connections(root):[{provider:root.provider}],added=new Set(list.map(c=>c.provider));
        return send(200,{items:list.map(c=>connectionStatus(stores.get(c.provider))),available:[...stores.keys()].filter(p=>!added.has(p)).map(id=>({id,name:providerNames[id]}))});
      }
      if(url.pathname==='/api/import'&&request.method==='POST'){
        const target=store??stores.get('chatgpt');if(target?.provider!=='chatgpt')return send(400,{error:'This importer accepts ChatGPT JSON only'});
        if(request.headers.origin!==origin)return send(403,{error:'Same-origin import required',code:'foreign-origin'});
        if(request.headers['content-type']?.split(';')[0].trim()!=='application/json')return send(415,{error:'JSON import required',code:'unsupported-format'});
        const raw=await readJsonRequest(request,{maxBytes:importLimit,timeoutMs:30000});
        return send(200,importJson(target,raw));
      }
      if(url.pathname==='/api/control'&&request.method==='POST'){
        if(request.headers.origin!==origin)return send(403,{error:'Same-origin control required'});
        if(request.headers['content-type']?.split(';')[0].trim()!=='application/json')return send(415,{error:'JSON control required'});
        const command=await readControl(request);
        if(typeof command.browserArchive==='boolean'){
          const target=store??stores.get('chatgpt');if(target?.provider!=='chatgpt')return send(400,{error:'Browsing archives are only available for ChatGPT'});target.meta('browser_archive_enabled',command.browserArchive?1:0);
        }else{
          const targets=store?[store]:[...new Set([root,...activeStores()])];
          root.transaction(()=>{for(const target of targets){
            if(target.accountName!==root.accountName)throw new Error('Dashboard account namespaces differ');
            const view=root.scope(target.provider);
            if(command.mode)startSync(view,command.mode);else if(typeof command.watchNew==='boolean')watchNewThreads(view,command.watchNew);else setSyncPaused(view,command.paused);
          }});
        }
        return send(200,status(store));
      }
      if(request.method!=='GET')return send(405,{error:'Unsupported method'});
      if(url.pathname==='/chat-index-guide')return send(200,readFileSync(new URL('../docs/chat-index.md',import.meta.url)),'text/plain');
      if(url.pathname==='/api/status')return send(200,status(store));
      if(url.pathname==='/api/threads'){
        const options={query:url.searchParams.get('q')??'',page:Number(url.searchParams.get('page')??1),limit:Number(url.searchParams.get('limit')??50),sort:url.searchParams.get('sort')??'source_updated',order:url.searchParams.get('order')??'desc'};
        return send(200,store?store.listThreads(options):combinedThreads(activeStores(),options));
      }
      const file=files.get(url.pathname);if(!file)return send(404,{error:'Not found'});
      send(200,readFileSync(new URL('../web/'+file[0],import.meta.url)),file[1]);
    }catch(e){send(e.status ?? (e.message==='Invalid thread list parameters'?400:500),{error:e.status?e.message:e.message==='Invalid thread list parameters'?'Invalid list parameters':'Unable to read local history',...(e.code?{code:e.code}:{})});}
  });
  startIndexing(server,activeStores);return server;
}
