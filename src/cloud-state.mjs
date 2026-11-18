import {openDb,transaction} from './db.mjs';
import {canQueueReminder,reminderWindows} from './domain.mjs';
const tables=['config','shifts','ui_state','pending','events','outbox'];
export function exportState(db){
 const snapshot={format:1,tables:{}};
 for(const table of tables)snapshot.tables[table]=db.prepare(`SELECT rowid AS __rowid,* FROM ${table} ORDER BY rowid`).all().map(r=>({...r}));
 if(Buffer.byteLength(JSON.stringify(snapshot))>2*1024*1024)throw Error('account_state_too_large');
 return snapshot;
}
export function restoreState(snapshot){
 const db=openDb();
 if(!snapshot)return db;
 try{
  if(snapshot.format!==1||!snapshot.tables)throw Error('invalid_state');
  transaction(db,()=>{for(const table of tables){
   const records=snapshot.tables[table];if(!Array.isArray(records))throw Error('invalid_state_table');
   const allowed=db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
   for(const record of records){
    if(!record||typeof record!=='object'||Object.keys(record).some(k=>k!=='__rowid'&&!allowed.includes(k)))throw Error('invalid_state_column');
    const cols=Object.keys(record).filter(k=>k!=='__rowid');
    if(record.__rowid!==undefined)cols.unshift('__rowid');
    const stmt=db.prepare(`INSERT INTO ${table} (${cols.map(k=>k==='__rowid'?'rowid':k).join(',')}) VALUES (${cols.map(()=>'?').join(',')})`);
    stmt.run(...cols.map(k=>record[k]));
   }
  }});return db;
 }catch(e){db.close();throw e;}
}
export function nextDue(bot){
 const now=bot.now(),c=bot.config(),candidates=[];
 const events=bot.db.prepare("SELECT received FROM events WHERE state IN ('new','reply_pending') AND received>? LIMIT 1").get(now-10*60000);
 if(events)candidates.push(now+15000);
 if(c.enabled&&c.confirmed){
  const jobs=bot.db.prepare('SELECT id,state,next_attempt,expires,accepted_at FROM outbox').all(),byId=new Map(jobs.map(j=>[j.id,j]));
  for(const job of jobs){
   if(job.state==='pending')candidates.push(Math.max(now,Math.min(job.next_attempt,job.expires)));
  }
  for(const reminder of reminderWindows(bot.rows(),c)){
   if(reminder.expires>now&&canQueueReminder(byId.get(reminder.key),reminder.expires)){
    candidates.push(Math.max(now,reminder.due));
   }
  }
 }
 return candidates.length?Math.min(...candidates):null;
}
