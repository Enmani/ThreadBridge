// MAIN world: observe requests the website already makes. Never initiate a request.
(() => {
  if (window.__threadbridgeObserver) return;
  window.__threadbridgeObserver = true;
  const channel = 'threadbridge-browser-archive-v1', maxBytes = 32 * 1024 * 1024;
  let enabled = false, identity = null, workspace, personalAccount = null, bootstrapAllowed=true, wasEnabled=false;
  let timer, lastRoute = '', receivedTreeRoute='', lastState='', previousIds = new Set(), seen = new Map();
  const post = value => window.postMessage({channel, ...value}, location.origin);
  const route = () => {
    const match = /\/c\/([A-Za-z0-9_-]{1,160})\/?$/.exec(location.pathname);
    if (!match) return null;
    return {id:match[1],url:location.origin+location.pathname,
      project:/\/g\/(g-p-[A-Za-z0-9_-]+)/.exec(location.pathname)?.[1] ?? null};
  };
  function setIdentity(user) {
    if (typeof user !== 'string' || !user.startsWith('user-')) return false;
    if (identity && identity !== user) {
      seen.clear(); previousIds.clear(); workspace=undefined; personalAccount=null;
    }
    identity=user; return true;
  }
  function sessionContext(session) {
    if (!setIdentity(session?.user?.id)) return;
    const account=session.account;
    if (typeof account?.id==='string' && ['personal','workspace','team'].includes(account.structure)) {
      if(account.structure==='personal') personalAccount=account.id;
      if(workspace===undefined || workspace===account.id) workspace=account.structure==='personal'?null:account.id;
    }
    if(typeof session.accessToken==='string')context({authorization:'Bearer '+session.accessToken});
  }
  function bootstrapSession() {
    if(!bootstrapAllowed)return;
    // The server-rendered session may arrive before Native Messaging enables capture.
    // Inspect only the known session envelope, never conversation text or arbitrary nested data.
    for(const script of document.querySelectorAll('script[type="application/json"]')) {
      if(script.textContent.length>maxBytes)continue;
      try {
        const root=JSON.parse(script.textContent);
        if(root.authStatus!=='logged_in' || !root.session?.user?.id || !root.session?.account)continue;
        if(identity && identity!==root.session.user.id)continue; // A stale document cannot undo an account switch.
        sessionContext(root.session); if(identity && workspace!==undefined)return;
      } catch { /* Ignore unrelated embedded JSON. */ }
    }
  }
  function context(headers) {
    const h = new Headers(headers), auth = h.get('authorization');let tokenAccount;
    // Decode only the user claim; credentials never leave this page or get persisted.
    if (auth?.startsWith('Bearer ')) try {
      const part = auth.slice(7).split('.')[1];
      const claims = JSON.parse(atob(part.replaceAll('-','+').replaceAll('_','/')));
      const user = claims['https://api.openai.com/auth']?.user_id ?? claims.sub;
      tokenAccount=claims['https://api.openai.com/auth']?.chatgpt_account_id;
      setIdentity(user);
    } catch { /* A non-JWT token cannot establish identity. */ }
    const account = h.get('chatgpt-account-id') ?? tokenAccount;
    if (account) workspace = account === personalAccount ? null : account;
    return {identity,workspace,account};
  }
  async function inspect(response, request) {
    if (!enabled || !response.ok) return;
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('application/json') || Number(response.headers.get('content-length') ?? 0) > maxBytes) return;
    // Bound the clone: do not read an unlimited stream or consume the website's response.
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    let size = 0; const chunks = [];
    try {
      while (true) { const {done,value} = await reader.read(); if (done) break;
        size += value.length; if (size > maxBytes) { void reader.cancel(); return; } chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
      const body = JSON.parse(new TextDecoder().decode(bytes));
      if (!enabled) return;
      if(request.identity && request.identity!==identity)return;
      if (request.path === '/api/auth/session') {
        sessionContext(body); schedule();
        return;
      }
      if (request.path.startsWith('/backend-api/accounts/check')) {
        for (const [id,entry] of Object.entries(body.accounts ?? {})) {
          // `default` is a dictionary alias, not the account ID sent in request headers.
          if (entry?.account?.structure === 'personal') personalAccount=entry.account.account_id ?? entry.account.id ?? id;
        }
        if (workspace === personalAccount) workspace=null;
        schedule(); return;
      }
      const current = route();
      if (!current || request.id !== current.id || !request.identity || request.identity !== identity) return;
      const raw = body.conversation ?? body;
      if (!raw.mapping || !raw.current_node || (raw.conversation_id ?? raw.id) !== current.id) return;
      const scope = request.account === personalAccount ? null : request.workspace;
      post({type:'capture',payload:{...current,title:String(raw.title ?? document.title).slice(0,1000),
        kind:'tree',identity:request.identity,workspace:scope,requestedAt:request.requestedAt,raw}});
      receivedTreeRoute=current.id;
      schedule();
    } catch { /* Malformed/non-history responses never affect the website. */ }
    finally { reader.releaseLock(); }
  }
  function requestInfo(input, options) {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url,location.href); } catch { return null; }
    if (url.origin !== location.origin) return null;
    const method = String(options?.method ?? input?.method ?? 'GET').toUpperCase();
    const ctx = context(options?.headers ?? input?.headers);
    if (method !== 'GET') return null;
    const match = /^\/backend-api\/conversation\/([A-Za-z0-9_-]{1,160})$/.exec(url.pathname);
    if (!match && url.pathname !== '/api/auth/session' && !url.pathname.startsWith('/backend-api/accounts/check')) return null;
    return {...ctx,path:url.pathname,id:match?.[1],requestedAt:Date.now()};
  }
  const originalFetch = window.fetch;
  window.fetch = function(input, options) {
    let request;
    if (enabled) try { request = requestInfo(input,options); } catch { /* Preserve normal fetch behavior. */ }
    const promise = originalFetch.apply(this,arguments);
    if (request) void promise.then(response => inspect(response,request)).catch(()=>{});
    return promise;
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send, header = XMLHttpRequest.prototype.setRequestHeader;
  const xhrInfo = new WeakMap();
  XMLHttpRequest.prototype.open = function(method,url) { xhrInfo.set(this,{method,url,headers:{}}); return open.apply(this,arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function(name,value) { const item=xhrInfo.get(this); if(item)item.headers[name]=value; return header.apply(this,arguments); };
  XMLHttpRequest.prototype.send = function() {
    const item=xhrInfo.get(this); let request;
    if (enabled && item) try { request=requestInfo(item.url,item); } catch {}
    if (request) this.addEventListener('load',()=>{
      if (!enabled || this.status<200 || this.status>=300) return;
      try {
        const body = this.responseType==='json' ? JSON.stringify(this.response) : this.responseType===''||this.responseType==='text' ? this.responseText : null;
        if (body && body.length <= maxBytes) void inspect(new Response(body,{headers:{'content-type':'application/json'}}),request);
      } catch {}
    },{once:true});
    return send.apply(this,arguments);
  };
  function messageMeta(element) {
    let id=element.getAttribute('data-message-id'), role=element.getAttribute('data-message-author-role');
    const ids=element.getAttribute('data-chatgpt-search-message-ids')?.trim().split(/\s+/);
    if(!id && ids && new Set(ids).size===1) id=ids[0];
    role ??= element.querySelector('[data-conversation-role]')?.getAttribute('data-conversation-role');
    if(!role && element.classList.contains('group/user-message'))role='user';
    // Current layouts may expose IDs only in React props. Walk this element's ancestors, never the global app state.
    let fiber=element[Object.keys(element).find(k=>k.startsWith('__reactFiber$'))];
    for(let n=0;fiber&&n<12&&(!id||!role);n++,fiber=fiber.return){
      const props=fiber.memoizedProps, msg=props?.message ?? props?.msg;
      if(msg?.id && ['user','assistant'].includes(msg.author?.role)){id ??= msg.id;role ??= msg.author.role;}
    }
    return {id,role};
  }
  function serialize(element) {
    const copy=element.cloneNode(true);
    copy.querySelectorAll('button,svg,script,style,[aria-hidden="true"],.sr-only,h4[data-conversation-role]').forEach(e=>e.remove());
    copy.querySelectorAll('.katex').forEach(e=>{
      const tex=e.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if(tex)e.replaceWith(document.createTextNode(e.closest('.katex-display')?'\n\\[\n'+tex+'\n\\]\n':'\\('+tex+'\\)'));
    });
    const text = node => {
      if(node.nodeType===3)return node.textContent;
      if(node.nodeType!==1)return '';
      if(node.tagName==='BR')return '\n';
      if(node.tagName==='PRE')return '\n```\n'+node.textContent+'\n```\n';
      const result=Array.from(node.childNodes).map(text).join('');
      return /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|TR)$/.test(node.tagName)?result+'\n':result;
    };
    return {text:text(copy).trim(),html:copy.innerHTML};
  }
  function capturePage() {
    timer=null; if(!enabled)return;
    const current=route(); if(!current)return;
    if(!identity || workspace===undefined)bootstrapSession();
    if(!identity || workspace===undefined){report('waiting-account');return;}
    const selector='[data-message-author-role],[data-chatgpt-search-message-ids],.group\\/user-message,[data-conversation-role="assistant"]';
    const nodes=Array.from(document.querySelectorAll(selector)), ids=new Set(), messages=[];
    if(lastRoute && lastRoute!==current.id) { previousIds=new Set(seen.keys()); seen.clear(); }
    lastRoute=current.id;
    for(let element of nodes){
      if(element.matches('[data-conversation-role]'))element=element.parentElement;
      const {id,role}=messageMeta(element);
      if(!id || !/^[A-Za-z0-9_-]{1,160}$/.test(id) || !['user','assistant'].includes(role) || ids.has(id) || previousIds.has(id))continue;
      // Incomplete generated replies are archived after generation ends.
      if(role==='assistant' && (element.closest('[data-is-streaming="true"]') || document.querySelector('[data-testid="stop-button"],[aria-label="Stop generating"],[aria-label="停止生成"]')))continue;
      const body=element.querySelector('.markdown,.whitespace-pre-wrap') ?? element;
      const content=serialize(body); if(!content.text)continue; ids.add(id);
      // Visible positions can change as old messages load; do not invent global chronology.
      const message={id,role,...content,ordinal:null};
      const value=JSON.stringify(message); if(seen.get(id)!==value){messages.push(message);seen.set(id,value);}
    }
    if(!messages.length){if(!ids.size&&receivedTreeRoute!==current.id)report('unrecognized-page');return;}
    lastState='';
    post({type:'capture',payload:{...current,title:document.title.replace(/\s*[-–]\s*ChatGPT\s*$/,'').slice(0,1000),
      kind:'page',identity,workspace,messages}});
  }
  function report(state){if(state!==lastState){lastState=state;post({type:'archive-state',state});}}
  function schedule(){clearTimeout(timer);timer=setTimeout(capturePage,1200);}
  new MutationObserver(schedule).observe(document,{subtree:true,childList:true,characterData:true});
  document.addEventListener('scroll',schedule,{passive:true,capture:true});
  window.addEventListener('message',event=>{
    if(event.source!==window || event.origin!==location.origin || event.data?.channel!==channel)return;
    if(event.data.type==='settings'){enabled=event.data.enabled===true;if(enabled){wasEnabled=true;bootstrapSession();schedule();}else{
      if(wasEnabled)bootstrapAllowed=false; // After a disabled interval, the initial document session may be stale.
      clearTimeout(timer);seen.clear();identity=null;workspace=undefined;personalAccount=null;lastState='';
    }}
    // Retry page fragments when durable local enqueue failed; never retry remote reads.
    if(event.data.type==='retry'){seen.clear();schedule();}
  });
  post({type:'ready'});
})();
