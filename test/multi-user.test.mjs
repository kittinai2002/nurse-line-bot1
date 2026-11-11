import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHmac} from 'node:crypto';
import {MultiUserBot} from '../src/multi-user.mjs';
import {NurseBot} from '../src/bot.mjs';
import {openDb,transaction} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';

const A='U'+'a'.repeat(32),B='U'+'b'.repeat(32),C='U'+'c'.repeat(32);
const env={LINE_OWNER_USER_ID:A,LINE_CHANNEL_SECRET:'test-secret',LINE_CHANNEL_ACCESS_TOKEN:'fake-token'};
const baseTime=Date.parse('2026-11-01T07:00:00+07:00');
const command=(bot,text)=>transaction(bot.db,()=>bot.handle(text));
function add(bot,text='เพิ่มเวร 2026-11\n1 ช') {
  const preview=command(bot,text);command(bot,preview.quickReply.items[0].action.text);
}
function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'nurse-multi-'));
  const clock={value:baseTime},requests=[];
  const options={now:()=>clock.value,fetchFn:async(url,init)=>{requests.push({url,body:JSON.parse(init.body),key:init.headers['X-Line-Retry-Key']});return new Response('{}',{status:200});}};
  const manager=new MultiUserBot(directory,env,options);
  let count=0;
  const event=(userId,text,type='message')=>({webhookEventId:`event-${++count}`,timestamp:clock.value,type,source:{type:'user',userId},replyToken:`reply-${count}`,message:{type:'text',text}});
  return {directory,clock,requests,options,manager,event,dispose:()=>{manager.close();rmSync(directory,{recursive:true,force:true});}};
}

test('two LINE users have separate schedules, settings, previews and history',async()=>{
  const f=fixture();const {manager,event,requests}=f;
  try {
    manager.ingest([event(B,'เมนู')]);await manager.tick();
    assert.equal(manager.db.prepare('SELECT COUNT(*) n FROM accounts').get().n,2);
    const a=manager.forUser(A),b=manager.forUser(B);
    manager.ingest([event(A,'เพิ่มเวร 2026-11\n1 ช')]);await manager.tick();
    const confirm=requests.at(-1).body.messages[0].contents.footer.contents[0].action.text;
    manager.ingest([event(B,confirm),event(B,confirm.replace('ยืนยัน','ยกเลิก'))]);await manager.tick();
    assert.equal(a.db.prepare('SELECT COUNT(*) n FROM pending').get().n,1);
    assert.deepEqual(b.rows(),[]);
    manager.ingest([event(A,confirm)]);await manager.tick();
    assert.equal(a.rows()[0].type,'เช้า');assert.deepEqual(b.rows(),[]);
    manager.ingest([event(B,'ตั้งเวลา เช้า 07:00 15:00'),event(B,'เตือนล่วงหน้า 30')]);await manager.tick();
    assert.equal(a.config().lead,60);assert.equal(b.config().lead,30);
    assert.deepEqual(a.config().times.เช้า,['08:00','16:00']);
    assert.deepEqual(b.config().times.เช้า,['07:00','15:00']);
    add(b,'เพิ่มเวร 2026-11\n1 บ');
    assert.equal(a.rows()[0].type,'เช้า');assert.equal(b.rows()[0].type,'บ่าย');
    assert.equal(a.config().enabled,false);assert.equal(b.config().enabled,false);
    a.db.prepare("INSERT INTO outbox(id,retry_key,date,type,text,expires,next_attempt,state) VALUES('a','key','2026-11-01','เช้า','private',0,0,'sent')").run();
    assert.match(command(b,'สถานะ').text,/ยังไม่มีประวัติส่ง/);
  }finally{f.dispose();}
});

test('each reminder reaches its own user; restart reloads all accounts and does not resend',async()=>{
  const f=fixture();let manager=f.manager;
  try {
    for(const userId of [A,B]) {
      const bot=manager.forUser(userId);command(bot,'ยืนยันเวลาเวร');add(bot);command(bot,'เปิดแจ้งเตือน');
    }
    // Restart before the due tick: B must be scheduled without sending a new message.
    manager.close();manager=new MultiUserBot(f.directory,env,f.options);
    await manager.tick();
    const pushes=f.requests.filter(r=>r.url.endsWith('/push'));
    assert.deepEqual(pushes.map(r=>r.body.to).sort(),[A,B].sort());
    assert.equal(new Set(pushes.map(r=>r.key)).size,2);
    manager.close();manager=new MultiUserBot(f.directory,env,f.options);
    await manager.tick();assert.equal(f.requests.filter(r=>r.url.endsWith('/push')).length,2);
  }finally{manager.close();rmSync(f.directory,{recursive:true,force:true});}
});

