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
  try{
    // Session is short-lived in memory and revalidated each request to detect account switching.
    const response=await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)return {status:response.status,identity:null,retry:response.headers.get('retry-after')};const session=await response.json();
    if(typeof session.accessToken!=='string'||typeof session.user?.id!=='string')return {status:401,identity:null};
    const identity=session.user.id;
    if(path==='/api/auth/session')return {status:200,identity};
    const result=await fetch(path,{method:'GET',credentials:'include',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:'Bearer '+session.accessToken,Accept:'application/json',...(workspace?{'chatgpt-account-id':workspace}:{})}});
    if(!result.ok)return {status:result.status,identity,retry:result.headers.get('retry-after')};
    if(!result.headers.get('content-type')?.includes('json'))return {status:502,identity};
    const size=Number(result.headers.get('content-length'));if(size>32*1024*1024)return {status:413,identity};
    const text=await result.text();if(new TextEncoder().encode(text).length>32*1024*1024)return {status:413,identity};
    return {status:200,identity,data:JSON.parse(text)};
  }catch{return {status:503,identity:null};}
}
