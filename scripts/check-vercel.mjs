import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
assert.equal(Number(process.versions.node.split('.')[0]),24,'Use Node.js 24');
for(const path of ['api/webhook.js','api/cron.js','api/healthz.js','src/vercel-handler.mjs','src/cloud-store.mjs','src/cloud-state.mjs','src/cloud-bot.mjs','src/cloud-migration.mjs','scripts/import-cloud.mjs','scripts/cloud-setup.mjs']){
 const result=spawnSync(process.execPath,['--check',path],{cwd:root,encoding:'utf8'});if(result.status!==0)throw Error('Invalid source: '+path);
}
const cfg=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
assert.ok(!cfg.crons,'External minute scheduler is used; no Hobby daily cron.');
assert.equal(cfg.outputDirectory,'public');
const {neon}=await import('@neondatabase/serverless');assert.equal(typeof neon,'function');
const {openDb}=await import('../src/db.mjs');const db=openDb();db.close();
console.log('Vercel source check passed (no database or LINE calls).');
