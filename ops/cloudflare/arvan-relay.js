import { safeEqual } from '../../src/auth.js';

const origin = 'https://37.152.178.89';
const pathPrefix = '/_arvan_telegram/';
const apiMethods = new Set([
  'getMe', 'getUpdates', 'getFile', 'sendMessage', 'sendPhoto', 'sendDocument', 'answerCallbackQuery', 'editMessageText', 'editMessageReplyMarkup', 'editMessageMedia',
]);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(pathPrefix)) {
      const provided = request.headers.get('X-Robotics-Origin-Token');
      if (!provided || !env.ARVAN_RELAY_TOKEN || !await safeEqual(provided, env.ARVAN_RELAY_TOKEN)) {
        return new Response('Not found', {status: 404});
      }
      if (!env.BOT_TOKEN) return new Response('Temporarily unavailable', {status: 503});
      const route = url.pathname.slice(pathPrefix.length);
      const file = route.match(/^file\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/);
      let path;
      if (file && request.method === 'GET') path = '/file/bot' + env.BOT_TOKEN + '/' + file[1];
      else if (apiMethods.has(route) && (request.method === 'POST' || (request.method === 'GET' && route === 'getMe'))) {
        path = '/bot' + env.BOT_TOKEN + '/' + route;
      } else return new Response('Not found', {status: 404});
      const key = route === 'getUpdates' ? 'polling' : 'api';
      if (env.TELEGRAM_RELAY_RATE && !(await env.TELEGRAM_RELAY_RATE.limit({ key })).success) {
        return Response.json({ ok: false, error_code: 429, description: 'Telegram relay rate limit', parameters: { retry_after: 10 } }, {
          status: 429, headers: { 'Retry-After': '10', 'Cache-Control': 'no-store' },
        });
      }
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