test('blocking and re-adding OA pauses only that user, retaining both schedules',async()=>{
  const f=fixture();const {manager,event}=f;
  try {
    for(const userId of [A,B]) {
      const bot=manager.forUser(userId);command(bot,'ยืนยันเวลาเวร');add(bot);command(bot,'เปิดแจ้งเตือน');bot.enqueueReminders();
    }
    manager.ingest([event(A,'','unfollow')]);await manager.tick();
    assert.equal(manager.forUser(A).config().enabled,false);
    assert.equal(manager.forUser(B).config().enabled,true);
    assert.deepEqual(f.requests.filter(r=>r.url.endsWith('/push')).map(r=>r.body.to),[B]);
    manager.ingest([event(A,'','follow')]);await manager.tick();
    assert.equal(manager.forUser(A).config().enabled,false);
    for(const id of [A,B])assert.equal(manager.forUser(id).rows().length,1);
  }finally{f.dispose();}
});

test('legacy owner data and delivery history stay private; changing owner cannot reassign data',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'nurse-upgrade-'));
  const options={now:()=>baseTime,fetchFn:async()=>new Response('{}',{status:200})};
  let manager;
  try {
    const db=openDb(join(directory,'nurse-bot.sqlite'));const legacy=new NurseBot(db,env,options);
    command(legacy,'ยืนยันเวลาเวร');add(legacy);command(legacy,'เปิดแจ้งเตือน');await legacy.tick();
    const key=db.prepare('SELECT retry_key FROM outbox').get().retry_key;db.close();
    manager=new MultiUserBot(directory,env,options);
    const owner=manager.forUser(A),other=manager.forUser(B);
    assert.equal(owner.rows().length,1);assert.equal(owner.config().enabled,true);
    assert.equal(owner.db.prepare('SELECT retry_key FROM outbox').get().retry_key,key);
    assert.equal(owner.db.prepare('SELECT state FROM outbox').get().state,'sent');
    assert.deepEqual(other.rows(),[]);assert.equal(other.config().enabled,false);
    assert.equal(other.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,0);
    manager.close();manager=null;
    assert.throws(()=>new MultiUserBot(directory,{...env,LINE_OWNER_USER_ID:B},options),/Original owner changed/);
    manager=new MultiUserBot(directory,env,options);assert.equal(manager.forUser(A).rows().length,1);
  }finally{manager?.close();rmSync(directory,{recursive:true,force:true});}
});

test('unsigned requests cannot enroll users; valid direct messages enroll, groups and malformed IDs do not',async()=>{
  const f=fixture(),app=createApp(f.manager,env);
  await new Promise(r=>app.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${app.address().port}/webhook`;
  try {
    const body=JSON.stringify({events:[f.event(B,'เมนู')]});
    assert.equal((await fetch(url,{method:'POST',body})).status,401);
    assert.equal(f.manager.db.prepare('SELECT COUNT(*) n FROM accounts').get().n,1);
    const group={...f.event(C,'เมนู'),source:{type:'group',userId:C,groupId:'group'}};
    const invalid=f.event('../../bad','เมนู');
    const signedBody=JSON.stringify({events:[f.event(B,'เมนู'),group,invalid,null]});
    const signature=createHmac('sha256',env.LINE_CHANNEL_SECRET).update(signedBody).digest('base64');
    assert.equal((await fetch(url,{method:'POST',body:signedBody,headers:{'x-line-signature':signature}})).status,200);
    assert.deepEqual(f.manager.db.prepare('SELECT user_id FROM accounts ORDER BY user_id').all().map(r=>r.user_id),[A,B]);
  }finally{
    await new Promise(r=>app.close(r));
    // The mocked reply request completes before the HTTP fetch above returns.
    await f.manager.tick();f.dispose();
  }
});
