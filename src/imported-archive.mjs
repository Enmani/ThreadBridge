import {canonical} from './model.mjs';

export const normalizeImportedText=text=>text.replace(/\r\n?/g,'\n').normalize('NFC').trim();
const supplemental=`NOT EXISTS(SELECT 1 FROM messages p WHERE p.account=m.account AND p.thread=m.thread AND p.role=m.role AND p.text=m.text)
  AND NOT EXISTS(SELECT 1 FROM browser_messages p WHERE p.account=m.account AND p.thread=m.thread AND p.role=m.role AND p.text=m.text)`;
export function additionalImportedMessages(store,id){
  return store.db.prepare(`SELECT COUNT(*) AS n FROM imported_messages m WHERE account=? AND thread=? AND ${supplemental}`).get(store.account,id).n;
}
export function initializeImportedArchive(db){
  db.exec(`CREATE TABLE IF NOT EXISTS imported_archives(
    account TEXT,thread TEXT,title TEXT,url TEXT,revision INTEGER,updated TEXT,PRIMARY KEY(account,thread));
    CREATE TABLE IF NOT EXISTS imported_messages(
    id INTEGER PRIMARY KEY,account TEXT,thread TEXT,role TEXT,text TEXT,source_time TEXT,model TEXT,created TEXT);
    CREATE INDEX IF NOT EXISTS imported_message_match ON imported_messages(account,thread,role,source_time);
    CREATE TABLE IF NOT EXISTS imported_snapshots(
    account TEXT,thread TEXT,revision INTEGER,raw TEXT,created TEXT,PRIMARY KEY(account,thread,revision));
    CREATE VIRTUAL TABLE IF NOT EXISTS import_search_index USING fts5(account UNINDEXED,thread UNINDEXED,node UNINDEXED,text,tokenize='trigram');`);
}

export function readImportedArchive(store,id,revision){
  const archive=store.db.prepare('SELECT * FROM imported_archives WHERE account=? AND thread=?').get(store.account,id);
  if(!archive)return null;
  const row=store.db.prepare('SELECT raw,revision FROM imported_snapshots WHERE account=? AND thread=? AND revision=?')
    .get(store.account,id,revision??archive.revision);
  return row?{coverage:'export-text',revision:row.revision,updated:archive.updated,raw:JSON.parse(row.raw)}:null;
}

export function saveImportedText(store,record){
  return store.transaction(()=>{
    const old=store.db.prepare('SELECT * FROM imported_archives WHERE account=? AND thread=?').get(store.account,record.id);
    const thread=store.thread(record.id),now=new Date().toISOString(),revision=(old?.revision??0)+1;
    let added=0,duplicates=0;
    // Exact role/text matches already held by a complete/native or browser archive need no second copy.
    // Match occurrences rather than a set, preserving repeated messages within an export.
    const known=new Map(),originalIds=new Set();
    const originals=[...store.db.prepare('SELECT message AS id,role,text FROM messages WHERE account=? AND thread=?').all(store.account,record.id),
      ...store.db.prepare('SELECT id,role,text FROM browser_messages WHERE account=? AND thread=?').all(store.account,record.id)];
    for(const message of originals){if(originalIds.has(message.id))continue;originalIds.add(message.id);
      const key=canonical([message.role,normalizeImportedText(message.text)]);known.set(key,(known.get(key)??0)+1);}
    const event=store.db.prepare('INSERT INTO changes(account,thread,node,kind,revision,before_json,after_json,created) VALUES(?,?,?,?,?,?,?,?)');
    for(const message of record.messages){
      const prior=store.db.prepare('SELECT id FROM imported_messages WHERE account=? AND thread=? AND role=? AND source_time=? AND text=?')
        .get(store.account,record.id,message.role,message.time,message.text);
      if(prior){duplicates++;continue;}
      const key=canonical([message.role,message.text]),count=known.get(key)??0;
      if(count){known.set(key,count-1);duplicates++;continue;}
      const insert=store.db.prepare('INSERT INTO imported_messages(account,thread,role,text,source_time,model,created) VALUES(?,?,?,?,?,?,?)')
        .run(store.account,record.id,message.role,message.text,message.time,message.model,now);
      const id='import-'+String(insert.lastInsertRowid),node='import:'+id;
      store.db.prepare('INSERT INTO import_search_index VALUES(?,?,?,?)').run(store.account,record.id,node,message.text);
      event.run(store.account,record.id,node,'added',revision,null,canonical({source:'json-import',id,idSource:'local-import',...message}),now);added++;
    }
    if(!thread)store.discover({id:record.id,title:record.title,updated:null,project:record.project,scope:'import'});
    if(added){
      const messages=store.db.prepare('SELECT id,role,text,source_time AS time,model FROM imported_messages WHERE account=? AND thread=? ORDER BY id')
        .all(store.account,record.id).map(m=>({...m,id:'import-'+m.id,idSource:'local-import'}));
      const title=thread?.title||record.title,raw=canonical({conversation_id:record.id,title,url:record.url,source:'json-import',coverage:'export-text',timeZone:null,messages});
      store.db.prepare('INSERT OR REPLACE INTO imported_archives VALUES(?,?,?,?,?,?)').run(store.account,record.id,title,record.url,revision,now);
      store.db.prepare('INSERT INTO imported_snapshots VALUES(?,?,?,?,?)').run(store.account,record.id,revision,raw,now);
    }
    return {added,duplicates,coverage:'export-text'};
  });
}

export function searchImportedText(store,query,escaped,limit){
  if(limit<=0)return [];
  const rows=[...query].length>=3?store.db.prepare(`SELECT m.thread,'import:import-'||m.id AS node,m.role,m.text,'export-text' AS coverage
    FROM import_search_index s JOIN imported_messages m ON m.account=s.account AND m.thread=s.thread AND s.node='import:import-'||m.id
    WHERE import_search_index MATCH ? AND s.account=? AND ${supplemental} LIMIT ?`).all('"'+query.replaceAll('"','""')+'"',store.account,limit):
    store.db.prepare(`SELECT thread,'import:import-'||id AS node,role,text,'export-text' AS coverage FROM imported_messages m
    WHERE account=? AND text LIKE ? ESCAPE '\\' AND ${supplemental} LIMIT ?`).all(store.account,`%${escaped}%`,limit);
  return rows;
}
