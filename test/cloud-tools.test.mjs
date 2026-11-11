import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,copyFileSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseEnv} from 'node:util';
import {MultiUserBot} from '../src/multi-user.mjs';
const A='U'+'a'.repeat(32),envText='LINE_OWNER_USER_ID='+A+'\nLINE_CHANNEL_SECRET='+'a'.repeat(32)+'\nLINE_CHANNEL_ACCESS_TOKEN=fake-token\n';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'nurse-cloud-tools-'));mkdirSync(join(root,'scripts'));cpSync(new URL('../src',import.meta.url),join(root,'src'),{recursive:true});for(const name of ['cloud-setup.mjs','import-cloud.mjs'])copyFileSync(new URL('../scripts/'+name,import.meta.url),join(root,'scripts',name));writeFileSync(join(root,'.env'),envText);t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('cloud setup preserves existing LINE env and never overwrites an existing private cloud configuration',t=>{
 const root=fixture(t),run=()=>spawnSync(process.execPath,[join(root,'scripts/cloud-setup.mjs')],{encoding:'utf8'});
 assert.equal(run().status,0);const cloud=readFileSync(join(root,'.env.vercel'),'utf8'),values=parseEnv(cloud);assert.equal(values.LINE_OWNER_USER_ID,A);assert.equal(values.LINE_CHANNEL_ACCESS_TOKEN,'fake-token');assert.equal(values.CRON_SECRET.length,64);assert.equal(readFileSync(join(root,'.env'),'utf8'),envText);
 assert.equal(run().status,0);assert.equal(readFileSync(join(root,'.env.vercel'),'utf8'),cloud);
});
test('cloud migration dry-run reads old data without network or changing files, and wrong owner is refused',t=>{
 const root=fixture(t),manager=new MultiUserBot(join(root,'data'),{LINE_OWNER_USER_ID:A});manager.forUser(A).db.prepare('INSERT INTO shifts(date,type) VALUES(?,?)').run('2026-12-01','หยุด');manager.close();const before=readFileSync(join(root,'data','nurse-bot.sqlite'));
 const run=()=>spawnSync(process.execPath,[join(root,'scripts/import-cloud.mjs')],{encoding:'utf8',env:{PATH:process.env.PATH}});
 const r=run();assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/ตรวจพบ 1 บัญชี/);assert.deepEqual(readFileSync(join(root,'data','nurse-bot.sqlite')),before);
 writeFileSync(join(root,'.env.vercel'),'LINE_OWNER_USER_ID=U'+'b'.repeat(32)+'\n');const bad=run();assert.equal(bad.status,1);assert.match(bad.stderr,/เจ้าของไม่ตรง/);assert.ok(!bad.stderr.includes('fake-token'));
});
