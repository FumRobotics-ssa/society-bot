import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createDatabase } from '../src/sqlite.js';
import { Store } from '../src/store.js';
import { handleUpdate } from '../src/bot.js';
import { maintenance } from '../src/jobs.js';

const schema = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort().map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');

function setup() {
  const db = createDatabase(); db.exec(schema);
  const store = new Store(db), env = { PUBLIC_URL: 'https://example.test', OWNER_IDS: '99', VERIFICATION_CHAT: '-100123' };
  let seq = 0;
  const message = (text, extra = {}) => ({ update_id: ++seq, message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text, ...extra } });
  const callback = data => ({ update_id: ++seq, callback_query: { id: String(seq), from: { id: 1 }, message: { message_id: seq, chat: { id: 1, type: 'private' } }, data } });
  const send = text => handleUpdate(message(text), env, store);
  const click = data => handleUpdate(callback(data), env, store);
  return { db, store, env, message, callback, send, click };
}
test('complete signup persists profile and rejects another persons contact', async () => {
  const f = setup(); await f.send('/add_account'); await f.send('علی'); await f.send('محمدی');
  await handleUpdate(f.message('', { contact: { user_id: 2, phone_number: '09123456789' } }), f.env, f.store);
  assert.equal((await f.store.getState(1)).step, 'signup:phone');
  await handleUpdate(f.message('', { contact: { user_id: 1, phone_number: '09123456789' } }), f.env, f.store);
  await f.click('s:boy'); await f.click('s:no'); await f.click('s:no'); await f.click('s:no'); await f.click('s:no'); await f.click('s:yes');
  const user = await f.store.getUser(1); assert.equal(user.first_name, 'علی'); assert.equal(user.phone, '09123456789'); assert.equal(user.profile.is_student, false); f.db.close();
});
test('free reservation auto-issues a ticket without requesting a receipt', async () => {
  const f = setup(); f.env.VERIFICATION_CHAT = ''; f.env.PUBLIC_URL = 'https://robotics-society.fum-robotics-ssa.workers.dev';
  await f.store.upsertUser({ id: 1, phone: '09123456789', first_name: 'علی' });
  const event = await f.store.saveEvent({ name: 'رویداد رایگان', capacity: 1, is_paid: 1, price: 0 });
  await f.click(`e:${event.id}`);
  await f.send('1');
  const quoteState = await f.store.getState(1);
  await f.click(`rq:y:${JSON.parse(quoteState.data_json).quote_nonce}`);
  const order = (await f.store.listOrders())[0];
  assert.equal(order.status, 'approved');
  assert.equal(order.unit_price, 0);
  assert.equal((await f.store.getState(1)).step, 'idle');
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE method IN ('sendPhoto','sendDocument')").first()).n, 0);
  const messages = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendMessage'").all()).results.map(row => JSON.parse(row.payload));
  const ticketLink = messages.flatMap(message => message.reply_markup?.inline_keyboard || []).flat().find(button => button.text === 'بلیت 1');
  assert.match(ticketLink.url, /^https:\/\/robotics-society\.fum-robotics-ssa\.workers\.dev\/ticket\/[0-9a-f]{64}$/);
  f.db.close();
});

