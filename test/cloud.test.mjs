import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {openDb} from '../src/db.mjs';
import {NurseBot} from '../src/bot.mjs';
import {CloudBot} from '../src/cloud-bot.mjs';
import {exportState,restoreState,nextDue} from '../src/cloud-state.mjs';
import {createVercelHandler} from '../src/vercel-handler.mjs';
import {LeaseLostError,AccountBusyError} from '../src/cloud-store.mjs';
const A='U'+'a'.repeat(32),B='U'+'b'.repeat(32),now=Date.parse('2026-11-10T07:00:00+07:00');
const env={LINE_OWNER_USER_ID:A,LINE_CHANNEL_SECRET:'a'.repeat(32),LINE_CHANNEL_ACCESS_TOKEN:'fake-access',DATABASE_URL:'postgresql://fake/test',CRON_SECRET:'test-cron-secret-'.repeat(3)};
class MemoryStore{
 constructor(){this.accounts=new Map();this.owner=null;this.commits=0;this.failAt=0;this.heartbeats=0;}
 async ensureOwner(id){if(this.owner&&this.owner!==id)throw Error('owner');this.owner=id;}
 async ping(){}
 async acquire(id,{create=false}={}){let r=this.accounts.get(id);if(!r){if(!create)return null;r={snapshot:null,revision:0,token:null,due:null};this.accounts.set(id,r);}if(r.token)throw new AccountBusyError();r.token=randomUUID();return {userId:id,token:r.token,snapshot:structuredClone(r.snapshot),revision:String(r.revision)};}
 async commit(lease,snapshot,due){if(++this.commits===this.failAt)throw Error('simulated_commit_failure');const r=this.accounts.get(lease.userId);if(r.token!==lease.token||String(r.revision)!==lease.revision)throw new LeaseLostError();r.snapshot=structuredClone(snapshot);r.due=due;r.revision++;lease.revision=String(r.revision);}
 async release(lease){const r=this.accounts.get(lease.userId);if(r.token===lease.token)r.token=null;}
 async due(limit){return [...this.accounts].filter(([,r])=>r.due!==null&&r.due<=now&&!r.token).slice(0,limit).map(([id])=>id);}
 async heartbeat(){this.heartbeats++;}
}
function seed(store,id,{enabled=true}={}){const db=openDb(),bot=new NurseBot(db,{}, {now:()=>now});bot.saveConfig({...bot.config(),enabled,confirmed:true});db.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run('2026-11-10','เช้า');store.accounts.set(id,{snapshot:exportState(db),revision:1,token:null,due:nextDue(bot)});db.close();}
const event=(id,text,uid=A)=>({type:'message',webhookEventId:id,timestamp:now,source:{type:'user',userId:uid},replyToken:'reply-'+id,message:{type:'text',text}});
test('cloud snapshot restores every table and delivery row order without local files',()=>{
 const db=openDb(),bot=new NurseBot(db,{}, {now:()=>now});bot.handle('ลงเวร');bot.ingest([event('draft','เมนู')]);
 db.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run('2026-11-10','หยุด');
 db.prepare('INSERT INTO outbox(id,retry_key,date,type,text,expires,next_attempt) VALUES(?,?,?,?,?,?,?)').run('out1','retry1','2026-11-10','เช้า','test',now+60000,now);
 const snapshot=exportState(db),copy=restoreState(JSON.parse(JSON.stringify(snapshot)));assert.deepEqual(exportState(copy),snapshot);db.close();copy.close();
 assert.throws(()=>restoreState({format:99,tables:{}}));assert.throws(()=>restoreState({format:1,tables:{config:[{id:1,sql_injection:'no'}]}}));
});
test('cloud persists commands before replying, deduplicates webhook and separates two people',async()=>{
 const store=new MemoryStore(),calls=[];let verified=false;
 const fetchFn=async(url,init)=>{const p=JSON.parse(init.body);calls.push(p);const saved=store.accounts.get(A)?.snapshot;if(p.replyToken==='reply-a'){assert.equal(JSON.parse(saved.tables.config[0].json).lead,30);assert.equal(saved.tables.events[0].state,'reply_pending');verified=true;}return new Response('{}');};
 let bot=new CloudBot(store,env,{now:()=>now,fetchFn});await bot.ingest([event('a','เตือนล่วงหน้า 30')]);await bot.ingest([event('b','เมนู',B)]);
 bot=new CloudBot(store,env,{now:()=>now,fetchFn});const count=calls.length;await bot.ingest([event('a','เตือนล่วงหน้า 30')]);assert.equal(calls.length,count);assert.ok(verified);
 assert.equal(JSON.parse(store.accounts.get(B).snapshot.tables.config[0].json).lead,60);
 await bot.ingest([{...event('group','เมนู'),source:{type:'group',userId:A}},{...event('old','เมนู'),timestamp:0}]);assert.equal(store.accounts.size,2);
});
test('cloud checkpoints stable push retry key across a crash after LINE accepted; duplicate cron is harmless',async()=>{
 const store=new MemoryStore();seed(store,A);const calls=[];
 const fetchFn=async(url,init)=>{const p=JSON.parse(init.body);calls.push({p,key:init.headers['X-Line-Retry-Key']});assert.equal(p.to,A);assert.equal(store.accounts.get(A).snapshot.tables.outbox[0].retry_key,init.headers['X-Line-Retry-Key']);return calls.length===1?new Response('{}'):new Response('{}',{status:409,headers:{'x-line-accepted-request-id':'accepted'}});};
 store.failAt=2;let bot=new CloudBot(store,env,{now:()=>now,fetchFn});await assert.rejects(()=>bot.account(A));
 assert.equal(store.accounts.get(A).snapshot.tables.outbox[0].state,'pending');
 store.failAt=0;bot=new CloudBot(store,env,{now:()=>now,fetchFn});await bot.cron();assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);
 assert.equal(store.accounts.get(A).snapshot.tables.outbox[0].state,'sent');await bot.cron();assert.equal(calls.length,2);
});
test('cloud pause prevents pushes, stale reminders expire, and failed account does not block another',async()=>{
 const store=new MemoryStore();seed(store,A,{enabled:false});seed(store,B);const calls=[];
 const bot=new CloudBot(store,env,{now:()=>now,fetchFn:async(url,init)=>{calls.push(JSON.parse(init.body));return new Response('{}');}});
 await bot.account(A);await bot.cron();assert.deepEqual(calls.map(p=>p.to),[B]);
 const late=new MemoryStore();seed(late,A);await new CloudBot(late,env,{now:()=>now+11*60000,fetchFn:async()=>{throw Error('should not send')}}).account(A);assert.equal(late.accounts.get(A).snapshot.tables.outbox.length,0);
 const partial=new MemoryStore();seed(partial,A);seed(partial,B);const acquire=partial.acquire.bind(partial);partial.acquire=async(id,opts)=>{if(id===A)throw Error('one-account-failure');return acquire(id,opts);};
 const result=await new CloudBot(partial,env,{now:()=>now,fetchFn:async()=>new Response('{}')}).cron();assert.deepEqual(result,{due:2,processed:1,failed:1,deferred:0,sent:1,expired:0,lineStatuses:{}});
});
test('Vercel webhook verifies exact bytes before DB access and cron requires a private header',async t=>{
 const store=new MemoryStore(),calls=[];let connections=0;const options={env,now:()=>now,storeFactory:async()=>{connections++;return store;},fetchFn:async(url,init)=>{calls.push(JSON.parse(init.body));return new Response('{}');}};
 const handlers={webhook:createVercelHandler('webhook',options),cron:createVercelHandler('cron',options),health:createVercelHandler('healthz',options)};
 const server=createServer((req,res)=>handlers[req.url.slice(1)]?.(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const origin='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(origin+'/cron')).status,401);assert.equal(connections,0);
 const raw=' {"events": '+JSON.stringify([event('http','เมนู')])+' } ',signature=createHmac('sha256',env.LINE_CHANNEL_SECRET).update(raw).digest('base64');
 assert.equal((await fetch(origin+'/webhook',{method:'POST',body:raw})).status,401);assert.equal(connections,0);
 assert.equal((await fetch(origin+'/webhook',{method:'POST',headers:{'x-line-signature':signature,'Content-Type':'application/json'},body:raw+' '})).status,401);
 assert.equal((await fetch(origin+'/webhook',{method:'POST',headers:{'x-line-signature':signature,'Content-Type':'application/json'},body:raw})).status,200);assert.equal(calls.length,1);
 assert.equal((await fetch(origin+'/cron',{headers:{Authorization:'Bearer '+env.CRON_SECRET}})).status,200);assert.equal(store.heartbeats,1);
 const health=await fetch(origin+'/health');assert.equal(health.status,200);assert.equal((await health.json()).mode,'vercel');
});


test('cloud records an expired prequeued reminder and can schedule it again at a later time',async()=>{
 const store=new MemoryStore();
 seed(store,A);
 let current=now-60000;
 let pushes=0;
 const bot=new CloudBot(store,env,{
  now:()=>current,
  fetchFn:async(url)=>{
   if(url.endsWith('/push'))pushes++;
   return new Response('{}');
  }
 });
 await bot.account(A);
 const queued=store.accounts.get(A).snapshot.tables.outbox[0];
 assert.equal(queued.state,'pending');
 assert.equal(queued.next_attempt,now);
 assert.equal(pushes,0);

 current=now+11*60000;
 assert.equal((await bot.account(A)).delivery.expired,1);
 assert.equal(pushes,0);
 await bot.ingest([{...event('change-lead','เตือนล่วงหน้า 30'),timestamp:current}]);
 const rescheduled=store.accounts.get(A).snapshot.tables.outbox[0];
 assert.equal(rescheduled.state,'pending');
 assert.equal(rescheduled.next_attempt,now+30*60000);
 current=now+30*60000;
 assert.equal((await bot.account(A)).delivery.sent,1);
 assert.equal(pushes,1);
});
