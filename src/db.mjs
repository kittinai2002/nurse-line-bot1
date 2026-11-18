import {DatabaseSync} from 'node:sqlite';
export function openDb(path=':memory:') {
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shifts (date TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY(date,type));
    CREATE TABLE IF NOT EXISTS ui_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, json TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, payload TEXT, received INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'new', response TEXT);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, retry_key TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, expires INTEGER NOT NULL, next_attempt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', last_status INTEGER, accepted_at INTEGER);
    CREATE INDEX IF NOT EXISTS outbox_due ON outbox(state,next_attempt);
  `);
  return db;
}
export function transaction(db,fn) {
  db.exec('BEGIN IMMEDIATE');
  try {const result=fn();db.exec('COMMIT');return result;}
  catch(e){db.exec('ROLLBACK');throw e;}
}
