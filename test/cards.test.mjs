import test from 'node:test';
import assert from 'node:assert/strict';
import {decorateMessage} from '../src/cards.mjs';
import {message,NurseBot} from '../src/bot.mjs';
import {openDb,transaction} from '../src/db.mjs';
import {DEFAULT_CONFIG,reminderText} from '../src/domain.mjs';
function texts(node){return [...(node.type==='text'?[node.text]:[]),...Object.values(node).flatMap(v=>Array.isArray(v)?v.flatMap(x=>x&&typeof x==='object'?texts(x):[]):v&&typeof v==='object'?texts(v):[])];}
test('cards preserve overnight date and shift times; no inaccurate live countdown',()=>{
 const c=DEFAULT_CONFIG();c.times.ดึก=['23:00','07:00'];
 const m=decorateMessage(message(reminderText({date:'2026-11-02',type:'ดึก'},c)));
 assert.equal(m.type,'flex');const t=texts(m.contents).join('\n');
 for(const value of ['วันที่เริ่ม 2/11/2569','23:00–07:00','จบวันถัดไป','เตือนล่วงหน้า 60 นาที'])assert.ok(t.includes(value));
 assert.ok(!t.includes('อีก 60 นาที'));
});
test('full month confirmation keeps all dates and exact action tokens, buttons only at end',()=>{
 const db=openDb();const bot=new NurseBot(db,{},{});
 const input='เพิ่มเวร 2026-12\n'+Array.from({length:31},(_,i)=>`${i+1} ช`).join('\n');
 const plain=transaction(db,()=>bot.handle(input)),m=decorateMessage(plain);
 assert.equal(m.contents.type,'carousel');const t=texts(m.contents).join('\n');
 for(let d=1;d<=31;d++)assert.ok(t.includes(`${d}/12/2569: เช้า`));
 const bubbles=m.contents.contents;assert.ok(bubbles.length<=12);
 assert.ok(bubbles.slice(0,-1).every(b=>!b.footer));
 assert.deepEqual(bubbles.at(-1).footer.contents.map(b=>b.action),plain.quickReply.items.map(i=>i.action));
 transaction(db,()=>bot.handle(bubbles.at(-1).footer.contents[0].action.text));assert.equal(bot.rows().length,31);
 assert.ok(Buffer.byteLength(JSON.stringify(m.contents))<50000);db.close();
});
test('copyable template stays text and transport sends decorated reply/push',async()=>{
 const db=openDb(),calls=[];const bot=new NurseBot(db,{LINE_CHANNEL_ACCESS_TOKEN:'fake'},{fetchFn:async(url,init)=>{calls.push(JSON.parse(init.body));return new Response('{}');}});
 const template=bot.handle('วางตาราง');assert.deepEqual(decorateMessage(template),template);
 for(const cmd of ['เมนู','ตั้งค่า','เวรวันนี้','เวรพรุ่งนี้','ตารางเวรของฉัน','สถานะ','ปิดแจ้งเตือน']){
  const plain=bot.handle(cmd);await bot.line('reply',{replyToken:'fake',messages:[plain]});
  const sent=calls.at(-1).messages[0];assert.equal(sent.type,'flex');assert.equal(sent.quickReply,undefined);const bubbles=sent.contents.type==='carousel'?sent.contents.contents:[sent.contents];if(plain.type==='flex')assert.deepEqual(sent,plain);else assert.deepEqual(bubbles.at(-1).footer.contents.map(b=>b.action),plain.quickReply.items.map(i=>i.action));assert.ok(sent.altText.length<=400);
 }
 await bot.line('push',{to:'fake',messages:[message('🔔 เตือนขึ้นเวรเช้า\nวันที่เริ่ม 1/11/2569\nเช้า 08:00–16:00')]},'same-retry-key');
 assert.equal(calls.at(-1).messages[0].type,'flex');db.close();
});
