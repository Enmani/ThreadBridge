export function initializeChatIndex(db){
  db.exec(`CREATE TABLE IF NOT EXISTS chat_index_dirty(account TEXT,thread TEXT,error TEXT,PRIMARY KEY(account,thread));
    CREATE TABLE IF NOT EXISTS chat_index_chunks(account TEXT,thread TEXT,id TEXT,ordinal INTEGER,text TEXT,reference TEXT,
      PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS chat_index_nodes(account TEXT,id TEXT,thread TEXT,title TEXT,left_id TEXT,right_id TEXT,
      count INTEGER,height INTEGER,generation INTEGER,basis TEXT,summary TEXT,kind TEXT,PRIMARY KEY(account,id));
    CREATE INDEX IF NOT EXISTS chat_index_thread ON chat_index_nodes(account,thread);
    CREATE INDEX IF NOT EXISTS chat_index_kind ON chat_index_nodes(account,kind);
    CREATE INDEX IF NOT EXISTS chat_index_parent_left ON chat_index_nodes(account,left_id);
    CREATE INDEX IF NOT EXISTS chat_index_parent_right ON chat_index_nodes(account,right_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_index_search USING fts5(account UNINDEXED,id UNINDEXED,title,text,tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS chat_index_titles AFTER UPDATE OF title,summary ON threads
    WHEN (OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary) AND
      EXISTS(SELECT 1 FROM chat_index_nodes WHERE account=NEW.account AND thread=NEW.id)
    BEGIN INSERT OR REPLACE INTO chat_index_dirty VALUES(NEW.account,NEW.id,NULL); END;`);
  for(const table of ['snapshots','browser_snapshots','imported_snapshots']){
    db.exec(`CREATE TRIGGER IF NOT EXISTS chat_index_${table} AFTER INSERT ON ${table}
      BEGIN INSERT OR REPLACE INTO chat_index_dirty VALUES(NEW.account,NEW.thread,NULL); END;
      INSERT OR IGNORE INTO chat_index_dirty(account,thread)
      SELECT DISTINCT account,thread FROM ${table} s WHERE NOT EXISTS
        (SELECT 1 FROM chat_index_nodes n WHERE n.account=s.account AND n.thread=s.thread AND n.kind='thread');`);
  }
}
