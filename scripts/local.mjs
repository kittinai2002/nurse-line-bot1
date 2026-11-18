import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const envPath=join(root,'.env');
const mode=process.argv[2]||'start';

async function readConfig(requireSecrets=false) {
  if(!existsSync(envPath))throw Error('ยังไม่มีไฟล์ .env กรุณาเปิด 01-SETUP.cmd ก่อน');
  const {parseEnv}=await import('node:util');
  const values=parseEnv(readFileSync(envPath,'utf8'));
  const port=Number(values.PORT||3000);
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('PORT ต้องเป็นเลขจำนวนเต็ม 1024–65535 เช่น 3000');
  const config={HOST:'127.0.0.1',PORT:String(port),DATA_DIR:resolve(root,values.DATA_DIR||'data')};
  if(requireSecrets) {
    for(const key of ['LINE_CHANNEL_SECRET','LINE_CHANNEL_ACCESS_TOKEN','LINE_OWNER_USER_ID']) {
      config[key]=(values[key]||'').trim();
      if(!config[key])throw Error(`กรุณากรอก ${key} ในไฟล์ .env แล้วบันทึกก่อนเปิดบอต`);
    }
    if(!/^[a-f0-9]{32}$/i.test(config.LINE_CHANNEL_SECRET))throw Error('Channel secret ต้องเป็นรหัส 32 ตัวจาก Basic settings');
    if(!/^U[a-f0-9]{32}$/.test(config.LINE_OWNER_USER_ID))throw Error('Your user ID ต้องขึ้นต้น U ตามด้วยรหัส 32 ตัว ไม่ใช่ Channel ID หรือ @LINE ID');
  }
  return config;
}

async function check(config) {
  const url=`http://127.0.0.1:${config.PORT}`;
  try {
    const response=await fetch(`${url}/healthz`,{signal:AbortSignal.timeout(3000)});
    const body=await response.json();
    if(!response.ok||body.ok!==true||body.service!=='nurse-line-bot')throw Error('wrong_service');
  }catch {throw Error(`ยังไม่พบบอตที่ ${url} ให้เปิด 02-START-BOT.cmd และตรวจข้อความในหน้าต่างนั้นก่อน`);}
  return url;
}

async function main() {
  if(Number(process.versions.node.split('.')[0])!==24)throw Error('โปรแกรมนี้ใช้ Node.js 24 LTS: https://nodejs.org/en/download');
  if(mode==='setup') {
    if(!existsSync(envPath)) {
      writeFileSync(envPath,readFileSync(join(root,'.env.local.example')),{flag:'wx',mode:0o600});
      console.log('สร้างไฟล์ตั้งค่า .env แล้ว');
    }else console.log('เปิดไฟล์ .env เดิม โดยไม่เขียนทับค่าที่เคยกรอก');
    console.log('กรอก Channel secret, Channel access token และ Your user ID แล้วกด Save');
    console.log('อย่าส่งไฟล์ .env หรือภาพรหัสเหล่านี้ในแชต');
    if(process.platform==='win32') {
      const editor=spawn('notepad.exe',[envPath],{stdio:'inherit'});
      editor.on('error',()=>{console.error('เปิด Notepad ไม่สำเร็จ ให้เปิดไฟล์ .env ในโฟลเดอร์บอตเอง');process.exitCode=1;});
    }else console.log(`เปิดแก้ไขไฟล์: ${envPath}`);
    return;
  }
  if(!['start','check','tunnel'].includes(mode))throw Error('ใช้ setup, start, check หรือ tunnel');
  const config=await readConfig(mode==='start');
  if(mode==='start') {
    const {start}=await import('../src/server.mjs');
    const {server}=start(config);
    server.once('error',error=>{
      console.error(error.code==='EADDRINUSE'?'พอร์ตนี้ถูกใช้อยู่แล้ว ตรวจว่าบอตเปิดอยู่หรือไม่ หรือเปลี่ยน PORT ใน .env':'เปิดบอตไม่ได้ ตรวจสิทธิ์โฟลเดอร์และการตั้งค่าพอร์ต');
      process.exit(1);
    });
    server.once('listening',()=>{
      console.log(`บอตในเครื่องพร้อม: http://127.0.0.1:${config.PORT}`);
      console.log(`ฐานข้อมูลเก็บที่: ${config.DATA_DIR}`);
      console.log('ขั้นต่อไปเปิด 03-START-TUNNEL.cmd แล้วตั้ง Webhook URL ใน LINE');
      console.log('ต้องเปิดคอมและหน้าต่างนี้ไว้ ระบบเริ่มแจ้งเตือนเมื่อยืนยันเวลา เพิ่มตาราง และเปิดแจ้งเตือนใน LINE');
      console.log('กด Ctrl+C เพื่อหยุดบอต');
    });
    return;
  }
  const origin=await check(config);
  if(mode==='check') {
    console.log(`ผ่าน: บอตและฐานข้อมูลตอบสนองที่ ${origin}`);
    console.log('ผลนี้ยังไม่ยืนยันการเชื่อม LINE ให้ Verify webhook และลองพิมพ์ เมนู ใน LINE ด้วย');
    return;
  }
  const binary=process.platform==='win32'?'cloudflared.exe':'cloudflared';
  const localBinary=join(root,binary);
  console.log('กำลังเปิดทางเชื่อม HTTPS จากอินเทอร์เน็ตมายังบอตในเครื่องนี้');
  console.log('คัดลอก https://...trycloudflare.com ที่แสดงด้านล่าง แล้วเติม /webhook ใน LINE Developers');
  console.log('ลิงก์เปลี่ยนทุกครั้งที่เปิด tunnel ใหม่ ต้องแก้ Webhook URL ให้ตรงกัน');
  console.log('เปิดทั้งหน้าต่างบอตและหน้าต่างนี้ค้างไว้ระหว่างใช้งาน');
  const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^LINE_/i.test(key)));
  const tunnel=spawn(existsSync(localBinary)?localBinary:binary,['tunnel','--url',origin],{cwd:root,env:childEnv,stdio:'inherit',shell:false});
  tunnel.on('error',()=>{
    console.error('เปิด cloudflared ไม่สำเร็จ ดาวน์โหลดรุ่น Windows จาก https://developers.cloudflare.com/tunnel/downloads/');
    console.error('ตั้งชื่อไฟล์เป็น cloudflared.exe แล้ววางข้างไฟล์ 03-START-TUNNEL.cmd');
    process.exitCode=1;
  });
  tunnel.on('exit',code=>{process.exitCode=code||0;});
}

main().catch(error=>{
  // Never print env contents or remote response bodies.
  console.error(error.code?'เปิดโปรแกรมไม่ได้ ตรวจไฟล์ .env และสิทธิ์โฟลเดอร์ แล้วอ่าน START-HERE-TH.txt':error.message);
  process.exitCode=1;
});
