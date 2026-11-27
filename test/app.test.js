import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createDatabase } from '../src/sqlite.js';
import { Store } from '../src/store.js';
import { handleRequest } from '../src/app.js';
import { handleUpdate } from '../src/bot.js';
import { createLoginCode, exchangeLogin, digest, SESSION_COOKIE } from '../src/auth.js';
import { receiveUpdate, processOutbox, processInbox } from '../src/jobs.js';
import { receiveTelegram } from '../src/telegram-receiver.js';
import worker from '../src/worker.js';

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
test('late payment approval checks access, claims available capacity and sends one ticket notification', async t => {
  const { db, env, store, request } = fixture();
  t.after(() => db.close());
  await store.upsertUser({ id: 1, phone: '09123456789' });
  await store.upsertUser({ id: 2, phone: '09223456789' });
  await store.setAdmin(7, 'checkin');
  await store.setAdmin(8, 'admin');
  const event = await store.saveEvent({ name: 'کارگاه', capacity: 2, max_per_user: 2, is_paid: 1, price: 1000 });
  const { order, tickets } = await store.reserve(1, event.id, 2, 'late');
  await db.prepare("UPDATE orders SET status='expired' WHERE id=?").bind(order.id).run();
  await db.prepare('DELETE FROM tickets WHERE id=?').bind(tickets[1].id).run();
  const { order: replacement } = await store.reserve(2, event.id, 1, 'replacement');
  const path = '/api/orders/' + order.id + '/approve-expired-payment';
  const approve = (auth, confirmed) => request(path, {
    method: 'POST', headers: { Origin: env.PUBLIC_URL, ...(auth ? { Cookie: auth } : {}) },
    body: JSON.stringify({ confirmed }),
  });
  assert.equal((await approve(null, true)).status, 401);
  assert.equal((await approve(await cookie(db, 7), true)).status, 403);
  const auth = await cookie(db, 8);
  assert.equal((await approve(auth, false)).status, 400);
  const full = await approve(auth, true);
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, 'EVENT_FULL');
  await store.cancelOrder(replacement.id, 2);

  db.exec("CREATE TRIGGER reject_late_notification BEFORE INSERT ON outbox WHEN NEW.method='__notify_late_payment' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.equal((await approve(auth, true)).status, 500);
  assert.equal((await store.getOrder(order.id)).status, 'expired');
  assert.equal((await store.getOrder(order.id)).tickets.length, 1);
  db.exec('DROP TRIGGER reject_late_notification;');
  const results = await Promise.all([approve(auth, true), approve(auth, true)]);
  assert.ok(results.every(response => response.status === 200));
  const approved = await Promise.all(results.map(response => response.json()));
  assert.deepEqual(approved.map(result => result.already_reviewed).sort(), [false, true]);
  assert.ok(approved.every(result => result.tickets.length === 2 && result.tickets.some(item => item.id === tickets[0].id)));
  assert.equal((await store.getEvent(event.id)).remaining, 0);
  assert.equal((await store.one("SELECT COUNT(*) AS n FROM audit_log WHERE action='approve_expired_payment'")).n, 1);

  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  };
  try { await processOutbox(env); } finally { globalThis.fetch = original; }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, 1);
  assert.match(sent[0].text, /بلیت برای شما صادر شد/);
  const buttons = sent[0].reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, 2);
  assert.equal((await request(new URL(buttons[0].url).pathname)).status, 200);
});

