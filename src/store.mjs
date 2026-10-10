import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {canonical} from './model.mjs';
import {accountKey,providerId} from './providers.mjs';
import {threadOrder} from './thread-order.mjs';
import {migrateThreads} from './store-migrations.mjs';
import {initializeBrowserArchive,readBrowserArchive} from './browser-archive.mjs';
import {initializeImportedArchive,readImportedArchive,searchImportedText,additionalImportedMessages} from './imported-archive.mjs';
import {initializeChatIndex} from './chat-index-schema.mjs';
import {initializeModels} from './model-schema.mjs';

export class Store {
  transactionState={depth:0};
  ownsDatabase=true;
  get transactionDepth(){return this.transactionState.depth;}
  set transactionDepth(value){this.transactionState.depth=value;}
  constructor(file, account, provider='chatgpt') {
    if (!account || typeof account !== 'string') throw new Error('An explicit account namespace is required');
    if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
    this.file=file===':memory:'?file:path.resolve(file);
    this.provider=providerId(provider);this.accountName=account;this.account=accountKey(provider,account);
    this.db = new DatabaseSync(file,{timeout:5000});
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(account TEXT, key TEXT, value TEXT, PRIMARY KEY(account,key));
      CREATE TABLE IF NOT EXISTS threads(account TEXT,id TEXT,title TEXT,summary TEXT,source_updated TEXT,synced_updated TEXT,
        pending INTEGER DEFAULT 1,coverage TEXT DEFAULT 'not-read',revision INTEGER DEFAULT 0,error TEXT,
        PRIMARY KEY(account,id));
      CREATE TABLE IF NOT EXISTS snapshots(account TEXT,thread TEXT,revision INTEGER,raw TEXT,coverage TEXT,created TEXT,
        PRIMARY KEY(account,thread,revision));
      CREATE TABLE IF NOT EXISTS messages(account TEXT,thread TEXT,node TEXT,message TEXT,role TEXT,text TEXT,json TEXT,
        PRIMARY KEY(account,thread,node));
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,account TEXT,thread TEXT,node TEXT,
        kind TEXT,revision INTEGER,before_json TEXT,after_json TEXT,created TEXT);
      CREATE INDEX IF NOT EXISTS changes_consumer ON changes(account,seq);
      CREATE TABLE IF NOT EXISTS consumers(account TEXT,name TEXT,ack INTEGER DEFAULT 0,offered INTEGER DEFAULT 0,
        PRIMARY KEY(account,name));
      CREATE TABLE IF NOT EXISTS leases(account TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(account UNINDEXED,thread UNINDEXED,node UNINDEXED,text,tokenize='trigram');`);
    migrateThreads(this.db);
    initializeBrowserArchive(this.db);
    initializeImportedArchive(this.db);
    initializeChatIndex(this.db);
    initializeModels(this.db);
  }
  close() { if(this.ownsDatabase)this.db.close(); }
  scope(provider){const view=Object.create(this);view.provider=providerId(provider);view.account=accountKey(provider,this.accountName);view.ownsDatabase=false;return view;}
  transaction(fn) {
    const outer=this.transactionDepth===0,savepoint='nested_'+this.transactionDepth;
    this.db.exec(outer?'BEGIN IMMEDIATE':'SAVEPOINT '+savepoint);this.transactionDepth++;
    try { const value=fn(); this.db.exec(outer?'COMMIT':'RELEASE '+savepoint); return value; }
    catch(e) { this.db.exec(outer?'ROLLBACK':'ROLLBACK TO '+savepoint);if(!outer)this.db.exec('RELEASE '+savepoint);throw e; }
    finally { this.transactionDepth--; }
  }
  meta(key, value) {
    if (value === undefined) return this.db.prepare('SELECT value FROM meta WHERE account=? AND key=?').get(this.account,key)?.value ?? null;
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?,?)').run(this.account,key,String(value));
  }
  discover(item, refresh=false) {
    const old=this.thread(item.id), json=canonical(item);
    const pending = refresh || !old || (this.provider==='chatgpt'?old.coverage !== 'full-tree':old.revision===0)
      || (!item.updated&&!item.assistantUpdated&&(!old.last_checked_at||Date.now()-Date.parse(old.last_checked_at)>=86400000))
      || (item.updated!=null&&old.synced_updated!==item.updated) || (item.assistantUpdated!=null&&old.synced_assistant!==item.assistantUpdated);
    this.db.prepare(`INSERT INTO threads(account,id,title,summary,source_updated,source_assistant,pending) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(account,id) DO UPDATE SET title=excluded.title,summary=excluded.summary,source_updated=excluded.source_updated,
      source_assistant=excluded.source_assistant,pending=CASE WHEN excluded.pending=1 THEN 1 ELSE threads.pending END`)
      .run(this.account,item.id,item.title,json,item.updated,item.assistantUpdated ?? null,Number(pending));
  }
  thread(id) { return this.db.prepare('SELECT * FROM threads WHERE account=? AND id=?').get(this.account,id); }
  pending(limit=100000) { return this.db.prepare(`SELECT * FROM threads WHERE account=? AND pending=1
    ORDER BY MAX(COALESCE(source_updated,''),COALESCE(source_assistant,'')) DESC,id LIMIT ?`).all(this.account,limit); }
  nativePending(limit=5){
    return this.db.prepare(`SELECT * FROM threads WHERE account=? AND coverage!='full-tree' AND
      (revision=0 OR error IS NOT NULL OR (source_updated IS NOT NULL AND source_updated IS NOT synced_updated)
       OR (source_assistant IS NOT NULL AND source_assistant IS NOT synced_assistant)
       OR (source_updated IS NULL AND source_assistant IS NULL AND COALESCE(last_checked_at,'')<?))
      ORDER BY MAX(COALESCE(source_updated,''),COALESCE(source_assistant,'')) DESC,id LIMIT ?`)
      .all(this.account,new Date(Date.now()-86400000).toISOString(),limit);
  }
  audit(before,limit=1){
    const items=this.db.prepare(`SELECT id FROM threads WHERE account=? AND revision>0 AND (coverage='full-tree' OR ?!='chatgpt') AND pending=0
      AND COALESCE(last_checked_at,'')<? ORDER BY last_checked_at,id LIMIT ?`).all(this.account,this.provider,before,limit);
    for(const item of items)this.db.prepare('UPDATE threads SET pending=1 WHERE account=? AND id=?').run(this.account,item.id);return items.length;
  }
  projectIds() { return [...new Set([...JSON.parse(this.meta('projects') ?? '[]'),...this.db.prepare('SELECT summary FROM threads WHERE account=?').all(this.account)
    .map(r=>JSON.parse(r.summary ?? '{}').project)].filter(p=>typeof p==='string' && p.startsWith('g-p-')))]; }
  rememberProject(id,name){
    if(typeof id!=='string'||(this.provider==='chatgpt'?!id.startsWith('g-p-'):!/^[A-Za-z0-9_-]{1,160}$/.test(id))||typeof name!=='string'||!name.trim())return;
    const names=JSON.parse(this.meta('project_names') ?? '{}'),value=name.trim().slice(0,500);
    if(names[id]===value)return;names[id]=value;this.meta('project_names',JSON.stringify(names));
  }
  fail(id,error) { this.db.prepare('UPDATE threads SET error=?,pending=1 WHERE account=? AND id=?').run(error,this.account,id); }
  save(snap, observedUpdate, observedAssistant, {browserCapture=false,browserProject=null}={}) {
    return this.transaction(()=>{
      const recordCapture=value=>{
        this.meta('last_capture',JSON.stringify(value));
        if(browserCapture){this.meta('last_browser_capture',JSON.stringify(value));this.meta('browser_capture_state','saved');}
        if(browserProject){const thread=this.thread(snap.id),summary=JSON.parse(thread.summary ?? '{}');
          this.db.prepare('UPDATE threads SET summary=? WHERE account=? AND id=?').run(canonical({...summary,project:browserProject}),this.account,snap.id);}
      };
      let thread=this.thread(snap.id);
      if (!thread) { this.discover({id:snap.id,title:snap.title,updated:snap.updated,project:null,scope:'import'}); thread=this.thread(snap.id); }
      // A bounded native read never replaces a full snapshot or generates false removals.
      if (thread.coverage==='full-tree' && snap.coverage!=='full-tree') throw new Error('Cannot replace a full tree with a bounded read');
      const previous=this.db.prepare('SELECT raw FROM snapshots WHERE account=? AND thread=? AND revision=?').get(this.account,snap.id,thread.revision);
      const revision=thread.revision + (previous?.raw===snap.raw ? 0 : 1);
      if (revision===thread.revision) {
        const savedAt=new Date().toISOString();
        this.db.prepare('UPDATE threads SET pending=0,error=NULL,synced_updated=?,synced_assistant=?,last_message_id=?,last_assistant_id=?,last_checked_at=? WHERE account=? AND id=?')
          .run(observedUpdate ?? snap.updated,observedAssistant ?? snap.assistantUpdated ?? null,snap.lastMessageId ?? null,snap.lastAssistantId ?? null,savedAt,this.account,snap.id);
        recordCapture({id:snap.id,title:snap.title,at:savedAt,coverage:snap.coverage,revision,changedMessages:0});
        return {changed:0,revision};
      }
      const oldRows=this.db.prepare('SELECT * FROM messages WHERE account=? AND thread=?').all(this.account,snap.id);
      const old=new Map(oldRows.map(r=>[r.node,r])); const now=new Date().toISOString(); let changed=0;
      const event=this.db.prepare('INSERT INTO changes(account,thread,node,kind,revision,before_json,after_json,created) VALUES(?,?,?,?,?,?,?,?)');
      for (const msg of snap.messages) {
        const before=old.get(msg.nodeId); old.delete(msg.nodeId);
        if (before?.json===msg.json) continue;
        event.run(this.account,snap.id,msg.nodeId,before?'modified':'added',revision,before?.json ?? null,msg.json,now); changed++;
        this.db.prepare('INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?,?,?)').run(this.account,snap.id,msg.nodeId,msg.messageId,msg.role,msg.text,msg.json);
        this.db.prepare('DELETE FROM search_index WHERE account=? AND thread=? AND node=?').run(this.account,snap.id,msg.nodeId);
        this.db.prepare('INSERT INTO search_index(account,thread,node,text) VALUES(?,?,?,?)').run(this.account,snap.id,msg.nodeId,msg.text);
      }
      if (snap.coverage==='full-tree') for (const [node,before] of old) {
        event.run(this.account,snap.id,node,'removed',revision,before.json,null,now); changed++;
        this.db.prepare('DELETE FROM messages WHERE account=? AND thread=? AND node=?').run(this.account,snap.id,node);
        this.db.prepare('DELETE FROM search_index WHERE account=? AND thread=? AND node=?').run(this.account,snap.id,node);
      }
      if (!changed) event.run(this.account,snap.id,null,'thread_modified',revision,null,null,now);
      this.db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?)').run(this.account,snap.id,revision,snap.raw,snap.coverage,now);
      this.db.prepare(`UPDATE threads SET title=?,revision=?,coverage=?,synced_updated=?,synced_assistant=?,last_message_id=?,last_assistant_id=?,last_checked_at=?,pending=0,error=NULL WHERE account=? AND id=?`)
        .run(snap.title,revision,snap.coverage,observedUpdate ?? snap.updated,observedAssistant ?? snap.assistantUpdated ?? null,
          snap.lastMessageId ?? null,snap.lastAssistantId ?? null,now,this.account,snap.id);
      recordCapture({id:snap.id,title:snap.title,at:now,coverage:snap.coverage,revision,changedMessages:changed});
      return {changed,revision};
    });
  }
  changes(consumer,limit=100) {
    if (!consumer) throw new Error('Consumer name required');
    limit=Math.max(1,Math.min(500,Number(limit)));
    return this.transaction(()=>{
      this.db.prepare('INSERT OR IGNORE INTO consumers(account,name) VALUES(?,?)').run(this.account,consumer);
      const state=this.db.prepare('SELECT * FROM consumers WHERE account=? AND name=?').get(this.account,consumer);
      const items=this.db.prepare('SELECT * FROM changes WHERE account=? AND seq>? ORDER BY seq LIMIT ?').all(this.account,state.ack,limit);
      const through=items.at(-1)?.seq ?? state.ack;
      this.db.prepare('UPDATE consumers SET offered=MAX(offered,?) WHERE account=? AND name=?').run(through,this.account,consumer);
      return {consumer,after:state.ack,through,items};
    });
  }
  ack(consumer,through) {
    const state=this.db.prepare('SELECT * FROM consumers WHERE account=? AND name=?').get(this.account,consumer);
    if (!state || !Number.isSafeInteger(through) || through<state.ack || through>state.offered) throw new Error('Invalid acknowledgement position');
    this.db.prepare('UPDATE consumers SET ack=? WHERE account=? AND name=?').run(through,this.account,consumer);
    return {consumer,through};
  }
  read(id,revision) {
    const thread=this.thread(id); if (!thread) return null;
    const row=this.db.prepare('SELECT raw,coverage,revision FROM snapshots WHERE account=? AND thread=? AND revision=?')
      .get(this.account,id,revision ?? thread.revision);
    const browserArchive=revision===undefined?readBrowserArchive(this,id):null;
    const importedArchive=revision===undefined?readImportedArchive(this,id):null;
    const extras={...(browserArchive?{browserArchive}:{}),...(importedArchive?{importedArchive}:{})};
    return row?{...row,raw:JSON.parse(row.raw),...extras}:importedArchive?{...importedArchive,...(browserArchive?{browserArchive}:{})}:browserArchive;
  }
  search(query,limit=20) {
    if (typeof query!=='string' || !query.trim()) throw new Error('Search text required');
    const bounded=Math.max(1,Math.min(100,Number(limit))),escaped=query.replace(/[\\%_]/g,'\\$&');
    const primary=[...query].length>=3 ? this.db.prepare(`SELECT m.thread,m.node,m.role,m.text FROM search_index s
      JOIN messages m ON m.account=s.account AND m.thread=s.thread AND m.node=s.node
      WHERE search_index MATCH ? AND s.account=? LIMIT ?`).all('"'+query.replaceAll('"','""')+'"',this.account,bounded)
      : this.db.prepare(`SELECT thread,node,role,text FROM messages WHERE account=? AND text LIKE ? ESCAPE '\\' LIMIT ?`)
        .all(this.account,`%${escaped}%`,bounded);
    const pages=this.db.prepare(`SELECT thread,'page:'||id AS node,role,text,'page-text' AS coverage FROM browser_messages b
      WHERE account=? AND text LIKE ? ESCAPE '\\' AND NOT EXISTS
      (SELECT 1 FROM messages m WHERE m.account=b.account AND m.thread=b.thread AND m.message=b.id AND m.text=b.text) LIMIT ?`)
      .all(this.account,`%${escaped}%`,bounded-primary.length);
    return [...primary,...pages,...searchImportedText(this,query,escaped,bounded-primary.length-pages.length)];
  }
  status() {
    const scan=JSON.parse(this.meta('directory_scan') ?? 'null');
    return {account:this.accountName,provider:this.provider,...this.db.prepare(`SELECT COUNT(*) AS threads,COALESCE(SUM(coverage='full-tree'),0) AS fullTrees,
      COALESCE(SUM(pending),0) AS pending,COALESCE(SUM(error IS NOT NULL),0) AS errors FROM threads WHERE account=?`).get(this.account),
      messages:this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account=?').get(this.account).n,
      lastCapture:JSON.parse(this.meta('last_capture') ?? 'null'),lastRequest:JSON.parse(this.meta('last_request') ?? 'null'),
      browserArchives:this.db.prepare('SELECT COUNT(*) AS n FROM browser_archives WHERE account=?').get(this.account).n,
      importedArchives:this.db.prepare('SELECT COUNT(*) AS n FROM imported_archives WHERE account=?').get(this.account).n,
      lastJsonImport:JSON.parse(this.meta('last_json_import')??'null'),
      lastBrowserCapture:JSON.parse(this.meta('last_browser_capture') ?? 'null'),browserCaptureState:this.meta('browser_capture_state'),
      lastScan:this.meta('watermark'),discovery:JSON.parse(this.meta('discovery') ?? 'null'),
      activeScan:scan?{started:scan.started,full:scan.full,pendingScopes:scan.jobs.filter(j=>!j.done).length,
        scopes:scan.jobs.map(j=>({scope:j.scope,done:j.done,pages:j.pages,nextOffset:j.kind==='chats'?j.offset:null,
          nextCursor:j.kind==='chats'?null:j.cursor,cutoff:j.cutoff,lastUpdated:j.lastUpdated ?? null,
          ordered:j.kind==='chats'?j.ordered:null,stopReason:j.stopReason ?? null}))}:null,
      background:this.meta('worker_state')?{state:this.meta('worker_state'),nextRunAt:Number(this.meta('next_run_at') ?? 0),
        heartbeatAt:Number(this.meta('worker_heartbeat_at') ?? 0),nextRequestAt:Number(this.meta('next_request_at') ?? 0),
        paceMs:Number(this.meta('effective_pace_ms') ?? 0),lastRun:JSON.parse(this.meta('last_run') ?? 'null')}:null};
  }
  listThreads({query='',page=1,limit=50,sort='source_updated',order='desc'}={}){
    if(typeof query!=='string'||query.length>200||!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error('Invalid thread list parameters');
    const term='%'+query.replace(/[\\%_]/g,'\\$&')+'%',where="account=? AND (title LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')",params=[this.account,term,term];
    const total=this.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE '+where).get(...params).n;
    const rows=this.db.prepare(`SELECT t.id,t.title,t.coverage,t.revision,t.pending,t.error,t.source_updated,t.source_assistant,t.last_checked_at,t.summary,
      (SELECT COUNT(*) FROM messages m WHERE m.account=t.account AND m.thread=t.id) AS messages FROM threads t WHERE ${where}
      ORDER BY ${threadOrder(sort,order)} LIMIT ? OFFSET ?`).all(...params,limit,(page-1)*limit);
    return {total,page,limit,pages:Math.max(1,Math.ceil(total/limit)),items:this.threadViews(rows)};
  }
  threadViews(rows){
    const names=JSON.parse(this.meta('project_names') ?? '{}');
    return rows.map(({summary,...row})=>{
      const entry=JSON.parse(summary ?? '{}'),projectId=typeof entry.project==='string'&&(this.provider!=='chatgpt'||entry.project.startsWith('g-p-'))?entry.project:null;
      const page=this.db.prepare('SELECT updated,revision FROM browser_archives WHERE account=? AND thread=?').get(this.account,row.id);
      const pageMessages=page?this.db.prepare('SELECT COUNT(*) AS n FROM browser_messages WHERE account=? AND thread=?').get(this.account,row.id).n:0;
      const imported=this.db.prepare('SELECT updated,revision FROM imported_archives WHERE account=? AND thread=?').get(this.account,row.id);
      const importedMessages=imported?this.db.prepare('SELECT COUNT(*) AS n FROM imported_messages WHERE account=? AND thread=?').get(this.account,row.id).n:0;
      return {...row,browserArchive:page?{...page,messages:pageMessages}:null,importedArchive:imported?{...imported,messages:importedMessages,additionalMessages:additionalImportedMessages(this,row.id)}:null,
        scope:entry.scope ?? null,projectId,projectName:projectId?names[projectId] ?? null:null};
    });
  }
  acquire(owner,ttl=120000) {
    return this.transaction(()=>{
      const lease=this.db.prepare('SELECT * FROM leases WHERE account=?').get(this.account);
      if (lease && lease.expires>Date.now() && lease.owner!==owner) throw new Error('Another sync is already running');
      this.db.prepare('INSERT OR REPLACE INTO leases VALUES(?,?,?)').run(this.account,owner,Date.now()+ttl);
    });
  }
  release(owner) { this.db.prepare('DELETE FROM leases WHERE account=? AND owner=?').run(this.account,owner); }
}
