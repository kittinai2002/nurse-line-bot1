import {randomUUID} from 'node:crypto';
export class LeaseLostError extends Error{constructor(){super('account_lease_lost');}}
export class AccountBusyError extends Error{constructor(){super('account_busy');}}
export class CloudStore{
 constructor(query){this.query=query;}
 async ensureOwner(owner){
  if(!/^U[a-f0-9]{32}$/.test(owner||''))throw Error('invalid_original_owner');
  await this.query("INSERT INTO nurse_meta(key,value) VALUES('original_owner',$1) ON CONFLICT(key) DO NOTHING",[owner]);
  const [row]=await this.query("SELECT value FROM nurse_meta WHERE key='original_owner'",[]);
  if(row?.value!==owner)throw Error('original_owner_changed');
 }
 async acquire(userId,{create=false}={}){
  if(!/^U[a-f0-9]{32}$/.test(userId||''))throw Error('invalid_user');
  if(create)await this.query('INSERT INTO nurse_cloud_accounts(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING',[userId]);
  const token=randomUUID();
  const [row]=await this.query(`UPDATE nurse_cloud_accounts SET lease_owner=$2::uuid,lease_until=clock_timestamp()+interval '90 seconds'
   WHERE user_id=$1 AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING snapshot,revision`,[userId,token]);
  if(!row){const existing=await this.query('SELECT user_id FROM nurse_cloud_accounts WHERE user_id=$1',[userId]);if(!existing.length)return null;throw new AccountBusyError();}
  return {userId,token,snapshot:row.snapshot,revision:String(row.revision)};
 }
 async commit(lease,snapshot,due){
  const [row]=await this.query(`UPDATE nurse_cloud_accounts SET snapshot=$3::jsonb,revision=revision+1,next_due=$4::timestamptz,
   lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
   WHERE user_id=$1 AND lease_owner=$2::uuid AND lease_until>clock_timestamp() AND revision=$5::bigint RETURNING revision`,
   [lease.userId,lease.token,JSON.stringify(snapshot),due===null?null:new Date(due).toISOString(),lease.revision]);
  if(!row)throw new LeaseLostError();lease.revision=String(row.revision);
 }
 async release(lease){await this.query('UPDATE nurse_cloud_accounts SET lease_owner=NULL,lease_until=NULL WHERE user_id=$1 AND lease_owner=$2::uuid',[lease.userId,lease.token]);}
 async due(limit=20){return (await this.query(`SELECT user_id FROM nurse_cloud_accounts WHERE next_due<=clock_timestamp()
  AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY next_due,user_id LIMIT $1`,[limit])).map(r=>r.user_id);}
 async heartbeat(){await this.query("INSERT INTO nurse_meta(key,value) VALUES('last_cron',clock_timestamp()::text) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[]);}
 async ping(){await this.query('SELECT 1',[]);}
 async verifyLineToken(token,clientId){
  const r=await fetch('https://api.line.me/oauth2/v2.1/verify?'+new URLSearchParams({access_token:token}),{signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('invalid_line_token');const data=await r.json();
  if(data.client_id!==clientId||Number(data.expires_in)<0)throw Error('wrong_line_client');
  const p=await fetch('https://api.line.me/v2/profile',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(8000)});
  if(!p.ok)throw Error('line_profile_failed');const profile=await p.json();
  if(!/^U[a-f0-9]{32}$/.test(profile.userId||''))throw Error('invalid_line_user');return profile;
 }
}
export async function connectCloudStore(env){
 if(!env.DATABASE_URL||!/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL))throw Error('database_not_configured');
 const {neon}=await import('@neondatabase/serverless');
 const sql=neon(env.DATABASE_URL);
 return new CloudStore((query,params)=>sql.query(query,params,{fetchOptions:{signal:AbortSignal.timeout(10000)}}));
}
