import qr from 'qrcode-generator';
import { Store, neshanUrl } from './store.js';
import { exchangeLogin, getSession, sessionCookie, validOrigin, cookieToken, digest, now, safeEqual } from './auth.js';
import { receiveUpdate, runJobs } from './jobs.js';
import { exportBackup } from './backup.js';
import { notifyOrder } from './bot.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json;charset=utf-8', ...headers } });
const html = text => new Response(text, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]));
function fail(message, status = 400) { const error = new Error(message); error.httpStatus = status; throw error; }
async function body(request, max = 65536) {
  if (Number(request.headers.get('Content-Length') || 0) > max) fail('درخواست بیش از حد بزرگ است', 413);
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > max) { await reader.cancel(); fail('درخواست بیش از حد بزرگ است', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('JSON نامعتبر است'); }
}
export function csv(rows) {
  if (!rows.length) return '\uFEFF';
  const columns = Object.keys(rows[0]).filter(key => !['profile', 'profile_json', 'token'].includes(key));
  const quote = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
  return '\uFEFF' + [columns.map(quote).join(','), ...rows.map(row => columns.map(key => quote(row[key])).join(','))].join('\r\n');
}
function download(content, filename, type) { return new Response(content, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"` } }); }
function qrSvg(url) { const code = qr(0, 'M'); code.addData(url); code.make(); return code.createSvgTag({ cellSize: 4, margin: 16, scalable: true }); }
function ticketHTML(ticket, env, print = false) {
  const mapUrl = neshanUrl(ticket.place_map_url);
  const valid = ticket.order_status === 'approved';
  return `<article class="ticket"><img class="association-logo" src="/logo.png" alt="نشان انجمن رباتیک دانشگاه فردوسی مشهد" width="76" height="76"><p>انجمن علمی رباتیک دانشگاه فردوسی مشهد</p><h2>${esc(ticket.event_name)}</h2>${ticket.place_name ? `<p>مکان: ${esc(ticket.place_name)}</p>` : ''}${ticket.place_address ? `<p>نشانی: ${esc(ticket.place_address)}</p>` : ''}${mapUrl ? `<p><a class="ticket-map" href="${esc(mapUrl)}" target="_blank" rel="noopener noreferrer">موقعیت و مسیریابی در نشان</a></p>` : ''}<p>${valid ? ticket.checked_in_at ? 'ورود ثبت شده' : 'بلیت معتبر' : 'این بلیت معتبر نیست'}</p><img src="/ticket/${ticket.token}/qr.svg" alt="کد QR بلیت" width="240" height="240"><p dir="ltr">${esc(ticket.legacy_code || ticket.id)}</p>${print ? `<p>${esc(ticket.first_name)} ${esc(ticket.last_name)}</p>` : ''}<p>برای ثبت ورود کد را به مسئول پذیرش نشان دهید</p></article>`;
}
function page(content, title = 'بلیت انجمن رباتیک') { return `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/ticket.css"><body><main>${content}</main></body></html>`; }
function pagination(url) { return { limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100)), offset: Math.max(0, Number(url.searchParams.get('offset')) || 0) }; }
async function allPages(loader) {
  const rows = [];
  for (let offset = 0; offset <= 10000; offset += 200) {
    const part = await loader({ limit: 200, offset }); rows.push(...part);
    if (part.length < 200) return rows;
  }
  fail('خروجی بزرگ است لطفا از بکاپ کامل دیتابیس استفاده کنید', 413);
}
async function receipt(env, order) {
  if (!order?.receipt_file_id) fail('رسید پیدا نشد', 404);
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: order.receipt_file_id }), signal: AbortSignal.timeout(10000) });
  const file = await response.json();
  const path = file.result?.file_path;
  if (!file.ok || !path || path.includes('..') || !/^[A-Za-z0-9_./-]+$/.test(path)) fail('دریافت رسید از تلگرام ناموفق بود', 502);
  if (file.result.file_size > 20 * 1024 * 1024) fail('حجم رسید بیش از حد مجاز است', 413);
  const upstream = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`, { signal: AbortSignal.timeout(15000) });
  if (!upstream.ok) fail('دریافت فایل ناموفق بود', 502);
  const type = upstream.headers.get('Content-Type') || '';
  const safeType = /^(image\/(png|jpeg|webp)|application\/pdf)(;|$)/.test(type) ? type : 'application/octet-stream';
  return new Response(upstream.body, { headers: { 'Content-Type': safeType, 'Content-Disposition': `${safeType.startsWith('image/') ? 'inline' : 'attachment'}; filename="receipt.${safeType.includes('pdf') ? 'pdf' : 'bin'}"` } });
}

async function api(request, env, store, url) {
  const path = url.pathname, method = request.method;
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) fail('روش درخواست مجاز نیست', 405);
  if (method !== 'GET' && !validOrigin(request, env)) fail('مبدا درخواست مجاز نیست', 403);
  if (path === '/api/session' && method === 'POST') {
    const data = await body(request);
    const session = await exchangeLogin(env.DB, data.token);
    if (!session) fail('لینک ورود نامعتبر یا منقضی شده است دوباره از ربات دستور admin بگیرید', 401);
    // Revocation and owner allowlists are evaluated on every request.
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, session.token) });
  }
  const session = await getSession(request, env, store);
  if (!session) fail('برای ادامه از ربات وارد پنل شوید', 401);
  if (path === '/api/me') return json(session);
  if (path === '/api/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(await digest(cookieToken(request))).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
  }
  if (path === '/api/check-in' && method === 'POST') {
    let { token } = await body(request); token = String(token || '').trim();
    if (token.includes('/ticket/')) token = token.split('/ticket/').at(-1).split(/[?#]/)[0];
    const ticket = await store.checkIn(token, session.user_id);
    return json({ id: ticket.id, event_name: ticket.event_name, first_name: ticket.first_name, last_name: ticket.last_name, checked_in_at: ticket.checked_in_at, already_checked_in: ticket.already_checked_in });
  }
  if (session.role === 'checkin') fail('دسترسی شما فقط برای ثبت ورود است', 403);
  if (path === '/api/stats' && method === 'GET') {
    const stats = await store.stats();
    const jobs = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM inbox WHERE status='failed') AS failed_inbox,(SELECT COUNT(*) FROM outbox WHERE status='failed') AS failed_outbox").first();
    return json({ ...stats, ...jobs });
  }
  if (path === '/api/events' && method === 'GET') return json(await store.listEvents(pagination(url)));
  if (path === '/api/audience-events' && method === 'GET') return json(await store.listAudienceEvents(pagination(url)));
  if (path === '/api/places' && method === 'GET') return json(await store.listPlaces());
  if (path === '/api/events' && method === 'POST') { const item = await store.saveEvent(await body(request)); await store.audit(session.user_id, 'event.create', item.id, {}); return json(item, 201); }
  if (path === '/api/places' && method === 'POST') { const item = await store.savePlace(await body(request)); await store.audit(session.user_id, 'place.create', item.id, {}); return json(item, 201); }
  const entity = path.match(/^\/api\/(events|places)\/(\d+)$/);
  if (entity && ['PATCH', 'DELETE'].includes(method)) {
    const kind = entity[1], id = Number(entity[2]);
    const result = method === 'DELETE'
      ? await store[kind === 'events' ? 'deleteEvent' : 'deletePlace'](id)
      : await store[kind === 'events' ? 'saveEvent' : 'savePlace'](await body(request), id);
    await store.audit(session.user_id, `${kind}.${method.toLowerCase()}`, id, {});
    return json(result ?? { ok: true });
  }
  if (path === '/api/orders' && method === 'GET') return json(await store.listOrders({ ...pagination(url), status: url.searchParams.get('status') || undefined, eventId: url.searchParams.get('eventId') || undefined }));
  const review = path.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/review$/);
  if (review && method === 'POST') {
    const data = await body(request); if (typeof data.approve !== 'boolean') fail('وضعیت تایید نامعتبر است');
    const order = await store.reviewOrder(review[1], data.approve, session.user_id);
    await notifyOrder(order, env, store, `review:${order.id}:${order.status}`);
    return json(order);
  }
  const file = path.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/receipt$/);
  if (file && method === 'GET') return receipt(env, await store.getOrder(file[1]));
  if (path === '/api/tickets' && method === 'GET') return json(await store.listTickets({ ...pagination(url), eventId: url.searchParams.get('eventId') || undefined }));
  if (path === '/api/users' && method === 'GET') return json(await store.listUsers({ ...pagination(url), search: url.searchParams.get('search') || '', audienceKey: url.searchParams.get('audienceKey') || '' }));
  if (path === '/api/export/users' && method === 'GET') return download(csv(await allPages(opts => store.listUsers(opts))), 'users.csv', 'text/csv;charset=utf-8');
  if (path === '/api/export/tickets' && method === 'GET') return download(csv(await allPages(opts => store.listTickets({ ...opts, eventId: url.searchParams.get('eventId') || undefined }))), 'tickets.csv', 'text/csv;charset=utf-8');
  if (path === '/api/print' && method === 'GET') {
    const eventId = url.searchParams.get('eventId'); if (!eventId) fail('رویداد را انتخاب کنید');
    const offset = pagination(url).offset, limit = Math.min(100, pagination(url).limit);
    const tickets = await store.listTickets({ eventId, offset, limit });
    const route = `/api/print?eventId=${encodeURIComponent(eventId)}&amp;limit=${limit}&amp;offset=`;
    const nav = `<p class="print-help">صفحه از ردیف ${offset + 1} تا ${offset + tickets.length}<br>فقط بلیتهای تایید شده چاپ میشوند<br>برای ذخیره PDF یا چاپ از گزینه چاپ مرورگر استفاده کنید<br>${offset > 0 ? `<a href="${route}${Math.max(0, offset - limit)}">صفحه قبل</a> ` : ''}${tickets.length === limit ? `<a href="${route}${offset + limit}">صفحه بعد</a>` : ''}</p>`;
    return html(page(nav + tickets.filter(t => t.order_status === 'approved').map(t => ticketHTML(t, env, true)).join(''), 'چاپ بلیت'));
  }
  if (path === '/api/broadcast' && method === 'POST') {
    const data = await body(request); if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 3500) fail('متن پیام باید بین یک تا ۳۵۰۰ نویسه باشد');
    if (data.audience_key && !await store.getAudienceEvent(data.audience_key)) fail('دسته رویداد پیدا نشد');
    if (data.event_id && !await store.getEvent(Number(data.event_id))) fail('رویداد پیدا نشد');
    const id = crypto.randomUUID();
    await store.enqueue('__broadcast', { text: data.text, audience_key: data.audience_key || null, event_id: data.event_id ? Number(data.event_id) : null, actor_id: session.user_id, broadcast_id: id }, id);
    await store.audit(session.user_id, 'broadcast', id, { audience_key: data.audience_key || null, event_id: data.event_id || null });
    return json({ queued: true, id }, 202);
  }
  if (path === '/api/expire' && method === 'POST') { await store.expireOrders(); return json({ ok: true }); }
  if (path === '/api/backup' && method === 'GET') {
    await store.audit(session.user_id, 'backup.export', 'database', {});
    return download(await exportBackup(env), `robotics-society-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
  }
  if (path.startsWith('/api/admins')) {
    if (session.role !== 'owner') fail('فقط مالک میتواند دسترسی مدیران را تغییر دهد', 403);
    if (path === '/api/admins' && method === 'GET') return json(await store.listAdmins());
    if (path === '/api/admins' && method === 'POST') {
      const data = await body(request); if (!['admin', 'checkin'].includes(data.role) || !Number.isSafeInteger(Number(data.user_id)) || Number(data.user_id) <= 0) fail('شناسه یا نقش نامعتبر است');
      await store.setAdmin(Number(data.user_id), data.role); await store.audit(session.user_id, 'admin.grant', data.user_id, { role: data.role }); return json({ ok: true });
    }
    const target = path.match(/^\/api\/admins\/(\d+)$/);
    if (target && method === 'DELETE') { await store.removeAdmin(Number(target[1])); await store.audit(session.user_id, 'admin.revoke', target[1], {}); return json({ ok: true }); }
  }
  fail('مسیر پیدا نشد', 404);
}

