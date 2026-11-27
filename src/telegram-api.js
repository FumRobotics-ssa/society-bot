export function telegramFetch(env, method, init) {
  return telegramRequest(env, method, `/bot${env.BOT_TOKEN}/${method}`, init);
}

export function telegramFile(env, path, init) {
  return telegramRequest(env, `file/${path}`, `/file/bot${env.BOT_TOKEN}/${path}`, init);
}

function telegramRequest(env, route, telegramPath, init = {}) {
  if (!env.TELEGRAM_RELAY_URL) return fetch(`https://api.telegram.org${telegramPath}`, init);
  const destination = new URL(`/_arvan_telegram/${route}`, env.TELEGRAM_RELAY_URL);
  if (destination.protocol !== 'https:' || !env.ARVAN_RELAY_TOKEN) {
    throw new Error('The Telegram relay requires HTTPS and an authentication token');
  }
  const headers = new Headers(init.headers);
  headers.set('X-Robotics-Origin-Token', env.ARVAN_RELAY_TOKEN);
  return fetch(destination.href, { ...init, headers, redirect: 'error' });
}
