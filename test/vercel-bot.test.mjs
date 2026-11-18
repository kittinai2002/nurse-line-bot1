import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import webhook from '../api/webhook.js';
import tick from '../api/tick.js';
import {TursoDatabase} from '../src/turso.mjs';
import {NurseBot} from '../src/bot.mjs';
import {parseSchedule, DEFAULT_CONFIG, shiftRange, bangkokDate, nextMonth} from '../src/domain.mjs';

const owner = 'U' + 'a'.repeat(32);

async function fixture(t, now = Date.parse('2026-11-01T07:00:00+07:00'), fetchFn = async () => new Response('{}', { status: 200 })) {
  const directory = await mkdtemp(join(tmpdir(), 'nurse-bot-test-'));
  const db = new TursoDatabase({ url: pathToFileURL(join(directory, 'schedule.sqlite')).href });
  t.after(() => db.close());
  await db.initSchema();
  const clock = { value: now };
  const env = { LINE_OWNER_USER_ID: owner, LINE_CHANNEL_SECRET: 'test-secret', LINE_CHANNEL_ACCESS_TOKEN: 'fake-token' };
  const bot = new NurseBot(db, env, { now: () => clock.value, fetchFn });
  return { db, clock, bot, env };
}

test('Thai year, multi shifts, explicit day off and invalid days', () => {
  const rows = parseSchedule('เพิ่มเวร 2569-11\n1 ช บ\n2 ด\n3 ห');
  assert.deepEqual(rows[0], { date: '2026-11-01', types: ['เช้า', 'บ่าย'] });
  assert.deepEqual(rows[2].types, []);
  for (const text of ['เพิ่มเวร 2026-02\n30 ช', 'เพิ่มเวร 2026-11\n1 ช\n1 บ', 'เพิ่มเวร 2026-11\n1 ช ห', 'เพิ่มเวร 2026-11\n1 X', 'เพิ่มเวร 2026-11\n1 ช ช']) {
    assert.throws(() => parseSchedule(text));
  }
});

test('midnight shifts are dated by start; Bangkok year rollover', () => {
  const c = DEFAULT_CONFIG();
  const night = shiftRange('2026-11-02', 'ดึก', c);
  const evening = shiftRange('2026-11-01', 'บ่าย', c);
  assert.equal(new Date(night.start).toISOString(), '2026-11-01T17:00:00.000Z');
  assert.equal(evening.end, night.start);
  assert.equal(bangkokDate(Date.parse('2026-12-31T18:00:00Z')), '2027-01-01');
  assert.equal(nextMonth(Date.parse('2026-12-15T00:00:00Z')), '2027-01');
});

test('database operations and schedule workflow in Turso async model', async t => {
  const { bot } = await fixture(t);
  await bot.handle('ยืนยันเวลาเวร');

  const preview = await bot.handle('เพิ่มเวร 2026-11\n1 ช\n2 บ');
  assert.equal((await bot.rows()).length, 0);

  const confirmMsg = preview.quickReply.items[0].action.text;
  await bot.handle(confirmMsg);
  const rows = await bot.rows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows, [{ date: '2026-11-01', type: 'เช้า' }, { date: '2026-11-02', type: 'บ่าย' }]);

  const todayView = await bot.handle('เวรวันนี้');
  assert.ok(todayView.text.includes('เวรเช้า') || todayView.text.includes('08:00'));

  const calView = await bot.handle('ตารางเวรของฉัน');
  assert.equal(calView.type, 'flex');
});

test('flow postback and setting shift hours', async t => {
  const { bot } = await fixture(t);
  const menu = await bot.handle('เมนู');
  assert.ok(menu.text.includes('เหมียวเตือนเวร'));

  const settings = await bot.handle('ตั้งค่า');
  assert.ok(settings.text.includes('ตั้งค่า'));

  const changeLead = await bot.handle('เตือนล่วงหน้า 45');
  assert.ok(changeLead.text.includes('45 นาที'));
  assert.equal((await bot.config()).lead, 45);
});

