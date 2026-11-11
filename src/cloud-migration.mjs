export function prepareMigration(snapshot){
 const copy=structuredClone(snapshot);
 copy.tables.events=[];copy.tables.pending=[];copy.tables.ui_state=[];
 for(const row of copy.tables.config){const c=JSON.parse(row.json);c.enabled=false;row.json=JSON.stringify(c);}
 return copy;
}
export async function importSnapshot(store,userId,snapshot){
 const lease=await store.acquire(userId,{create:true});
 try{
  if(lease.snapshot)return {skipped:true};
  await store.commit(lease,prepareMigration(snapshot),null);return {imported:true};
 }finally{await store.release(lease);}
}
