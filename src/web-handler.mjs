import {connectCloudStore} from './cloud-store.mjs';
import {restoreState,exportState,nextDue} from './cloud-state.mjs';
import {NurseBot} from './bot.mjs';
import {TYPES,validDate,assertNoOverlap} from './domain.mjs';

export function createWebHandler({env=process.env,storeFactory=connectCloudStore,fetchFn=fetch}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  if(req.method!=='GET'&&req.method!=='POST')return send(405,{error:'method_not_allowed'});
  if(!env.LINE_LOGIN_CHANNEL_ID)return send(503,{error:'web_login_not_configured'});
  const auth=req.headers.authorization||'',m=/^Bearer ([\w.-]{20,4096})$/.exec(auth);if(!m)return send(401,{error:'login_required'});
  try{
   const store=await storeFactory(env);const profile=await store.verifyLineToken(m[1],env.LINE_LOGIN_CHANNEL_ID);
   if(req.method==='GET'){
    const lease=await store.acquire(profile.userId);if(!lease)return send(404,{error:'account_not_found'});
    try{const db=restoreState(lease.snapshot);try{const bot=new NurseBot(db,env);return send(200,{user:{name:profile.displayName,picture:profile.pictureUrl||null},rows:bot.rows(),config:bot.config()});}finally{db.close();}}
    finally{await store.release(lease).catch(()=>{});}
   }
   let body;try{body=await new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>8192)reject(Error('too_large'));});req.on('end',()=>{try{resolve(JSON.parse(s));}catch{reject(Error('bad_json'));}});});}catch{return send(400,{error:'invalid_request'});}
   if(!Array.isArray(body.rows)||body.rows.length>31||body.rows.some(r=>!validDate(r.date)||!Array.isArray(r.types)||r.types.length>3||r.types.some(t=>!TYPES.includes(t)&&t!=='หยุด')||new Set(r.types).size!==r.types.length||(r.types.includes('หยุด')&&r.types.length!==1)))return send(400,{error:'invalid_schedule'});
   const lease=await store.acquire(profile.userId,{create:true});if(!lease)return send(503,{error:'account_busy'});
   try{const db=restoreState(lease.snapshot);try{const bot=new NurseBot(db,{...env,LINE_OWNER_USER_ID:profile.userId},{fetchFn});const dates=new Set(body.rows.map(r=>r.date));const rows=[...bot.rows().filter(r=>!dates.has(r.date)),...body.rows.flatMap(r=>r.types.length?r.types.map(type=>({date:r.date,type})):[{date:r.date,type:'หยุด'}])];assertNoOverlap(rows,bot.config());
     for(const date of dates){db.prepare('DELETE FROM shifts WHERE date=?').run(date);db.prepare("UPDATE outbox SET state='cancelled' WHERE date=? AND state='pending'").run(date);}
     for(const row of body.rows)for(const type of row.types.length?row.types:['หยุด'])db.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run(row.date,type);
     await store.commit(lease,exportState(db),nextDue(bot));return send(200,{ok:true,rows:bot.rows()});
    }finally{db.close();}}
   finally{await store.release(lease).catch(()=>{});}
  }catch{return send(401,{error:'authentication_or_request_failed'});}
 };
}
