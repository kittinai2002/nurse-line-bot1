import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarModel,calendarMessage} from '../src/calendar.mjs';
import {NurseBot} from '../src/bot.mjs';
import {openDb,transaction} from '../src/db.mjs';
const now=Date.parse('2026-12-31T23:30:00+07:00');
function actions(n){return [...(n.action?[n.action]:[]),...Object.values(n).flatMap(v=>Array.isArray(v)?v.flatMap(x=>x&&typeof x==='object'?actions(x):[]):v&&typeof v==='object'?actions(v):[])];}
function texts(n){return [...(n.type==='text'?[n.text]:[]),...Object.values(n).flatMap(v=>Array.isArray(v)?v.flatMap(x=>x&&typeof x==='object'?texts(x):[]):v&&typeof v==='object'?texts(v):[])];}
test('calendar aligns weekdays, renders leap years and six-week months without dropping dates',()=>{
 for(const [month,count,offset] of [['2024-02',29,3],['2026-02',28,6],['2026-08',31,5],['2026-11',30,6]]){
  const m=calendarModel(month,[],now);assert.equal(m.cells.length%7,0);assert.equal(m.cells.findIndex(Boolean),offset);
  assert.deepEqual(m.cells.filter(Boolean).map(c=>c.day),Array.from({length:count},(_,i)=>i+1));
  if(month==='2026-08')assert.equal(m.cells.length,42);
 }
 const m=calendarModel('2569-12',[],now);assert.equal(m.label,'ธันวาคม 2569');assert.equal(m.next,'2027-01');assert.equal(m.previous,'2026-11');assert.equal(m.cells.filter(c=>c?.today)[0].day,31);
 assert.equal(calendarModel('2020-01',[]).previous,null);assert.equal(calendarModel('2100-12',[]).next,null);
});
test('full calendar retains multiple shifts, distinguishes off from missing and fits LINE bubble limit',()=>{
 const rows=Array.from({length:31},(_,i)=>['เช้า','บ่าย','ดึก'].map(type=>({date:'2026-08-'+String(i+1).padStart(2,'0'),type}))).flat();
 rows.splice(0,3,{date:'2026-08-01',type:'หยุด'});rows.splice(1,3);
 const m=calendarMessage('2026-08',rows,now),t=texts(m.contents).join('\n');
 assert.equal(m.contents.type,'bubble');assert.ok(t.includes('ช บ ด'));assert.ok(t.includes('ห'));assert.ok(t.includes('·'));
 const days=actions(m.contents).filter(a=>a.text?.startsWith('ลงเวร '));assert.equal(days.length,31);assert.equal(new Set(days.map(a=>a.text)).size,31);
 assert.ok(Buffer.byteLength(JSON.stringify(m.contents))<30000);assert.equal(m.quickReply,undefined);
});
test('month navigation and date tap show own schedule; editing preselects date without writing',()=>{
 const db=openDb(),otherDb=openDb(),bot=new NurseBot(db,{}, {now:()=>now}),other=new NurseBot(otherDb,{}, {now:()=>now});
 db.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run('2027-01-01','ดึก');
 let m=bot.handle('ตารางเวร 2026-12');const next=actions(m.contents).find(a=>a.label==='เดือนถัดไป ›');m=bot.handle(next.text);assert.match(m.altText,/มกราคม 2570/);
 const day=actions(m.contents).find(a=>a.text==='ลงเวร 2027-01-01');const pick=transaction(db,()=>bot.handle(day.text));assert.match(pick.text,/ดึก 00:00–08:00/);assert.equal(bot.rows().length,1);
 assert.match(other.handle(day.text).text,/ยังไม่ได้เลือกเวร/);
 assert.ok(pick.quickReply.items.some(i=>i.action.label==='✓ ดึก'));
 assert.match(bot.handle('เวรวันที่ 2027-02-30').text,/ไม่ถูกต้อง/);assert.equal(bot.rows().length,1);
 assert.match(bot.handle('รายการเวร 2027-01').text,/1: ดึก/);db.close();otherDb.close();
});
