// Injected as a self-contained function in the extension's isolated world.
// Only read RPCs are constructed here; bootstrap credentials never leave the page.
export async function providerPageRequest(path,workspace=null,provider='claude',authuser=0){
  const origins={claude:'https://claude.ai',gemini:'https://gemini.google.com'};
  const forbidden=()=>({status:403,identity:null});
  if(!Object.hasOwn(origins,provider)||location.origin!==origins[provider]||!Number.isSafeInteger(authuser)||authuser<0||authuser>99)return forbidden();
  if(workspace!=null&&(typeof workspace!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(workspace)))return forbidden();
  if(typeof path!=='string'||path.length>4096||!/^\/(?:api\/auth\/session|history\/list\?[^#]*|history\/conversation\/[A-Za-z0-9_-]{1,160})$/.test(path))return forbidden();
  const url=new URL(path,origins[provider]),session=path==='/api/auth/session',list=url.pathname==='/history/list';
  const params=url.searchParams,scope=params.get('scope'),cursor=params.get('cursor');
  if(list&&([...params.keys()].some(k=>!['scope','offset','cursor'].includes(k))||[...params.keys()].some(k=>params.getAll(k).length!==1)
    ||!(provider==='claude'?scope==='active':['active','pinned'].includes(scope))||!/^(0|[1-9]\d{0,6})$/.test(params.get('offset')??'')||cursor!=null&&(!cursor||cursor.length>2048)))return forbidden();
  const id=list||session?null:url.pathname.split('/').at(-1);
  if(provider==='gemini'&&id&&!/^c_[A-Za-z0-9_-]+$/.test(id))return forbidden();
  const deadline=AbortSignal.timeout(30000),max=32*1024*1024;
  async function read(response){
    if(Number(response.headers.get('content-length'))>max)throw new Error('History response too large');
    if(!response.body){const text=await response.text();if(new TextEncoder().encode(text).length>max)throw new Error('History response too large');return text;}
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw new Error('History response too large');}chunks.push(value);}}
    finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }
  async function get(path){return fetch(path,{method:'GET',credentials:'include',redirect:'error',signal:deadline,headers:{Accept:'application/json'}});}
  function failure(response,identity=null,organization=null){return {status:response.status,identity,workspace:organization,retry:response.headers.get('retry-after')};}
  async function json(response){
    if(!response.headers.get('content-type')?.includes('json'))throw new Error('History endpoint returned non-JSON');return JSON.parse(await read(response));
  }
  if(provider==='claude'){
    const auth=await get('/api/account');if(!auth.ok)return failure(auth);
    const account=await json(auth);
    if(typeof account?.uuid!=='string'||!account.uuid||!Array.isArray(account.memberships))return {status:401,identity:null};
    const organizations=account.memberships.map(m=>m?.organization?.uuid).filter(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(v));
    const org=workspace??(organizations.length===1?organizations[0]:null);
    if(!org||!organizations.includes(org))return {status:403,identity:account.uuid};
    if(session)return {status:200,identity:account.uuid,workspace:org};
    const query=new URLSearchParams({limit:'100',offset:params.get('offset')??'0'});if(cursor)query.set('cursor',cursor);
    const resource=`/api/organizations/${org}/chat_conversations`;
    const response=await get(list?resource+'?'+query:resource+`/${id}?tree=True&rendering_mode=raw&render_all_tools=false`);
    if(!response.ok)return failure(response,account.uuid,org);
    return {status:response.status,identity:account.uuid,workspace:org,data:await json(response)};
  }
  const bootstrap=await get('/app?authuser='+authuser);if(!bootstrap.ok)return failure(bootstrap);
  const html=await read(bootstrap);
  function field(key){const match=html.match(new RegExp('"'+key+'"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")'));return match?JSON.parse(match[1]):null;}
  const token=field('SNlM0e'),identity=field('oPEP7c'),build=field('cfb2h'),sid=field('FdrFJe');
  if(typeof token!=='string'||!token||typeof identity!=='string'||!/^\S+@\S+\.\S+$/.test(identity))return {status:401,identity:null};
  const user=identity.toLowerCase();if(session)return {status:200,identity:user};
  const rpc=list?'MaZiqc':'hNvQHb';
  const payload=list?[100,cursor,[scope==='pinned'?1:0,null,1]]:[id,10000,null,1,[1],[4],null,1];
  const query=new URLSearchParams({rpcids:rpc,'source-path':'/app',authuser:String(authuser),rt:'c'});
  if(typeof build==='string')query.set('bl',build);if(typeof sid==='string')query.set('f.sid',sid);
  const body=new URLSearchParams({at:token,'f.req':JSON.stringify([[[rpc,JSON.stringify(payload),null,'generic']]])});
  const response=await fetch('/_/BardChatUi/data/batchexecute?'+query,{method:'POST',credentials:'include',redirect:'error',signal:deadline,
    headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body:body.toString()});
  if(!response.ok)return failure(response,user);
  // batchexecute frames start with an anti-XSSI prefix, then UTF-16 length + JSON.
  // Reject damaged frames and missing RPC bodies instead of reporting an empty history.
  let text=await read(response);if(!text.startsWith(")]}'"))throw new Error('Invalid Gemini RPC prefix');text=text.slice(4);
  const replies=[];let offset=0;
  while(offset<text.length){
    while(/\s/.test(text[offset]??'')&&offset<text.length)offset++;if(offset===text.length)break;
    const end=text.indexOf('\n',offset);if(end<0)throw new Error('Invalid Gemini RPC frame');
    const lengthText=text.slice(offset,end).trim();if(!/^\d+$/.test(lengthText))throw new Error('Invalid Gemini RPC frame length');
    const length=Number(lengthText);offset=end+1;if(!Number.isSafeInteger(length)||length<1||offset+length>text.length)throw new Error('Truncated Gemini RPC frame');
    const frame=JSON.parse(text.slice(offset,offset+length));offset+=length;
    if(!Array.isArray(frame))throw new Error('Invalid Gemini RPC frame data');
    for(const entry of frame)if(Array.isArray(entry)&&entry[0]==='wrb.fr'&&entry[1]===rpc){
      if(typeof entry[2]!=='string')throw new Error('Gemini history RPC failed');replies.push(JSON.parse(entry[2]));
    }
  }
  if(replies.length!==1)throw new Error('Missing or ambiguous Gemini history RPC');
  return {status:200,identity:user,data:list?replies[0]:{conversation_id:id,body:replies[0]}};
}
