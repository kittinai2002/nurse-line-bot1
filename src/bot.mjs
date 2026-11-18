import {randomUUID, createHmac, timingSafeEqual} from 'node:crypto';
import {DEFAULT_CONFIG,TYPES,bangkokDate,nextMonth,parseSchedule,validTime,validDate,normalizeMonth,assertNoOverlap,thaiDate,timeDescription,reminderWindows,reminderText} from './domain.mjs';
import {transaction} from './db.mjs';
import {decorateMessage} from './cards.mjs';
import {calendarMessage} from './calendar.mjs';
import {handleFlow,handlePostback,reply,validPostback} from './flow.mjs';

export function verifySignature(raw,signature,secret) {
  if(!secret||typeof signature!=='string') return false;
  const expected=createHmac('sha256',secret).update(raw).digest();
  const got=Buffer.from(signature,'base64');
  return expected.length===got.length&&timingSafeEqual(expected,got);
}
export const message=reply;
export class NurseBot {
  constructor(db,env,{fetchFn=fetch,now=()=>Date.now()}={}) {
    this.db=db;this.env=env;this.fetch=fetchFn;this.now=now;this.busy=false;
    db.prepare('INSERT OR IGNORE INTO config(id,json) VALUES(1,?)').run(JSON.stringify(DEFAULT_CONFIG()));
  }
  config(){return JSON.parse(this.db.prepare('SELECT json FROM config WHERE id=1').get().json);}
  saveConfig(c){this.db.prepare('UPDATE config SET json=? WHERE id=1').run(JSON.stringify(c));}
  rows(){return this.db.prepare('SELECT date,type FROM shifts ORDER BY date,type').all();}
  ingest(events) {
    transaction(this.db,()=>{
      for(const e of events) {
        if(e.source?.type!=='user'||e.source?.userId!==this.env.LINE_OWNER_USER_ID) continue;
        if(!e.webhookEventId||typeof e.timestamp!=='number'||Math.abs(this.now()-e.timestamp)>10*60000) continue;
        if(!['message','follow','unfollow','postback'].includes(e.type)) continue;
        if(e.type==='postback'&&!validPostback(e.postback))continue;
        if(e.type==='message' && (e.message?.type!=='text'||typeof e.message.text!=='string'||e.message.text.length>5000)) continue;
        const payload={type:e.type,text:e.message?.text,replyToken:e.replyToken,timestamp:e.timestamp,postback:e.type==='postback'?{data:e.postback.data,params:{date:e.postback.params?.date,time:e.postback.params?.time}}:undefined};
        this.db.prepare('INSERT OR IGNORE INTO events(id,payload,received) VALUES(?,?,?)').run(e.webhookEventId,JSON.stringify(payload),this.now());
      }
    });
  }
  cancelPending(){this.db.prepare("UPDATE outbox SET state='cancelled' WHERE state='pending'").run();}
  handlePostback(postback){return handlePostback(this,postback);}
  handle(text) {
    const c=this.config();text=text.trim();
    if(['ปฏิทินเวร','ตารางของฉัน'].includes(text))text='ตารางเวรของฉัน';
    if(['เว็บ','จัดการเวร','เปิดเว็บ'].includes(text))text='เมนู';
    const guided=handleFlow(this,text);if(guided)return guided;
    if(text==='ยืนยันเวลาเวร') {c.confirmed=true;this.saveConfig(c);return message(`✅ ยืนยันเวลาเวรแล้ว\n${TYPES.map(t=>timeDescription(t,c)).join('\n')}\n\nเพิ่มตารางแล้วพิมพ์ เปิดแจ้งเตือน เมื่อพร้อม`);}
    if(text.startsWith('ตั้งเวลา ')) {
      const m=/^ตั้งเวลา\s+(เช้า|บ่าย|ดึก)\s+(\d{2}:\d{2})\s+(\d{2}:\d{2})$/.exec(text);
      if(!m||!validTime(m[2])||!validTime(m[3])||m[2]===m[3]) return message('ใช้รูปแบบ ตั้งเวลา เช้า 08:00 16:00 และเวลาเริ่มกับเวลาจบต้องไม่ตรงกัน');
      c.times[m[1]]=[m[2],m[3]]; assertNoOverlap(this.rows(),c);
      c.confirmed=false;c.enabled=false;this.saveConfig(c);this.cancelPending();
      return message(`บันทึกเวลา${m[1]}แล้ว และพักการเตือนเพื่อรอยืนยัน\nพิมพ์ ตั้งค่า เพื่อตรวจสอบและยืนยันเวลาอีกครั้ง`);
    }
    if(text.startsWith('เตือนล่วงหน้า ')) {
      const m=/^เตือนล่วงหน้า\s+(\d+)$/.exec(text);const lead=Number(m?.[1]);
      if(!m||lead<5||lead>1440) return message('ตั้งเวลาเตือนล่วงหน้าได้ 5–1440 นาที เช่น เตือนล่วงหน้า 60');
      c.lead=lead;this.saveConfig(c);this.cancelPending();return message(`✅ ตั้งเตือนล่วงหน้า ${lead} นาทีแล้ว`,[['กลับตั้งค่า','ตั้งค่า'],['เมนูหลัก','เมนู']]);
    }
    if(text==='เปิดแจ้งเตือน') {
      if(!c.confirmed) return message('ตรวจเวลาเวรก่อนเปิดแจ้งเตือน\nเลือกเวลาให้ตรงกับที่ทำงาน แล้วกดใช้เวลาชุดนี้',[['ตั้งเวลาเวร','ตั้งเวลาเวร'],['เมนูหลัก','เมนู']]);
      if(!this.rows().some(r=>r.date>=bangkokDate(this.now())&&r.type!=='หยุด')) return message('ยังไม่มีเวรปัจจุบันหรืออนาคต\nลงเวรแล้วกลับมาเปิดแจ้งเตือนได้เลย',[['ลงเวร','ลงเวร'],['เมนูหลัก','เมนู']]);
      c.enabled=true;this.saveConfig(c);return message(`🔔 เปิดแจ้งเตือนแล้ว ก่อนขึ้นเวร ${c.lead} นาที\nตรวจสอบว่าเพิ่มเพื่อน OA และเปิดการแจ้งเตือน LINE ไว้ด้วยนะครับ`);
    }
    if(text==='ปิดแจ้งเตือน') {c.enabled=false;this.saveConfig(c);this.cancelPending();return message('🔕 ปิดแจ้งเตือนแล้ว ตารางเวรยังอยู่ครบครับ');}
    if(['เวรวันนี้','เวรพรุ่งนี้','เวรวันพรุ่งนี้'].includes(text)) {
      const tomorrow=text!=='เวรวันนี้';
      const day=tomorrow?'พรุ่งนี้':'วันนี้';
      const date=bangkokDate(this.now()+(tomorrow?86400000:0));
      const rows=this.rows().filter(r=>r.date===date);
      const summary=rows.length?rows.map(r=>r.type==='หยุด'?'🌿 วันหยุด':timeDescription(r.type,c)).join('\n'):`ยังไม่ได้บันทึกเวร${day} (ไม่ได้หมายถึงวันหยุด)`;
      return message(`📅 เวร${day}\nวันที่เริ่มเวร ${thaiDate(date)}\n${summary}\n\nแจ้งเตือน ${c.enabled?'เปิด':'ปิด'}`,[['ดูเวรพรุ่งนี้','เวรพรุ่งนี้'],['แก้เวรวันที่แสดง','ลงเวร '+date],['ตารางของฉัน','ตารางเวรของฉัน']]);
    }
    if(text.startsWith('เวรวันที่ ')) {
      const date=text.slice('เวรวันที่ '.length).trim();
      if(!validDate(date)||date<'2020-01-01'||date>'2100-12-31')return message('วันที่ไม่ถูกต้อง',[['ปฏิทินเวร','ตารางเวรของฉัน'],['เมนูหลัก','เมนู']]);
      const rows=this.rows().filter(r=>r.date===date);
      return message(`🐾 เวรวันที่ ${thaiDate(date)}\n${rows.length?rows.map(r=>r.type==='หยุด'?'🌿 วันหยุด':timeDescription(r.type,c)).join('\n'):'ยังไม่ได้ลงเวรในวันที่เลือก (ไม่ได้หมายถึงวันหยุด)'}\nวันที่แสดงคือวันที่เริ่มเวร`,[['แก้เวรวันที่เลือก','ลงเวร '+date],['กลับปฏิทิน','ตารางเวร '+date.slice(0,7)],['เมนูหลัก','เมนู']]);
    }
    if(text==='ตารางเวรของฉัน'||text.startsWith('ตารางเวร ')) {
      const month=text==='ตารางเวรของฉัน'?bangkokDate(this.now()).slice(0,7):normalizeMonth(text.slice(8).trim());
      return calendarMessage(month,this.rows(),this.now());
    }
    if(text==='รายการเวร'||text.startsWith('รายการเวร ')) {
      const month=text==='รายการเวร'?bangkokDate(this.now()).slice(0,7):normalizeMonth(text.slice('รายการเวร '.length).trim());
      const rows=this.rows().filter(r=>r.date.startsWith(month));
      const dates=[...new Set(rows.map(r=>r.date))];
      return message(`🐾 รายการเวร ${month}\n${dates.length?dates.map(d=>`${Number(d.slice(-2))}: ${rows.filter(r=>r.date===d).map(r=>r.type).join(' + ')}`).join('\n'):'ยังไม่มีตารางเดือนนี้'}\nวันที่แสดงคือวันที่เริ่มเวร`,[['กลับปฏิทิน','ตารางเวร '+month],['ลง/แก้เวร','ลงเวร'],['เมนูหลัก','เมนู']]);
    }
    if(text.startsWith('เพิ่มเวร ')) {
      const updates=parseSchedule(text);const dates=new Set(updates.map(u=>u.date));
      const rows=[...this.rows().filter(r=>!dates.has(r.date)),...updates.flatMap(u=>(u.types.length?u.types:['หยุด']).map(type=>({date:u.date,type})))];
      assertNoOverlap(rows,c);
      const id=randomUUID().slice(0,8);
      this.db.prepare('INSERT INTO pending(id,json,expires) VALUES(?,?,?)').run(id,JSON.stringify(updates),this.now()+10*60000);
      return message(`ตรวจสอบตารางก่อนบันทึก\n${updates.map(u=>`${thaiDate(u.date)}: ${u.types.join(' + ')||'หยุด'}`).join('\n')}\n\nวันที่ในรายการจะแทนที่เวรเดิม ยืนยันภายใน 10 นาที`,[['ยืนยันบันทึก',`ยืนยัน ${id}`],['ยกเลิก',`ยกเลิก ${id}`]]);
    }
    if(/^ยืนยัน [a-f0-9-]{8}$/.test(text)) {
      const id=text.split(' ')[1];const pending=this.db.prepare('SELECT * FROM pending WHERE id=? AND expires>?').get(id,this.now());
      if(!pending) return message('รายการนี้หมดอายุหรือบันทึกแล้ว ส่งตารางใหม่ได้ครับ');
      const updates=JSON.parse(pending.json);const dates=new Set(updates.map(u=>u.date));
      const combined=[...this.rows().filter(r=>!dates.has(r.date)),...updates.flatMap(u=>(u.types.length?u.types:['หยุด']).map(type=>({date:u.date,type})))];
      assertNoOverlap(combined,c);
      for(const u of updates) {
        this.db.prepare('DELETE FROM shifts WHERE date=?').run(u.date);
        this.db.prepare("UPDATE outbox SET state='cancelled' WHERE date=? AND state='pending'").run(u.date);
        for(const type of u.types.length?u.types:['หยุด']) this.db.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run(u.date,type);
      }
      this.db.prepare('DELETE FROM pending WHERE id=?').run(id);
      return message(`✅ บันทึก ${updates.length} วันแล้ว\nแจ้งเตือน: ${c.enabled?'เปิด':'ปิด'}`,[...(c.enabled?[]:[[c.confirmed?'เปิดแจ้งเตือน':'ตั้งเวลาเวร',c.confirmed?'เปิดแจ้งเตือน':'ตั้งเวลาเวร']]),['ลงเวรเพิ่ม','ลงเวร'],['ดูตาราง','ตารางเวร '+updates[0].date.slice(0,7)],['เมนูหลัก','เมนู']]);
    }
    if(/^ยกเลิก [a-f0-9-]{8}$/.test(text)){this.db.prepare('DELETE FROM pending WHERE id=?').run(text.split(' ')[1]);return message('ยกเลิกรายการแล้ว ตารางเดิมไม่เปลี่ยนครับ');}
    if(text==='สถานะ') {
      const logs=this.db.prepare('SELECT date,type,state,last_status FROM outbox ORDER BY rowid DESC LIMIT 5').all();
      const names={sent:'LINE รับข้อความแล้ว',pending:'รอส่ง/ลองใหม่',failed:'ส่งไม่สำเร็จ',expired:'เลยเวลาเตือน',cancelled:'ยกเลิก'};
      return message(`แจ้งเตือน: ${c.enabled?'เปิด':'ปิด'}\n${logs.map(l=>`${l.date} ${l.type}: ${names[l.state]}${l.last_status?' ('+l.last_status+')':''}`).join('\n')||'ยังไม่มีประวัติส่ง'}\n\nสถานะรับข้อความจาก API ไม่ใช่การยืนยันว่าเปิดอ่านแล้ว`);
    }
    return message('ยังไม่เข้าใจข้อความนี้\nกดลงเวรเพื่อลงแบบเลือกวันและเวร หรือกลับเมนูหลัก',[['ลง/แก้เวร','ลงเวร'],['เมนูหลัก','เมนู']]);
  }
  async line(path,payload,retryKey) {
    payload={...payload,messages:payload.messages.map(decorateMessage)};
    const headers={'Content-Type':'application/json','Authorization':`Bearer ${this.env.LINE_CHANNEL_ACCESS_TOKEN}`};
    if(retryKey) headers['X-Line-Retry-Key']=retryKey;
    const response=await this.fetch(`https://api.line.me/v2/bot/message/${path}`,{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
    return {status:response.status,accepted:response.ok||(response.status===409&&!!response.headers.get('x-line-accepted-request-id'))};
  }
  async processEvents() {
    for(const event of this.db.prepare("SELECT * FROM events WHERE state IN ('new','reply_pending') ORDER BY received LIMIT 10").all()) {
      const p=JSON.parse(event.payload);
      if(this.now()-p.timestamp>10*60000) {this.db.prepare("UPDATE events SET state='expired',payload=NULL,response=NULL WHERE id=?").run(event.id);continue;}
      let result;
      if(event.state==='new') {
        result=transaction(this.db,()=>{
          let reply;
          if(p.type==='unfollow'){const c=this.config();c.enabled=false;this.saveConfig(c);this.cancelPending();reply=null;}
          else {
            // SAVEPOINT ensures an invalid command never commits partial edits.
            this.db.exec('SAVEPOINT command');
            try{reply=p.type==='follow'?this.handle('เมนู'):p.type==='postback'?this.handlePostback(p.postback):this.handle(p.text);this.db.exec('RELEASE command');}
            catch(e){this.db.exec('ROLLBACK TO command; RELEASE command');reply=message(`ยังไม่ได้บันทึก\n${String(e.message).slice(0,250)}`,[['ลองขั้นตอนเดิม','ทำต่อ'],['เมนูหลัก','เมนู']]);}
          }
          this.db.prepare('UPDATE events SET state=?,response=? WHERE id=?').run(reply?'reply_pending':'done',reply?JSON.stringify(reply):null,event.id);
          return reply;
        });
      } else result=JSON.parse(event.response);
      if(!result||!p.replyToken||this.now()-p.timestamp>55000) {this.db.prepare("UPDATE events SET state='done',payload=NULL,response=NULL WHERE id=?").run(event.id);continue;}
      try {
        const r=await this.line('reply',{replyToken:p.replyToken,messages:[result]});
        if(r.accepted||(r.status>=400&&r.status<500&&r.status!==429)) this.db.prepare("UPDATE events SET state=?,payload=NULL,response=NULL WHERE id=?").run(r.accepted?'done':'reply_failed',event.id);
      } catch { /* Retry the same reply token on the next tick, within its validity. */ }
    }
  }
  enqueueReminders({ queueAhead = false } = {}) {
    const c=this.config();const now=this.now();
    const today=bangkokDate(now);
    const next=bangkokDate(now+86400000);
    const rows=this.db.prepare('SELECT date,type FROM shifts WHERE date BETWEEN ? AND ?').all(today,next);
    for(const r of reminderWindows(rows,c)) {
      if(r.expires<=now||(!queueAhead&&r.due>now))continue;
      // Cancelled unsent reminders may be reactivated; accepted messages are never re-sent.
      this.db.prepare(`INSERT INTO outbox(id,retry_key,date,type,text,expires,next_attempt) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET text=excluded.text, expires=excluded.expires,next_attempt=excluded.next_attempt,state='pending'
        WHERE outbox.accepted_at IS NULL AND
          (outbox.state='cancelled' OR (outbox.state='expired' AND outbox.expires<>excluded.expires))
      `).run(r.key,randomUUID(),r.date,r.type,reminderText(r,c),r.expires,Math.max(now,r.due));
    }
  }
  async sendOutbox() {
    const now=this.now();
    const {changes:expired}=this.db.prepare("UPDATE outbox SET state='expired' WHERE state='pending' AND expires<=?").run(now);
    const delivery={sent:0,expired,lineStatuses:{}};
    if(!this.config().enabled) return delivery;
    for(const job of this.db.prepare("SELECT * FROM outbox WHERE state='pending' AND next_attempt<=? AND expires>? ORDER BY next_attempt LIMIT 5").all(now,now)) {
      let result={status:0,accepted:false};
      try {result=await this.line('push',{to:this.env.LINE_OWNER_USER_ID,messages:[message(job.text)]},job.retry_key);}catch{}
      if(result.accepted)delivery.sent++;
      else delivery.lineStatuses[result.status]=(delivery.lineStatuses[result.status]||0)+1;
      const state=result.accepted?'sent':result.status>=400&&result.status<500&&result.status!==429?'failed':'pending';
      this.db.prepare('UPDATE outbox SET state=?,last_status=?,attempts=attempts+1,next_attempt=?,accepted_at=? WHERE id=?').run(state,result.status,this.now()+Math.min(300000,30000*2**Math.min(job.attempts,4)),result.accepted?this.now():null,job.id);
    }
    return delivery;
  }
  async tick({ queueAhead = false } = {}) {
    if(this.busy)return; this.busy=true;
    try {
      await this.processEvents();
      this.enqueueReminders({queueAhead});
      const delivery=await this.sendOutbox();
      this.db.prepare('DELETE FROM pending WHERE expires<?').run(this.now());
      this.db.prepare('DELETE FROM events WHERE received<?').run(this.now()-86400000);
      this.db.prepare('DELETE FROM outbox WHERE expires<?').run(this.now()-90*86400000);
      return delivery;
    } finally {this.busy=false;}
  }
}
