export function initializeModels(db){
  db.exec(`CREATE TABLE IF NOT EXISTS model_connections(account TEXT,id TEXT,name TEXT,kind TEXT,protocol TEXT,base_url TEXT,
    credential TEXT,status TEXT,catalog TEXT,checked_at TEXT,error TEXT,version INTEGER DEFAULT 1,PRIMARY KEY(account,id));
    CREATE TABLE IF NOT EXISTS model_index_settings(account TEXT PRIMARY KEY,connection TEXT,model TEXT,running INTEGER DEFAULT 0,
    daily_limit INTEGER DEFAULT 200,version INTEGER DEFAULT 1,error TEXT,completed INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS model_index_leases(account TEXT PRIMARY KEY,owner TEXT,expires INTEGER);
    CREATE TABLE IF NOT EXISTS model_index_usage(account TEXT,day TEXT,requests INTEGER DEFAULT 0,input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,PRIMARY KEY(account,day));
    CREATE TABLE IF NOT EXISTS model_client_sessions(account TEXT,connection TEXT,session TEXT,expires INTEGER,
    PRIMARY KEY(account,connection,session));`);
}