test('event statistics count distinct registrants, checked-in tickets and live reservations', async t => {
  const { db, store, request } = fixture();
  t.after(() => db.close());
  for (let id = 1; id <= 5; id++) await store.upsertUser({ id, phone: '09123456789' });
  await store.upsertUser({ id: 1, full_name: 'سارا احمدی راد' });
  await store.upsertUser({ id: 2, first_name: 'رضا', last_name: 'کریمی' });
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
  assert.equal(selectedRows[0], '"id","first_name","last_name","username","phone","full_name"');
  assert.deepEqual(selectedRows.slice(1).map(row => row.split(',')[0]).sort(), ['"1"', '"2"']);
  assert.ok(selectedRows.find(row => row.startsWith('"1",')).endsWith('"سارا احمدی راد"'));
  assert.ok(selectedRows.find(row => row.startsWith('"2",')).endsWith('"رضا کریمی"'));
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
  const { db, store, request } = fixture(); await store.upsertUser({ id: 1, full_name: 'PrivateName Example', phone: '09123456789' });
  const event = await store.saveEvent({ name: '<script>bad</script>', capacity: 2 });
  const { tickets } = await store.reserve(1, event.id, 1, 'first'); const ticket = tickets[0];
  assert.equal((await request('/ticket/' + ticket.id)).status, 404);
  const page = await request('/ticket/' + ticket.token); const text = await page.text();
  assert.equal(page.status, 200); assert.ok(!text.includes('PrivateName')); assert.ok(!text.includes('09123456789')); assert.ok(!text.includes('<script>'));
  const headers = { Cookie: await cookie(db, 99) };
  const printed = await request('/api/print?eventId=' + event.id, { headers });
  assert.match(await printed.text(), /PrivateName Example/);
  const search = await request('/api/users?search=PrivateName%20Example', { headers });
  assert.deepEqual((await search.json()).map(user => user.full_name), ['PrivateName Example']);
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
test('blocked Telegram accounts get no processing for messages or callbacks', async t => {
  const { db, env, store, request } = fixture();
  t.after(() => db.close());
  const message = (update_id, id) => ({ update_id, message: { from: { id }, chat: { id, type: 'private' }, text: '/start' } });
  await receiveUpdate(env, message(1, 42));
  env.BLOCKED_TELEGRAM_USER_IDS = '7, 42';
  const post = update => request('/telegram', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET },
    body: JSON.stringify(update),
  });
  assert.equal((await post(message(2, 42))).status, 200);
  assert.equal((await post({ update_id: 3, callback_query: { from: { id: 42 } } })).status, 200);
  assert.equal((await post(message(4, 142))).status, 200);
  assert.deepEqual((await store.all('SELECT update_id FROM inbox ORDER BY update_id')).map(item => item.update_id), [1, 4]);
  await processInbox(env, 1, '42');
  assert.equal((await store.one('SELECT status FROM inbox WHERE update_id=1')).status, 'done');
  assert.equal((await store.one("SELECT count(*) AS n FROM outbox WHERE json_extract(payload,'$.chat_id')=?", 42)).n, 0);
});

test('Telegram ingress caps queued work and blocks repeated bursts after verifying unique, recent messages', async t => {
  const { db, env, store, request } = fixture();
  t.after(() => db.close());
  env.TELEGRAM_ABUSE_SAMPLE = { limit: async () => ({ success: true }) };
  const now = Math.floor(Date.now() / 1000) - 1;
  const update = (id, from, text, date = now) => ({
    update_id: id, message: { date, message_id: id, from: { id: from, username: 'fixture_user' }, chat: { id: from, type: 'private' }, text },
  });
  const waiting = async id => (await store.one("SELECT count(*) AS n FROM inbox WHERE stream_key=? AND status='new'", String(id))).n;
  for (let index = 1; index <= 24; index++) {
    assert.equal(await receiveUpdate(env, update(index, 1, 'متن متفاوت ' + index)), '1');
    assert.equal(await receiveUpdate(env, update(100 + index, 2, 'تکراری')), '2');
    assert.equal(await receiveUpdate(env, update(200 + index, 3, 'پیام مانده نزد تلگرام', now - 300)), '3');
  }
  assert.equal(await receiveUpdate(env, update(25, 1, 'یک متن متفاوت دیگر')), null);
  assert.equal(await waiting(1), 24);
  assert.equal(await receiveUpdate(env, update(225, 3, 'متن تازه')), null);
  assert.equal(await waiting(3), 24);
  assert.equal((await store.listTelegramAbuseBlocks()).length, 0);

  assert.equal(await receiveUpdate(env, update(124, 2, 'تکراری')), null);
  assert.equal((await store.listTelegramAbuseBlocks()).length, 0);
  assert.equal(await receiveUpdate(env, update(125, 2, 'تکراری')), null);
  assert.equal(await waiting(2), 0);
  const [block] = await store.listTelegramAbuseBlocks();
  assert.equal(block.stream_key, '2');
  assert.equal(block.message_count, 24);
  assert.equal(block.repeated_count, 23);
  assert.equal(await receiveUpdate(env, update(126, 2, 'متن تازه')), null);
  assert.equal(await receiveUpdate(env, update(301, 4, 'ثبت‌نام')), '4');

  env.TELEGRAM_INGRESS_RATE = { limit: async () => ({ success: false }) };
  const preventedCallback = { update_id: 302, callback_query: { from: { id: 4 } } };
  assert.equal(await receiveUpdate(env, preventedCallback), null);
  assert.equal((await store.listTelegramAbuseBlocks()).length, 1);
  assert.equal(await waiting(4), 1);
  delete env.TELEGRAM_INGRESS_RATE;

  await store.setAdmin(7, 'checkin');
  const URL = '/api/telegram-abuse-blocks';
  assert.equal((await request(URL)).status, 401);
  assert.equal((await request(URL, { headers: { Cookie: await cookie(db, 7) } })).status, 403);
  const auth = await cookie(db, 99);
  const response = await request(URL + '/2', { method: 'DELETE', headers: { Origin: env.PUBLIC_URL, Cookie: auth } });
  assert.equal(response.status, 200);
  assert.deepEqual(await (await request(URL, { headers: { Cookie: auth } })).json(), []);
  assert.equal(await receiveUpdate(env, update(127, 2, 'پس از رفع مسدودسازی')), '2');
});

