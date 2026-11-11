import {NurseBot} from './bot.mjs';
import {exportState,restoreState,nextDue} from './cloud-state.mjs';
import {validPostback} from './flow.mjs';
export function validCloudEvent(e,now=Date.now()){
 if(e?.source?.type!=='user'||!/^U[a-f0-9]{32}$/.test(e.source.userId||''))return false;
 if(typeof e.webhookEventId!=='string'||!e.webhookEventId||typeof e.timestamp!=='number'||!Number.isFinite(e.timestamp)||Math.abs(now-e.timestamp)>10*60000)return false;
 if(e.type==='postback')return validPostback(e.postback);
 if(e.type==='message')return e.message?.type==='text'&&typeof e.message.text==='string'&&e.message.text.length<=5000;
 return ['follow','unfollow'].includes(e.type);
}
export class CloudBot{
 constructor(store,env,{now=()=>Date.now(),fetchFn=fetch,deadline=Date.now()+45000}={}){this.store=store;this.env=env;this.now=now;this.fetch=fetchFn;this.deadline=deadline;}
 async account(userId,events=[],{create=false}={}){
  const lease=await this.store.acquire(userId,{create});if(!lease)return {ignored:true};
  let db;
  try{
   db=restoreState(lease.snapshot);
   const bot=new NurseBot(db,{...this.env,LINE_OWNER_USER_ID:userId},{now:this.now,fetchFn:this.fetch});
   const checkpoint=async()=>{await this.store.commit(lease,exportState(db),nextDue(bot));};
   const line=bot.line.bind(bot);
   bot.line=async(...args)=>{
    if(Date.now()>this.deadline-12000)throw Error('request_budget_exhausted');
    // Persist mutations and retry keys BEFORE any LINE side effect. Commit also fences/renews this lease.
    await checkpoint();return line(...args);
   };
   if(events.length){bot.ingest(events);await checkpoint();}
   await bot.tick();await checkpoint();return {ok:true};
  }finally{
   // Never save uncommitted state after lease failure. Requests retry from the last durable checkpoint.
   if(db)db.close();await this.store.release(lease).catch(()=>{});
  }
 }
 async ingest(events){
  const groups=new Map();for(const e of events){if(!validCloudEvent(e,this.now()))continue;const id=e.source.userId;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(e);}
  for(const [id,batch] of groups){if(Date.now()>this.deadline-12000)throw Error('request_budget_exhausted');await this.account(id,batch,{create:batch.some(e=>e.type!=='unfollow')});}
 }
 async cron(){
  let processed=0,failed=0;const users=await this.store.due(20);
  // Bounded work: remaining due accounts remain due and are picked up by the next invocation.
  for(let i=0;i<users.length;i+=3){if(Date.now()>this.deadline-15000)break;
   const results=await Promise.allSettled(users.slice(i,i+3).map(id=>this.account(id)));
   for(const r of results)r.status==='fulfilled'?processed++:failed++;
  }
  await this.store.heartbeat();return {processed,failed};
 }
}
