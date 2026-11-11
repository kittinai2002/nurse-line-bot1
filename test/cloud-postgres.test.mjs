import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
