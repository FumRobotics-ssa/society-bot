import { Store } from './store.js';
import { handleUpdate } from './bot.js';
import { now } from './auth.js';
import { runBackup } from './backup.js';

const changes = result => result.meta?.changes || 0;
function cleanError(error, env) {
  let text = String(error?.message || 'job failed').slice(0, 500);
  for (const key of ['BOT_TOKEN', 'WEBHOOK_SECRET', 'S3_SECRET_ACCESS_KEY', 'S3_ACCESS_KEY_ID']) {
    if (env[key]) text = text.replaceAll(env[key], '[redacted]');
  }
  return text;
}
export async function receiveUpdate(env, update) {
  if (!Number.isSafeInteger(update?.update_id)) throw new Error('Invalid update');
  const actor = update.callback_query?.from?.id || update.message?.from?.id || update.update_id;
  await env.DB.prepare('INSERT OR IGNORE INTO inbox(update_id,stream_key,payload) VALUES(?,?,?)').bind(update.update_id, String(actor), JSON.stringify(update)).run();
}
export async function processInbox(env, limit = 1) {
  const store = new Store(env.DB);
  for (let i = 0; i < limit; i++) {
    const job = await env.DB.prepare(`UPDATE inbox SET status='processing',lease_until=?,attempts=attempts+1
      WHERE update_id=(SELECT q.update_id FROM inbox q WHERE ((q.status='new' AND q.available_at<=?) OR
      (q.status='processing' AND q.lease_until<?)) AND NOT EXISTS (
        SELECT 1 FROM inbox earlier WHERE earlier.stream_key=q.stream_key
        AND earlier.update_id<q.update_id AND earlier.status IN ('new','processing')
      ) ORDER BY q.update_id LIMIT 1) RETURNING *`).bind(now() + 90, now(), now()).first();
    if (!job) return;
    try {
      await handleUpdate(JSON.parse(job.payload), env, store);
      await env.DB.prepare("UPDATE inbox SET status='done',processed_at=?,last_error=NULL WHERE update_id=? AND lease_until=?").bind(now(), job.update_id, nowLease(job)).run();
    } catch (error) {
      await env.DB.prepare('UPDATE inbox SET status=?,available_at=?,last_error=? WHERE update_id=? AND lease_until=?')
        .bind(job.attempts >= 8 ? 'failed' : 'new', now() + Math.min(3600, 2 ** job.attempts * 5), cleanError(error, env), job.update_id, job.lease_until).run();
    }
  }
}
function nowLease(job) { return job.lease_until; }

async function broadcast(job, env) {
  const data = JSON.parse(job.payload);
  const cursor = Number(data.cursor || 0);
  const query = data.event_id
    ? `SELECT DISTINCT u.id FROM users u JOIN orders o ON o.user_id=u.id WHERE u.id>? AND u.phone<>'' AND o.event_id=? AND o.status='approved' ORDER BY u.id LIMIT 20`
    : `SELECT id FROM users WHERE id>? AND phone<>'' ORDER BY id LIMIT 20`;
  const args = data.event_id ? [cursor, data.event_id] : [cursor];
  const rows = (await env.DB.prepare(query).bind(...args).all()).results;
  const statements = rows.map((row, index) => env.DB.prepare(`INSERT OR IGNORE INTO outbox(id,method,payload,dedupe_key,available_at) VALUES(?,?,?,?,?)`)
    .bind(crypto.randomUUID(), 'sendMessage', JSON.stringify({ chat_id: row.id, text: data.text }), `${data.broadcast_id || job.id}:user:${row.id}`, now() + Math.floor(index / 10)));
  if (rows.length === 20) {
    const last = rows.at(-1).id;
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO outbox(id,method,payload,dedupe_key,available_at) VALUES(?,?,?,?,?)')
      .bind(crypto.randomUUID(), '__broadcast', JSON.stringify({ ...data, broadcast_id: data.broadcast_id || job.id, cursor: last }), `${data.broadcast_id || job.id}:page:${last}`, now() + 3));
  }
  if (statements.length) await env.DB.batch(statements);
}
async function telegram(method, data, env) {
  if (!/^[A-Za-z]+$/.test(method)) throw new Error('Unknown Telegram method');
  let body, headers;
  if (Object.hasOwn(data, '_documentText')) {
    body = new FormData();
    for (const [key, value] of Object.entries(data)) if (!['_documentText', 'filename'].includes(key)) body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    body.set('document', new Blob([data._documentText], { type: data.filename?.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'application/json' }), data.filename || 'export.json');
  } else { body = JSON.stringify(data); headers = { 'Content-Type': 'application/json' }; }
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!result.ok) {
    const error = new Error(`Telegram ${result.error_code || response.status}: ${result.description || 'request failed'}`);
    error.retryAfter = result.parameters?.retry_after;
    error.permanent = [400, 403, 404].includes(result.error_code);
    throw error;
  }
}
export async function processOutbox(env, limit = 8) {
  for (let i = 0; i < limit; i++) {
    const job = await env.DB.prepare(`UPDATE outbox SET status='processing',lease_until=?,attempts=attempts+1
      WHERE id=(SELECT id FROM outbox WHERE (status='pending' AND available_at<=?) OR
      (status='processing' AND lease_until<?) ORDER BY available_at,created_at LIMIT 1) RETURNING *`).bind(now() + 90, now(), now()).first();
    if (!job) return;
    try {
      if (job.method === '__broadcast') await broadcast(job, env);
      else if (job.method === '__backup') await runBackup(env, job.id);
      else await telegram(job.method, JSON.parse(job.payload), env);
      await env.DB.prepare("UPDATE outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=? AND lease_until=?").bind(now(), job.id, job.lease_until).run();
    } catch (error) {
      const failed = error.permanent || job.attempts >= 10;
      await env.DB.prepare('UPDATE outbox SET status=?,available_at=?,last_error=? WHERE id=? AND lease_until=?')
        .bind(failed ? 'failed' : 'pending', now() + Math.max(2, Number(error.retryAfter || Math.min(3600, 2 ** job.attempts * 3))), cleanError(error, env), job.id, job.lease_until).run();
    }
  }
}
export async function maintenance(env, at = new Date()) {
  const store = new Store(env.DB);
  await store.expireOrders();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_codes WHERE expires_at<?').bind(now()),
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(now()),
    env.DB.prepare("DELETE FROM inbox WHERE status='done' AND processed_at<?").bind(now() - 7 * 86400),
    env.DB.prepare("DELETE FROM outbox WHERE status='sent' AND sent_at<?").bind(now() - 7 * 86400),
  ]);
  // Queue once per UTC day on the first cron run, even if the midnight run was delayed.
  if (env.BACKUP_CHAT || env.S3_BUCKET) {
    await store.enqueue('__backup', {}, `backup:${at.toISOString().slice(0, 10)}`);
  }
}
export async function runJobs(env, { maintenance: maintain = false } = {}) {
  if (maintain) await maintenance(env);
  await processInbox(env, 1);
  await processOutbox(env, 8);
}