test('the Compose receiver queues Telegram callbacks and forwards registration replies after acknowledgement', async t => {
  const { db, env, request, store } = fixture();
  t.after(() => db.close());
  env.DEFER_TELEGRAM_JOBS = true;
  const event = await store.saveEvent({ name: 'رویداد تست', capacity: 4 });
  const shutdown = new AbortController();
  const offsets = [];
  const replies = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/getUpdates')) {
      offsets.push(JSON.parse(init.body).offset);
      if (offsets.length === 1) return Response.json({ ok: true, result: [{
        update_id: 123, callback_query: { id: 'fixture', from: { id: 42 }, data: `e:${event.id}`,
          message: { chat: { type: 'private', id: 42 } } },
      }] });
      shutdown.abort();
      return Response.json({ ok: true, result: [] });
    }
    if (path === '/telegram') return request('/telegram', init);
    replies.push(JSON.parse(init.body));
    return Response.json({ ok: true });
  });
  await receiveTelegram(env, AbortSignal.any([shutdown.signal, AbortSignal.timeout(1500)]));
  assert.deepEqual(offsets, [undefined, 124]);
  assert.equal((await store.one('SELECT status FROM inbox WHERE update_id=123')).status, 'new');
  await processInbox(env);
  await processOutbox(env, 8, 'interactive');
  assert.ok(replies.some(reply => reply.reply_markup?.inline_keyboard[0][0].callback_data === `register:${event.id}`));
});

test('standalone intake caps combined accounts and records a rejected update', async t => {
  const { db, env } = fixture();
  t.after(() => db.close());
  const counters = [];
  Object.assign(env, { INBOX_CAPACITY: 2, RECORD_QUEUE_EVENT: name => counters.push(name) });
  const update = id => ({ update_id: id, message: { from: { id }, chat: { type: 'private', id }, text: '/start' } });
  assert.equal(await receiveUpdate(env, update(1)), '1');
  assert.equal(await receiveUpdate(env, update(2)), '2');
  assert.equal(await receiveUpdate(env, update(3)), null);
  assert.deepEqual(counters, ['not_enqueued']);
  await processInbox(env);
  assert.equal(await receiveUpdate(env, update(4)), '4');
  assert.equal((await db.prepare("SELECT count(*) AS n FROM inbox WHERE status IN ('new','processing')").first()).n, 2);
});