test('paid reserve receipt owner approval and retried update preserve one order', async () => {
  const f = setup(); await f.store.upsertUser({ id: 1, phone: '09123456789', first_name: 'علی' });
  const place = await f.store.savePlace({ name: 'سالن', capacity: 2, map_url: 'https://nshn.ir/example' });
  const event = await f.store.saveEvent({ name: 'نمایش', place_id: place.id, capacity: 2, is_paid: 1, price: 50000 });
  await f.click('e:' + event.id); const booking = f.message('1');
  await handleUpdate(booking, f.env, f.store); await handleUpdate(booking, f.env, f.store);
  const quoteState = await f.store.getState(1);
  await f.click(`rq:y:${JSON.parse(quoteState.data_json).quote_nonce}`);
  assert.equal((await f.store.listOrders()).length, 1);
  const receipt = f.message('', { photo: [{ file_id: 'safe-photo', file_size: 1000 }] }); await handleUpdate(receipt, f.env, f.store);
  const receiptPayload = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendPhoto'").first()).payload;
  assert.match(receiptPayload, /https:\/\/nshn.ir\/example/);
  const order = (await f.store.listOrders())[0]; assert.equal(order.status, 'pending');
  const review = f.callback(`r:${order.id}:y`); review.callback_query.message.chat = { id: -100123, type: 'supergroup' };
  await handleUpdate(review, f.env, f.store); assert.equal((await f.store.getOrder(order.id)).status, 'pending');
  review.update_id += 100; review.callback_query.from.id = 99;
  await handleUpdate(review, f.env, f.store); assert.equal((await f.store.getOrder(order.id)).status, 'approved');
  const jobs = (await f.db.prepare('SELECT payload FROM outbox').all()).results; assert.ok(jobs.some(j => j.payload.includes('/ticket/'))); assert.ok(jobs.some(j => j.payload.includes('https://nshn.ir/example'))); f.db.close();
});

test('receipt review shows the saved self-reported tariff and previously approved tickets for the same event', async () => {
  const f = setup();
  await f.store.upsertUser({ id: 1, phone: '09123456789', first_name: 'علی', last_name: 'محمدی', profile: { is_fum_student: true, student_number: '0000123456' } });
  const event = await f.store.saveEvent({ name: 'نمایش', capacity: 3, max_per_user: 3, pricing_mode: 'differentiated', price: 50000, fum_student_price: 25000 });
  const first = await f.store.reserve(1, event.id, 1, 'first');
  await f.store.submitReceipt(first.order.id, 1, 'first-photo');
  await f.store.reviewOrder(first.order.id, true, 99);
  await f.click(`e:${event.id}`);
  await f.send('1');
  const quoteState = await f.store.getState(1);
  await f.click(`rq:y:${JSON.parse(quoteState.data_json).quote_nonce}`);
  await handleUpdate(f.message('', { photo: [{ file_id: 'second-photo', file_size: 1000 }] }), f.env, f.store);
  const sent = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendPhoto'").all()).results;
  assert.equal(sent.length, 1);
  const caption = JSON.parse(sent[0].payload).caption;
  assert.match(caption, /گروه تعرفه هنگام سفارش: تعرفهٔ دانشجوی فردوسی \(بر اساس خوداظهاری\)/);
  assert.match(caption, /تعداد بلیت درخواستی: 1/);
  assert.match(caption, /تعداد بلیت‌های قبلا خریداری شده: 1/);
  assert.match(caption, /نام رویداد: نمایش/);
  assert.match(caption, /مبلغ هر بلیت مورد انتظار: ۲۵٬۰۰۰ تومان/);
  assert.match(caption, /مبلغ کل مورد انتظار: ۲۵٬۰۰۰ تومان/);
  f.db.close();
});

test('/complete_student_info lets an older FUM profile enter a 10-digit number', async () => {
  const f = setup();
  await f.store.upsertUser({ id: 1, phone: '09123456789', profile: { is_fum_student: true, student_major: 'مکانیک' } });
  await f.send('/complete_student_info');
  assert.equal((await f.store.getState(1)).step, 'fum_student_number');
  await f.send('۱۲۳۴۵۶۷۸۹');
  assert.equal((await f.store.getState(1)).step, 'fum_student_number');
  assert.equal((await f.store.getUser(1)).profile.student_number, undefined);
  await f.send('٠٠١٢٣٤٥٦٧٨');
  const user = await f.store.getUser(1);
  assert.equal(user.profile.student_number, '0012345678');
  assert.equal((await f.store.getState(1)).step, 'idle');
  const replies = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendMessage'").all()).results.map(row => JSON.parse(row.payload).text);
  assert.ok(replies.some(text => text.includes('۱۰ رقمی')));
  assert.ok(replies.some(text => text.includes('استعلام نمی‌شود')));
  f.db.close();
});

