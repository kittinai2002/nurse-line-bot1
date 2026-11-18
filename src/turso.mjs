export class TursoDatabase {
  constructor({ url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN, requireRemote = false } = {}) {
    const remote = typeof url === 'string' && /^(libsql|https):\/\//.test(url);
    if (!remote && (requireRemote || !url?.startsWith('file:'))) {
      throw Error('Set TURSO_DATABASE_URL to a libsql:// or https:// Turso URL');
    }
    if (requireRemote && !authToken?.trim()) throw Error('Set TURSO_AUTH_TOKEN');
    this.url = remote ? new URL(url.replace(/^libsql:/, 'https:')).href : url;
    this.authToken = authToken;
    this.remote = remote;
  }

  async getClient() {
    this.clientPromise ??= (async () => {
      const { createClient } = this.remote
        ? await import('@libsql/client/web')
        : await import('@libsql/client');
      return createClient({ url: this.url, authToken: this.authToken });
    })();
    return this.clientPromise;
  }

  async execute(sql, args = []) {
    return (await this.getClient()).execute({ sql, args });
  }

  async withWriteTransaction(work) {
    const tx = await (await this.getClient()).transaction('write');
    const database = {
      execute: (sql, args = []) => tx.execute({ sql, args }),
      withWriteTransaction: callback => callback(database)
    };
    try {
      const result = await work(database);
      await tx.commit();
      return result;
    } catch (err) {
      if (!tx.closed) await tx.rollback();
      throw err;
    } finally {
      tx.close();
    }
  }

  async close() {
    (await this.getClient()).close();
  }

  async initSchema() {
    this.schemaPromise ??= this.createSchema().catch(err => {
      this.schemaPromise = null;
      throw err;
    });
    return this.schemaPromise;
  }

  async createSchema() {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS accounts (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS config (user_id TEXT PRIMARY KEY, json TEXT NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS shifts (user_id TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY(user_id, date, type));`,
      `CREATE TABLE IF NOT EXISTS ui_state (user_id TEXT PRIMARY KEY, json TEXT NOT NULL, expires INTEGER NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, json TEXT NOT NULL, expires INTEGER NOT NULL);`,
      `CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload TEXT, received INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'new', response TEXT);`,
      `CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, retry_key TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL, expires INTEGER NOT NULL, next_attempt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', last_status INTEGER, accepted_at INTEGER);`,
      `CREATE INDEX IF NOT EXISTS outbox_user_due ON outbox(user_id, state, next_attempt);`,
      `CREATE INDEX IF NOT EXISTS outbox_user_date ON outbox(user_id, date);`,
      `CREATE INDEX IF NOT EXISTS shifts_user_date ON shifts(user_id, date);`
    ];
    await (await this.getClient()).batch(stmts, 'write');
  }
}