test('updates refused by a sender limit do not consume the shared Telegram budget', async t => {
  const { db, env, store } = fixture();
  t.after(() => db.close());
  const perAccount = new Map();
  env.INBOX_CAPACITY = 256;
  env.TELEGRAM_INGRESS_RATE = { async limit({ key }) {
    const used = (perAccount.get(key) || 0) + 1;
    perAccount.set(key, used);
    return { success: used <= 40 };
  } };
  const globalRate = t.mock.fn(async () => ({ success: globalRate.mock.calls.length < 41 }));
  env.TELEGRAM_GLOBAL_RATE = { limit: globalRate };
  const update = (id, actor) => ({ update_id: id, message: { from: { id: actor }, chat: { id: actor, type: 'private' } } });
  for (let id = 1; id <= 80; id++) await receiveUpdate(env, update(id, 7));
  assert.equal(globalRate.mock.calls.length, 40);
  assert.equal((await store.one("SELECT count(*) AS n FROM inbox WHERE stream_key='7'")).n, 24);
  assert.equal(await receiveUpdate(env, update(81, 8)), '8');
  assert.equal(globalRate.mock.calls.length, 41);
  assert.equal(await receiveUpdate(env, update(82, 9)), null);
});

test('valid receipts and registration confirmations have reserved space and are not acknowledged before storing', async t => {
  const { db, env, store, request } = fixture();
  t.after(() => db.close());
  Object.assign(env, { INBOX_CAPACITY: 1, VERIFICATION_CHAT: '100', DEFER_TELEGRAM_JOBS: true });
  const post = update => request('/telegram', { method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET }, body: JSON.stringify(update) });
  const privateMessage = (id, actor, data) => ({ update_id: id, message: { from: { id: actor }, chat: { type: 'private', id: actor }, ...data } });
  await receiveUpdate(env, privateMessage(1, 80, { text: '/start' }));
  env.TELEGRAM_GLOBAL_RATE = { async limit() { return { success: false }; } };
  env.TELEGRAM_INGRESS_RATE = env.TELEGRAM_GLOBAL_RATE;
  for (const id of [9, 10]) await store.upsertUser({ id, phone: '09123456789' });
  const event = await store.saveEvent({ name: 'کارگاه', capacity: 10, is_paid: 1, price: 1000 });
  const { order } = await store.reserve(9, event.id, 1, 'reserved-9');
  await store.setState(9, 'payment_receipt', { order_id: order.id });
  await store.setState(10, 'reserve_confirm', { quote_nonce: '0123456789ab' });
  const confirm = (id, nonce) => ({ update_id: id, callback_query: {
    id: `callback-${id}`, from: { id: 10 }, message: { chat: { id: 10, type: 'private' } }, data: `rq:y:${nonce}`,
  } });
  const receipt = { document: { mime_type: 'application/pdf', file_id: 'pdf-file', file_size: 1024 } };
  assert.equal((await post(privateMessage(2, 7, receipt))).status, 200);
  assert.equal((await post(confirm(3, '0123456789ac'))).status, 200);
  assert.equal((await post(confirm(4, '0123456789ab'))).status, 200);
  await db.prepare(`WITH RECURSIVE filler(n) AS (SELECT 100 UNION ALL SELECT n+1 FROM filler WHERE n<130)
    INSERT INTO inbox(update_id,stream_key,payload) SELECT n,CAST(n AS TEXT),'{}' FROM filler`).run();
  assert.equal((await post(privateMessage(5, 9, receipt))).status, 503);
  assert.equal((await post(confirm(4, '0123456789ab'))).status, 200);
  assert.equal(await store.one('SELECT priority FROM inbox WHERE update_id=5'), null);
  await db.prepare('DELETE FROM inbox WHERE update_id=130').run();
  assert.equal((await post(privateMessage(5, 9, receipt))).status, 200);
  assert.deepEqual((await store.all('SELECT update_id FROM inbox WHERE priority=1 ORDER BY update_id')).map(row => row.update_id), [4, 5]);
  await processInbox(env, 1, '9');
  assert.equal((await store.getOrder(order.id)).status, 'pending');
  assert.equal((await store.one("SELECT count(*) AS n FROM outbox WHERE dedupe_key LIKE 'receipt:%'")).n, 1);
  await processInbox(env, 1);
  assert.equal((await store.one('SELECT status FROM inbox WHERE update_id=1')).status, 'new');
});

