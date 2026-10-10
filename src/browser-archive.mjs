import {canonical, snapshot} from './model.mjs';

export const browserArchiveEnabled = store => store.meta('browser_archive_enabled') !== '0';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);

export function initializeBrowserArchive(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS browser_archives(
    account TEXT,thread TEXT,title TEXT,url TEXT,project TEXT,revision INTEGER,updated TEXT,
    PRIMARY KEY(account,thread));
    CREATE TABLE IF NOT EXISTS browser_messages(
      account TEXT,thread TEXT,id TEXT,role TEXT,text TEXT,html TEXT,ordinal INTEGER,created TEXT,updated TEXT,
      PRIMARY KEY(account,thread,id));
    CREATE TABLE IF NOT EXISTS browser_snapshots(
      account TEXT,thread TEXT,revision INTEGER,raw TEXT,created TEXT,
      PRIMARY KEY(account,thread,revision));`);
}

export function readBrowserArchive(store, id, revision) {
  const archive = store.db.prepare('SELECT * FROM browser_archives WHERE account=? AND thread=?').get(store.account,id);
  if (!archive) return null;
  const row = store.db.prepare('SELECT raw,revision FROM browser_snapshots WHERE account=? AND thread=? AND revision=?')
    .get(store.account,id,revision ?? archive.revision);
  return row ? {coverage:'page-text',revision:row.revision,raw:JSON.parse(row.raw),updated:archive.updated} : null;
}

function validatePage(payload) {
  if (!validId(payload?.id) || typeof payload.url !== 'string') throw new Error('invalid-capture');
  let url;
  try { url = new URL(payload.url); } catch { throw new Error('invalid-capture'); }
  const route = /\/c\/([A-Za-z0-9_-]{1,160})\/?$/.exec(url.pathname);
  if (url.origin !== 'https://chatgpt.com' || route?.[1] !== payload.id || url.search || url.hash) throw new Error('invalid-capture');
  if (typeof payload.title !== 'string' || payload.title.length > 1000) throw new Error('invalid-capture');
  if (payload.project != null && (!validId(payload.project) || !payload.project.startsWith('g-p-'))) throw new Error('invalid-capture');
  if (!['page','tree'].includes(payload.kind)) throw new Error('invalid-capture');
  if (Buffer.byteLength(JSON.stringify(payload)) > 32*1024*1024) throw new Error('capture-too-large');
  if (payload.kind === 'tree') return;
  if (!Array.isArray(payload.messages) || !payload.messages.length || payload.messages.length > 500) throw new Error('invalid-capture');
  const ids = new Set();
  for (const message of payload.messages) {
    if (!validId(message.id) || ids.has(message.id) || !['user','assistant'].includes(message.role)
      || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 2*1024*1024
      || typeof message.html !== 'string' || message.html.length > 4*1024*1024
      || message.ordinal != null && (!Number.isSafeInteger(message.ordinal) || message.ordinal < 0)) throw new Error('invalid-capture');
    ids.add(message.id);
  }
}

function savePage(store, payload) {
  return store.transaction(() => {
    const old = store.db.prepare('SELECT * FROM browser_archives WHERE account=? AND thread=?').get(store.account,payload.id);
    const now = new Date().toISOString();
    let changed = 0;
    const revision = (old?.revision ?? 0) + 1;
    const event = store.db.prepare('INSERT INTO changes(account,thread,node,kind,revision,before_json,after_json,created) VALUES(?,?,?,?,?,?,?,?)');
    for (const message of payload.messages) {
      const before = store.db.prepare('SELECT * FROM browser_messages WHERE account=? AND thread=? AND id=?')
        .get(store.account,payload.id,message.id);
      if (before && before.role===message.role && before.text===message.text && before.html===message.html
        && (before.ordinal ?? null)===(message.ordinal ?? null)) continue;
      // Off-screen messages are retained; the visible page is never a deletion signal.
      store.db.prepare('INSERT OR REPLACE INTO browser_messages VALUES(?,?,?,?,?,?,?,?,?)')
        .run(store.account,payload.id,message.id,message.role,message.text,message.html,message.ordinal ?? null,before?.created ?? now,now);
      event.run(store.account,payload.id,'page:'+message.id,before?'modified':'added',revision,
        before?canonical({source:'browser-page',id:before.id,role:before.role,text:before.text}):null,
        canonical({source:'browser-page',...message}),now);
      changed++;
    }
    if (!changed && old?.title===payload.title && old?.project===(payload.project ?? null)) {
      store.meta('browser_capture_state','saved');return {changed:0,revision:old.revision};
    }
    const messages = store.db.prepare(`SELECT id,role,text,html,ordinal FROM browser_messages WHERE account=? AND thread=?
      ORDER BY ordinal IS NULL,ordinal,created,id`).all(store.account,payload.id);
    const raw = canonical({conversation_id:payload.id,title:payload.title,url:payload.url,project_id:payload.project ?? null,
      source:'browser-page',coverage:'page-text',order:messages.every(m=>m.ordinal!==null)?'page-position':'capture-order',messages});
    store.db.prepare('INSERT OR REPLACE INTO browser_archives VALUES(?,?,?,?,?,?,?)')
      .run(store.account,payload.id,payload.title,payload.url,payload.project ?? null,revision,now);
    store.db.prepare('INSERT INTO browser_snapshots VALUES(?,?,?,?,?)').run(store.account,payload.id,revision,raw,now);
    const thread = store.thread(payload.id);
    if (!thread) store.discover({id:payload.id,title:payload.title,updated:null,project:payload.project ?? null,scope:'browser'});
    else if (payload.title && thread.title!==payload.title) store.db.prepare('UPDATE threads SET title=? WHERE account=? AND id=?')
      .run(payload.title,store.account,payload.id);
    // Complete trees/native snapshots and their pending/timestamps are independent of page fragments.
    if (payload.project) {
      const current = store.thread(payload.id), summary = JSON.parse(current.summary ?? '{}');
      store.db.prepare('UPDATE threads SET summary=? WHERE account=? AND id=?')
        .run(canonical({...summary,project:payload.project}),store.account,payload.id);
    }
    store.meta('last_browser_capture',JSON.stringify({id:payload.id,title:payload.title,at:now,coverage:'page-text',changedMessages:changed,revision}));
    store.meta('browser_capture_state','saved');
    return {changed,revision};
  });
}

export function acceptBrowserCapture(store, payload, config) {
  if (!browserArchiveEnabled(store)) return {ok:false,state:'disabled'};
  try {
    validatePage(payload);
    if (typeof payload.identity!=='string' || !payload.identity) throw new Error('waiting-account');
    const bound = store.meta('source_identity');
    if (!bound) throw new Error('account-not-bound');
    if (bound!==payload.identity+':'+(config.workspace ?? 'personal')) throw new Error('account-mismatch');
    if (payload.workspace===undefined) throw new Error('waiting-account');
    if (payload.workspace!==config.workspace) throw new Error('workspace-mismatch');
    let result;
    if (payload.kind==='tree') {
      const snap = snapshot(payload.raw,payload.id);
      const thread = store.thread(payload.id);
      const latest = store.read(payload.id);
      // A late response from an older page load must not roll back newer complete content.
      if(thread?.coverage==='full-tree'&&Number.isSafeInteger(payload.requestedAt)&&thread.last_checked_at&&
        payload.requestedAt<Date.parse(thread.last_checked_at))return {ok:true,state:'older',changed:0};
      if (thread?.coverage==='full-tree' && snap.updated && latest?.raw?.update_time &&
        Date.parse(snap.updated)<Number(latest.raw.update_time)*1000) return {ok:true,state:'older',changed:0};
      result = store.save(snap,undefined,undefined,{browserCapture:true,browserProject:payload.project});
    } else result = savePage(store,payload);
    return {ok:true,state:'saved',...result};
  } catch (error) {
    const state = ['invalid-capture','capture-too-large','account-mismatch','workspace-mismatch','waiting-account','account-not-bound'].includes(error.message)?error.message:'save-failed';
    try{store.meta('browser_capture_state',state);}catch{/* The acknowledgement still reports a database failure. */}
    return {ok:false,state};
  }
}
