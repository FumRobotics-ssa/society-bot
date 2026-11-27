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

test('check-in codes are random eight-digit numbers without a leading zero', async t => {
  const { store, event } = await fixture(t, { capacity: 100, max: 100 });
  const { tickets } = await store.reserve(1, event.id, 100, 'random-codes');
  const codes = tickets.map(ticket => ticket.checkin_code);
  assert.equal(codes.length, 100);
  assert.ok(codes.every(code => /^[1-9][0-9]{7}$/.test(code)));
  assert.equal(new Set(codes).size, codes.length);
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

test('legacy and fixed-price events keep one tariff for everyone and snapshot it on orders', async t => {
  const { store, event } = await fixture(t, { paid: true });
  await store.upsertUser({ id: 1, profile: { is_fum_student: true, student_number: '0001234567' } });
  const quote = await store.quoteOrder(1, event.id, 2);
  assert.deepEqual(quote, { event_id: event.id, quantity: 2, pricing_group: 'fixed', unit_price: 250000, total_price: 500000 });
  const { order } = await store.reserve(1, event.id, 1, 'fixed-order');
  assert.equal(order.unit_price, 250000);
  assert.equal(order.pricing_group, 'fixed');
  await store.saveEvent({ price: 900000 }, event.id);
  await store.upsertUser({ id: 1, profile: { is_fum_student: false } });
  const saved = await store.getOrder(order.id);
  assert.equal(saved.unit_price, 250000);
  assert.equal(saved.pricing_group, 'fixed');
});

test('differentiated pricing is computed from stored self-reported profile, not caller selection', async t => {
  const { store } = await fixture(t, { capacity: 8, max: 4 });
  const event = await store.saveEvent({ name: 'تعرفه متفاوت', capacity: 8, max_per_user: 4,
    pricing_mode: 'differentiated', price: 180000, fum_student_price: 70000 });
  await store.upsertUser({ id: 1, profile: { is_fum_student: true, student_number: '۰۰۱۲۳۴۵۶۷۸' } });
  await store.upsertUser({ id: 2, profile: { is_fum_student: false, is_student: true, university_name: 'دانشگاه دیگر' } });
  assert.equal(event.is_paid, 1);
  assert.equal(event.pricing_mode, 'differentiated');
  assert.deepEqual(await store.quoteOrder(1, event.id, 2), {
    event_id: event.id, quantity: 2, pricing_group: 'fum_student', unit_price: 70000, total_price: 140000,
  });
  assert.deepEqual(await store.quoteOrder(2, event.id, 1), {
    event_id: event.id, quantity: 1, pricing_group: 'general', unit_price: 180000, total_price: 180000,
  });
  await assert.rejects(store.reserve(1, event.id, 1, 'forged-tariff', { quantity: 1, pricing_group: 'general', unit_price: 0 }), { code: 'PRICE_CHANGED' });
  const studentOrder = await store.reserve(1, event.id, 2, 'student-order');
  const generalOrder = await store.reserve(2, event.id, 1, 'general-order');
  assert.equal(studentOrder.order.pricing_group, 'fum_student');
  assert.equal(studentOrder.order.unit_price, 70000);
  assert.equal(generalOrder.order.pricing_group, 'general');
  assert.equal(generalOrder.order.unit_price, 180000);
  await store.saveEvent({ price: 300000, fum_student_price: 250000 }, event.id);
  await store.upsertUser({ id: 1, profile: { is_fum_student: false } });
  assert.equal((await store.getOrder(studentOrder.order.id)).unit_price, 70000);
  assert.equal((await store.getOrder(studentOrder.order.id)).pricing_group, 'fum_student');
});

test('incomplete FUM profiles cannot use the student tariff until a 10-digit string is saved', async t => {
  const { store } = await fixture(t);
  const event = await store.saveEvent({ name: 'دانشجویی', capacity: 4, pricing_mode: 'differentiated', price: 100000, fum_student_price: 50000 });
  await store.upsertUser({ id: 1, profile: { is_fum_student: true, fum_faculty: 'مهندسی' } });
  await assert.rejects(store.quoteOrder(1, event.id, 1), { code: 'STUDENT_PROFILE_INCOMPLETE' });
  await store.upsertUser({ id: 1, profile: { student_number: '۰۰۰۱۲۳۴۵۶' } });
  await assert.rejects(store.quoteOrder(1, event.id, 1), { code: 'STUDENT_PROFILE_INCOMPLETE' });
  await store.upsertUser({ id: 1, profile: { student_number: '۰۰۰۱۲۳۴۵۶۷۸۹' } });
  await assert.rejects(store.quoteOrder(1, event.id, 1), { code: 'STUDENT_PROFILE_INCOMPLETE' });
  await store.upsertUser({ id: 1, profile: { student_number: '٠٠١٢٣٤٥٦٧٨' } });
  const user = await store.getUser(1);
  assert.equal(user.profile.student_number, '0012345678');
  assert.equal((await store.quoteOrder(1, event.id, 1)).pricing_group, 'fum_student');
});

test('confirmed quote is rejected if event or saved user tariff changes before reservation', async t => {
  const { store } = await fixture(t);
  const event = await store.saveEvent({ name: 'تغییر تعرفه', capacity: 4, max_per_user: 3,
    pricing_mode: 'differentiated', price: 80000, fum_student_price: 50000 });
  await store.upsertUser({ id: 1, profile: { is_fum_student: true, student_number: '0000123456' } });
  const oldQuote = await store.quoteOrder(1, event.id, 2);
  await store.saveEvent({ price: 90000, fum_student_price: 60000 }, event.id);
  await assert.rejects(store.reserve(1, event.id, 2, 'stale-price', oldQuote), { code: 'PRICE_CHANGED' });
  await store.saveEvent({ price: 80000, fum_student_price: 50000 }, event.id);
  await store.upsertUser({ id: 1, profile: { is_fum_student: false } });
  await assert.rejects(store.reserve(1, event.id, 2, 'stale-profile', oldQuote), { code: 'PRICE_CHANGED' });
  assert.equal((await store.listOrders()).length, 0);
});

test('zero student tariff issues a free order while public tariff remains paid', async t => {
  const { store } = await fixture(t, { capacity: 3, max: 2 });
  const event = await store.saveEvent({ name: 'تعرفه رایگان دانشجو', capacity: 3, max_per_user: 2,
    pricing_mode: 'differentiated', price: 45000, fum_student_price: 0 });
  await store.upsertUser({ id: 1, profile: { is_fum_student: true, student_number: '0000123456' } });
  const student = await store.reserve(1, event.id, 2, 'free-student');
  const publicOrder = await store.reserve(2, event.id, 1, 'paid-public');
  assert.equal(student.order.status, 'approved');
  assert.equal(student.order.pricing_group, 'fum_student');
  assert.equal(student.order.unit_price, 0);
  assert.equal(student.tickets.length, 2);
  assert.equal(publicOrder.order.status, 'reserved');
  assert.equal(publicOrder.order.pricing_group, 'general');
  assert.equal(publicOrder.order.unit_price, 45000);
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

test('unconfirmed paid bookings share the event limit and cancellation releases it', async t => {
  const { store, event } = await fixture(t, { capacity: 8, max: 2, paid: true });
  await store.saveEvent({ pending_booking_limit: 3 }, event.id);
  const held = await store.reserve(1, event.id, 2, 'first-held');
  await store.submitReceipt(held.order.id, 1, 'receipt');
  await store.reserve(2, event.id, 1, 'second-held');
  await assert.rejects(store.reserve(3, event.id, 1, 'over-limit'), { code: 'PENDING_RESERVATION_LIMIT' });
  await store.cancelOrder(held.order.id, 1);
  assert.equal((await store.reserve(3, event.id, 2, 'new-hold')).order.status, 'reserved');
  assert.equal((await store.getEvent(event.id)).pending_booking_limit, 3);
});

test('expiry queues one notice for a paid reservation that ran out of time before receiving a receipt', async t => {
  const { store, event, db } = await fixture(t, { capacity: 5, paid: true });
  await store.saveEvent({ pending_booking_limit: 5 }, event.id);
  const reserve = async id => (await store.reserve(id, event.id, 1, `expiry-${id}`)).order;
  const late = await reserve(1);
  const submitted = await reserve(2);
  const alreadyExpired = await reserve(3);
  const deleted = await reserve(4);
  const stillOpen = await reserve(5);
  await store.submitReceipt(submitted.id, 2, 'on-time');
  await store.deleteUser(4);
  const past = db.native.prepare('UPDATE orders SET expires_at=unixepoch()-1 WHERE id=?');
  for (const order of [late, submitted, deleted]) past.run(order.id);
  db.native.prepare("UPDATE orders SET status='expired' WHERE id=?").run(alreadyExpired.id);

  const sweeps = await Promise.all([store.expireOrders(), store.expireOrders()]);
  assert.equal(sweeps.reduce((total, sweep) => total + sweep.expired, 0), 3);
  for (const order of [late, submitted, alreadyExpired, deleted]) {
    assert.equal((await store.getOrder(order.id)).status, 'expired');
  }
  assert.equal((await store.getOrder(stillOpen.id)).status, 'reserved');
  const jobs = await store.all('SELECT method,payload,dedupe_key FROM outbox');
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  const payload = JSON.parse(job.payload);
  assert.equal(job.method, 'sendMessage');
  assert.equal(job.dedupe_key, `receipt-expired:${late.id}`);
  assert.equal(payload.chat_id, 1);
  assert.match(payload.text, /مهلت ارسال رسید برای «تئاتر» تمام شد/);
  assert.match(payload.text, /پشتیبانی انجمن رباتیک دانشگاه فردوسی مشهد @FUMrs_admin پیام بدهید/);
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

test('the event question cap is per attendee and retry-safe at the limit', async t => {
  const { store, event } = await fixture(t);
  const other = await store.saveEvent({ name: 'نشست دوم', capacity: 2 });
  await store.reserve(1, event.id, 1, 'first-attendee');
  await store.reserve(2, event.id, 1, 'second-attendee');
  await store.reserve(1, other.id, 1, 'other-event');
  const settings = { enabled: true, closes_at: Math.floor(Date.now() / 1000) + 3600 };
  await assert.rejects(store.saveEventQuestionSettings(event.id, { ...settings, max_questions: 4 }), { code: 'INVALID_INPUT' });
  assert.equal((await store.saveEventQuestionSettings(event.id, settings)).max_questions, 3);
  await store.saveEventQuestionSettings(other.id, { ...settings, max_questions: 1 });

  const keys = ['question-1', 'question-2', 'question-3', 'question-4'];
  const attempts = await Promise.allSettled(keys.map(key => store.submitEventQuestion(event.id, 1, key, key)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 3);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'QUESTION_LIMIT');
  const savedKey = keys[attempts.findIndex(result => result.status === 'fulfilled')];
  await store.submitEventQuestion(event.id, 1, savedKey, savedKey);
  assert.equal((await store.listEventQuestions(event.id)).length, 3);
  assert.equal((await store.getEventQuestionAccess(event.id, 1)).remaining, 0);
  await store.submitEventQuestion(event.id, 2, 'سؤال نفر دوم', 'second-attendee-q');
  await store.submitEventQuestion(other.id, 1, 'سؤال رویداد دوم', 'other-event-q');
  await assert.rejects(store.submitEventQuestion(other.id, 1, 'سؤال اضافه', 'other-extra'), { code: 'QUESTION_LIMIT' });
  assert.equal((await store.saveEventQuestionSettings(other.id, settings)).max_questions, 1);
});
