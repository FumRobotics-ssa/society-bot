import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createDatabase } from '../src/sqlite.js';
import { Store } from '../src/store.js';
import { handleRequest } from '../src/app.js';
import { createLoginCode, exchangeLogin, digest, SESSION_COOKIE } from '../src/auth.js';
import { receiveUpdate, processOutbox, processInbox } from '../src/jobs.js';

const schema = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort().map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');

function fixture() {
  const db = createDatabase(); db.exec(schema);
  const env = { DB: db, OWNER_IDS: '99', PUBLIC_URL: 'https://example.test', WEBHOOK_SECRET: 'a'.repeat(40), BOT_TOKEN: 'fake', ASSETS: { fetch: async () => new Response('asset') } };
  const store = new Store(db);
  const request = (path, init = {}) => handleRequest(new Request(env.PUBLIC_URL + path, init), env, { waitUntil() {} });
  return { db, env, store, request };
}
async function cookie(db, userId) { const session = await exchangeLogin(db, await createLoginCode(db, userId)); return SESSION_COOKIE + '=' + session.token; }
test('one time login consumed once and secret only stored hashed', async () => {
  const { db } = fixture(); const code = await createLoginCode(db, 99);
  const stored = await db.prepare('SELECT token_hash FROM login_codes').first(); assert.equal(stored.token_hash, await digest(code));
  assert.ok(await exchangeLogin(db, code)); assert.equal(await exchangeLogin(db, code), null); db.close();
});
test('admin API requires session and trusted Origin for mutations', async () => {
  const { db, request } = fixture(); assert.equal((await request('/api/users')).status, 401);
  const auth = await cookie(db, 99);
  assert.equal((await request('/api/places', { method: 'POST', headers: { Cookie: auth, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/places', { method: 'POST', headers: { Cookie: auth, Origin: 'https://example.test' }, body: JSON.stringify({ name: 'سالن', capacity: 10 }) })).status, 201);
  db.close();
});
test('role revocation immediately invalidates existing sessions and checkin role cannot read users', async () => {
  const { db, store, request } = fixture(); await store.setAdmin(7, 'checkin'); const auth = await cookie(db, 7);
  assert.equal((await request('/api/users', { headers: { Cookie: auth } })).status, 403);
  assert.equal((await request('/api/me', { headers: { Cookie: auth } })).status, 200);
  await store.removeAdmin(7); assert.equal((await request('/api/me', { headers: { Cookie: auth } })).status, 401); db.close();
});
test('public ticket needs unpredictable token and reveals no name or phone', async () => {
  const { db, store, request } = fixture(); await store.upsertUser({ id: 1, first_name: 'PrivateName', phone: '09123456789' });
  const event = await store.saveEvent({ name: '<script>bad</script>', capacity: 2 });
  const { tickets } = await store.reserve(1, event.id, 1, 'first'); const ticket = tickets[0];
  assert.equal((await request('/ticket/' + ticket.id)).status, 404);
  const page = await request('/ticket/' + ticket.token); const text = await page.text();
  assert.equal(page.status, 200); assert.ok(!text.includes('PrivateName')); assert.ok(!text.includes('09123456789')); assert.ok(!text.includes('<script>'));
  const image = await request('/ticket/' + ticket.token + '/qr.svg'); assert.equal(image.status, 200); assert.match(await image.text(), /<svg/); db.close();
});
test('Neshan location appears on issued ticket and invalid links are rejected', async () => {
  const { db, store, request } = fixture();
  await store.upsertUser({ id: 1, first_name: 'علی' });
  await assert.rejects(store.savePlace({ name: 'سالن', capacity: 5, map_url: 'https://neshan.org.evil.test/maps' }), /لینک نشان/);
  const place = await store.savePlace({ name: 'سالن', address: 'دانشگاه فردوسی مشهد', capacity: 5, map_url: 'https://neshan.org/maps/places/test' });
  const event = await store.saveEvent({ name: 'رویداد', place_id: place.id, capacity: 5 });
  const { tickets } = await store.reserve(1, event.id, 1, 'map-test');
  const page = await request('/ticket/' + tickets[0].token);
  const text = await page.text();
  assert.match(text, /دانشگاه فردوسی مشهد/);
  assert.match(text, /href="https:\/\/neshan.org\/maps\/places\/test"/);
  db.close();
});

test('webhook rejects absent or incorrect secret and deduplicates durable updates', async () => {
  const { db, env, request } = fixture();
  assert.equal((await request('/telegram', { method: 'POST', body: '{"update_id":1}' })).status, 403);
  await receiveUpdate(env, { update_id: 1, message: { from: { id: 2 } } }); await receiveUpdate(env, { update_id: 1, message: { from: { id: 2 } } });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM inbox').first()).n, 1); db.close();
});
test('Telegram 429 backs off durable outbox without dropping message', async () => {
  const { db, env, store } = fixture(); await store.enqueue('sendMessage', { chat_id: 1, text: 'hello' }, 'x');
  const original = globalThis.fetch; globalThis.fetch = async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 60 } });
  try { await processOutbox(env, 1); } finally { globalThis.fetch = original; }
  const job = await db.prepare('SELECT * FROM outbox').first(); assert.equal(job.status, 'pending'); assert.ok(job.available_at >= Math.floor(Date.now() / 1000) + 59); db.close();
});
test('sender ordering blocks later updates during retry backoff but permits other senders', async () => {
  const { db, env } = fixture();
  await receiveUpdate(env, { update_id: 1, message: { from: { id: 2 } } });
  await receiveUpdate(env, { update_id: 2, message: { from: { id: 2 } } });
  await receiveUpdate(env, { update_id: 3, message: { from: { id: 3 } } });
  await db.prepare('UPDATE inbox SET available_at=unixepoch()+100 WHERE update_id=1').run();
  await processInbox(env, 1);
  assert.equal((await db.prepare('SELECT status FROM inbox WHERE update_id=2').first()).status, 'new');
  assert.equal((await db.prepare('SELECT status FROM inbox WHERE update_id=3').first()).status, 'done'); db.close();
});

test('login issues the Robotics Society session cookie and it authenticates requests', async () => {
  const { db, env, request } = fixture();
  const code = await createLoginCode(db, 99);
  const response = await request('/api/session', { method: 'POST', headers: { Origin: env.PUBLIC_URL, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: code }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /^robotics_society_session=[a-f0-9]{64};/);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal((await request('/api/me', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
  db.close();
});
