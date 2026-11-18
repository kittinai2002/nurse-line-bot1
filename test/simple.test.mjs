import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb,transaction} from '../src/db.mjs';
import {NurseBot} from '../src/bot.mjs';
import {createApp} from '../src/server.mjs';
import {decorateMessage} from '../src/cards.mjs';
const now=Date.parse('2026-11-01T12:00:00+07:00');
function fixture(){const db=openDb(),bot=new NurseBot(db,{LIFF_ID:'1234567890-ignored'}, {now:()=>now});const cmd=t=>transaction(db,()=>bot.handle(t));const tap=(m,label)=>{const a=m.quickReply.items.find(i=>i.action.label===label)?.action;assert.ok(a,label);return transaction(db,()=>a.type==='message'?bot.handle(a.text):bot.handlePostback({data:a.data}));};return{db,bot,cmd,tap};}
test('main menu is three choices and never opens a website, including old web command',async()=>{
 const {db,bot,cmd}=fixture();for(const text of ['เมนู','เว็บ']){const m=cmd(text);assert.deepEqual(m.quickReply.items.map(i=>i.action.label),['เวรวันนี้','ตารางของฉัน','ตั้งค่า']);assert.ok(m.quickReply.items.every(i=>i.action.type==='message'));}
 const server=createApp(bot,{});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{for(const path of ['/app/','/api/web/state'])assert.equal((await fetch('http://127.0.0.1:'+server.address().port+path)).status,404);}finally{await new Promise(r=>server.close(r));db.close();}
});
test('tap calendar date preselects existing shifts, keeps one card and saves only on Save',()=>{
 const {db,bot,cmd,tap}=fixture();db.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run('2026-11-02','เช้า');
 let m=cmd('ลงเวร 2026-11-02');assert.ok(m.quickReply.items.some(i=>i.action.label==='✓ เช้า'));
 m=tap(m,'บ่าย');const card=decorateMessage(m);assert.equal(card.contents.type,'bubble');assert.equal(card.quickReply,undefined);assert.equal(bot.rows().length,1);
 const actions=[];function walk(n){if(n.action)actions.push(n.action);for(const c of n.contents||[])walk(c);for(const key of ['header','body','footer'])if(n[key])walk(n[key]);}walk(card.contents);
 assert.equal(actions.filter(a=>/:shift:/.test(a.data||'')).length,4);
 const saved=tap(m,'บันทึกเวร');assert.equal(saved.type,'flex');assert.equal(bot.rows().length,2);assert.match(JSON.stringify(saved),/บันทึกเวรแล้ว/);db.close();
});
test('delete needs confirmation, preserves other dates, and replay cannot delete again',()=>{
 const {db,bot,cmd,tap}=fixture();for(const date of ['2026-11-02','2026-11-03'])db.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run(date,'หยุด');
 let m=cmd('ลงเวร 2026-11-02');m=tap(m,'ลบเวรวันที่เลือก');assert.equal(bot.rows().length,2);cmd('ยกเลิกขั้นตอน');assert.equal(bot.rows().length,2);
 m=tap(cmd('ลงเวร 2026-11-02'),'ลบเวรวันที่เลือก');tap(m,'ยืนยันลบเวร');assert.deepEqual(bot.rows().map(r=>r.date),['2026-11-03']);
 assert.match(tap(m,'ยืนยันลบเวร').text,/เก่าหรือหมดอายุ/);assert.equal(bot.rows().length,1);db.close();
});