test('FUM student pricing requires completion, converts numerals, preserves leading zeroes, and ignores forged tariff data', async () => {
  const f = setup();
  await f.store.upsertUser({ id: 1, phone: '09123456789', first_name: 'علی', profile: { is_fum_student: true, student_major: 'مکانیک' } });
  const event = await f.store.saveEvent({ name: 'رویداد تعرفه‌ای', capacity: 4, max_per_user: 3,
    pricing_mode: 'differentiated', price: 150000, fum_student_price: 60000 });
  await f.click(`e:${event.id}`);
  assert.equal((await f.store.getState(1)).step, 'fum_student_number');
  await f.send('۰۰۱۲۳۴۵۶۷۸');
  const user = await f.store.getUser(1);
  assert.equal(user.profile.student_number, '0012345678');
  assert.equal(typeof user.profile.student_number, 'string');
  assert.equal((await f.store.getState(1)).step, 'reserve_quantity');
  await f.send('2');
  const state = await f.store.getState(1), data = JSON.parse(state.data_json);
  assert.equal(state.step, 'reserve_confirm');
  assert.equal((await f.store.listOrders()).length, 0);
  const summary = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendMessage' ORDER BY rowid DESC LIMIT 1").first()).payload;
  assert.match(JSON.parse(summary).text, /دانشجوی فردوسی/);
  assert.match(JSON.parse(summary).text, /قیمت هر بلیت: ۶۰٬۰۰۰ تومان/);
  assert.match(JSON.parse(summary).text, /مبلغ کل: ۱۲۰٬۰۰۰ تومان/);
  assert.match(JSON.parse(summary).text, /خوداظهاری/);
  await f.click(`rq:y:${data.quote_nonce}:general:0`);
  assert.equal((await f.store.listOrders()).length, 0);
  await f.click(`rq:y:${data.quote_nonce}`);
  const order = (await f.store.listOrders())[0];
  assert.equal(order.pricing_group, 'fum_student');
  assert.equal(order.unit_price, 60000);
  assert.equal(order.quantity, 2);
  assert.equal(order.status, 'reserved');
  f.db.close();
});

test('student zero-price tier follows the free ticket flow without a receipt', async () => {
  const f = setup();
  await f.store.upsertUser({ id: 1, phone: '09123456789', profile: { is_fum_student: true, student_number: '0000123456' } });
  f.env.VERIFICATION_CHAT = '';
  const event = await f.store.saveEvent({ name: 'رایگان برای دانشجوی فردوسی', capacity: 2, max_per_user: 2,
    pricing_mode: 'differentiated', price: 45000, fum_student_price: 0 });
  await f.click(`e:${event.id}`);
  await f.send('2');
  const state = await f.store.getState(1);
  const quote = JSON.parse(state.data_json);
  assert.equal(quote.total_price, 0);
  await f.click(`rq:y:${quote.quote_nonce}`);
  const order = (await f.store.listOrders())[0];
  assert.equal(order.status, 'approved');
  assert.equal(order.pricing_group, 'fum_student');
  assert.equal(order.unit_price, 0);
  assert.equal(order.quantity, 2);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE method IN ('sendPhoto','sendDocument')").first()).n, 0);
  f.db.close();
});

test('daily backup catches up after midnight and queues only once per UTC day', async () => {
  const f = setup();
  f.env.DB = f.db;
  f.env.BACKUP_CHAT = '-100456';
  await maintenance(f.env, new Date('2026-11-12T00:04:00Z'));
  await maintenance(f.env, new Date('2026-11-12T00:05:00Z'));
  assert.equal((await f.db.prepare("SELECT id FROM outbox WHERE method='__backup'").all()).results.length, 1);
  await maintenance(f.env, new Date('2026-11-13T00:03:00Z'));
  assert.equal((await f.db.prepare("SELECT id FROM outbox WHERE method='__backup'").all()).results.length, 2);
  f.db.close();
});