test('an outbox backlog delays broadcasts and ordinary intake until the outgoing queue drains', async t => {
  const { db, env, store } = fixture();
  t.after(() => db.close());
  env.OUTBOX_BACKPRESSURE = true;
  await store.enqueue('__broadcast', { text: 'hello' }, 'broadcast-test');
  await db.prepare(`WITH RECURSIVE filler(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM filler WHERE n<1023)
    INSERT INTO outbox(id,method,payload,available_at) SELECT 'future-'||n,'sendMessage','{}',unixepoch()+7200 FROM filler`).run();
  await receiveUpdate(env, { update_id: 1, message: { from: { id: 9 } } });
  await processInbox(env, 1);
  await processOutbox(env, 1, 'bulk');
  assert.equal((await store.one('SELECT attempts FROM inbox')).attempts, 0);
  assert.equal((await store.one("SELECT attempts FROM outbox WHERE dedupe_key='broadcast-test'")).attempts, 0);
  await db.prepare("DELETE FROM outbox WHERE id='future-1'").run();
  await processInbox(env, 1);
  await processOutbox(env, 1, 'bulk');
  assert.equal((await store.one('SELECT status FROM inbox')).status, 'done');
  assert.equal((await store.one("SELECT status FROM outbox WHERE dedupe_key='broadcast-test'")).status, 'sent');
});

test('the database cap remains active if the shared rate-limit binding is temporarily unavailable', async t => {
  const { db, env } = fixture();
  t.after(() => db.close());
  env.INBOX_CAPACITY = 1;
  env.TELEGRAM_GLOBAL_RATE = { async limit() { throw new Error('fixture outage'); } };
  const update = id => ({ update_id: id, message: { from: { id } } });
  assert.equal(await receiveUpdate(env, update(1)), '1');
  assert.equal(await receiveUpdate(env, update(2)), null);
});

test('Worker refuses to claim additional inbox work while another invocation holds the running slot', async t => {
  const { db, env, store } = fixture();
  t.after(() => db.close());
  env.INBOX_CONCURRENCY = 1;
  for (const id of [1, 2]) {
    await receiveUpdate(env, { update_id: id, message: { from: { id }, chat: { type: 'private', id }, text: '/start' } });
  }
  await db.prepare("UPDATE inbox SET status='processing',lease_until=unixepoch()+90 WHERE update_id=1").run();
  await processInbox(env, 5, '2');
  assert.equal((await store.one('SELECT status FROM inbox WHERE update_id=2')).status, 'new');
  await db.prepare('UPDATE inbox SET lease_until=0 WHERE update_id=1').run();
  await processInbox(env, 5);
  assert.equal((await store.one("SELECT count(*) AS n FROM inbox WHERE status='done'")).n, 2);
});

