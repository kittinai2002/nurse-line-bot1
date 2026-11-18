import {NurseBot} from '../src/bot.mjs';
import {TursoDatabase} from '../src/turso.mjs';

let db;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'cron_secret_missing' });
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    db ??= new TursoDatabase({ requireRemote: true });
    await db.initSchema();
    const accounts = await db.execute('SELECT user_id FROM accounts');
    const userIds = new Set(accounts.rows.map(row => row.user_id));
    if (process.env.LINE_OWNER_USER_ID) userIds.add(process.env.LINE_OWNER_USER_ID);

    let processed = 0;
    let failed = 0;
    let expired = 0;
    let deliveryFailures = 0;
    for (const userId of userIds) {
      try {
        const bot = new NurseBot(db, process.env, { userId });
        await bot.enqueueReminders();
        const stats = await bot.sendOutbox();
        expired += stats.expired;
        deliveryFailures += stats.deliveryFailures;
        processed++;
      } catch (err) {
        failed++;
        console.error('tick_account_failed', { error: err.name, code: err.code });
      }
    }
    await NurseBot.cleanUp(db, Date.now());
    const status = failed ? 500 : expired || deliveryFailures ? 502 : 200;
    return res.status(status).json({
      ok: status === 200,
      users_processed: processed,
      users_failed: failed,
      reminders_expired: expired,
      delivery_failures: deliveryFailures,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('tick_failed', { error: err.name, code: err.code });
    return res.status(500).json({ error: 'tick_failed' });
  }
}