async function route(request, env, ctx) {
  const url = new URL(request.url), store = new Store(env.DB);
  if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, app: 'robotics-society' });
  if (url.pathname === '/telegram' && request.method === 'POST') {
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !await safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_SECRET)) return json({ error: 'Forbidden' }, 403);
    const update = await body(request, 262144);
    await receiveUpdate(env, update);
    ctx.waitUntil(runJobs(env).catch(() => console.error('Background job failed — inspect durable queue')));
    return json({ ok: true });
  }
  if (url.pathname.startsWith('/api/')) return api(request, env, store, url);
  if (request.method !== 'GET' && request.method !== 'HEAD') fail('روش درخواست مجاز نیست', 405);
  const ticket = url.pathname.match(/^\/ticket\/([a-f0-9]{64})(\/qr\.svg)?$/);
  if (ticket) {
    const row = await store.getTicket(ticket[1]); if (!row || row.token !== ticket[1]) fail('بلیت پیدا نشد', 404);
    if (ticket[2]) return new Response(qrSvg(`${env.PUBLIC_URL.replace(/\/$/, '')}/ticket/${row.token}`), { headers: { 'Content-Type': 'image/svg+xml;charset=utf-8' } });
    return html(page(ticketHTML(row, env)));
  }
  if (url.pathname === '/') return Response.redirect(new URL('/admin', request.url), 302);
  const assets = ['/admin', '/admin.html', '/admin.js', '/jalali.js', '/grid.js', '/style.css', '/ticket.css', '/logo.png'];
  if (!assets.includes(url.pathname) && !/^\/fonts\/(?:Meem-[A-Za-z]+\.ttf|fontawesome-webfont\.woff2)$/.test(url.pathname)) fail('مسیر پیدا نشد', 404);
  const asset = new URL(request.url); if (url.pathname === '/admin') asset.pathname = '/admin.html';
  return env.ASSETS.fetch(new Request(asset, request));
}
export async function handleRequest(request, env, ctx = { waitUntil: promise => promise.catch(console.error) }) {
  let response;
  try { response = await route(request, env, ctx); }
  catch (error) {
    const status = error.httpStatus || (error.code ? 409 : 500);
    response = json({ error: status === 500 ? 'خطای داخلی لطفا دوباره تلاش کنید' : error.message, code: error.code }, status);
  }
  const hardened = new Response(response.body, response);
  hardened.headers.set('X-Content-Type-Options', 'nosniff');
  hardened.headers.set('Referrer-Policy', 'no-referrer');
  hardened.headers.set('X-Frame-Options', 'DENY');
  hardened.headers.set('Cache-Control', 'no-store');
  hardened.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  hardened.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  return hardened;
}
