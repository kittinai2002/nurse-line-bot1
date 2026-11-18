import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb,transaction} from '../src/db.mjs';
import {NurseBot,verifySignature} from '../src/bot.mjs';
import {createApp} from '../src/server.mjs';
import {parseSchedule,DEFAULT_CONFIG,shiftRange,remindersDue,assertNoOverlap,bangkokDate,nextMonth} from '../src/domain.mjs';

const owner='U'+'a'.repeat(32);
function fixture(now=Date.parse('2026-11-01T07:00:00+07:00'),fetchFn=async()=>new Response('{}',{status:200})){
  const db=openDb();const clock={value:now};const env={LINE_OWNER_USER_ID:owner,LINE_CHANNEL_SECRET:'test-secret',LINE_CHANNEL_ACCESS_TOKEN:'fake-test-token'};
  const bot=new NurseBot(db,env,{now:()=>clock.value,fetchFn});
  const command=text=>transaction(db,()=>bot.handle(text));return {db,clock,bot,env,command};
}
test('Thai year, multi shifts, explicit day off and invalid days',()=>{
  const rows=parseSchedule('เพิ่มเวร 2569-11\n1 ช บ\n2 ด\n3 ห');
  assert.deepEqual(rows[0],{date:'2026-11-01',types:['เช้า','บ่าย']});assert.deepEqual(rows[2].types,[]);
  for(const text of ['เพิ่มเวร 2026-02\n30 ช','เพิ่มเวร 2026-11\n1 ช\n1 บ','เพิ่มเวร 2026-11\n1 ช ห','เพิ่มเวร 2026-11\n1 X','เพิ่มเวร 2026-11\n1 ช ช'])assert.throws(()=>parseSchedule(text));
});
test('midnight shifts are dated by start; Bangkok year rollover',()=>{
  const c=DEFAULT_CONFIG();const night=shiftRange('2026-11-02','ดึก',c);const evening=shiftRange('2026-11-01','บ่าย',c);
  assert.equal(new Date(night.start).toISOString(),'2026-11-01T17:00:00.000Z');assert.equal(evening.end,night.start);
  assert.equal(bangkokDate(Date.parse('2026-12-31T18:00:00Z')),'2027-01-01');
  assert.equal(nextMonth(Date.parse('2026-12-15T00:00:00Z')),'2027-01');
});
test('overlaps across dates rejected while adjacent shifts allowed',()=>{
  const c=DEFAULT_CONFIG();const rows=[{date:'2026-11-01',type:'บ่าย'},{date:'2026-11-02',type:'ดึก'}];
  assert.doesNotThrow(()=>assertNoOverlap(rows,c));c.times.บ่าย=['16:00','01:00'];assert.throws(()=>assertNoOverlap(rows,c));
});
test('due window, disabled state and stale notifications',()=>{
  const c=DEFAULT_CONFIG();const r=[{date:'2026-11-01',type:'เช้า'}];const now=Date.parse('2026-11-01T07:00:00+07:00');
  assert.equal(remindersDue(r,c,now).length,0);c.enabled=c.confirmed=true;
  assert.equal(remindersDue(r,c,now-1).length,0);assert.equal(remindersDue(r,c,now).length,1);
  assert.equal(remindersDue(r,c,now+10*60000).length,0);
});
test('schedule preview, confirmation and partial replacement are atomic',()=>{
  const {command,bot,db}=fixture();command('ยืนยันเวลาเวร');const preview=command('เพิ่มเวร 2026-11\n1 ช\n2 บ');
  assert.equal(bot.rows().length,0);command(preview.quickReply.items[0].action.text);assert.equal(bot.rows().length,2);
  const update=command('เพิ่มเวร 2026-11\n1 ห');command(update.quickReply.items[0].action.text);
  assert.deepEqual(bot.rows().map(r=>[r.date,r.type]),[['2026-11-01','หยุด'],['2026-11-02','บ่าย']]);
  command(update.quickReply.items[0].action.text);assert.equal(bot.rows().length,2);db.close();
});
test('settings remain off until explicit confirmation; changing hours pauses alerts',()=>{
  const {command,bot,db}=fixture();assert.equal(bot.config().enabled,false);assert.ok(command('เปิดแจ้งเตือน').quickReply.items.some(i=>i.action.text==='ตั้งเวลาเวร'));
  command('ยืนยันเวลาเวร');const p=command('เพิ่มเวร 2026-11\n1 ช');command(p.quickReply.items[0].action.text);command('เปิดแจ้งเตือน');assert.equal(bot.config().enabled,true);
  command('ตั้งเวลา เช้า 07:00 15:00');assert.equal(bot.config().enabled,false);assert.equal(bot.config().confirmed,false);db.close();
});
test('signature validation binds exact raw bytes and rejects forged requests',()=>{
  const raw=Buffer.from('{"events":[]}');const sig=createHmac('sha256','key').update(raw).digest('base64');
  assert.equal(verifySignature(raw,sig,'key'),true);assert.equal(verifySignature(Buffer.from('{ "events":[]}'),sig,'key'),false);
  assert.equal(verifySignature(raw,'bad','key'),false);assert.equal(verifySignature(raw,undefined,'key'),false);
});
test('duplicate webhook commands execute once; strangers and groups ignored',async()=>{
  let calls=0;const {bot,db,clock}=fixture(undefined,async()=>{calls++;return new Response('{}',{status:200});});
  const event={webhookEventId:'e1',timestamp:clock.value,type:'message',source:{type:'user',userId:owner},message:{type:'text',text:'เพิ่มเวร 2026-11\n1 ช'},replyToken:'reply'};
  bot.ingest([event,event,{...event,webhookEventId:'e2',source:{type:'group',userId:owner}},{...event,webhookEventId:'e3',source:{type:'user',userId:'other'}}]);
  await bot.tick();bot.ingest([event]);await bot.tick();assert.equal(calls,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pending').get().n,1);db.close();
});
test('retry key survives timeout; LINE 409 accepted is not sent again',async()=>{
  const requests=[];const {bot,command,db,clock}=fixture(undefined,async(url,options)=>{
    requests.push(options.headers['X-Line-Retry-Key']);if(requests.length===1)throw Error('timeout after acceptance');
    return new Response('{}',{status:409,headers:{'x-line-accepted-request-id':'accepted'}});
  });
  command('ยืนยันเวลาเวร');const p=command('เพิ่มเวร 2026-11\n1 ช');command(p.quickReply.items[0].action.text);command('เปิดแจ้งเตือน');
  await bot.tick();clock.value+=31000;await bot.tick();clock.value+=31000;await bot.tick();
  assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);assert.equal(db.prepare('SELECT state FROM outbox').get().state,'sent');
  const p2=command('เพิ่มเวร 2026-11\n1 ช');command(p2.quickReply.items[0].action.text);await bot.tick();assert.equal(requests.length,2);db.close();
});
test('429 retries; pause cancels unsent reminders; resume reuses retry key',async()=>{
  const keys=[];const {bot,command,db}=fixture(undefined,async(url,options)=>{keys.push(options.headers['X-Line-Retry-Key']);return new Response('{}',{status:keys.length===1?429:200});});
  command('ยืนยันเวลาเวร');const p=command('เพิ่มเวร 2026-11\n1 ช');command(p.quickReply.items[0].action.text);command('เปิดแจ้งเตือน');await bot.tick();
  command('ปิดแจ้งเตือน');await bot.tick();assert.equal(keys.length,1);command('เปิดแจ้งเตือน');await bot.tick();assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);db.close();
});
test('HTTP webhook verification works and unsigned callers are rejected',async()=>{
  const {bot,env,db}=fixture();const app=createApp(bot,env);await new Promise(r=>app.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(origin+'/healthz')).status,200);
    const body=JSON.stringify({events:[]});assert.equal((await fetch(origin+'/webhook',{method:'POST',body})).status,401);
    const sig=createHmac('sha256',env.LINE_CHANNEL_SECRET).update(body).digest('base64');
    assert.equal((await fetch(origin+'/webhook',{method:'POST',body,headers:{'x-line-signature':sig}})).status,200);
  }finally{await new Promise(r=>app.close(r));db.close();}
});
test('restart preserves schedule and ambiguous delivery retry key',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'nurse-bot-test-'));const path=join(directory,'db.sqlite');
  const now=Date.parse('2026-11-01T07:00:00+07:00');
  const env={LINE_OWNER_USER_ID:owner,LINE_CHANNEL_SECRET:'test',LINE_CHANNEL_ACCESS_TOKEN:'fake'};
  let db=openDb(path);let bot=new NurseBot(db,env,{now:()=>now,fetchFn:async()=>{throw Error('network');}});
  transaction(db,()=>{bot.handle('ยืนยันเวลาเวร');const preview=bot.handle('เพิ่มเวร 2026-11\n1 ช');bot.handle(preview.quickReply.items[0].action.text);bot.handle('เปิดแจ้งเตือน');});
  await bot.tick();const key=db.prepare('SELECT retry_key FROM outbox').get().retry_key;db.close();
  db=openDb(path);let resumedKey;
  bot=new NurseBot(db,env,{now:()=>now+31000,fetchFn:async(url,options)=>{resumedKey=options.headers['X-Line-Retry-Key'];return new Response('{}',{status:200});}});
  try{assert.equal(bot.rows().length,1);assert.equal(bot.config().enabled,true);await bot.tick();assert.equal(resumedKey,key);assert.equal(db.prepare('SELECT state FROM outbox').get().state,'sent');}
  finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
