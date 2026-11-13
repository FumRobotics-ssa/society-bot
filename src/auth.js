export const SESSION_COOKIE = 'robotics_society_session';
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
export const now = () => Math.floor(Date.now() / 1000);
export const ownerIds = env => String(env.OWNER_IDS || '').split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x));
export async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
export async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([digest(a || ''), digest(b || '')]);
  let different = 0;
  for (let i = 0; i < ha.length; i++) different |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return different === 0;
}
export async function roleFor(env, store, userId) {
  if (ownerIds(env).includes(String(userId))) return 'owner';
  return (await store.getAdmin(userId))?.role || null;
}
export async function createLoginCode(db, userId) {
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  await db.prepare('INSERT INTO login_codes(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await digest(token), userId, now() + 300).run();
  return token;
}
export async function exchangeLogin(db, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await db.prepare('DELETE FROM login_codes WHERE token_hash=? AND expires_at>? RETURNING user_id').bind(await digest(token), now()).first();
  if (!row) return null;
  const session = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  await db.prepare('INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await digest(session), row.user_id, now() + 8 * 3600).run();
  return { token: session, user_id: row.user_id };
}
export function cookieToken(request) {
  return request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) || '';
}
export async function getSession(request, env, store) {
  const token = cookieToken(request);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await env.DB.prepare('SELECT user_id FROM admin_sessions WHERE token_hash=? AND expires_at>?').bind(await digest(token), now()).first();
  if (!row) return null;
  const role = await roleFor(env, store, row.user_id);
  return role ? { user_id: row.user_id, role } : null;
}
export function sessionCookie(request, token, maxAge = 28800) {
  const url = new URL(request.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local && url.protocol === 'http:' ? '' : '; Secure'}`;
}
export function validOrigin(request, env) {
  const origin = request.headers.get('Origin');
  try { return origin === new URL(env.PUBLIC_URL).origin; } catch { return false; }
}
