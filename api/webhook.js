import {verifySignature, NurseBot} from '../src/bot.mjs';
import {TursoDatabase} from '../src/turso.mjs';

let db;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, message: 'LINE Webhook endpoint ready. Send POST from LINE.' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks);
  if (!verifySignature(rawBody, req.headers['x-line-signature'], process.env.LINE_CHANNEL_SECRET)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }
  if (!Array.isArray(body?.events)) {
    return res.status(400).json({ error: 'invalid_events' });
  }
  const events = body.events.filter(e => e?.source?.type === 'user' && e.source.userId);
  if (!events.length) return res.status(200).json({ ok: true });

  try {
    db ??= new TursoDatabase({ requireRemote: true });
    await db.initSchema();
    for (const event of events) {
      await new NurseBot(db, process.env, { userId: event.source.userId }).processEvent(event);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('webhook_processing_failed', { error: err.name, code: err.code });
    return res.status(500).json({ error: 'webhook_processing_failed' });
  }
}
