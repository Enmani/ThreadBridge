// Executes in the extension's isolated world. Tokens never leave this browser context.
export async function pageRequest(path,workspace=null) {
  if(location.origin!=='https://chatgpt.com')return {status:403,identity:null};
  const valid=path==='/api/auth/session'||/^\/backend-api\/conversations\?(?:[^#]*)$/.test(path)
    ||/^\/backend-api\/conversation\/[A-Za-z0-9_-]{1,160}$/.test(path)
    ||/^\/backend-api\/gizmos\/snorlax\/sidebar\?(?:[^#]*)$/.test(path)
    ||/^\/backend-api\/gizmos\/g-p-[A-Za-z0-9_-]{1,156}\/conversations\?(?:[^#]*)$/.test(path)
    ||/^\/backend-api\/(?:projects|gizmos\/discovery\/mine)(?:\?[^#]*)?$/.test(path);
  if(!valid)return {status:403,identity:null};
  if(workspace!==null&&(typeof workspace!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(workspace)))return {status:403,identity:null};
  // This isolated-world cache survives executeScript calls, but never browser reloads.
  // Explicit bearer tokens bind reads to the verified user until the next check.
  const cacheable=typeof document!=='undefined',key='__threadbridgeSessionV1';
  const state=cacheable?(globalThis[key]??={session:null,until:0,scope:null,listening:false}):{session:null,until:0};
  const scope=()=>JSON.stringify([workspace,cacheable?document.cookie:null]);
  if(cacheable&&!state.listening&&typeof globalThis.addEventListener==='function'){
    state.listening=true;
    for(const event of ['focus','pageshow','storage'])globalThis.addEventListener(event,()=>{state.session=null;state.until=0;});
  }
  const invalidate=()=>{state.session=null;state.until=0;};
  try{
    const before=scope();
    if(path==='/api/auth/session'||!state.session||Date.now()>=state.until||state.scope!==before){
      invalidate();
      const response=await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)return {status:response.status,identity:null,retry:response.headers.get('retry-after')};const session=await response.json();
      if(typeof session.accessToken!=='string'||typeof session.user?.id!=='string')return {status:401,identity:null};
      if(before!==scope())return {status:403,identity:null};
      state.session=session;state.scope=before;
      const expires=Date.parse(session.expires);state.until=Math.min(Date.now()+30000,Number.isFinite(expires)?expires:Infinity);
    }
    const session=state.session;
    const identity=session.user.id;
    if(path==='/api/auth/session')return {status:200,identity};
    const result=await fetch(path,{method:'GET',credentials:'include',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:'Bearer '+session.accessToken,Accept:'application/json',...(workspace?{'chatgpt-account-id':workspace}:{})}});
    if(before!==scope()){invalidate();return {status:403,identity:null};}
    if(!result.ok){if([401,403].includes(result.status))invalidate();return {status:result.status,identity,retry:result.headers.get('retry-after')};}
    if(!result.headers.get('content-type')?.includes('json'))return {status:502,identity};
    const size=Number(result.headers.get('content-length'));if(size>32*1024*1024)return {status:413,identity};
    const text=await result.text();if(new TextEncoder().encode(text).length>32*1024*1024)return {status:413,identity};
    if(before!==scope()||state.session!==session){invalidate();return {status:403,identity:null};}
    return {status:200,identity,data:JSON.parse(text)};
  }catch{invalidate();return {status:503,identity:null};}
}