test('reminder enqueue and outbox processing', async t => {
  const { bot, clock } = await fixture(t, Date.parse('2026-11-01T06:00:00+07:00'));
  await bot.handle('ยืนยันเวลาเวร');
  const p = await bot.handle('เพิ่มเวร 2026-11\n1 ช');
  await bot.handle(p.quickReply.items[0].action.text);
  await bot.handle('เปิดแจ้งเตือน');
  assert.equal((await bot.config()).enabled, true);

  // Advance time to 07:00 (60 minutes before 08:00 shift)
  clock.value = Date.parse('2026-11-01T07:00:00+07:00');
  await bot.enqueueReminders();

  const outboxRes = await bot.db.execute('SELECT * FROM outbox WHERE user_id = ?', [bot.userId]);
  assert.equal(outboxRes.rows.length, 1);
  assert.equal(outboxRes.rows[0].type, 'เช้า');
});

function response() {
  return {
    status(code) { this.code = code; return this; },
    json(body) { return { status: this.code, body }; }
  };
}

test('webhook verifies untouched bytes and rejects an invalid signature', async t => {
  const saved = process.env.LINE_CHANNEL_SECRET;
  process.env.LINE_CHANNEL_SECRET = 'local-webhook-test';
  t.after(() => {
    if (saved === undefined) delete process.env.LINE_CHANNEL_SECRET;
    else process.env.LINE_CHANNEL_SECRET = saved;
  });

  const raw = Buffer.from('{ "events": [], "destination": "ทดสอบ" }\n');
  const signature = createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(raw).digest('base64');
  const request = value => {
    const req = Readable.from([raw.subarray(0, 46), raw.subarray(46)]);
    req.method = 'POST';
    req.headers = { 'x-line-signature': value };
    Object.defineProperty(req, 'body', { get() { throw Error('Request parsing must follow signature verification'); } });
    return req;
  };

  assert.equal((await webhook(request(signature), response())).status, 200);
  assert.equal((await webhook(request('invalid'), response())).status, 401);
});

test('a redelivered event only changes state and replies once', async t => {
  let replies = 0;
  const { bot, db, clock } = await fixture(t, undefined, async () => {
    replies++;
    return new Response('{}', { status: 200 });
  });
  const event = {
    type: 'message', source: { type: 'user', userId: bot.userId }, timestamp: clock.value,
    webhookEventId: 'same-event', replyToken: 'test',
    message: { type: 'text', text: 'เพิ่มเวร 2026-11\n1 ช' }
  };

  await bot.processEvent(event);
  await bot.processEvent(event);
  assert.equal(replies, 1);
  assert.equal((await db.execute('SELECT count(*) AS count FROM pending')).rows[0].count, 1);
});

