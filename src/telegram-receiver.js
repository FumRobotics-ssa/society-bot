import { setTimeout as delay } from 'node:timers/promises';
import { telegramFetch } from './telegram-api.js';

export async function receiveTelegram(env, signal) {
  if (!env.BOT_TOKEN || !/^[A-Za-z0-9_-]{32,256}$/.test(env.WEBHOOK_SECRET || '')) {
    throw new Error('BOT_TOKEN and WEBHOOK_SECRET are required for the receiver');
  }
  const target = new URL(env.TELEGRAM_INGRESS_URL || 'http://127.0.0.1:8787/telegram');
  let offset;
  let failures = 0;
  let lastHeartbeat = 0;
  while (!signal.aborted) {
    try {
      const upstream = await telegramFetch(env, 'getUpdates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset, timeout: 25, limit: 40, allowed_updates: ['message', 'callback_query'] }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(38000)]),
      });
      if (!upstream.ok) throw new Error(`Telegram poll HTTP ${upstream.status}`);
      const page = await upstream.json();
      if (!page.ok || !Array.isArray(page.result)) throw new Error('Invalid Telegram poll result');
      if (!lastHeartbeat) {
        console.info('Telegram polling connection verified');
      }
      let received = 0;
      for (const update of page.result.sort((left, right) => left.update_id - right.update_id)) {
        if (signal.aborted) break;
        if (!Number.isSafeInteger(update?.update_id)) throw new Error('Invalid update ID');
        const response = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET },
          body: JSON.stringify(update),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Local inbox HTTP ${response.status}`);
        if (offset === undefined || update.update_id >= offset) offset = update.update_id + 1;
        received++;
      }
      if (received) console.info('Accepted Telegram updates:', received);
      if (Date.now() - lastHeartbeat >= 60000) {
        console.info(JSON.stringify({ event: 'telegram_receiver_healthy' }));
        lastHeartbeat = Date.now();
      }
      failures = 0;
    } catch (error) {
      if (signal.aborted) break;
      const detail = String(error?.message || '');
      console.warn(/^(Telegram poll HTTP |Local inbox HTTP )\d+$/.test(detail) ? detail : 'Telegram receive temporarily interrupted');
      failures++;
      const wait = Math.min(20000, 1000 * 2 ** Math.min(failures, 5));
      await delay(wait, undefined, { signal }).catch(() => {});
    }
  }
}
