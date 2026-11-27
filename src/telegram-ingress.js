import { now, ownerIds } from './auth.js';

export const TELEGRAM_PENDING_LIMIT = 24;
const receiptTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export function telegramReceipt(message) {
  const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : null;
  if (photo) return { file: photo, type: 'photo' };
  const document = message?.document;
  if (receiptTypes.includes(document?.mime_type)) return { file: document, type: 'document' };
  return null;
}

export async function criticalTelegramUpdate(env, update, actor) {
  const chat = update.callback_query?.message?.chat ?? update.message?.chat;
  if (!Number.isSafeInteger(actor) || chat?.type !== 'private' || chat.id !== actor) return false;
  const confirmation = /^rq:y:([a-f0-9]{12})$/.exec(update.callback_query?.data || '');
  if (confirmation) {
    return Boolean(await env.DB.prepare(`SELECT 1 FROM conversation_states
      WHERE user_id=? AND step='reserve_confirm' AND json_extract(data_json,'$.quote_nonce')=?`)
      .bind(actor, confirmation[1]).first());
  }
  const receipt = telegramReceipt(update.message);
  if (!env.VERIFICATION_CHAT || !receipt?.file.file_id || (receipt.file.file_size || 0) > 10 * 1024 * 1024) return false;
  return Boolean(await env.DB.prepare(`SELECT 1 FROM conversation_states s JOIN orders o
    ON o.id=json_extract(s.data_json,'$.order_id') AND o.user_id=s.user_id
    WHERE s.user_id=? AND s.step='payment_receipt' AND o.status='reserved' AND o.expires_at>unixepoch()`)
    .bind(actor).first());
}
const SPAM_WINDOW = 60;
const MIN_SPAM_MESSAGES = 20;
const MIN_REPEATS = 12;
const MIN_IDENTICAL = 6;

export async function inspectTelegramBurst(env, streamKey, update) {
  const message = update.message;
  const at = now();
  if (message?.chat?.type !== 'private' || String(message.chat.id) !== streamKey
      || typeof message.text !== 'string' || !Number.isSafeInteger(message.date)
      || message.date < at - SPAM_WINDOW || message.date > at + 5 || ownerIds(env).includes(streamKey)) return;
  if (!env.TELEGRAM_ABUSE_SAMPLE || !(await env.TELEGRAM_ABUSE_SAMPLE.limit({ key: streamKey })).success) return;

  const existing = await env.DB.prepare('SELECT unblocked_at FROM telegram_abuse_blocks WHERE stream_key=?').bind(streamKey).first();
  if (existing && existing.unblocked_at === null) return;
  const after = Math.max(at - SPAM_WINDOW, existing?.unblocked_at ?? 0);
  const { results } = await env.DB.prepare(`
    WITH recent AS MATERIALIZED (
      SELECT update_id,payload FROM inbox INDEXED BY inbox_stream
      WHERE stream_key=? ORDER BY update_id DESC LIMIT 48
    )
    SELECT update_id, json_extract(payload,'$.message.message_id') AS message_id,
      json_extract(payload,'$.message.text') AS text
    FROM recent WHERE json_extract(payload,'$.message.chat.type')='private'
      AND json_extract(payload,'$.message.chat.id')=?
      AND json_extract(payload,'$.message.date')>? AND json_extract(payload,'$.message.date')<=?`
  ).bind(streamKey, Number(streamKey), after, at + 5).all();
  if (results.some(row => row.update_id === update.update_id)) return;

  const ids = new Set();
  const frequencies = new Map();
  let mostRepeated = 0;
  for (const row of results) {
    if (!Number.isSafeInteger(row.message_id) || ids.has(row.message_id) || typeof row.text !== 'string') continue;
    const text = row.text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!text) continue;
    ids.add(row.message_id);
    const frequency = (frequencies.get(text) || 0) + 1;
    frequencies.set(text, frequency);
    mostRepeated = Math.max(mostRepeated, frequency);
  }
  const repeated = ids.size - frequencies.size;
  if (ids.size < MIN_SPAM_MESSAGES || repeated < MIN_REPEATS || mostRepeated < MIN_IDENTICAL) return;

  const username = /^[a-z0-9_]{1,32}$/i.test(message.from?.username || '') ? message.from.username : '';
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO telegram_abuse_blocks(stream_key,username,message_count,repeated_count,blocked_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(stream_key) DO UPDATE SET username=excluded.username,message_count=excluded.message_count,
        repeated_count=excluded.repeated_count,blocked_at=excluded.blocked_at,unblocked_at=NULL
      WHERE telegram_abuse_blocks.unblocked_at=?`)
      .bind(streamKey, username, ids.size, repeated, at, existing?.unblocked_at ?? 0),
    env.DB.prepare(`UPDATE inbox SET status='done',processed_at=?,last_error=NULL
      WHERE stream_key=? AND status IN ('new','processing')
      AND (status='new' OR lease_until<?) AND changes()>0`).bind(at, streamKey, at),
  ]);
}
