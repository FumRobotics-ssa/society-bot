import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../src/store.js';
import { createDatabase } from '../src/sqlite.js';

const schema = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort().map(name => readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8')).join('\n');
async function fixture(t, { capacity = 3, max = 2, paid = false } = {}) {
  const db = createDatabase();
  db.exec(schema);
  t.after(() => db.close());
  const store = new Store(db);
  for (let id = 1; id <= 6; id++) await store.upsertUser({ id, first_name: `User ${id}`, phone: '09120000000' });
  const event = await store.saveEvent({ name: 'تئاتر', capacity, max_per_user: max, is_paid: paid, price: paid ? 250000 : 0 });
  return { store, db, event };
}

test('competing reservations never oversell and tickets and orders commit together', async t => {
  const { store, event, db } = await fixture(t, { capacity: 3, max: 2 });
  const attempts = await Promise.allSettled([
    store.reserve(1, event.id, 2, 'first'),
    store.reserve(2, event.id, 2, 'second'),
  ]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.code, 'EVENT_FULL');
  assert.equal((await store.getEvent(event.id)).remaining, 1);
  assert.equal(db.native.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  assert.equal(db.native.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 2);
});

test('same update can be retried and a key cannot be reused by another user', async t => {
  const { store, event } = await fixture(t, { capacity: 2, max: 2 });
  const [a, b] = await Promise.all([
    store.reserve(1, event.id, 2, 'telegram:100'),
    store.reserve(1, event.id, 2, 'telegram:100'),
  ]);
  assert.equal(a.order.id, b.order.id);
  assert.equal(a.tickets.length, 2);
  assert.equal((await store.listOrders()).length, 1);
  await assert.rejects(store.reserve(2, event.id, 2, 'telegram:100'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('per user limit is checked across concurrent separate orders', async t => {
  const { store, event } = await fixture(t, { capacity: 10, max: 2 });
  const results = await Promise.allSettled([
    store.reserve(1, event.id, 2, 'one'), store.reserve(1, event.id, 1, 'two'),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'USER_LIMIT');
});

test('failure while creating tickets rolls back the order and its reserved stock', async t => {
  const { store, event, db } = await fixture(t);
  db.exec("CREATE TRIGGER simulate_ticket_failure BEFORE INSERT ON tickets BEGIN SELECT RAISE(ABORT,'test_failure'); END;");
  await assert.rejects(store.reserve(1, event.id, 1, 'rollback'));
  assert.equal((await store.listOrders()).length, 0);
  assert.equal((await store.getEvent(event.id)).remaining, 3);
});

test('expired orders release capacity and cannot later be approved', async t => {
  const { store, event, db } = await fixture(t, { capacity: 1, max: 1, paid: true });
  const first = await store.reserve(1, event.id, 1, 'expired');
  await store.submitReceipt(first.order.id, 1, 'receipt-1', 'photo', 'r1');
  db.native.prepare('UPDATE orders SET expires_at=unixepoch()-1 WHERE id=?').run(first.order.id);
  assert.equal((await store.getEvent(event.id)).remaining, 1);
  const second = await store.reserve(2, event.id, 1, 'new');
  await store.submitReceipt(second.order.id, 2, 'receipt-2');
  await store.reviewOrder(second.order.id, true, 99);
  await assert.rejects(store.reviewOrder(first.order.id, true, 99), { code: 'ORDER_EXPIRED' });
  assert.equal((await store.getEvent(event.id)).remaining, 0);
  await store.expireOrders();
  assert.equal((await store.getOrder(first.order.id)).status, 'expired');
});

test('receipt belongs to purchaser and duplicate submission does not extend its deadline', async t => {
  const { store, event, db } = await fixture(t, { paid: true });
  const { order } = await store.reserve(1, event.id, 1, 'receipt');
  await assert.rejects(store.submitReceipt(order.id, 2, 'foreign-receipt'), { code: 'NOT_FOUND' });
  await store.submitReceipt(order.id, 1, 'own-receipt');
  db.native.prepare('UPDATE orders SET expires_at=unixepoch()+10 WHERE id=?').run(order.id);
  const repeated = await store.submitReceipt(order.id, 1, 'own-receipt');
  assert.equal(repeated.duplicate, true);
  assert.ok(repeated.expires_at < Math.floor(Date.now() / 1000) + 20);
});

test('payment review is idempotent but an opposite review cannot change a final order', async t => {
  const { store, event } = await fixture(t, { paid: true });
  const { order } = await store.reserve(1, event.id, 1, 'review');
  await store.submitReceipt(order.id, 1, 'file');
  const first = await store.reviewOrder(order.id, true, 99);
  const again = await store.reviewOrder(order.id, true, 99);
  assert.equal(first.already_reviewed, false);
  assert.equal(again.already_reviewed, true);
  await assert.rejects(store.reviewOrder(order.id, false, 99), { code: 'ORDER_ALREADY_REVIEWED' });
});

test('check in is atomic and unpaid tickets cannot enter', async t => {
  const { store, event } = await fixture(t, { paid: true });
  const { order, tickets } = await store.reserve(1, event.id, 1, 'entry');
  const token = tickets[0].token;
  assert.equal(token.length, 64);
  await assert.rejects(store.checkIn(token, 90), { code: 'INVALID_TICKET' });
  await store.submitReceipt(order.id, 1, 'receipt');
  await store.reviewOrder(order.id, true, 99);
  const results = await Promise.all([store.checkIn(token, 90), store.checkIn(token, 91)]);
  assert.equal(results.filter(r => !r.already_checked_in).length, 1);
  assert.equal(results[0].checked_in_at, results[1].checked_in_at);
  assert.equal(results[0].checked_in_by, results[1].checked_in_by);
  await store.undoCheckIn(token, 99);
  assert.equal((await store.getTicket(token)).checked_in_at, null);
});

test('capacity and per user limit cannot be reduced below existing reservations', async t => {
  const { store, event } = await fixture(t, { capacity: 5, max: 3 });
  await store.reserve(1, event.id, 3, 'capacity');
  await assert.rejects(store.saveEvent({ capacity: 2 }, event.id), { code: 'CAPACITY_BELOW_RESERVED' });
  await assert.rejects(store.saveEvent({ max_per_user: 2 }, event.id), { code: 'USER_LIMIT_BELOW_RESERVED' });
  assert.equal((await store.getEvent(event.id)).capacity, 5);
});

test('profile deletion anonymizes records and retains issued ticket history', async t => {
  const { store, event, db } = await fixture(t);
  const { tickets } = await store.reserve(1, event.id, 1, 'history');
  await store.setState(1, 'signup', { phone: 'private' });
  await store.deleteUser(1);
  assert.equal(await store.getUser(1), null);
  assert.equal(await store.getState(1), null);
  const ticket = await store.getTicket(tickets[0].token);
  assert.equal(ticket.phone, '');
  assert.equal(ticket.first_name, 'کاربر حذف شده');
  assert.equal(ticket.order_status, 'approved');
  assert.equal(db.native.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 1);
});

test('large batch uses one ticket insertion and event archival keeps historical bookings', async t => {
  const { store, event } = await fixture(t, { capacity: 100, max: 100 });
  const { order, tickets } = await store.reserve(1, event.id, 100, 'bulk');
  assert.equal(tickets.length, 100);
  assert.equal(new Set(tickets.map(t => t.token)).size, 100);
  await store.deleteEvent(event.id);
  assert.equal((await store.listEvents()).length, 0);
  assert.equal((await store.getOrder(order.id)).tickets.length, 100);
  await assert.rejects(store.reserve(2, event.id, 1, 'archived'), { code: 'EVENT_INACTIVE' });
});

test('cancel and expiry release capacity and outgoing messages are deduplicated', async t => {
  const { store, event, db } = await fixture(t, { capacity: 1, max: 1, paid: true });
  const { order } = await store.reserve(1, event.id, 1, 'cancel');
  await store.cancelOrder(order.id, 1);
  assert.equal((await store.getEvent(event.id)).remaining, 1);
  await store.enqueue('sendMessage', { chat_id: 1, text: 'hello' }, 'same-key');
  await store.enqueue('sendMessage', { chat_id: 1, text: 'hello' }, 'same-key');
  assert.equal(db.native.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
});
