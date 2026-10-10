import http from 'node:http';
import {readFileSync} from 'node:fs';
import {pauseRequested,syncMode,syncComplete,startSync,watchNewRequested,watchNewThreads,setSyncPaused} from './sync-control.mjs';
import {browserArchiveEnabled} from './browser-archive.mjs';
import {importJson,importLimit} from './json-import.mjs';
import {readJsonRequest} from './http-json.mjs';

const files=new Map([['/',['index.html','text/html']],['/app.mjs',['app.mjs','text/javascript']],['/import-ui.mjs',['import-ui.mjs','text/javascript']],['/labels.mjs',['labels.mjs','text/javascript']],['/style.css',['style.css','text/css']]]);
export function dashboardStatus(store,now=Date.now()){
  const status=store.status(),worker=status.background,connected=Boolean(worker?.heartbeatAt&&now-worker.heartbeatAt<45000);
  const paused=pauseRequested(store),nextAt=connected&&!paused&&!['paused','account-changed'].includes(worker.state)?Math.max(worker.nextRunAt,worker.nextRequestAt):null;
  const textArchives=store.db.prepare("SELECT COUNT(*) AS n FROM threads WHERE account=? AND revision>0 AND coverage='bounded-text'").get(store.account).n;
  return {...status,app:'threadbridge',textArchives,runtime:{connected,paused,nextAt,now,mode:syncMode(store),complete:syncComplete(store),finishedAt:store.meta('sync_finished_at'),
    browserArchive:browserArchiveEnabled(store),browserArchiveReady:connected&&store.meta('browser_archive_version')==='1',
    watchNew:watchNewRequested(store),directoryIntervalMs:Number(store.meta('directory_interval_ms') ?? 900000)}};
}
async function readControl(request){
  const value=await readJsonRequest(request);
  if(!value||Array.isArray(value)||Object.keys(value).length!==1||!(typeof value.paused==='boolean'||typeof value.watchNew==='boolean'||typeof value.browserArchive==='boolean'||['ids','full'].includes(value.mode)))
    throw Object.assign(new Error('Invalid control request'),{status:400});
  return value;
}
export function createDashboard(store){
  return http.createServer(async(request,response)=>{
    const address=response.socket.localPort,origin=`http://127.0.0.1:${address}`;
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
    // Only the user's local control console can embed this dashboard; controls remain same-origin.
    response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors http://127.0.0.1:17322");
    const send=(code,value,type='application/json')=>{response.writeHead(code,{'Content-Type':type+'; charset=utf-8'});response.end(type==='application/json'?JSON.stringify(value):value);};
    if(request.headers.host!==`127.0.0.1:${address}`||request.headers.origin&&request.headers.origin!==origin||request.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Local dashboard only'});
    try{
      const url=new URL(request.url,origin);
      if(url.pathname==='/api/import'&&request.method==='POST'){
        if(request.headers.origin!==origin)return send(403,{error:'Same-origin import required',code:'foreign-origin'});
        if(request.headers['content-type']?.split(';')[0].trim()!=='application/json')return send(415,{error:'JSON import required',code:'unsupported-format'});
        const raw=await readJsonRequest(request,{maxBytes:importLimit,timeoutMs:30000});
        return send(200,importJson(store,raw));
      }
      if(url.pathname==='/api/control'&&request.method==='POST'){
        if(request.headers.origin!==origin)return send(403,{error:'Same-origin control required'});
        if(request.headers['content-type']?.split(';')[0].trim()!=='application/json')return send(415,{error:'JSON control required'});
        const command=await readControl(request);
        if(command.mode)startSync(store,command.mode);else if(typeof command.watchNew==='boolean')watchNewThreads(store,command.watchNew);
        else if(typeof command.browserArchive==='boolean')store.meta('browser_archive_enabled',command.browserArchive?1:0);
        else setSyncPaused(store,command.paused);
        return send(200,dashboardStatus(store));
      }
      if(request.method!=='GET')return send(405,{error:'Unsupported method'});
      if(url.pathname==='/api/status')return send(200,dashboardStatus(store));
      if(url.pathname==='/api/threads')return send(200,store.listThreads({query:url.searchParams.get('q') ?? '',page:Number(url.searchParams.get('page') ?? 1),limit:Number(url.searchParams.get('limit') ?? 50)}));
      const file=files.get(url.pathname);if(!file)return send(404,{error:'Not found'});
      send(200,readFileSync(new URL('../web/'+file[0],import.meta.url)),file[1]);
    }catch(e){send(e.status ?? (e.message==='Invalid thread list parameters'?400:500),{error:e.status?e.message:e.message==='Invalid thread list parameters'?'Invalid list parameters':'Unable to read local history',...(e.code?{code:e.code}:{})});}
  });
}
