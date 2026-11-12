import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDatabase } from '../src/sqlite.js';
import { Store } from '../src/store.js';
import { handleUpdate } from '../src/bot.js';

function setup() {
  const db = createDatabase(); db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
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
  const event = await f.store.saveEvent({ name: 'نمایش', capacity: 2, is_paid: 1, price: 50000 });
  await f.click('e:' + event.id); const booking = f.message('1');
  await handleUpdate(booking, f.env, f.store); await handleUpdate(booking, f.env, f.store);
  assert.equal((await f.store.listOrders()).length, 1);
  const receipt = f.message('', { photo: [{ file_id: 'safe-photo', file_size: 1000 }] }); await handleUpdate(receipt, f.env, f.store);
  const order = (await f.store.listOrders())[0]; assert.equal(order.status, 'pending');
  const review = f.callback(`r:${order.id}:y`); review.callback_query.message.chat = { id: -100123, type: 'supergroup' };
  await handleUpdate(review, f.env, f.store); assert.equal((await f.store.getOrder(order.id)).status, 'pending');
  review.update_id += 100; review.callback_query.from.id = 99;
  await handleUpdate(review, f.env, f.store); assert.equal((await f.store.getOrder(order.id)).status, 'approved');
  const jobs = (await f.db.prepare('SELECT payload FROM outbox').all()).results; assert.ok(jobs.some(j => j.payload.includes('/ticket/'))); f.db.close();
});