test('signup choice closes its keyboard and confirms the selected value', async () => {
  const f = setup();
  await f.send('/add_account');
  await f.send('علی');
  await f.send('محمدی');
  await handleUpdate(f.message('', { contact: { user_id: 1, phone_number: '09123456789' } }), f.env, f.store);
  const choice = f.callback('s:boy');
  choice.callback_query.message.text = 'جنسیت را انتخاب کنید';
  await handleUpdate(choice, f.env, f.store);
  const edits = (await f.db.prepare("SELECT payload FROM outbox WHERE method='editMessageText'").all()).results;
  assert.equal(edits.length, 1);
  const edited = JSON.parse(edits[0].payload);
  assert.match(edited.text, /✅ جنسیت: آقا/);
  assert.deepEqual(edited.reply_markup, { inline_keyboard: [] });
  f.db.close();
});

test('admin_help and checkin_help format commands with LTR isolation for authorized roles', async () => {
  const f = setup();
  await f.send('/admin_help');
  let messages = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendMessage'").all()).results.map(r => JSON.parse(r.payload));
  assert.equal(messages[messages.length - 1].text, 'این دستور موجود نیست یا اجازه اجرای آن را ندارید');

  const ownerMsg = f.message('/admin_help');
  ownerMsg.message.from.id = 99;
  ownerMsg.message.chat.id = 99;
  await handleUpdate(ownerMsg, f.env, f.store);
  messages = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendMessage'").all()).results.map(r => JSON.parse(r.payload));
  const adminText = messages[messages.length - 1].text;
  assert.match(adminText, /راهنمای مدیر سامانه/);
  assert.match(adminText, /\u2066\/admin\u2069/);

  await f.store.setAdmin(2, 'checkin');
  const checkerMsg = f.message('/checkin_help');
  checkerMsg.message.from.id = 2;
  checkerMsg.message.chat.id = 2;
  await handleUpdate(checkerMsg, f.env, f.store);
  messages = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendMessage'").all()).results.map(r => JSON.parse(r.payload));
  const checkerText = messages[messages.length - 1].text;
  assert.match(checkerText, /راهنمای پذیرش/);
  assert.match(checkerText, /\u2066\/attend_ticket CODE\u2069/);

  f.db.close();
});
test('bot displays poster as photo when event has poster and as text when no poster', async () => {
  const f = setup();
  await f.store.upsertUser({ id: 1, phone: '09123456789', first_name: 'علی' });

  const noPosterEvent = await f.store.saveEvent({ name: 'رویداد ساده', capacity: 5 });
  await f.click(`e:${noPosterEvent.id}`);
  let outbox = (await f.db.prepare("SELECT method, payload FROM outbox ORDER BY id DESC LIMIT 1").all()).results;
  assert.equal(outbox[0].method, 'sendMessage');
  assert.match(JSON.parse(outbox[0].payload).text, /رویداد ساده/);

  const posterEvent = await f.store.saveEvent({ name: 'رویداد با پوستر', capacity: 5, poster_url: 'https://example.test/poster.jpg' });
  await f.click(`e:${posterEvent.id}`);
  outbox = (await f.db.prepare("SELECT method, payload FROM outbox ORDER BY id DESC LIMIT 1").all()).results;
  assert.equal(outbox[0].method, 'sendPhoto');
  const photoPayload = JSON.parse(outbox[0].payload);
  assert.equal(photoPayload.photo, 'https://example.test/poster.jpg');
  assert.match(photoPayload.caption, /رویداد با پوستر/);
  assert.match(photoPayload.caption, /تعداد بلیت مورد نظر را وارد کنید/);

  f.db.close();
});
