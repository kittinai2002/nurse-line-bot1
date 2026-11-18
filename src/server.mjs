import {createServer} from 'node:http';
import {mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {verifySignature} from './bot.mjs';
import {MultiUserBot} from './multi-user.mjs';

export function createApp(bot,env,options={}) {
  return createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const url=new URL(req.url,'http://localhost');
    const reply=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj));};
    if(req.method==='GET'&&url.pathname==='/healthz') {try{bot.db.prepare('SELECT 1').get();reply(200,{ok:true,service:'nurse-line-bot'});}catch{reply(503,{ok:false});}return;}
    if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/info')){reply(200,{ok:true,service:'nurse-line-bot',message:'ใช้งานใน LINE OA โดยส่งคำว่า เมนู'});return;}
    if(req.method!=='POST'||url.pathname!=='/webhook'){reply(404,{error:'not_found'});return;}
    let raw;
    try {
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>262144){reply(413,{error:'too_large'});req.destroy();return;}chunks.push(chunk);}
      raw=Buffer.concat(chunks);
    }catch {if(!res.headersSent)reply(400,{error:'invalid_request'});return;}
    if(!verifySignature(raw,req.headers['x-line-signature'],env.LINE_CHANNEL_SECRET)){reply(401,{error:'invalid_signature'});return;}
    try {
      const body=JSON.parse(raw.toString('utf8'));
      if(!Array.isArray(body.events)||body.events.length>100){reply(400,{error:'invalid_events'});return;}
      bot.ingest(body.events);reply(200,{ok:true});
      // A persisted queue survives process restarts; inbound requests never wait for LINE replies.
      void bot.tick().catch(()=>console.error('bot_tick_failed'));
    }catch {reply(500,{error:'processing_failed'});}
  });
}
export function start(env=process.env) {
  for(const key of ['LINE_CHANNEL_SECRET','LINE_CHANNEL_ACCESS_TOKEN','LINE_OWNER_USER_ID']) if(!env[key]) throw Error(`Missing required environment variable: ${key}`);
  if(!/^U[a-f0-9]{32}$/.test(env.LINE_OWNER_USER_ID))throw Error('LINE_OWNER_USER_ID must be the user ID for this provider');
  const directory=env.DATA_DIR||'./data';mkdirSync(directory,{recursive:true});
  const bot=new MultiUserBot(directory,env);const db=bot.db;const server=createApp(bot,env);
  const interval=setInterval(()=>void bot.tick().catch(()=>console.error('bot_tick_failed')),1000);
  server.listen(Number(env.PORT||3000),env.HOST||'0.0.0.0',()=>console.log('nurse_bot_ready'));
  let stopping=false;
  const stop=()=>{if(stopping)return;stopping=true;clearInterval(interval);server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),12000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  return {server,bot,db};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)start();
