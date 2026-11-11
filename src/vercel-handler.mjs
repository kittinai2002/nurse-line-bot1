import {timingSafeEqual} from 'node:crypto';
import {verifySignature} from './bot.mjs';
import {CloudBot} from './cloud-bot.mjs';
import {connectCloudStore} from './cloud-store.mjs';
const secretMatches=(actual,secret)=>{if(typeof secret!=='string'||secret.length<32||typeof actual!=='string')return false;const a=Buffer.from(actual),b=Buffer.from('Bearer '+secret);return a.length===b.length&&timingSafeEqual(a,b);};
export function validateCloudEnv(env){
 if(!/^[a-f0-9]{32}$/i.test(env.LINE_CHANNEL_SECRET||'')||!env.LINE_CHANNEL_ACCESS_TOKEN||!/^U[a-f0-9]{32}$/.test(env.LINE_OWNER_USER_ID||'')||!env.DATABASE_URL||typeof env.CRON_SECRET!=='string'||env.CRON_SECRET.length<32)throw Error('cloud_config_missing');
}
export function createVercelHandler(kind,{env=process.env,storeFactory=connectCloudStore,fetchFn=fetch,now=()=>Date.now()}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  if((kind==='webhook'&&req.method!=='POST')||(kind!=='webhook'&&!['GET','POST'].includes(req.method))){reply(405,{error:'method_not_allowed'});return;}
  // Verify credentials/body before creating any DB connection or account.
  if(kind==='cron'&&!secretMatches(req.headers.authorization,env.CRON_SECRET)){reply(401,{error:'unauthorized'});return;}
  let body;
  if(kind==='webhook'){
   const chunks=[];let size=0;
   try{for await(const chunk of req){size+=chunk.length;if(size>262144){reply(413,{error:'too_large'});return;}chunks.push(Buffer.from(chunk));}}
   catch{reply(400,{error:'invalid_request'});return;}
   const raw=Buffer.concat(chunks);
   if(!verifySignature(raw,req.headers['x-line-signature'],env.LINE_CHANNEL_SECRET)){reply(401,{error:'invalid_signature'});return;}
   try{body=JSON.parse(raw.toString('utf8'));if(!Array.isArray(body.events)||body.events.length>100)throw Error();}
   catch{reply(400,{error:'invalid_events'});return;}
  }
  try{
   validateCloudEnv(env);const store=await storeFactory(env);
   if(kind==='healthz'){await store.ping();reply(200,{ok:true,service:'nurse-line-bot',mode:'vercel'});return;}
   await store.ensureOwner(env.LINE_OWNER_USER_ID);
   const bot=new CloudBot(store,env,{now,fetchFn,deadline:Date.now()+40000});
   if(kind==='webhook'){
    // Await durable processing; no detached timers/tasks that Vercel may freeze.
    await bot.ingest(body.events);reply(200,{ok:true});
   }else{
    const result=await bot.cron();reply(result.failed?503:200,{ok:result.failed===0,...result});
   }
  }catch{
   // Never return DB URLs, LINE tokens, SQL or upstream response bodies to clients/logs.
   reply(503,{error:'temporarily_unavailable'});
  }
 };
}