test('a failed multi-day save rolls back and can be retried with the same event', async t => {
  const { bot, db, clock } = await fixture(t);
  const original = await bot.handle('เพิ่มเวร 2026-11\n1 ช\n2 ช');
  await bot.handle(original.quickReply.items[0].action.text);
  const preview = await bot.handle('เพิ่มเวร 2026-11\n1 ด\n2 บ');
  await db.execute(`CREATE TRIGGER simulate_second_day_failure BEFORE INSERT ON shifts
    WHEN NEW.date = '2026-11-02' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
  const event = {
    type: 'message', source: { type: 'user', userId: bot.userId }, timestamp: clock.value,
    webhookEventId: 'retryable-save', message: { type: 'text', text: preview.quickReply.items[0].action.text }
  };

  await assert.rejects(bot.processEvent(event), /simulated write failure/);
  assert.deepEqual((await bot.rows()).map(row => row.type), ['เช้า', 'เช้า']);
  assert.equal((await db.execute('SELECT count(*) AS count FROM events')).rows[0].count, 0);
  await db.execute('DROP TRIGGER simulate_second_day_failure');
  await bot.processEvent(event);
  assert.deepEqual((await bot.rows()).map(row => row.type), ['ดึก', 'บ่าย']);
});

test('concurrent outbox workers only send one push for a queued shift', async t => {
  let pushes = 0;
  let startPush;
  let finishPush;
  const started = new Promise(resolve => { startPush = resolve; });
  const finish = new Promise(resolve => { finishPush = resolve; });
  const { bot, db, clock } = await fixture(t, Date.parse('2026-11-01T06:00:00+07:00'), async () => {
    pushes++;
    startPush();
    await finish;
    return new Response('{}', { status: 200 });
  });
  await bot.handle('ยืนยันเวลาเวร');
  const preview = await bot.handle('เพิ่มเวร 2026-11\n1 ช');
  await bot.handle(preview.quickReply.items[0].action.text);
  await bot.handle('เปิดแจ้งเตือน');
  await bot.enqueueReminders();
  clock.value = Date.parse('2026-11-01T07:00:00+07:00');

  const first = bot.sendOutbox();
  try {
    await Promise.race([started, first]);
    assert.equal(pushes, 1);
    await bot.sendOutbox();
    assert.equal(pushes, 1);
  } finally {
    finishPush();
    await first;
  }
  assert.equal((await db.execute('SELECT state FROM outbox')).rows[0].state, 'sent');
});

test('a reminder queued before an outage is reported as expired on recovery', async t => {
  const { bot, db, clock } = await fixture(t, Date.parse('2026-11-01T06:00:00+07:00'), () => {
    throw Error('Unexpected push');
  });
  await bot.handle('ยืนยันเวลาเวร');
  const preview = await bot.handle('เพิ่มเวร 2026-11\n1 ช');
  await bot.handle(preview.quickReply.items[0].action.text);
  await bot.handle('เปิดแจ้งเตือน');
  await bot.tick();
  clock.value = Date.parse('2026-11-01T07:10:00+07:00');
  assert.deepEqual(await bot.tick(), { expired: 1, deliveryFailures: 0 });
  assert.equal((await db.execute('SELECT state FROM outbox')).rows[0].state, 'expired');
  await bot.handle('เตือนล่วงหน้า 30');
  await bot.tick();
  const reminder = (await db.execute('SELECT state, next_attempt FROM outbox')).rows[0];
  assert.equal(reminder.state, 'pending');
  assert.equal(reminder.next_attempt, Date.parse('2026-11-01T07:30:00+07:00'));
});

test('cron requires a secret and only accepts bearer authentication', async t => {
  const saved = process.env.CRON_SECRET;
  t.after(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });
  delete process.env.CRON_SECRET;
  assert.equal((await tick({ method: 'GET', headers: {} }, response())).status, 503);
  process.env.CRON_SECRET = 'local-cron-test';
  assert.equal((await tick({ method: 'GET', headers: {}, query: { secret: 'local-cron-test' } }, response())).status, 401);
});

test('a production database requires a remote URL and a token', () => {
  assert.throws(() => new TursoDatabase({ url: '', requireRemote: true }), /TURSO_DATABASE_URL/);
  assert.throws(() => new TursoDatabase({ url: 'libsql://database.example', authToken: '', requireRemote: true }), /TURSO_AUTH_TOKEN/);
});


test('LINE delivery retries reuse the same key and recognize prior acceptance', async t => {
  t.mock.method(console, 'error', () => {});
  const keys = [];
  const { bot, db, clock } = await fixture(t, undefined, async (url, options) => {
    keys.push(options.headers['X-Line-Retry-Key']);
    return keys.length === 1
      ? new Response('{}', { status: 429 })
      : new Response('{}', { status: 409, headers: { 'x-line-accepted-request-id': 'accepted-on-line' } });
  });
  await bot.handle('ยืนยันเวลาเวร');
  const preview = await bot.handle('เพิ่มเวร 2026-11\n1 ช');
  await bot.handle(preview.quickReply.items[0].action.text);
  await bot.handle('เปิดแจ้งเตือน');
  assert.equal((await bot.tick()).deliveryFailures, 1);
  clock.value += 60000;
  assert.equal((await bot.tick()).deliveryFailures, 0);
  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
  const reminder = (await db.execute('SELECT state, attempts FROM outbox')).rows[0];
  assert.equal(reminder.state, 'sent');
  assert.equal(reminder.attempts, 2);
});
