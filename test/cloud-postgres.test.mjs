import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createVercelHandler} from '../src/vercel-handler.mjs';
import {openDb} from '../src/db.mjs';
import {NurseBot} from '../src/bot.mjs';
import {exportState,nextDue} from '../src/cloud-state.mjs';
import {PGlite} from '@electric-sql/pglite';
import {CloudStore,AccountBusyError,LeaseLostError} from '../src/cloud-store.mjs';
let db,store;const A='U'+'a'.repeat(32),B='U'+'b'.repeat(32);
before(async()=>{db=new PGlite();await db.exec(readFileSync(new URL('../schema/vercel.sql',import.meta.url),'utf8'));store=new CloudStore(async(sql,params)=>(await db.query(sql,params)).rows);});
after(async()=>await db.close());
test('PostgreSQL leases allow only one worker and fence expired workers and stale revisions',async()=>{
 await store.ensureOwner(A);await assert.rejects(()=>store.ensureOwner(B));
 const results=await Promise.allSettled([store.acquire(A,{create:true}),store.acquire(A,{create:true})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const first=results.find(r=>r.status==='fulfilled').value;assert.ok(results.find(r=>r.status==='rejected').reason instanceof AccountBusyError);
 await store.commit(first,{format:1,tables:{}},Date.now()-1000);
 const stale={...first,revision:'0'};await assert.rejects(()=>store.commit(stale,{bad:true},null),LeaseLostError);
 await db.query("UPDATE nurse_cloud_accounts SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=$1",[A]);
 const next=await store.acquire(A);assert.notEqual(first.token,next.token);
 await assert.rejects(()=>store.commit(first,{bad:true},null),LeaseLostError);await store.release(first);
 await assert.rejects(()=>store.acquire(A),AccountBusyError);await store.commit(next,{format:1,tables:{good:true}},Date.now()-1000);await store.release(next);
 assert.deepEqual(await store.due(),[A]);assert.equal((await db.query('SELECT snapshot FROM nurse_cloud_accounts WHERE user_id=$1',[A])).rows[0].snapshot.tables.good,true);
});
test('PostgreSQL no-account reads do not register people; scheduling and release persist correctly',async()=>{
 assert.equal(await store.acquire(B),null);const lease=await store.acquire(B,{create:true});await store.commit(lease,{format:1,tables:{}},Date.now()+86400000);await store.release(lease);
 assert.ok(!(await store.due()).includes(B));await store.heartbeat();await store.ping();
 assert.ok((await db.query("SELECT value FROM nurse_meta WHERE key='last_cron'")).rows[0].value);
});
test('migration pauses alerts, preserves retry/history and never overwrites existing online data',async()=>{
 const {openDb}=await import('../src/db.mjs'),{NurseBot}=await import('../src/bot.mjs'),{exportState,restoreState}=await import('../src/cloud-state.mjs'),{importSnapshot}=await import('../src/cloud-migration.mjs');
 const source=openDb(),bot=new NurseBot(source,{}),C='U'+'c'.repeat(32);bot.saveConfig({...bot.config(),confirmed:true,enabled:true,lead:30});source.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run('2026-12-01','เช้า');
 source.prepare('INSERT INTO outbox(id,retry_key,date,type,text,expires,next_attempt,state,accepted_at) VALUES(?,?,?,?,?,?,?,?,?)').run('old','same-key','2026-12-01','เช้า','old text',100,90,'sent',95);
 bot.handle('ลงเวร');const snapshot=exportState(source),before=JSON.stringify(snapshot);
 assert.deepEqual(await importSnapshot(store,C,snapshot),{imported:true});assert.equal(JSON.stringify(snapshot),before);
 let lease=await store.acquire(C);const restored=restoreState(lease.snapshot),online=new NurseBot(restored,{});assert.equal(online.config().enabled,false);assert.equal(online.config().lead,30);assert.equal(online.rows().length,1);assert.equal(restored.prepare('SELECT retry_key FROM outbox').get().retry_key,'same-key');assert.equal(restored.prepare('SELECT 1 FROM ui_state').get(),undefined);
 online.saveConfig({...online.config(),lead:90});await store.commit(lease,exportState(restored),null);restored.close();await store.release(lease);
 assert.deepEqual(await importSnapshot(store,C,snapshot),{skipped:true});lease=await store.acquire(C);assert.equal(JSON.parse(lease.snapshot.tables.config[0].json).lead,90);await store.release(lease);source.close();
});


test('authenticated cron sends due Postgres reminders, exposes LINE failures and retries safely',async t=>{
 const database=new PGlite();
 t.after(()=>database.close());
 await database.exec(readFileSync(new URL('../schema/vercel.sql',import.meta.url),'utf8'));
 const store=new CloudStore(async(sql,params)=>(await database.query(sql,params)).rows);
 const env={
  LINE_OWNER_USER_ID:A,LINE_CHANNEL_SECRET:'a'.repeat(32),LINE_CHANNEL_ACCESS_TOKEN:'fake-access',
  DATABASE_URL:'postgresql://fake/test',CRON_SECRET:'local-cron-secret-'.repeat(2)
 };
 const local=openDb();
 let current=Date.parse('2020-01-01T07:00:00+07:00');
 const bot=new NurseBot(local,env,{now:()=>current});
 bot.saveConfig({...bot.config(),enabled:true,confirmed:true});
 local.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run('2020-01-01','เช้า');
 const lease=await store.acquire(A,{create:true});
 await store.commit(lease,exportState(local),nextDue(bot));
 await store.release(lease);
 local.close();

 const keys=[];
 const handler=createVercelHandler('cron',{
  env,now:()=>current,storeFactory:async()=>store,
  fetchFn:async(url,init)=>{
   assert.match(url,/\/push$/);
   assert.equal(JSON.parse(init.body).to,A);
   keys.push(init.headers['X-Line-Retry-Key']);
   return new Response('{}',{status:keys.length===1?429:200});
  }
 });
 const server=createServer(handler);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port;
 const run=()=>fetch(origin,{headers:{Authorization:'Bearer '+env.CRON_SECRET}});

 const rejected=await run();
 assert.equal(rejected.status,502);
 assert.deepEqual((await rejected.json()).lineStatuses,{'429':1});
 current+=60000;
 const delivered=await run();
 assert.equal(delivered.status,200);
 assert.equal((await delivered.json()).sent,1);
 assert.ok(keys[0]);
 assert.deepEqual(keys,[keys[0],keys[0]]);
 const empty=await run();
 assert.equal((await empty.json()).due,0);
 assert.equal(keys.length,2);
});
