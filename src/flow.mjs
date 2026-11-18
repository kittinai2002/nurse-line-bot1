import {randomBytes} from 'node:crypto';
import {calendarMessage} from './calendar.mjs';
import {TYPES,bangkokDate,nextMonth,thaiDate,validDate,validTime,normalizeMonth,timeDescription,assertNoOverlap} from './domain.mjs';

export function validPostback(p){return typeof p?.data==='string'&&p.data.length<=300&&(!p.params||(['date','time'].every(k=>p.params[k]===undefined||(typeof p.params[k]==='string'&&p.params[k].length<=20))));}

const nav=[['เมนูหลัก','เมนู']];
export function reply(text,choices=nav) {
  return {type:'text',text,quickReply:{items:choices.map(choice=>({type:'action',action:Array.isArray(choice)?{type:'message',label:choice[0],text:choice[1]}:choice}))}};
}
const get=bot=>{const row=bot.db.prepare('SELECT json,expires FROM ui_state WHERE id=1').get();return row&&row.expires>bot.now()?JSON.parse(row.json):null;};
const clear=bot=>bot.db.prepare('DELETE FROM ui_state').run();
function save(bot,s){s.token=randomBytes(8).toString('hex');bot.db.prepare('INSERT OR REPLACE INTO ui_state(id,json,expires) VALUES(1,?,?)').run(JSON.stringify(s),bot.now()+30*60000);return s;}
const action=(s,label,op)=>({type:'postback',label,data:`u:${s.token}:${op}`});
const picker=(s,label,op,mode,initial)=>({type:'datetimepicker',label,data:`u:${s.token}:${op}`,mode,initial,...(mode==='date'?{min:'2020-01-01',max:'2100-12-31'}:{})});
const cancelled=()=>reply('ยกเลิกแล้ว\nข้อมูลที่บันทึกไว้ยังอยู่ครบ');
function view(bot,s){
 const c=bot.config();
 if(s.stage==='date')return reply('ลงเวรของฉัน\nเลือกวันที่ต้องการลงหรือแก้เวร',[
  picker(s,'เลือกวันที่','date','date',bangkokDate(bot.now())),action(s,'วันนี้','day:'+bangkokDate(bot.now())),action(s,'พรุ่งนี้','day:'+bangkokDate(bot.now()+86400000)),['กลับตาราง','ตารางเวรของฉัน']]);
 if(s.stage==='days')return reply(`📆 ลงหลายวัน · ${s.month}\nพิมพ์วันที่ที่มีเวรแบบเดียวกัน เช่น 1 3 5-7\nไม่ต้องพิมพ์ชื่อเวรในขั้นตอนนี้`,[['เปลี่ยนเดือน','ลงหลายวัน'],['ยกเลิก','ยกเลิกขั้นตอน']]);
 if(s.stage==='shifts'){
  const label=s.dates.length===1?thaiDate(s.dates[0]):s.dates.map(d=>Number(d.slice(-2))).join(', ')+' · '+s.dates[0].slice(0,7);
  const chosen=s.types.length?s.types.map(t=>t==='หยุด'?'หยุด':timeDescription(t,c)).join('\n'):'ยังไม่ได้เลือกเวร';
  return reply(`เลือกเวร · ${label}\n${chosen}\nแตะเวรเพื่อเลือกหรือเอาออก แล้วกดบันทึก`,[...['เช้า','บ่าย','ดึก','หยุด'].map(t=>action(s,(s.types.includes(t)?'✓ ':'')+t,'shift:'+t)),...(s.types.length?[action(s,'บันทึกเวร','saveShifts')]:[]),action(s,'ลบเวรวันที่เลือก','reviewDelete'),['ยกเลิก','ยกเลิกขั้นตอน']]);
 }
 if(s.stage==='times')return reply(`🕒 เวลาเวรของคุณ\n${TYPES.map(t=>timeDescription(t,{times:s.times})).join('\n')}\nเวลาตรงแล้วกดใช้เวลาชุดนี้ได้เลย`,[...TYPES.map(t=>action(s,'แก้เวร'+t,'edit:'+t)),action(s,'ใช้เวลาชุดนี้','saveTimes'),['ยกเลิก','ยกเลิกขั้นตอน']]);
 if(s.stage==='start'||s.stage==='end'){
  const start=s.stage==='start';return reply(`🕒 เวร${s.shift} · ${start?'เวลาเริ่ม':'เวลาเลิก'}\n${start?'เลือกเวลาเริ่มเวร':'เวลาเริ่มที่เลือก: '+s.start+'\nเลือกเวลาเลิกเวร'}\nหากตัวเลือกเวลาไม่เปิด พิมพ์เวลา เช่น 07:30\nเวลาเลิกน้อยกว่าเวลาเริ่มหมายถึงจบวันถัดไป`,[picker(s,start?'เลือกเวลาเริ่ม':'เลือกเวลาเลิก','time','time',s.times[s.shift][start?0:1]),action(s,'กลับไปเลือกเวร','backTimes'),['ยกเลิก','ยกเลิกขั้นตอน']]);
 }
 return reply('ขั้นตอนหมดอายุแล้ว\nกดเมนูเพื่อเริ่มใหม่');
}
function selectDate(bot,s,date){
 const local=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);if(local){let y=Number(local[3]);if(y>=2400)y-=543;date=`${y}-${local[2].padStart(2,'0')}-${local[1].padStart(2,'0')}`;}
 if(!validDate(date)||date<'2020-01-01'||date>'2100-12-31')return reply('วันที่ไม่ถูกต้อง\nพิมพ์วันที่แบบ 2026-11-02 หรือเลือกจากปฏิทิน',[picker(s,'เลือกวันที่','date','date',bangkokDate(bot.now())),...nav]);
 s.stage='shifts';s.dates=[date];s.types=bot.rows().filter(r=>r.date===date).map(r=>r.type);return view(bot,save(bot,s));
}
function selectTime(bot,s,time){
 const simple=/^(\d{1,2})[:.](\d{2})$/.exec(time);if(simple)time=simple[1].padStart(2,'0')+':'+simple[2];
 if(!validTime(time))return reply('เวลาไม่ถูกต้อง\nใช้รูปแบบ 07:30 หรือกดเลือกเวลา',[picker(s,'เลือกเวลา','time','time',s.times[s.shift][s.stage==='start'?0:1]),['ยกเลิก','ยกเลิกขั้นตอน']]);
 if(s.stage==='start'){s.start=time;s.stage='end';}
 else{if(time===s.start)return reply('เวลาเริ่มและเลิกต้องต่างกัน\nกดเลือกเวลาเลิกใหม่',[picker(s,'เวลาเลิก','time','time',time),action(s,'เริ่มเลือกใหม่','backTimes')]);s.times[s.shift]=[s.start,time];s.stage='times';}
 return view(bot,save(bot,s));
}
export function handlePostback(bot,p){
 const m=/^u:([a-f0-9]{16}):(.+)$/.exec(p?.data||'');const s=get(bot);
 if(!m||!s||s.token!==m[1])return reply('ปุ่มนี้เป็นขั้นตอนเก่าหรือหมดอายุ\nกลับเมนูเพื่อเริ่มใหม่ ข้อมูลเดิมยังอยู่');
 const op=m[2];
 if(s.stage==='date'&&op==='date')return selectDate(bot,s,p.params?.date||'');
 if(s.stage==='date'&&op.startsWith('day:'))return selectDate(bot,s,op.slice(4));
 if(s.stage==='shifts'&&op.startsWith('shift:')){
  const t=op.slice(6);if(![...TYPES,'หยุด'].includes(t))return view(bot,s);
  if(s.types.includes(t))s.types=s.types.filter(v=>v!==t);
  else s.types=t==='หยุด'?['หยุด']:[...s.types.filter(v=>v!=='หยุด'),t].sort((a,b)=>TYPES.indexOf(a)-TYPES.indexOf(b));
  return view(bot,save(bot,s));
 }
 if(s.stage==='shifts'&&op==='saveShifts'&&s.types.length){
  const preview=bot.handle('เพิ่มเวร '+s.dates[0].slice(0,7)+'\n'+s.dates.map(d=>`${Number(d.slice(-2))} ${s.types.join(' ')}`).join('\n'));
  // The selection card already shows the dates, shifts and overwrite notice.
  // Commit on its explicit Save action using the existing validated transaction path.
  bot.handle(preview.quickReply.items[0].action.text);const month=s.dates[0].slice(0,7);clear(bot);return calendarMessage(month,bot.rows(),bot.now(),{notice:'✓ บันทึกเวรแล้ว'});
 }
 if(s.stage==='shifts'&&op==='reviewDelete'){
  s.stage='delete';return reply(`ลบเวร ${s.dates.length} วัน?\n${s.dates.map(thaiDate).join(', ')}\nวันที่เลือกจะกลับเป็น “ยังไม่ลงเวร”`,[action(save(bot,s),'ยืนยันลบเวร','deleteShifts'),['ยกเลิก','ยกเลิกขั้นตอน']]);
 }
 if(s.stage==='delete'&&op==='deleteShifts'){
  for(const date of s.dates){bot.db.prepare('DELETE FROM shifts WHERE date=?').run(date);bot.db.prepare("UPDATE outbox SET state='cancelled' WHERE date=? AND state='pending'").run(date);}
  const month=s.dates[0].slice(0,7);clear(bot);return calendarMessage(month,bot.rows(),bot.now(),{notice:'✓ ลบเวรวันที่เลือกแล้ว'});
 }
 if(s.stage==='times'&&op.startsWith('edit:')&&TYPES.includes(op.slice(5))){s.shift=op.slice(5);s.stage='start';return view(bot,save(bot,s));}
 if(['start','end'].includes(s.stage)&&op==='time')return selectTime(bot,s,p.params?.time||'');
 if(['start','end'].includes(s.stage)&&op==='backTimes'){s.stage='times';return view(bot,save(bot,s));}
 if(s.stage==='times'&&op==='saveTimes'){
  const c=bot.config();if(JSON.stringify(c.times)!==JSON.stringify(s.original)){clear(bot);return reply('เวลาเวรถูกแก้ระหว่างขั้นตอน\nเปิดหน้าตั้งเวลาอีกครั้งเพื่อตรวจค่าล่าสุด',[['ตั้งเวลาเวร','ตั้งเวลาเวร'],...nav]);}
  const proposed={...c,times:s.times,confirmed:true};assertNoOverlap(bot.rows(),proposed);
  bot.saveConfig(proposed);bot.cancelPending();clear(bot);
  return reply(`✅ บันทึกและยืนยันเวลาแล้ว\n${TYPES.map(t=>timeDescription(t,proposed)).join('\n')}\nแจ้งเตือน: ${c.enabled?'เปิด':'ปิด'}`,c.enabled?[['ลง/แก้เวร','ลงเวร'],...nav]:[['ลง/แก้เวร','ลงเวร'],['เปิดแจ้งเตือน','เปิดแจ้งเตือน'],...nav]);
 }
 return reply('ปุ่มนี้ไม่ตรงกับขั้นตอนปัจจุบัน\nกลับเมนูแล้วเริ่มใหม่ได้เลย');
}
export function handleFlow(bot,input){
 const c=bot.config(),today=bangkokDate(bot.now()),month=today.slice(0,7);
 if(['เมนู','เริ่มต้น','ช่วยเหลือ'].includes(input)){
  clear(bot);
  return reply(`เหมียวเตือนเวร\n${!c.confirmed?'เริ่มใช้ครั้งแรก: เปิดตั้งค่าเพื่อตรวจเวลาเวร':c.enabled?'แจ้งเตือนเปิดอยู่ · ก่อนเวร '+c.lead+' นาที':'แจ้งเตือนยังปิดอยู่ · เปิดได้ในตั้งค่า'}`,[['เวรวันนี้','เวรวันนี้'],['ตารางของฉัน','ตารางเวรของฉัน'],['ตั้งค่า','ตั้งค่า']]);
 }
 if(input==='ดูเวร'){clear(bot);return reply('📅 ดูเวรของคุณ\nเลือกวันที่ต้องการดู',[['วันนี้','เวรวันนี้'],['พรุ่งนี้','เวรพรุ่งนี้'],...nav]);}
 if(input==='ยกเลิกขั้นตอน'){clear(bot);return cancelled();}
 if(['ลงเวร','เพิ่มเวร','เพิ่มเวรเดือนหน้า','เพิ่มเวรในเดือนถัดไป'].includes(input)){
  if(input.includes('เดือน'))return handleFlow(bot,'ลงหลายวัน '+nextMonth(bot.now()));
  return view(bot,save(bot,{stage:'date'}));
 }
 if(input.startsWith('ลงเวร ')){return selectDate(bot,save(bot,{stage:'date'}),input.slice('ลงเวร '.length).trim());}
 if(input==='ลงหลายวัน'){clear(bot);return reply('📆 ลงหลายวันพร้อมกัน\nเลือกเดือน แล้วพิมพ์วันที่ที่มีเวรแบบเดียวกัน',[['เดือนนี้','ลงหลายวัน '+month],['เดือนหน้า','ลงหลายวัน '+nextMonth(bot.now())],['เลือกวันเดียว','ลงเวร'],...nav]);}
 if(input.startsWith('ลงหลายวัน ')){const selected=normalizeMonth(input.slice('ลงหลายวัน '.length));return view(bot,save(bot,{stage:'days',month:selected}));}
 if(input==='ตั้งค่า'){
  clear(bot);return reply(`ตั้งค่า\n${TYPES.map(t=>timeDescription(t,c)).join('\n')}\nเตือนก่อนเวร ${c.lead} นาที\nแจ้งเตือน: ${c.enabled?'เปิด':'ปิด'}${!c.confirmed?' · ยังไม่ยืนยันเวลา':''}`,[['เปลี่ยนเวลาเวร','ตั้งเวลาเวร'],['เตือนก่อนขึ้นเวร','เลือกระยะเตือน'],[c.enabled?'ปิดแจ้งเตือน':'เปิดแจ้งเตือน',c.enabled?'ปิดแจ้งเตือน':'เปิดแจ้งเตือน'],...nav]);
 }
 if(input==='ตั้งเวลาเวร'){return view(bot,save(bot,{stage:'times',times:structuredClone(c.times),original:structuredClone(c.times)}));}
 if(input==='เลือกระยะเตือน'){clear(bot);return reply('🔔 เตือนก่อนขึ้นเวรกี่นาที\nเลือกได้เลย หรือพิมพ์ เตือนล่วงหน้า 45 เพื่อระบุเอง',[[15,15],[30,30],[60,60],[90,90],[120,120]].map(([n])=>[n+' นาที','เตือนล่วงหน้า '+n]).concat([['กลับตั้งค่า','ตั้งค่า']]));}
 if(input==='วางตาราง'){
  clear(bot);return reply(`📝 คัดลอกตัวอย่างนี้แล้วเปลี่ยนวันที่/เวร\n\nเพิ่มเวร ${month}\n1 ช\n2 บ\n3 ด\n4 ห\n5 ช บ\n\nช=เช้า บ=บ่าย ด=ดึก ห=หยุด\nส่งเพื่อตรวจสอบก่อนบันทึก`,[['ลงแบบกดเลือก','ลงเวร'],...nav]);
 }
 const s=get(bot);
 if(input==='ทำต่อ')return s?view(bot,s):reply('ขั้นตอนหมดอายุแล้ว\nกดเมนูเพื่อเริ่มใหม่');
 // Explicit legacy commands and navigation take precedence over draft input.
 if(/^(เวรวันนี้|เวรพรุ่งนี้|เวรวันพรุ่งนี้|เวรวันที่ |รายการเวร|ตารางเวร|เพิ่มเวร |ตั้งเวลา |เตือนล่วงหน้า |ยืนยัน|ยกเลิก |เปิดแจ้งเตือน|ปิดแจ้งเตือน|สถานะ)/.test(input)){clear(bot);return null;}
 if(!s)return null;
 if(s.stage==='date')return selectDate(bot,s,input);
 if(['start','end'].includes(s.stage))return selectTime(bot,s,input);
 if(s.stage==='days'){
  const days=new Set();let invalid=false;
  for(const part of input.trim().split(/[\s,]+/)){
   const m=/^(\d{1,2})(?:-(\d{1,2}))?$/.exec(part);if(!m){invalid=true;break;}
   const a=Number(m[1]),b=Number(m[2]||m[1]);if(a<1||b>31||b<a){invalid=true;break;}
   for(let n=a;n<=b;n++)days.add(n);
  }
  const dates=[...days].sort((a,b)=>a-b).map(n=>`${s.month}-${String(n).padStart(2,'0')}`);
  if(invalid||!dates.length||dates.some(d=>!validDate(d)))return reply(`วันที่ไม่ถูกต้องสำหรับ ${s.month}\nพิมพ์เฉพาะเลขวัน เช่น 1 3 5-7`,[['เปลี่ยนเดือน','ลงหลายวัน'],['ยกเลิก','ยกเลิกขั้นตอน']]);
  s.stage='shifts';s.dates=dates;s.types=[];return view(bot,save(bot,s));
 }
 return view(bot,s);
}
