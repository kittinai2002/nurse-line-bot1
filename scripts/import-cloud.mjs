import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {exportState} from '../src/cloud-state.mjs';
import {importSnapshot} from '../src/cloud-migration.mjs';
import {connectCloudStore} from '../src/cloud-store.mjs';
class MigrationInputError extends Error{}
const root=fileURLToPath(new URL('../',import.meta.url));
async function main(){
 if(Number(process.versions.node.split('.')[0])!==24)throw new MigrationInputError('ใช้ Node.js 24');
 const local=existsSync(join(root,'.env'))?parseEnv(readFileSync(join(root,'.env'),'utf8')):{};
 const cloud=existsSync(join(root,'.env.vercel'))?parseEnv(readFileSync(join(root,'.env.vercel'),'utf8')):{};
 const env={...local,...cloud,...process.env};
 if(!/^U[a-f0-9]{32}$/.test(env.LINE_OWNER_USER_ID||''))throw new MigrationInputError('กรอก LINE_OWNER_USER_ID เดิมใน .env.vercel');
 if(local.LINE_OWNER_USER_ID&&local.LINE_OWNER_USER_ID!==env.LINE_OWNER_USER_ID)throw new MigrationInputError('เจ้าของไม่ตรงกับ .env เดิม ห้ามเปลี่ยนเจ้าของเพื่อย้ายข้อมูล');
 const directory=resolve(root,local.DATA_DIR||'data');
 if(!existsSync(join(directory,'nurse-bot.sqlite')))throw new MigrationInputError('ไม่พบ data เดิม ให้วางชุดนี้ในโฟลเดอร์บอตเดิมและเก็บ data ไว้');
 const ids=new Set([env.LINE_OWNER_USER_ID]);
 if(existsSync(join(directory,'accounts.sqlite'))){const db=new DatabaseSync(join(directory,'accounts.sqlite'),{readOnly:true});try{const owner=db.prepare("SELECT value FROM meta WHERE key='original_owner'").get();if(owner?.value!==env.LINE_OWNER_USER_ID)throw new MigrationInputError('เจ้าของฐานข้อมูลไม่ตรงกัน');for(const r of db.prepare('SELECT user_id FROM accounts').all())ids.add(r.user_id);}finally{db.close();}}
 const apply=process.argv.includes('--apply');
 if(apply&&!env.DATABASE_URL)throw new MigrationInputError('กรอก DATABASE_URL ใน .env.vercel ก่อน');
 if(apply){
  let running=false;try{const r=await fetch('http://127.0.0.1:'+Number(local.PORT||3000)+'/healthz',{signal:AbortSignal.timeout(1200)});running=r.ok;}catch{}
  if(running)throw new MigrationInputError('หยุดบอต Windows ด้วย Ctrl+C และสำรอง data ก่อนย้าย');
 }
 const store=apply?await connectCloudStore(env):null;if(store)await store.ensureOwner(env.LINE_OWNER_USER_ID);
 let imported=0,skipped=0;
 for(const id of ids){
  const path=id===env.LINE_OWNER_USER_ID?join(directory,'nurse-bot.sqlite'):join(directory,'users',createHash('sha256').update(id).digest('hex')+'.sqlite');
  if(!existsSync(path))throw new MigrationInputError('ข้อมูลบางบัญชีหาย หยุดย้ายเพื่อไม่ให้เริ่มฐานเปล่า');
  const db=new DatabaseSync(path,{readOnly:true});let snapshot;
  try{db.exec('BEGIN');snapshot=exportState(db);db.exec('COMMIT');}finally{db.close();}
  if(!store){imported++;continue;}
  const result=await importSnapshot(store,id,snapshot);if(result.skipped)skipped++;else imported++;
 }
 console.log((apply?'ย้ายแล้ว ':'ตรวจพบ ')+imported+' บัญชี'+(skipped?' · ข้ามบัญชีออนไลน์เดิม '+skipped:'')+' โดยไม่แก้ไฟล์ data เดิม');
 console.log(apply?'ส่ง เมนู ใน OA แล้วตรวจตาราง/เวลา ก่อนเปิดแจ้งเตือนของแต่ละคนอีกครั้ง':'ยังไม่เขียนออนไลน์ เมื่อตรวจพร้อมใช้ npm run cloud:import -- --apply');
}
main().catch(error=>{if(error instanceof MigrationInputError){console.error(error.message);process.exitCode=1;return;}console.error('ย้ายไม่สำเร็จ: ตรวจว่า schema Neon พร้อม ค่าตั้งตรงกับเจ้าของเดิม บอตเก่าหยุดแล้ว และไม่มีตารางออนไลน์ที่ขัดกัน ห้ามลบ data เดิม');process.exitCode=1;});
