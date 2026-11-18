import {timingSafeEqual} from 'node:crypto';
import {createRequire} from 'node:module';
import {verifySignature} from './bot.mjs';
import {CloudBot} from './cloud-bot.mjs';
import {connectCloudStore} from './cloud-store.mjs';
const {version}=createRequire(import.meta.url)('../package.json');
const secretMatches=(actual,secret)=>{if(typeof secret!=='string'||secret.length<32||typeof actual!=='string')return false;const a=Buffer.from(actual),b=Buffer.from('Bearer '+secret);return a.length===b.length&&timingSafeEqual(a,b);};
export function validateCloudEnv(env){
 const invalid=[];
 if(!/^[a-f0-9]{32}$/i.test(env.LINE_CHANNEL_SECRET||''))invalid.push('LINE_CHANNEL_SECRET');
 if(!env.LINE_CHANNEL_ACCESS_TOKEN?.trim())invalid.push('LINE_CHANNEL_ACCESS_TOKEN');
 if(!/^U[a-f0-9]{32}$/.test(env.LINE_OWNER_USER_ID||''))invalid.push('LINE_OWNER_USER_ID');
 if(!/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL||''))invalid.push('DATABASE_URL');
 if(typeof env.CRON_SECRET!=='string'||env.CRON_SECRET.length<32)invalid.push('CRON_SECRET');
 if(invalid.length)throw Object.assign(Error('cloud_config_missing'),{code:'CONFIG_INVALID',invalid});
}

function failureCode(err){
 switch(err?.code){
  case 'CONFIG_INVALID':return 'cloud_config_invalid';
  case 'OWNER_MISMATCH':return 'original_owner_mismatch';
  case '42P01':return 'database_schema_missing';
  case '28P01':case '28000':return 'database_auth_failed';
  default:return 'temporarily_unavailable';
 }
}
export function createVercelHandler(kind,{env=process.env,storeFactory=connectCloudStore,fetchFn=fetch,now=()=>Date.now()}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  if((kind==='webhook'&&req.method!=='POST')||(kind!=='webhook'&&!['GET','POST'].includes(req.method))){reply(405,{error:'method_not_allowed'});return;}
  // Verify credentials/body before creating any DB connection or account.
  if(kind==='cron'&&(typeof env.CRON_SECRET!=='string'||env.CRON_SECRET.length<32)){
   console.error('nurse_cloud_error',{route:kind,code:'cloud_config_invalid',variables:['CRON_SECRET']});
   reply(503,{error:'cron_not_configured'});return;
  }
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
   if(kind==='healthz'){await store.ping();reply(200,{ok:true,service:'nurse-line-bot',mode:'vercel',database:'neon',version});return;}
   await store.ensureOwner(env.LINE_OWNER_USER_ID);
   const bot=new CloudBot(store,env,{now,fetchFn,deadline:Date.now()+40000});
   if(kind==='webhook'){
    // Await durable processing; no detached timers/tasks that Vercel may freeze.
    await bot.ingest(body.events);reply(200,{ok:true});
   }else{
    const result=await bot.cron();
    const status=result.failed?503:result.expired||Object.keys(result.lineStatuses).length?502:200;
    reply(status,{ok:status===200,version,...result});
   }
  }catch(err){
   const code=failureCode(err);
   console.error('nurse_cloud_error',{route:kind,code,...(err?.invalid?{variables:err.invalid}:{})});
   reply(503,{error:kind==='cron'?code:'temporarily_unavailable'});
  }
 };
}
