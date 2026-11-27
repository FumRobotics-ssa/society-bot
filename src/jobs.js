import { Store } from './store.js';
import { handleUpdate, notifyOrder } from './bot.js';
import { now } from './auth.js';
import { runBackup } from './backup.js';
import { inspectTelegramBurst, TELEGRAM_PENDING_LIMIT } from './telegram-ingress.js';
import { telegramFetch } from './telegram-api.js';

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
  if (isBlockedTelegramUser(env, actor)) {
    env.RECORD_QUEUE_EVENT?.('blocked');
    return null;
  }
  if (env.TELEGRAM_GLOBAL_RATE && !(await env.TELEGRAM_GLOBAL_RATE.limit({ key: 'telegram' })).success) {
    env.RECORD_QUEUE_EVENT?.('global_rate_limited');
    return null;
  }
  const streamKey = String(actor || update.update_id);
  let limited = false;
  if (actor && env.TELEGRAM_INGRESS_RATE) {
    try { limited = !(await env.TELEGRAM_INGRESS_RATE.limit({ key: streamKey })).success; }
    catch { console.warn('Telegram request limiter unavailable; using the database queue limit'); }
  }
  if (!limited) {
    const globalGuard = env.INBOX_CAPACITY ? `AND NOT EXISTS (
        SELECT 1 FROM inbox INDEXED BY inbox_stream_active WHERE status IN ('new','processing') LIMIT 1 OFFSET ?
      )` : '';
    const accepted = await env.DB.prepare(`INSERT OR IGNORE INTO inbox(update_id,stream_key,payload)
      SELECT ?,?,? WHERE NOT EXISTS (
        SELECT 1 FROM telegram_abuse_blocks WHERE stream_key=? AND unblocked_at IS NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM inbox INDEXED BY inbox_stream_active WHERE stream_key=? AND status IN ('new','processing')
        LIMIT 1 OFFSET ?
      ) ${globalGuard}`).bind(update.update_id, streamKey, JSON.stringify(update), streamKey, streamKey,
        TELEGRAM_PENDING_LIMIT - 1, ...(env.INBOX_CAPACITY ? [env.INBOX_CAPACITY - 1] : [])).run();
    if (accepted.meta.changes) return streamKey;
  }
  env.RECORD_QUEUE_EVENT?.(limited ? 'rate_limited' : 'not_enqueued');
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
  for (let i = 0; i < limit && !env.JOBS_STOPPING?.(); i++) {
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
  const { _documentText, filename, _eventPosterId, _fallbackToText, _optionalPoster, ...fields } = data;
  let poster;
  if (_eventPosterId) {
    const stored = await env.DB.prepare('SELECT poster_url FROM events WHERE id=?').bind(_eventPosterId).first('poster_url');
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(stored || '');
    if (!match || match[2].length % 4 !== 0) {
      const error = new Error('Stored event poster is missing or invalid');
      error.invalidPhoto = error.permanent = true;
      throw error;
    }
    const mime = match[1].toLowerCase();
    poster = new Blob([Uint8Array.from(atob(match[2]), byte => byte.charCodeAt(0))], { type: mime });
  }
  let body, headers;
  if (_documentText !== undefined || poster) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    if (poster) body.set('photo', poster, `event-poster.${poster.type.split('/')[1]}`);
    else body.set('document', new Blob([_documentText], { type: filename?.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'application/json' }), filename || 'export.json');
  } else { body = JSON.stringify(fields); headers = { 'Content-Type': 'application/json' }; }
  const response = await telegramFetch(env, method, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout) });
  const result = await response.json();
  if (!result.ok) {
    const error = new Error(`Telegram ${result.error_code || response.status}: ${result.description || 'request failed'}`);
    error.retryAfter = result.parameters?.retry_after;
    error.safeToRetry = result.error_code === 429;
    error.permanent = [400, 403, 404].includes(result.error_code);
    error.invalidPhoto = method === 'sendPhoto' && result.error_code === 400;
    throw error;
  }
}
const outboxLanes = {
  interactive: "AND method NOT IN ('sendPhoto','sendDocument','__broadcast','__backup') AND (dedupe_key IS NULL OR dedupe_key NOT LIKE '%:user:%')",
  media: "AND method IN ('sendPhoto','sendDocument')",
  bulk: "AND (method IN ('__broadcast','__backup') OR (method='sendMessage' AND dedupe_key LIKE '%:user:%'))",
};

export async function processOutbox(env, limit = 8, lane = null) {
  const laneFilter = lane === null ? '' : outboxLanes[lane];
  if (laneFilter === undefined) throw new Error('Unknown outbox lane');
  for (let i = 0; i < limit && !env.JOBS_STOPPING?.(); i++) {
    const at = now();
    // A timed-out receipt send or an expired send lease may already have posted the media.
    const job = await env.DB.prepare(`WITH next_job AS MATERIALIZED (
      SELECT id, method IN ('sendPhoto','sendDocument') AND COALESCE(dedupe_key,'') LIKE 'receipt:%'
        AND (status='processing' OR (last_error IS NOT NULL AND last_error NOT LIKE 'Telegram 429:%')) AS uncertain_receipt
      FROM outbox WHERE ((status='pending' AND available_at<=?) OR (status='processing' AND lease_until<?)) ${laneFilter}
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
    let payload;
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
      } else {
        payload = JSON.parse(job.payload);
        if (payload._optionalPoster && now() - job.created_at > 120) throw new Error('Optional event poster expired');
        const timeout = receiptDelivery ? 25000 : (payload._fallbackToText || payload._optionalPoster) ? 6000 : 10000;
        await telegram(job.method, payload, env, timeout);
      }
      await env.DB.prepare("UPDATE outbox SET status='sent',sent_at=?,last_error=NULL WHERE id=? AND lease_until=?").bind(now(), job.id, job.lease_until).run();
    } catch (error) {
      const uncertainReceipt = receiptDelivery && !error.permanent && !error.safeToRetry;
      const failed = uncertainReceipt || error.permanent || payload?._optionalPoster || job.attempts >= 10;
      if (job.method === 'sendPhoto' && payload?._fallbackToText && (error.invalidPhoto || (!error.permanent && !error.safeToRetry))) {
        const { chat_id, caption: text, reply_markup } = payload;
        await env.DB.prepare(`UPDATE outbox SET method='sendMessage',payload=?,status='pending',
          attempts=0,available_at=?,lease_until=0,last_error=NULL WHERE id=? AND lease_until=?`)
          .bind(JSON.stringify({ chat_id, text, reply_markup }), now(), job.id, job.lease_until).run();
        continue;
      }
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