test('Cloudflare app mode limits only authenticated Telegram ingress', async t => {
  const { db, env } = fixture();
  t.after(() => db.close());
  const ctx = { waitUntil() {} };
  const rate = t.mock.fn(async () => ({ success: false }));
  env.HOSTING_MODE = 'cloudflare';
  env.TELEGRAM_GLOBAL_RATE = { limit: rate };
  assert.equal((await worker.fetch(new Request('https://preview.example.test/health'), env, ctx)).status, 200);
  assert.equal((await worker.fetch(new Request('https://preview.example.test/api/session'), env, ctx)).status, 404);
  assert.equal((await worker.fetch(new Request('https://example.test/admin'), env, ctx)).status, 200);
  const options = { method: 'POST', body: JSON.stringify({ update_id: 1, message: { from: { id: 1 } } }) };
  assert.equal((await worker.fetch(new Request('https://example.test/telegram', options), env, ctx)).status, 403);
  assert.equal(rate.mock.calls.length, 0);
  const authorized = new Request('https://example.test/telegram', {
    ...options, headers: { 'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET },
  });
  assert.equal((await worker.fetch(authorized, env, ctx)).status, 200);
  assert.equal(rate.mock.calls.length, 1);
  assert.equal(await db.prepare('SELECT count(*) FROM inbox').first('count(*)'), 0);
});

test('automatic deployment uses the Arvan relay and limits its authenticated Telegram API only', async t => {
  const rate = t.mock.fn(async () => ({ success: false }));
  const env = { BOT_TOKEN: 'fixture', ARVAN_RELAY_TOKEN: 'fixture', TELEGRAM_RELAY_RATE: { limit: rate } };
  const schedule = t.mock.fn();
  const ctx = { waitUntil: schedule };
  const panel = await worker.fetch(new Request('https://worker.example.test/admin'), env, ctx);
  assert.equal(panel.status, 302);
  assert.ok(panel.headers.get('Location').endsWith('/admin'));
  worker.scheduled({}, env, ctx);
  assert.equal(schedule.mock.calls.length, 0);
  const endpoint = 'https://worker.example.test/_arvan_telegram/getMe';
  assert.equal((await worker.fetch(new Request(endpoint), env, ctx)).status, 404);
  assert.equal(rate.mock.calls.length, 0);
  const response = await worker.fetch(new Request(endpoint, { headers: { 'X-Robotics-Origin-Token': 'fixture' } }), env, ctx);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).parameters.retry_after, 10);
  assert.equal(rate.mock.calls.length, 1);
});

test('interactive outbox sends registration replies ahead of waiting media and broadcasts', async t => {
  const { db, env, store } = fixture();
  t.after(() => db.close());
  await store.enqueue('sendPhoto', { chat_id: 1, photo: 'fixture-photo' }, 'old-photo');
  await store.enqueue('sendMessage', { chat_id: 1, text: 'broadcast' }, 'broadcast-example:user:1');
  await store.enqueue('sendMessage', { chat_id: 1, text: 'ثبت‌نام' }, 'registration-reply');
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  env.OUTBOX_LANE_CONCURRENCY = 1;
  await db.prepare("UPDATE outbox SET status='processing',lease_until=unixepoch()+90 WHERE dedupe_key='old-photo'").run();
  await processOutbox(env, 8, 'interactive');
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).text, 'ثبت‌نام');
  assert.equal((await store.one("SELECT count(*) AS n FROM outbox WHERE status IN ('pending','processing')")).n, 2);
});

test('Telegram 429 backs off durable outbox without dropping message', async () => {
  const { db, env, store } = fixture(); await store.enqueue('sendMessage', { chat_id: 1, text: 'hello' }, 'x');
  const original = globalThis.fetch; globalThis.fetch = async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 60 } });
  try { await processOutbox(env, 1); } finally { globalThis.fetch = original; }
  const job = await db.prepare('SELECT * FROM outbox').first(); assert.equal(job.status, 'pending'); assert.ok(job.available_at >= Math.floor(Date.now() / 1000) + 59); db.close();
});

test('uncertain receipt sends are held for panel review without resending the same media', async t => {
  const { db, env, store } = fixture();
  t.after(() => db.close());
  await store.enqueue('sendPhoto', { chat_id: 1, photo: 'fixture-photo' }, 'receipt:timeout:photo');
  await store.enqueue('sendPhoto', { chat_id: 1, photo: 'fixture-photo' }, 'receipt:interrupted:photo');
  await store.enqueue('sendDocument', { chat_id: 1, document: 'fixture-pdf' }, 'receipt:old-retry:pdf');
  await store.enqueue('sendMessage', { chat_id: 1, text: 'Regular message' }, 'regular');
  await db.prepare("UPDATE outbox SET status='processing',attempts=1,lease_until=0 WHERE dedupe_key='receipt:interrupted:photo'").run();
  await db.prepare("UPDATE outbox SET attempts=1,last_error='Timed out' WHERE dedupe_key='receipt:old-retry:pdf'").run();

  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    const payload = JSON.parse(request.body);
    calls.push(payload);
    if (payload.photo) throw new DOMException('Timed out', 'TimeoutError');
    return Response.json({ ok: true });
  };
  try {
    await processOutbox(env);
    await db.prepare("UPDATE outbox SET available_at=0 WHERE status='pending'").run();
    await processOutbox(env);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.filter(payload => payload.photo || payload.document).length, 1);
  assert.equal(calls.filter(payload => payload.text).length, 1);
  const held = await store.all("SELECT status,attempts,last_error FROM outbox WHERE dedupe_key LIKE 'receipt:%'");
  assert.equal(held.length, 3);
  for (const row of held) {
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /Receipt delivery unconfirmed/);
  }
});

