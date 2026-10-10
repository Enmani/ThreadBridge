// Additive migration preserves existing accounts, snapshots and consumer cursors.
export function migrateThreads(db){
  const fields=['source_assistant','synced_assistant','last_message_id','last_assistant_id','last_checked_at'];
  const present=new Set(db.prepare('PRAGMA table_info(threads)').all().map(c=>c.name));
  db.exec('BEGIN IMMEDIATE');
  try{for(const field of fields)if(!present.has(field))db.exec(`ALTER TABLE threads ADD COLUMN ${field} TEXT`);
    if(!present.has('last_checked_at'))db.exec(`UPDATE threads SET last_checked_at=(SELECT created FROM snapshots
      WHERE snapshots.account=threads.account AND snapshots.thread=threads.id AND snapshots.revision=threads.revision)`);
    db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
}
