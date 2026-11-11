import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {openDb,transaction} from '../src/db.mjs';
import {NurseBot} from '../src/bot.mjs';
import {MultiUserBot} from '../src/multi-user.mjs';
import {createApp} from '../src/server.mjs';
import {decorateMessage} from '../src/cards.mjs';
const now=Date.parse('2026-12-31T23:30:00+07:00');
function fixture(){const db=openDb();const bot=new NurseBot(db,{}, {now:()=>now});const cmd=t=>transaction(db,()=>bot.handle(t));const tap=(m,label,params={})=>{const a=m.quickReply.items.find(i=>i.action.label===label)?.action;assert.ok(a,label);return transaction(db,()=>a.type==='message'?bot.handle(a.text):bot.handlePostback({data:a.data,params}));};return {db,bot,cmd,tap};}
test('guided date picker and multi-shift selection only commit on explicit Save',()=>{
 const {db,bot,cmd,tap}=fixture();let m=cmd('ลงเวร');const old=m;
 m=tap(m,'เลือกวันที่',{date:'2027-01-01'});m=tap(m,'เช้า');m=tap(m,'บ่าย');
 assert.equal(bot.rows().length,0);tap(m,'บันทึกเวร');assert.deepEqual(bot.rows().map(r=>r.type).sort(),['เช้า','บ่าย'].sort());
 const stale=tap(old,'พรุ่งนี้');assert.match(stale.text,/เก่าหรือหมดอายุ/);assert.equal(bot.rows().length,2);db.close();
});
test('batch dates validate month boundaries and replace only selected days after confirmation',()=>{
 const {db,bot,cmd,tap}=fixture();cmd('ลงหลายวัน 2027-02');assert.match(cmd('29').text,/ไม่ถูกต้อง/);assert.equal(bot.rows().length,0);
 let m=cmd('1 3 5-7');m=tap(m,'ดึก');m=tap(m,'หยุด');assert.match(m.text,/หยุด/);tap(m,'บันทึกเวร');
 assert.equal(bot.rows().length,5);assert.ok(bot.rows().every(r=>r.type==='หยุด'));
 m=cmd('ลงเวร');m=tap(m,'เลือกวันที่',{date:'2027-02-03'});m=tap(m,'เช้า');tap(m,'บันทึกเวร');
 assert.equal(bot.rows().length,5);assert.equal(bot.rows().find(r=>r.date==='2027-02-03').type,'เช้า');db.close();
});
test('time picker drafts allow editing a whole set before overlap validation; cancel leaves config intact',()=>{
 const {db,bot,cmd,tap}=fixture();const original=bot.config();let m=cmd('ตั้งเวลาเวร');m=tap(m,'แก้เวรเช้า');m=tap(m,'เลือกเวลาเริ่ม',{time:'07:00'});m=tap(m,'เลือกเวลาเลิก',{time:'15:00'});
 assert.deepEqual(bot.config(),original);cmd('ยกเลิกขั้นตอน');assert.deepEqual(bot.config(),original);
 db.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run('2027-01-01','เช้า');db.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run('2027-01-01','บ่าย');
 m=cmd('ตั้งเวลาเวร');m=tap(m,'แก้เวรเช้า');m=tap(m,'เลือกเวลาเริ่ม',{time:'09:00'});m=tap(m,'เลือกเวลาเลิก',{time:'17:00'});
 assert.throws(()=>tap(m,'ใช้เวลาชุดนี้'),/ทับซ้อน/);assert.deepEqual(bot.config(),original);
 m=tap(m,'แก้เวรบ่าย');m=tap(m,'เลือกเวลาเริ่ม',{time:'17:00'});m=tap(m,'เลือกเวลาเลิก',{time:'01:00'});tap(m,'ใช้เวลาชุดนี้');
 assert.deepEqual(bot.config().times.เช้า,['09:00','17:00']);assert.deepEqual(bot.config().times.บ่าย,['17:00','01:00']);assert.equal(bot.config().confirmed,true);assert.equal(bot.config().enabled,false);db.close();
});
test('typed fallbacks support Thai dates and simple time notation; explicit menu cancels draft',()=>{
 const {db,bot,cmd,tap}=fixture();cmd('ลงเวร');let m=cmd('1/1/2570');assert.match(m.text,/1\/1\/2570/);cmd('เมนู');assert.match(tap(m,'เช้า').text,/เก่าหรือหมดอายุ/);
 m=cmd('ตั้งเวลาเวร');m=tap(m,'แก้เวรดึก');m=cmd('23.00');m=cmd('7:00');tap(m,'ใช้เวลาชุดนี้');assert.deepEqual(bot.config().times.ดึก,['23:00','07:00']);db.close();
});
test('signed postbacks survive restart, stay private, reject replay and use only one action surface',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nurse-flow-'));const A='U'+'a'.repeat(32),B='U'+'b'.repeat(32);const env={LINE_OWNER_USER_ID:A,LINE_CHANNEL_SECRET:'secret',LINE_CHANNEL_ACCESS_TOKEN:'fake'};const calls=[];
 const options={now:()=>now,fetchFn:async(url,init)=>{calls.push(JSON.parse(init.body));return new Response('{}');}};
 let manager=new MultiUserBot(dir,env,options);let m=transaction(manager.forUser(A).db,()=>manager.forUser(A).handle('ลงเวร'));const dateAction=m.quickReply.items[0].action;manager.close();manager=new MultiUserBot(dir,env,options);
 const server=createApp(manager,env);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/webhook`;
 const event=(user,id)=>({type:'postback',webhookEventId:id,timestamp:now,source:{type:'user',userId:user},replyToken:id,postback:{data:dateAction.data,params:{date:'2027-01-01'}}});
 const send=async(e,signed=true)=>{const raw=JSON.stringify({events:[e]});return fetch(url,{method:'POST',headers:signed?{'x-line-signature':createHmac('sha256',env.LINE_CHANNEL_SECRET).update(raw).digest('base64')}:{},body:raw});};
 try{
  assert.equal((await send(event(A,'unsigned'),false)).status,401);
  assert.equal((await send(event(B,'b'))).status,200);await manager.tick();
  assert.match(JSON.stringify(calls.at(-1)),/เก่าหรือหมดอายุ/);
  assert.equal((await send(event(A,'a'))).status,200);await manager.tick();
  const result=calls.at(-1).messages[0];assert.equal(result.quickReply,undefined);assert.equal(result.type,'flex');assert.match(result.altText,/1\/1\/2570/);
  const count=calls.length;await send(event(A,'a'));await manager.tick();assert.equal(calls.length,count);
  assert.equal(manager.forUser(A).rows().length,0);assert.equal(manager.forUser(B).rows().length,0);
 }finally{await new Promise(r=>server.close(r));manager.close();rmSync(dir,{recursive:true,force:true});}
});
test('draft expiry, wrong step, invalid picker inputs and old confirmations never silently mutate schedules',()=>{
 const {db,bot,cmd,tap}=fixture();let m=cmd('ลงเวร');assert.match(tap(m,'เลือกวันที่',{date:'2027-02-30'}).text,/ไม่ถูกต้อง/);
 m=tap(m,'พรุ่งนี้');const old=m;m=tap(m,'เช้า');assert.match(tap(old,'บ่าย').text,/เก่าหรือหมดอายุ/);assert.equal(bot.rows().length,0);
 db.prepare('UPDATE ui_state SET expires=0').run();assert.match(tap(m,'บันทึกเวร').text,/เก่าหรือหมดอายุ/);assert.equal(bot.rows().length,0);
 m=cmd('ตั้งเวลาเวร');m=tap(m,'แก้เวรเช้า');assert.match(tap(m,'เลือกเวลาเริ่ม',{time:'99:99'}).text,/ไม่ถูกต้อง/);
 assert.equal(bot.config().confirmed,false);db.close();
});