test('a receipt is retried after Telegram explicitly rejects the send with a rate limit', async t => {
  const { db, env, store } = fixture();
  t.after(() => db.close());
  await store.enqueue('sendDocument', { chat_id: 1, document: 'fixture-pdf' }, 'receipt:rate-limit:pdf');
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => ++requests === 1
    ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, { status: 429 })
    : Response.json({ ok: true });
  try {
    await processOutbox(env);
    const first = await store.one('SELECT status,last_error,available_at FROM outbox');
    assert.equal(first.status, 'pending');
    assert.match(first.last_error, /^Telegram 429:/);
    assert.ok(first.available_at >= Math.floor(Date.now() / 1000) + 59);
    await db.prepare('UPDATE outbox SET available_at=0').run();
    await processOutbox(env);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(requests, 2);
  const sent = await store.one('SELECT status,attempts FROM outbox');
  assert.equal(sent.status, 'sent');
  assert.equal(sent.attempts, 2);
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

test('a new webhook processes its sender without waiting for another sender’s backlog', async t => {
  const { db, env, store } = fixture();
  t.after(() => db.close());
  for (let id = 1; id <= 4; id++) await receiveUpdate(env, { update_id: id, message: { from: { id: 1 } } });
  const stream = await receiveUpdate(env, { update_id: 5, message: { from: { id: 2 } } });
  await receiveUpdate(env, { update_id: 6, message: { from: { id: 2 } } });
  const status = id => store.one('SELECT status FROM inbox WHERE update_id=?', id).then(row => row.status);
  await db.prepare('UPDATE inbox SET available_at=unixepoch()+300 WHERE update_id=5').run();
  await processInbox(env, 1, stream);
  assert.equal(await status(5), 'new');
  assert.equal(await status(6), 'new');
  await db.prepare('UPDATE inbox SET available_at=0 WHERE update_id=5').run();
  await processInbox(env, 1, stream);
  assert.equal(await status(1), 'new');
  assert.equal(await status(5), 'done');
  assert.equal(await status(6), 'new');
  await processInbox(env, 2);
  assert.equal(await status(1), 'done');
  assert.equal(await status(2), 'new');
  assert.equal(await status(6), 'done');
});

test('inbox claims the first eligible active update and recovers an expired lease in order', async t => {
  const { db, env } = fixture();
  t.after(() => db.close());
  await db.prepare(`WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<1000)
    INSERT INTO inbox(update_id,stream_key,status,payload) SELECT id,'2','done','{}' FROM ids`).run();
  for (const [update_id, id] of [[1001, 2], [1002, 2], [1003, 3], [1004, 4], [1005, 5]]) {
    await receiveUpdate(env, { update_id, message: { from: { id } } });
  }
  await db.prepare("UPDATE inbox SET status='processing',lease_until=unixepoch()+300 WHERE update_id=1001").run();
  await db.prepare("UPDATE inbox SET status='failed' WHERE update_id=1003").run();
  await processInbox(env);
  const status = id => db.prepare('SELECT status FROM inbox WHERE update_id=?').bind(id).first('status');
  assert.equal(await status(1001), 'processing');
  assert.equal(await status(1002), 'new');
  assert.equal(await status(1003), 'failed');
  assert.equal(await status(1004), 'done');
  assert.equal(await status(1005), 'new');
  await db.prepare('UPDATE inbox SET lease_until=unixepoch()-1 WHERE update_id=1001').run();
  await processInbox(env);
  assert.equal(await status(1001), 'done');
  assert.equal(await status(1002), 'new');
  await processInbox(env);
  assert.equal(await status(1002), 'done');
  assert.equal(await status(1005), 'new');
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
