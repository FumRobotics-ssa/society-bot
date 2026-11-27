const origin = 'https://37.152.178.89';
const pathPrefix = '/_arvan_telegram/';
const apiMethods = new Set([
  'getMe', 'getUpdates', 'getFile', 'sendMessage', 'sendPhoto', 'sendDocument', 'answerCallbackQuery', 'editMessageText', 'editMessageReplyMarkup',
]);
function authorized(provided, secret) {
  if (!provided || !secret || provided.length !== secret.length) return false;
  const text = new TextEncoder();
  const providedBytes = text.encode(provided);
  const secretBytes = text.encode(secret);
  return providedBytes.length === secretBytes.length && crypto.subtle.timingSafeEqual(providedBytes, secretBytes);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(pathPrefix)) {
      if (!authorized(request.headers.get('X-Robotics-Origin-Token'), env.ARVAN_RELAY_TOKEN)) return new Response('Not found', {status: 404});
      if (!env.BOT_TOKEN) return new Response('Temporarily unavailable', {status: 503});
      const route = url.pathname.slice(pathPrefix.length);
      const file = route.match(/^file\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/);
      let path;
      if (file && request.method === 'GET') path = '/file/bot' + env.BOT_TOKEN + '/' + file[1];
      else if (apiMethods.has(route) && (request.method === 'POST' || (request.method === 'GET' && route === 'getMe'))) {
        path = '/bot' + env.BOT_TOKEN + '/' + route;
      } else return new Response('Not found', {status: 404});
      const headers = new Headers();
      const contentType = request.headers.get('Content-Type');
      if (contentType) headers.set('Content-Type', contentType);
      const response = await fetch('https://api.telegram.org' + path, {
        method: request.method, headers, body: request.body, redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) return new Response('Unexpected Telegram redirect', {status: 502});
      return new Response(response.body, {status: response.status, headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      }});
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      return new Response(null, {status: 302, headers: {
        'Location': origin + url.pathname + url.search, 'Cache-Control': 'no-store',
      }});
    }
    return new Response('Temporarily unavailable', {status: 503, headers:{'Cache-Control':'no-store'}});
  },
  scheduled() {},
};
