import { Store } from './store.js';
import { handleUpdate, notifyOrder } from './bot.js';
import { now } from './auth.js';
import { runBackup } from './backup.js';
import { inspectTelegramBurst, TELEGRAM_PENDING_LIMIT } from './telegram-ingress.js';

const changes = result => result.meta?.changes || 0;
const receiptDeliveryUnconfirmed = 'Receipt delivery unconfirmed. Review the receipt in the admin panel.';
function cleanError(error, env) {
  let text = String(error?.message || 'job failed').slice(0, 500);
  for (const key of ['BOT_TOKEN', 'WEBHOOK_SECRET', 'S3_SECRET_ACCESS_KEY', 'S3_ACCESS_KEY_ID']) {
    if (env[key]) text = text.replaceAll(env[key], '[redacted]');
  }
  return text;
}
function isBlockedTelegramUser(env, id) {
  return id != null && Boolean(env.BLOCKED_TELEGRAM_USER_IDS?.split(',').some(value => value.trim() === String(id)));
}

export async function receiveUpdate(env, update) {
  if (!Number.isSafeInteger(update?.update_id)) throw new Error('Invalid update');
  const actor = update.callback_query?.from?.id || update.message?.from?.id;
  if (isBlockedTelegramUser(env, actor)) return null;
  const streamKey = String(actor || update.update_id);
  let limited = false;
  if (actor && env.TELEGRAM_INGRESS_RATE) {
    try { limited = !(await env.TELEGRAM_INGRESS_RATE.limit({ key: streamKey })).success; }
    catch { console.warn('Telegram request limiter unavailable; using the database queue limit'); }
  }
  if (!limited) {
    const accepted = await env.DB.prepare(`INSERT OR IGNORE INTO inbox(update_id,stream_key,payload)
      SELECT ?,?,? WHERE NOT EXISTS (
        SELECT 1 FROM telegram_abuse_blocks WHERE stream_key=? AND unblocked_at IS NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM inbox INDEXED BY inbox_stream_active WHERE stream_key=? AND status IN ('new','processing')
        LIMIT 1 OFFSET ?
      )`).bind(update.update_id, streamKey, JSON.stringify(update), streamKey, streamKey, TELEGRAM_PENDING_LIMIT - 1).run();
    if (accepted.meta.changes) return streamKey;
  }
  if (actor) {
    try { await inspectTelegramBurst(env, streamKey, update); }
    catch { console.error('Could not verify the Telegram burst'); }
  }
  return null;
}
export async function processInbox(env, limit = 1, streamKey = null) {
  const store = new Store(env.DB);
  const active = "status IN ('new','processing')";
  const heads = streamKey === null
    ? `SELECT stream_key, MIN(update_id) AS update_id FROM inbox INDEXED BY inbox_stream_active WHERE ${active} GROUP BY stream_key`
    : `SELECT MIN(update_id) AS update_id FROM inbox INDEXED BY inbox_stream_active WHERE stream_key=? AND ${active}`;
  const target = streamKey === null ? [] : [streamKey];
  const fairBatch = streamKey === null && limit > 1;
  const served = new Set();
  const priority = fairBatch ? "h.stream_key IN (SELECT value FROM json_each(?)), " : "";
  for (let i = 0; i < limit; i++) {
    const at = now();
    // Find each stream's head using only active rows. A head in backoff still blocks later updates.
    const job = await env.DB.prepare(`WITH stream_heads AS (${heads})
    UPDATE inbox SET status='processing',lease_until=?,attempts=attempts+1
    WHERE update_id=(
      SELECT q.update_id FROM stream_heads h JOIN inbox q ON q.update_id=h.update_id
      WHERE (q.status='new' AND q.available_at<=?) OR (q.status='processing' AND q.lease_until<?)
      ORDER BY ${priority}q.update_id LIMIT 1
    ) RETURNING *, EXISTS(SELECT 1 FROM telegram_abuse_blocks WHERE stream_key=inbox.stream_key AND unblocked_at IS NULL)
      AS automatically_blocked`).bind(...target, at + 90, at, at, ...(fairBatch ? [JSON.stringify([...served])] : [])).first();
    if (!job) return;
    if (fairBatch) served.add(job.stream_key);
    try {
      if (!job.automatically_blocked && !isBlockedTelegramUser(env, job.stream_key)) {
        await handleUpdate(JSON.parse(job.payload), env, store);
      }
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
  const legacyAudience = /^legacy:([1-9]\d*)$/.exec(String(data.audience_key || ''));
  const currentAudience = /^current:([1-9]\d*)$/.exec(String(data.audience_key || ''));
  if (data.audience_key && !legacyAudience && !currentAudience) throw new Error('Invalid broadcast audience key');
  const eventId = currentAudience ? Number(currentAudience[1]) : data.event_id;
  const query = legacyAudience
    ? `SELECT DISTINCT u.id FROM users u JOIN legacy_event_participants ep ON ep.user_id=u.id WHERE u.id>? AND u.phone<>'' AND ep.legacy_event_id=? ORDER BY u.id LIMIT 20`
    : eventId
    ? `SELECT DISTINCT u.id FROM users u JOIN orders o ON o.user_id=u.id WHERE u.id>? AND u.phone<>'' AND o.event_id=? AND o.status='approved' ORDER BY u.id LIMIT 20`
    : `SELECT id FROM users WHERE id>? AND phone<>'' ORDER BY id LIMIT 20`;
  const args = legacyAudience ? [cursor, Number(legacyAudience[1])] : eventId ? [cursor, Number(eventId)] : [cursor];
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
async function telegram(method, data, env, timeout) {
  if (!/^[A-Za-z]+$/.test(method)) throw new Error('Unknown Telegram method');
  let body, headers;
  if (Object.hasOwn(data, '_documentText')) {
    body = new FormData();
    for (const [key, value] of Object.entries(data)) if (!['_documentText', 'filename'].includes(key)) body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    body.set('document', new Blob([data._documentText], { type: data.filename?.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'application/json' }), data.filename || 'export.json');
  } else { body = JSON.stringify(data); headers = { 'Content-Type': 'application/json' }; }
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout) });
  const result = await response.json();
  if (!result.ok) {
    const error = new Error(`Telegram ${result.error_code || response.status}: ${result.description || 'request failed'}`);
    error.retryAfter = result.parameters?.retry_after;
    error.safeToRetry = result.error_code === 429;
    error.permanent = [400, 403, 404].includes(result.error_code);
    throw error;
  }
}
export async function processOutbox(env, limit = 8) {
  for (let i = 0; i < limit; i++) {
    const at = now();
    // A timed-out receipt send or an expired send lease may already have posted the media.
    const job = await env.DB.prepare(`WITH next_job AS MATERIALIZED (
      SELECT id, method IN ('sendPhoto','sendDocument') AND COALESCE(dedupe_key,'') LIKE 'receipt:%'
        AND (status='processing' OR (last_error IS NOT NULL AND last_error NOT LIKE 'Telegram 429:%')) AS uncertain_receipt
      FROM outbox WHERE (status='pending' AND available_at<=?) OR (status='processing' AND lease_until<?)
      ORDER BY available_at,created_at LIMIT 1
    )
    UPDATE outbox SET
      status=CASE WHEN next_job.uncertain_receipt THEN 'failed' ELSE 'processing' END,
      lease_until=CASE WHEN next_job.uncertain_receipt THEN 0 ELSE ? END,
      attempts=attempts + (NOT next_job.uncertain_receipt),
      last_error=CASE WHEN next_job.uncertain_receipt THEN ? ELSE last_error END
    FROM next_job WHERE outbox.id=next_job.id RETURNING *`).bind(at, at, at + 90, receiptDeliveryUnconfirmed).first();
    if (!job) return;
    if (job.status === 'failed') continue;
    const receiptDelivery = job.dedupe_key?.startsWith('receipt:') && ['sendPhoto', 'sendDocument'].includes(job.method);
    try {
      if (job.method === '__broadcast') await broadcast(job, env);
      else if (job.method === '__backup') await runBackup(env, job.id);
      else if (job.method === '__notify_late_payment') {
        const store = new Store(env.DB);
        const { order_id } = JSON.parse(job.payload);
        const order = await store.getOrder(order_id);
        if (order?.status === 'approved') {
          await notifyOrder(order, env, store, job.dedupe_key, '✅ پرداخت شما تأیید شد و بلیت برای شما صادر شد.');
        }
      } else await telegram(job.method, JSON.parse(job.payload), env, receiptDelivery ? 25000 : 10000);
      await env.DB.prepare("UPDATE outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=? AND lease_until=?").bind(now(), job.id, job.lease_until).run();
    } catch (error) {
      const uncertainReceipt = receiptDelivery && !error.permanent && !error.safeToRetry;
      const failed = uncertainReceipt || error.permanent || job.attempts >= 10;
      const detail = cleanError(error, env);
      await env.DB.prepare('UPDATE outbox SET status=?,available_at=?,last_error=? WHERE id=? AND lease_until=?')
        .bind(failed ? 'failed' : 'pending', now() + Math.max(2, Number(error.retryAfter || Math.min(3600, 2 ** job.attempts * 3))),
          uncertainReceipt ? `${receiptDeliveryUnconfirmed} ${detail}` : detail, job.id, job.lease_until).run();
    }
  }
}
export async function maintenance(env, at = new Date()) {
  const store = new Store(env.DB);
  await store.expireOrders();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_codes WHERE expires_at<?').bind(now()),
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(now()),
    env.DB.prepare("DELETE FROM inbox INDEXED BY inbox_retention WHERE status='done' AND processed_at<?").bind(now() - 7 * 86400),
    env.DB.prepare("DELETE FROM outbox INDEXED BY outbox_retention WHERE status='sent' AND sent_at<?").bind(now() - 7 * 86400),
  ]);
  // Queue once per UTC day on the first cron run, even if the midnight run was delayed.
  if (env.BACKUP_CHAT || env.S3_BUCKET) {
    await store.enqueue('__backup', {}, `backup:${at.toISOString().slice(0, 10)}`);
  }
}
export async function runJobs(env, { maintenance: maintain = false, inboxLimit = 1, streamKey = null } = {}) {
  if (maintain) await maintenance(env);
  await processInbox(env, inboxLimit, streamKey);
  await processOutbox(env, Math.max(8, inboxLimit));
}
