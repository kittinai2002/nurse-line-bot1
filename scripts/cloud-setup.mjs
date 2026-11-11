import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {parseEnv} from 'node:util';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const target=new URL('../.env.vercel',import.meta.url);
try{
 if(!existsSync(target)){
  const local=new URL('../.env',import.meta.url),values=existsSync(local)?parseEnv(readFileSync(local,'utf8')):{};
  const env={LINE_CHANNEL_SECRET:values.LINE_CHANNEL_SECRET||'',LINE_CHANNEL_ACCESS_TOKEN:values.LINE_CHANNEL_ACCESS_TOKEN||'',LINE_OWNER_USER_ID:values.LINE_OWNER_USER_ID||'',DATABASE_URL:'',CRON_SECRET:randomBytes(32).toString('hex')};
  writeFileSync(target,Object.entries(env).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{flag:'wx',mode:0o600});
 }
 console.log('เปิด .env.vercel เดิมหรือสร้างใหม่แล้ว กรอก DATABASE_URL จาก Neon และตรวจข้อมูล LINE ให้ครบ');
 console.log('ไม่แก้ .env หรือ data เดิม อย่าแชร์ไฟล์ .env.vercel หรือภาพรหัสในแชต');
 if(process.platform==='win32'){const p=spawn('notepad.exe',[fileURLToPath(target)],{stdio:'inherit'});p.on('error',()=>{console.error('เปิด Notepad ไม่สำเร็จ ให้เปิด .env.vercel เอง');process.exitCode=1;});}
}catch{console.error('เตรียมไฟล์ไม่สำเร็จ ตรวจสิทธิ์โฟลเดอร์');process.exitCode=1;}
