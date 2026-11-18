import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {openDb,transaction} from './db.mjs';
import {NurseBot} from './bot.mjs';
import {validPostback} from './flow.mjs';

const validUserId=id=>typeof id==='string'&&/^U[a-f0-9]{32}$/.test(id);

// Every person has a separate SQLite database. The original owner's database
// stays at its original path; no legacy rows are reassigned or copied to others.
export class MultiUserBot {
  constructor(directory,env,options={}) {
    if(!validUserId(env.LINE_OWNER_USER_ID))throw Error('LINE_OWNER_USER_ID must identify the original owner');
    this.directory=directory;this.env=env;this.options=options;
    this.now=options.now||(()=>Date.now());this.bots=new Map();this.busy=false;
    mkdirSync(join(directory,'users'),{recursive:true});
    const db=new DatabaseSync(join(directory,'accounts.sqlite'));
    this.db=db;
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      `);
      transaction(db,()=>{
        const original=db.prepare("SELECT value FROM meta WHERE key='original_owner'").get();
        if(original&&original.value!==env.LINE_OWNER_USER_ID)throw Error('Original owner changed. Restore the original LINE_OWNER_USER_ID; never replace it with a new member.');
        db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('original_owner',?)").run(env.LINE_OWNER_USER_ID);
        db.prepare('INSERT OR IGNORE INTO accounts(user_id,created_at) VALUES(?,?)').run(env.LINE_OWNER_USER_ID,this.now());
      });
      this.forUser(env.LINE_OWNER_USER_ID);
    }catch(error){for(const bot of this.bots.values())bot.db.close();db.close();throw error;}
  }

  forUser(userId) {
    if(!validUserId(userId))throw Error('Invalid LINE user ID');
    const existing=this.bots.get(userId);if(existing)return existing;
    const path=userId===this.env.LINE_OWNER_USER_ID
      ?join(this.directory,'nurse-bot.sqlite')
      :join(this.directory,'users',createHash('sha256').update(userId).digest('hex')+'.sqlite');
    const db=openDb(path);
    try {
      const bot=new NurseBot(db,{...this.env,LINE_OWNER_USER_ID:userId},this.options);
      this.db.prepare('INSERT OR IGNORE INTO accounts(user_id,created_at) VALUES(?,?)').run(userId,this.now());
      this.bots.set(userId,bot);return bot;
    }catch(error){db.close();throw error;}
  }

  ingest(events) {
    for(const event of events) {
      // source.userId is trusted only after createApp has verified LINE's HMAC.
      // Never take identity from message text, a query parameter or a group.
      if(event?.source?.type!=='user'||!validUserId(event.source.userId))continue;
      if(typeof event.webhookEventId!=='string'||!event.webhookEventId||typeof event.timestamp!=='number'||!Number.isFinite(event.timestamp)||Math.abs(this.now()-event.timestamp)>10*60000)continue;
      if(!['message','follow','unfollow','postback'].includes(event.type))continue;
      if(event.type==='postback'&&!validPostback(event.postback))continue;
      if(event.type==='message'&&(event.message?.type!=='text'||typeof event.message.text!=='string'||event.message.text.length>5000))continue;
      // Do not create a new account solely because an unknown person blocked OA.
      if(event.type==='unfollow'&&!this.db.prepare('SELECT 1 FROM accounts WHERE user_id=?').get(event.source.userId))continue;
      this.forUser(event.source.userId).ingest([event]);
    }
  }

  async tick() {
    if(this.busy)return;this.busy=true;
    try {
      for(const account of this.db.prepare('SELECT user_id FROM accounts ORDER BY created_at,user_id').all()) {
        // A failed account must not prevent other people's notifications.
        try {await this.forUser(account.user_id).tick();}
        catch {console.error('account_tick_failed');}
      }
    }finally{this.busy=false;}
  }

  close() {
    for(const bot of this.bots.values())bot.db.close();
    this.bots.clear();this.db.close();
  }
}
