import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createDatabase } from '../src/sqlite.js';
import { Store } from '../src/store.js';
import { handleRequest } from '../src/app.js';
import { handleUpdate } from '../src/bot.js';
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
test('event statistics count distinct registrants, checked-in tickets and live reservations', async t => {
  const { db, store, request } = fixture();
  t.after(() => db.close());
  for (let id = 1; id <= 5; id++) await store.upsertUser({ id, phone: '09123456789' });
  const event = await store.saveEvent({ name: 'کارگاه', capacity: 12, max_per_user: 5, is_paid: 1, price: 1000 });
  const empty = await store.saveEvent({ name: 'رویداد آینده', capacity: 3 });
  const archived = await store.saveEvent({ name: 'بایگانی', capacity: 10 });
  await store.deleteEvent(archived.id);

  const approve = async (userId, quantity, key) => {
    const { order, tickets } = await store.reserve(userId, event.id, quantity, key);
    await store.submitReceipt(order.id, userId, 'receipt-' + key);
    await store.reviewOrder(order.id, true, 99);
    return tickets;
  };
  const tickets = await approve(1, 2, 'first');
  await approve(1, 1, 'second');
  await approve(2, 2, 'another-user');
  for (const ticket of tickets) await store.checkIn(ticket.token, 99);
  const pending = await store.reserve(3, event.id, 2, 'pending');
  await store.submitReceipt(pending.order.id, 3, 'pending-receipt');
  await store.reserve(4, event.id, 1, 'held');
  const expired = await store.reserve(5, event.id, 2, 'expired');
  await db.prepare('UPDATE orders SET expires_at=unixepoch()-1 WHERE id=?').bind(expired.order.id).run();
  await store.expireOrders();
  await store.reserve(5, empty.id, 1, 'other-event');

  const path = '/api/events?limit=1';
  assert.equal((await request(path)).status, 401);
  await store.setAdmin(7, 'checkin');
  assert.equal((await request(path, { headers: { Cookie: await cookie(db, 7) } })).status, 403);
  const headers = { Cookie: await cookie(db, 99) };
  const firstPage = await request(path, { headers });
  assert.equal(firstPage.status, 200);
  const [emptyStats] = await firstPage.json();
  assert.equal(emptyStats.id, empty.id);
  assert.equal(emptyStats.remaining, empty.capacity - 1);
  assert.equal(emptyStats.registered_users, 1);
  assert.equal(emptyStats.checked_in_tickets, 0);

  const secondPage = await request(path + '&offset=1', { headers });
  assert.equal(secondPage.status, 200);
  const [stats] = await secondPage.json();
  assert.equal(stats.id, event.id);
  assert.equal(stats.registered_users, 2);
  assert.equal(stats.approved_tickets, 5);
  assert.equal(stats.checked_in_tickets, 2);
  assert.equal(stats.held_tickets, 3);
  assert.equal(stats.occupied, 8);
  assert.equal(stats.remaining, 4);

  const exportPath = '/api/export/confirmed-participants';
  const selectedPath = exportPath + '?audienceKey=current%3A' + event.id;
  assert.equal((await request(selectedPath)).status, 401);
  assert.equal((await request(selectedPath, { headers: { Cookie: await cookie(db, 7) } })).status, 403);
  const exported = await request(selectedPath, { headers });
  assert.match(exported.headers.get('Content-Disposition'), /confirmed-participants.csv/);
  const selectedRows = (await exported.text()).split('\r\n');
  assert.equal(selectedRows[0], '"id","first_name","last_name","username","phone"');
  assert.deepEqual(selectedRows.slice(1).map(row => row.split(',')[0]).sort(), ['"1"', '"2"']);
  const allRows = (await (await request(exportPath, { headers })).text()).split('\r\n');
  assert.deepEqual(allRows.slice(1).map(row => row.split(',')[0]).sort(), ['"1"', '"2"', '"5"']);
});
test('registration cutoff rejects a stale quote and leaves prior orders payable', async t => {
  const { db, store, request } = fixture();
  t.after(() => db.close());
  const headers = { Cookie: await cookie(db, 99), Origin: 'https://example.test' };
  const registrationClosesAt = Math.floor(Date.now() / 1000) + 3600;
  const created = await request('/api/events', { method: 'POST', headers, body: JSON.stringify({
    name: 'کارگاه', capacity: 4, is_paid: 1, price: 1000, registration_closes_at: registrationClosesAt,
  }) });
  assert.equal(created.status, 201);
  const event = await created.json();
  assert.equal(event.registration_closes_at, registrationClosesAt);
  for (const id of [1, 2]) await store.upsertUser({ id, phone: '09123456789' });
  const { order } = await store.reserve(1, event.id, 1, 'existing-hold');
  const quote = await store.quoteOrder(2, event.id, 1);
  await store.saveEvent({ registration_closes_at: 1 }, event.id);
  assert.equal((await store.listEvents({ activeOnly: true })).length, 0);
  assert.equal((await store.stats()).active_events, 0);
  await assert.rejects(store.reserve(2, event.id, 1, 'stale-quote', quote), { code: 'EVENT_INACTIVE' });
  assert.equal((await store.submitReceipt(order.id, 1, 'receipt')).status, 'pending');
  assert.equal((await store.reviewOrder(order.id, true, 99)).status, 'approved');
  const changed = await request('/api/events/' + event.id, { method: 'PATCH', headers, body: '{"registration_closes_at":null}' });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).registration_open, 1);
});
test('event creation and editing save question settings with the event', async t => {
  const { db, store, request } = fixture();
  t.after(() => db.close());
  await store.setAdmin(7, 'checkin');
  await store.setAdmin(8, 'admin');
  const headers = { Cookie: await cookie(db, 8), Origin: 'https://example.test' };
  const write = (method, path, data, auth = headers) => request(path, { method, headers: auth, body: JSON.stringify(data) });
  const events = '/api/events';
  const closesAt = Math.floor(Date.now() / 1000) + 3600;
  const question_settings = { enabled: true, closes_at: closesAt, max_questions: 2 };
  const input = { name: 'گفت‌وگو با مهمان', capacity: 12, question_settings };

  const checkin = { ...headers, Cookie: await cookie(db, 7) };
  assert.equal((await write('POST', events, input, checkin)).status, 403);
  assert.equal((await write('POST', events, { ...input, question_settings: { ...question_settings, closes_at: 1 } })).status, 409);
  assert.deepEqual(await store.listEventsWithRegistrationStats(), []);

  const created = await write('POST', events, input);
  assert.equal(created.status, 201);
  const event = await created.json();
  assert.deepEqual(event.question_settings, { ...question_settings, enabled: 1 });
  const [listed] = await (await request(events, { headers })).json();
  assert.equal(listed.id, event.id);
  assert.equal(listed.questions_enabled, 1);
  assert.equal(listed.questions_closes_at, closesAt);
  assert.equal(listed.questions_max, 2);

  const path = events + '/' + event.id;
  assert.equal((await write('PATCH', path, { name: 'ویرایش نام', question_settings: { ...question_settings, max_questions: 4 } })).status, 409);
  assert.equal((await store.getEvent(event.id)).name, input.name);
  assert.equal((await write('PATCH', path, { active: false })).status, 200);
  assert.equal((await store.getEventQuestionSettings(event.id)).enabled, 1);

  const edited = await write('PATCH', path, { name: 'ویرایش نام', question_settings: { ...question_settings, enabled: false, max_questions: 1 } });
  assert.equal(edited.status, 200);
  const updated = await edited.json();
  assert.equal(updated.name, 'ویرایش نام');
  assert.deepEqual({ ...await store.getEventQuestionSettings(event.id) }, {
    id: event.id, name: updated.name, enabled: 0, closes_at: closesAt, max_questions: 1,
  });
});
test('the panel saves an optional event end, validates its order, and lets admins clear it', async t => {
  const { db, request } = fixture();
  t.after(() => db.close());
  const headers = { Cookie: await cookie(db, 99), Origin: 'https://example.test' };
  const write = (path, body, method = 'POST') => request(path, { method, headers, body: JSON.stringify(body) });
  const events = '/api/events';
  const start = '2026-12-03T23:30:00+03:30';
  const end = '2026-12-04T01:15:00+03:30';
  const input = { name: 'نشست شبانه', capacity: 10, starts_at: start };

  const noStart = await write(events, { ...input, starts_at: '', ends_at: end });
  assert.equal(noStart.status, 409);
  const sameTime = await write(events, { ...input, ends_at: start });
  assert.equal(sameTime.status, 409);
  const created = await write(events, { ...input, ends_at: end });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const path = events + '/' + id;

  const readEvent = async () => (await (await request(events, { headers })).json()).find(item => item.id === id);
  assert.equal((await readEvent()).ends_at, end);
  assert.equal((await write(path, { ends_at: 'invalid' }, 'PATCH')).status, 409);
  assert.equal((await write(path, { starts_at: end }, 'PATCH')).status, 409);
  assert.equal((await write(path, { active: false }, 'PATCH')).status, 200);
  assert.equal((await readEvent()).ends_at, end);
  assert.equal((await write(path, { ends_at: '' }, 'PATCH')).status, 200);
  assert.equal((await readEvent()).ends_at, '');
});
test('only panel admins can manage and download selected event questions', async t => {
  const { db, store, request } = fixture();
  t.after(() => db.close());
  await store.upsertUser({ id: 1, phone: '09123456789', first_name: 'SenderName' });
  await store.setAdmin(7, 'checkin');
  await store.setAdmin(8, 'admin');
  const event = await store.saveEvent({ name: 'گفت‌وگوی صنعت', capacity: 2 });
  const other = await store.saveEvent({ name: 'رویداد دیگر', capacity: 2 });
  await store.reserve(1, event.id, 1, 'registered');
  const path = `/api/events/${event.id}/questions`;
  const checkin = { Cookie: await cookie(db, 7) };
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path + '/export')).status, 401);
  assert.equal((await request(path, { headers: checkin })).status, 403);
  assert.equal((await request(path + '/export', { headers: checkin })).status, 403);

  const admin = { Cookie: await cookie(db, 8), Origin: 'https://example.test' };
  const patch = (url, body) => request(url, { method: 'PATCH', headers: admin, body: JSON.stringify(body) });
  const initial = await (await request(path, { headers: admin })).json();
  assert.equal(initial.enabled, 0);
  assert.equal(initial.closes_at, null);
  assert.equal((await patch(path, { enabled: true, closes_at: 1 })).status, 409);
  const closesAt = Math.floor(Date.now() / 1000) + 3600;
  assert.equal((await patch(path, { enabled: true, closes_at: closesAt })).status, 200);
  await store.submitEventQuestion(event.id, 1, 'نقش دانشجویان در صنعت چیست؟', 'chosen');
  await store.submitEventQuestion(event.id, 1, 'پرسش دیگر برای مهمان', 'unselected');
  const page = await (await request(path + '?limit=1&offset=1', { headers: admin })).json();
  assert.equal(page.closes_at, closesAt);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].question, 'نقش دانشجویان در صنعت چیست؟');
  assert.equal('user_id' in page.items[0], false);
  const { id } = page.items[0];
  assert.equal((await patch(`/api/events/${other.id}/questions/${id}`, { selected: true })).status, 409);
  const messagesBeforeReview = await store.one('SELECT COUNT(*) AS count FROM outbox');
  assert.equal((await patch(path + '/' + id, { selected: true, topic: 'فرصت‌های شغلی' })).status, 200);
  const approved = await (await request(path + '?status=approved', { headers: admin })).json();
  const pending = await (await request(path + '?status=pending', { headers: admin })).json();
  assert.deepEqual(approved.items.map(item => item.id), [id]);
  assert.deepEqual(pending.items.map(item => item.question), ['پرسش دیگر برای مهمان']);
  assert.deepEqual(await store.one('SELECT COUNT(*) AS count FROM outbox'), messagesBeforeReview);
  const exportResponse = await request(path + '/export', { headers: admin });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('Content-Disposition'), /attachment.*questions\.txt/);
  assert.equal(exportResponse.headers.get('Cache-Control'), 'no-store');
  const output = await exportResponse.text();
  assert.match(output, /فرصت‌های شغلی[\s\S]+نقش دانشجویان در صنعت چیست/);
  assert.doesNotMatch(output, /SenderName|09123456789|پرسش دیگر/);
  assert.equal((await patch(path + '/' + id, { selected: false, topic: 'فرصت‌های شغلی' })).status, 200);
  const updatedExport = await request(path + '/export', { headers: admin });
  assert.doesNotMatch(await updatedExport.text(), /نقش دانشجویان|پرسش دیگر/);
  assert.deepEqual(await store.one('SELECT COUNT(*) AS count FROM outbox'), messagesBeforeReview);
});
test('payment support connects the bot thread to an admin-only inbox, with one owner and reply', async t => {
  const { db, env, store, request } = fixture();
  t.after(() => db.close());
  await store.upsertUser({ id: 1, phone: '09123456789' });
  await store.setAdmin(7, 'checkin');
  await store.setAdmin(8, 'admin');
  const event = await store.saveEvent({ name: 'کارگاه', capacity: 2, is_paid: true, price: 50000 });
  const { order } = await store.reserve(1, event.id, 1, 'paid-for-support');
  await db.prepare('UPDATE orders SET expires_at=unixepoch()-1 WHERE id=?').bind(order.id).run();
  await store.expireOrders();
  const notice = JSON.parse((await store.one("SELECT payload FROM outbox WHERE method='sendMessage'")).payload);
  const orderButton = notice.reply_markup.inline_keyboard[0][0];
  assert.equal(orderButton.callback_data, `sp:o:${order.id}`);

  let seq = 0;
  const click = (data, id = 1) => handleUpdate({
    update_id: ++seq, callback_query: { id: String(seq), data, from: { id }, message: { chat: { id, type: 'private' } } },
  }, env, store);
  const say = (id, message, updateId = ++seq) => handleUpdate({
    update_id: updateId, message: { from: { id }, chat: { id, type: 'private' }, ...message },
  }, env, store);
  await click(orderButton.callback_data, 2);
  assert.equal(await store.getState(2), null);
  await click(orderButton.callback_data);
  const submitted = ++seq;
  const receipt = { caption: 'رسید بعد از مهلت', document: { file_id: 'private-receipt-id', mime_type: 'application/pdf', file_size: 512 } };
  await say(1, receipt, submitted);
  await say(1, receipt, submitted);
  const [ticket] = await store.listSupportTickets();
  assert.equal(ticket.order_id, order.id);
  assert.equal(ticket.status, 'new');
  const [first] = await store.listSupportMessages(ticket.id);
  assert.equal(first.text, receipt.caption);
  assert.equal(first.has_file, 1);
  assert.equal((await store.listSupportMessages(ticket.id)).length, 1);
  await click(`sp:r:${ticket.id}`, 2);
  assert.equal(await store.getState(2), null);

  const support = '/api/support';
  const path = support + '/' + ticket.id;
  const filePath = path + '/attachments/' + first.id;
  assert.equal((await request(filePath)).status, 401);
  const checkin = { Cookie: await cookie(db, 7) };
  assert.equal((await request(support, { headers: checkin })).status, 403);
  assert.equal((await request(filePath, { headers: checkin })).status, 403);
  const admins = await Promise.all([8, 99].map(async id => ({ Cookie: await cookie(db, id), Origin: env.PUBLIC_URL })));
  const post = (suffix, headers, body) => request(path + '/' + suffix, { method: 'POST', headers, body: JSON.stringify(body) });
  const claims = await Promise.all(admins.map(headers => post('claim', headers)));
  assert.deepEqual(claims.map(reply => reply.status).sort(), [200, 409]);
  const winner = claims.findIndex(reply => reply.status === 200);
  const reply = { requestKey: crypto.randomUUID(), text: 'شماره پیگیری واریز را بفرستید.', waitForUser: true };
  db.exec("CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON outbox WHEN NEW.dedupe_key LIKE 'support-reply:%' BEGIN SELECT RAISE(ABORT,'fixture_outbox_failure'); END;");
  await assert.rejects(store.replyToSupportTicket(ticket.id, [8, 99][winner], reply), /fixture_outbox_failure/);
  assert.equal((await store.listSupportMessages(ticket.id)).length, 1);
  db.exec('DROP TRIGGER fixture_outbox_failure');
  assert.equal((await post('reply', admins[1 - winner], reply)).status, 409);
  assert.equal((await post('reply', admins[winner], reply)).status, 202);
  assert.equal((await post('reply', admins[winner], reply)).status, 202);
  const thread = await (await request(path, { headers: admins[0] })).json();
  assert.equal(thread.ticket.status, 'waiting_user');
  assert.equal(thread.messages.length, 2);
  assert.doesNotMatch(JSON.stringify(thread), /private-receipt-id/);

  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/getFile')) {
      assert.equal(JSON.parse(options.body).file_id, 'private-receipt-id');
      return Response.json({ ok: true, result: { file_path: 'documents/receipt.pdf', file_size: 4 } });
    }
    if (url.endsWith('/documents/receipt.pdf')) return new Response('%PDF', { headers: { 'Content-Type': 'application/pdf' } });
    if (url.endsWith('/sendMessage')) sent.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  });
  const downloaded = await request(filePath, { headers: admins[0] });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('Cache-Control'), 'no-store');
  assert.equal(await downloaded.text(), '%PDF');
  assert.equal((await request(support + '/9999/attachments/' + first.id, { headers: admins[0] })).status, 404);
  await processOutbox(env, 30);
  const delivery = sent.filter(payload => payload.text.includes(reply.text));
  assert.equal(delivery.length, 1);
  assert.equal(delivery[0].chat_id, 1);
  assert.equal(delivery[0].reply_markup.inline_keyboard[0][0].callback_data, `sp:v:${ticket.id}:0`);

  await click(`sp:r:${ticket.id}`);
  await say(1, { text: 'شماره مرجع در پیوست بالا است.' });
  assert.equal((await store.getSupportTicket(ticket.id)).status, 'in_review');
  assert.equal((await post('close', admins[winner])).status, 200);
  assert.equal((await store.getSupportTicket(ticket.id)).status, 'closed');
  await click(orderButton.callback_data);
  await click(`sp:r:${ticket.id}`);
  await say(1, { text: 'هنوز نتیجه را نگرفته‌ام.' });
  assert.equal((await store.listSupportTickets()).length, 1);
  assert.equal((await store.getSupportTicket(ticket.id)).status, 'in_review');
  assert.equal((await store.getOrder(order.id)).status, 'expired');
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
test('public event poster endpoint and ticket layout with poster and without poster', async () => {
  const { db, store, request } = fixture();
  await store.upsertUser({ id: 1, first_name: 'رضا' });

  const plainEvent = await store.saveEvent({ name: 'بدون پوستر', capacity: 2 });
  const { tickets: plainTickets } = await store.reserve(1, plainEvent.id, 1, 'order-plain');
  const plainPage = await (await request('/ticket/' + plainTickets[0].token)).text();
  assert.ok(!plainPage.includes('ticket-poster-pane'));
  assert.equal((await request(`/api/events/${plainEvent.id}/poster`)).status, 404);

  const sampleDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const posterEvent = await store.saveEvent({ name: 'دارای پوستر', capacity: 2, poster_url: sampleDataUrl });
  const { tickets: posterTickets } = await store.reserve(1, posterEvent.id, 1, 'order-poster');
  const posterPage = await (await request('/ticket/' + posterTickets[0].token)).text();
  assert.ok(posterPage.includes('ticket-view has-poster'));
  assert.ok(posterPage.includes('ticket-poster-pane'));
  assert.ok(posterPage.includes(`src="/api/events/${posterEvent.id}/poster"`));

  const posterRes = await request(`/api/events/${posterEvent.id}/poster`);
  assert.equal(posterRes.status, 200);
  assert.equal(posterRes.headers.get('Content-Type'), 'image/png');
  const buffer = await posterRes.arrayBuffer();
  assert.ok(buffer.byteLength > 0);

  const urlEvent = await store.saveEvent({ name: 'لینک پوستر', capacity: 2, poster_url: 'https://example.test/poster.jpg' });
  const urlRes = await request(`/api/events/${urlEvent.id}/poster`);
  assert.equal(urlRes.status, 302);
  assert.equal(urlRes.headers.get('Location'), 'https://example.test/poster.jpg');

  db.close();
});
