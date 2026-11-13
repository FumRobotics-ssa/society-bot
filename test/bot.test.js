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
test('paid reserve receipt owner approval and retried update preserve one order', async () => {
  const f = setup(); await f.store.upsertUser({ id: 1, phone: '09123456789', first_name: 'علی' });
  const place = await f.store.savePlace({ name: 'سالن', capacity: 2, map_url: 'https://nshn.ir/example' });
  const event = await f.store.saveEvent({ name: 'نمایش', place_id: place.id, capacity: 2, is_paid: 1, price: 50000 });
  await f.click('e:' + event.id); const booking = f.message('1');
  await handleUpdate(booking, f.env, f.store); await handleUpdate(booking, f.env, f.store);
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

test('receipt review shows student status and previously approved tickets for the same event', async () => {
  const f = setup();
  await f.store.upsertUser({ id: 1, phone: '09123456789', first_name: 'علی', last_name: 'محمدی', profile: { is_fum_student: true } });
  const event = await f.store.saveEvent({ name: 'نمایش', capacity: 3, max_per_user: 3, is_paid: 1, price: 50000 });
  const first = await f.store.reserve(1, event.id, 1, 'first');
  await f.store.submitReceipt(first.order.id, 1, 'first-photo');
  await f.store.reviewOrder(first.order.id, true, 99);
  await f.click(`e:${event.id}`);
  await f.send('1');
  await handleUpdate(f.message('', { photo: [{ file_id: 'second-photo', file_size: 1000 }] }), f.env, f.store);
  const sent = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendPhoto'").all()).results;
  assert.equal(sent.length, 1);
  const caption = JSON.parse(sent[0].payload).caption;
  assert.match(caption, /دانشجوی فردوسی: بله/);
  assert.match(caption, /تعداد بلیت درخواستی: 1/);
  assert.match(caption, /تعداد بلیت‌های قبلا خریداری شده: 1/);
  assert.match(caption, /نام رویداد: نمایش/);
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
