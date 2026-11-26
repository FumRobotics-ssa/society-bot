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

test('only event managers can request a stable registration link in private', async t => {
  const f = setup();
  t.after(() => f.db.close());
  f.env.BOT_TOKEN = 'test-token-event-links';
  const getMe = t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://api.telegram.org/bottest-token-event-links/getMe');
    return Response.json({ ok: true, result: { username: 'FumExampleBot' } });
  });
  const event = await f.store.saveEvent({ name: 'کارگاه رباتیک', capacity: 5, active: 0 });
  const archived = await f.store.saveEvent({ name: 'رویداد بایگانی', capacity: 5 });
  await f.store.deleteEvent(archived.id);
  await f.store.setAdmin(2, 'checkin');
  await f.store.setAdmin(3, 'admin');
  const command = (text, id, type = 'private') => handleUpdate(f.message(text, { from: { id }, chat: { id, type } }), f.env, f.store);
  const click = (data, id) => {
    const update = f.callback(data);
    update.callback_query.from.id = id;
    update.callback_query.message.chat.id = id;
    return handleUpdate(update, f.env, f.store);
  };
  await command('/event_link ' + event.id, 1);
  await command('/event_link ' + event.id, 2);
  await click('el:' + event.id, 2);
  await command('/event_link ' + event.id, 99, 'supergroup');
  assert.equal(getMe.mock.callCount(), 0);
  await command('/event_link', 99);
  await click('el:' + event.id, 99);
  await command('/event_link ' + event.id, 3);
  await command('/event_link ' + archived.id, 99);
  const replies = (await f.store.all("SELECT payload FROM outbox WHERE method='sendMessage' ORDER BY id")).map(row => JSON.parse(row.payload));
  const choices = replies.flatMap(reply => reply.reply_markup?.inline_keyboard || []).flat();
  assert.ok(choices.some(button => button.callback_data === 'el:' + event.id));
  assert.ok(!choices.some(button => button.callback_data === 'el:' + archived.id));
  const link = 'https://t.me/FumExampleBot?start=getTicket_' + event.id;
  assert.deepEqual(replies.filter(reply => reply.text.includes(link)).map(reply => reply.chat_id).sort((a, b) => a - b), [3, 99]);
  assert.equal(choices.filter(button => button.copy_text?.text === link).length, 2);
  assert.ok(replies.some(reply => reply.text.includes('همین لینک کار می‌کند')));
  assert.equal(getMe.mock.callCount(), 1);
});

test('a public event link resumes an existing signup and then opens the same event without reserving', async t => {
  const f = setup();
  t.after(() => f.db.close());
  const event = await f.store.saveEvent({ name: 'کارگاه مسیر‌یابی', capacity: 3 });
  const place = await f.store.savePlace({ name: 'سالن دانشکده', capacity: 3 });
  const other = await f.store.saveEvent({ name: 'کارگاه دیگر', capacity: 3, place_id: place.id, starts_at: '2026-12-03T14:00:00+03:30' });
  await f.send('/start getTicket_' + other.id);
  assert.equal(await f.store.getState(1), null);
  assert.equal(await f.store.getUser(1), null);
  const preview = JSON.parse((await f.store.one("SELECT payload FROM outbox WHERE method='sendMessage'")).payload);
  assert.match(preview.text, /کارگاه دیگر[\s\S]*سالن دانشکده[\s\S]*رایگان/);
  assert.match(preview.text, /۱۲ آذر ۱۴۰۵/);
  assert.equal(preview.reply_markup.inline_keyboard[0][0].callback_data, 'register:' + other.id);
  await f.click('register:' + other.id);
  assert.equal((await f.store.getState(1)).step, 'signup:first_name');
  await f.send('علی');
  await f.send('/start getTicket_' + event.id);
  assert.equal((await f.store.getState(1)).step, 'signup:last_name');
  await f.click('register:' + event.id);
  await f.send('محمدی');
  await handleUpdate(f.message('', { contact: { user_id: 1, phone_number: '09123456789' } }), f.env, f.store);
  const state = await f.store.getState(1);
  assert.equal(state.step, 'reserve_quantity');
  assert.equal(JSON.parse(state.data_json).event_id, event.id);
  assert.equal((await f.store.getUser(1)).first_name, 'علی');
  assert.equal((await f.store.getUser(1)).profile.student_number, undefined);
  assert.equal((await f.store.listOrders()).length, 0);
  await f.send('/start getTicket_' + other.id);
  assert.equal(JSON.parse((await f.store.getState(1)).data_json).event_id, other.id);
  await f.send('1');
  const quote = await f.store.getState(1);
  await f.click('rq:y:' + JSON.parse(quote.data_json).quote_nonce);
  assert.equal((await f.store.listOrders())[0].event_id, other.id);
});

test('event details show the optional end time and reserve the id and remaining capacity for admins', async t => {
  const f = setup();
  t.after(() => f.db.close());
  await f.store.upsertUser({ id: 1, phone: '09123456789' });
  const event = await f.store.saveEvent({ name: 'رویداد متنی', capacity: 7, starts_at: '2026-12-03T14:00:00+03:30', ends_at: '2026-12-03T16:00:00+03:30' });
  const withPoster = await f.store.saveEvent({ name: 'رویداد با پوستر', capacity: 7, poster_url: 'https://example.test/event.jpg' });
  await f.store.reserve(1, event.id, 1, 'existing-order');

  await f.click(`e:${event.id}`);
  await f.send(`/start getTicket_${withPoster.id}`);
  const admin = f.message(`/get_event ${event.id}`, { from: { id: 99 }, chat: { id: 99, type: 'private' } });
  await handleUpdate(admin, f.env, f.store);

  const replies = (await f.store.all("SELECT payload FROM outbox WHERE method IN ('sendMessage', 'sendPhoto')"))
    .map(row => JSON.parse(row.payload));
  const participantReplies = replies.filter(reply => reply.chat_id === 1);
  assert.equal(participantReplies.length, 2);
  const details = participantReplies.find(reply => reply.text?.includes(event.name)).text;
  assert.match(details, /^🕒 ۱۲ آذر ۱۴۰۵، از ساعت ۱۴ تا ۱۶$/m);
  const caption = participantReplies.find(reply => reply.caption?.includes(withPoster.name)).caption;
  assert.match(caption, /^🕒 زمان برگزاری اعلام نشده$/m);
  for (const reply of participantReplies) {
    assert.doesNotMatch(reply.text || reply.caption, /ظرفیت باقی‌مانده|شناسه:/);
  }
  const adminDetails = replies.find(reply => reply.chat_id === 99).text;
  assert.match(adminDetails, new RegExp(`شناسه: ${event.id}`));
  assert.match(adminDetails, /ظرفیت باقی‌مانده: 6/);
});
test('registered attendees can submit a private question once per update and resume their prior step', async t => {
  const f = setup();
  t.after(() => f.db.close());
  await f.store.upsertUser({ id: 1, phone: '09123456789' });
  await f.store.upsertUser({ id: 2, phone: '09123456780' });
  const event = await f.store.saveEvent({ name: 'نشست گفت‌وگو', capacity: 6, max_per_user: 2 });
  const booking = await f.store.reserve(1, event.id, 1, 'registered');
  await f.store.saveEventQuestionSettings(event.id, { enabled: true, closes_at: Math.floor(Date.now() / 1000) + 3600 });

  const outsider = f.callback(`eq:${event.id}`);
  outsider.callback_query.from.id = 2;
  outsider.callback_query.message.chat.id = 2;
  await handleUpdate(outsider, f.env, f.store);
  assert.equal(await f.store.getState(2), null);
  await f.click(`e:${event.id}`);
  assert.equal((await f.store.getState(1)).step, 'reserve_quantity');
  const offered = await f.store.one("SELECT payload FROM outbox WHERE payload LIKE '%پرسش از مهمان%' AND method='sendMessage'");
  assert.ok(JSON.parse(offered.payload).reply_markup.inline_keyboard.flat().some(button => button.callback_data === `eq:${event.id}`));

  await f.click(`eq:${event.id}`);
  assert.equal((await f.store.getState(1)).step, 'event_question');
  const question = f.message('مسیر ورود به صنعت رباتیک چیست؟');
  await handleUpdate(question, f.env, f.store);
  await handleUpdate(question, f.env, f.store);
  assert.equal((await f.store.getState(1)).step, 'reserve_quantity');
  const items = await f.store.listEventQuestions(event.id);
  assert.deepEqual(items.map(item => item.question), [question.message.text]);
  const confirmation = await f.store.one('SELECT payload FROM outbox WHERE dedupe_key=?', `update:${question.update_id}:reply`);
  assert.match(JSON.parse(confirmation.payload).text, /سؤالت ثبت شد/);

  const closesAt = Math.floor(Date.now() / 1000) + 3600;
  await f.store.saveEventQuestionSettings(event.id, { enabled: true, closes_at: closesAt, max_questions: 1 });
  await f.click(`eq:${event.id}`);
  const limitReply = await f.store.one("SELECT payload FROM outbox WHERE method='answerCallbackQuery' AND payload LIKE '%به سقف تعداد سؤال‌های%'");
  assert.ok(limitReply);
  assert.equal((await f.store.getState(1)).step, 'reserve_quantity');
  await f.store.saveEventQuestionSettings(event.id, { enabled: true, closes_at: closesAt, max_questions: 3 });

  await f.store.saveEvent({ active: 0 }, event.id);
  await f.click(`o:${booking.order.id}`);
  assert.ok(await f.store.one("SELECT payload FROM outbox WHERE dedupe_key LIKE '%:view:approved:0' AND payload LIKE '%پرسش از مهمان%'"));
  await f.click(`eq:${event.id}`);
  await f.send('/cancel');
  assert.equal((await f.store.getState(1)).step, 'reserve_quantity');
  await f.click(`eq:${event.id}`);
  await f.db.prepare('UPDATE event_question_settings SET closes_at=unixepoch()-1 WHERE event_id=?').bind(event.id).run();
  await f.send('این سؤال بعد از مهلت فرستاده شده است');
  assert.equal((await f.store.listEventQuestions(event.id)).length, 1);
  assert.equal((await f.store.getState(1)).step, 'reserve_quantity');
});

test('event links reject invalid or closed events and handle an event closing during signup', async t => {
  const f = setup();
  t.after(() => f.db.close());
  const event = await f.store.saveEvent({ name: 'کارگاه', capacity: 3 });
  const closed = await f.store.saveEvent({ name: 'کارگاه بسته', capacity: 3, active: 0 });
  await f.send('/start getTicket_invalid');
  await f.send('/start getTicket_99999');
  await f.send('/start getTicket_' + closed.id);
  assert.equal(await f.store.getState(1), null);
  await f.send('/start getTicket_' + event.id);
  await f.click('register:' + event.id);
  await f.store.deleteEvent(event.id);
  await f.send('علی');
  await f.send('محمدی');
  await handleUpdate(f.message('', { contact: { user_id: 1, phone_number: '09123456789' } }), f.env, f.store);
  assert.equal((await f.store.getState(1)).step, 'idle');
  assert.equal((await f.store.getUser(1)).phone, '09123456789');
  const replies = (await f.store.all("SELECT payload FROM outbox WHERE method='sendMessage' ORDER BY id")).map(row => JSON.parse(row.payload).text);
  assert.ok(replies.some(text => text.includes('لینک ثبت‌نام رویداد معتبر نیست')));
  assert.equal(replies.filter(text => text.includes('ثبت‌نام آن متوقف شده است')).length, 3);
});
test('short event signup requests a student number only for the Ferdowsi tariff', async t => {
  const f = setup();
  t.after(() => f.db.close());
  const event = await f.store.saveEvent({ name: 'کارگاه', capacity: 5, pricing_mode: 'differentiated', price: 60000, fum_student_price: 25000 });
  const contact = id => handleUpdate(f.message('', { from: { id }, chat: { id, type: 'private' }, contact: { user_id: id, phone_number: '09123456789' } }), f.env, f.store);
  const send = (id, text) => handleUpdate(f.message(text, { from: { id }, chat: { id, type: 'private' } }), f.env, f.store);
  const click = (id, data) => {
    const update = f.callback(data);
    update.callback_query.from.id = id;
    update.callback_query.message.chat.id = id;
    return handleUpdate(update, f.env, f.store);
  };
  for (const id of [1, 2]) {
    await send(id, '/start getTicket_' + event.id);
    await click(id, 'register:' + event.id);
    await send(id, 'علی');
    await send(id, 'محمدی');
    await contact(id);
    assert.equal((await f.store.getState(id)).step, 'choose_event_tariff');
  }
  await f.click('tariff:n:' + event.id);
  assert.equal((await f.store.getState(1)).step, 'reserve_quantity');
  assert.equal((await f.store.getUser(1)).profile.student_number, undefined);
  assert.equal((await f.store.quoteOrder(1, event.id, 1)).unit_price, 60000);
  await click(2, 'tariff:y:' + event.id);
  assert.equal((await f.store.getState(2)).step, 'fum_student_number');
  await send(2, '۱۲۳');
  assert.equal((await f.store.getState(2)).step, 'fum_student_number');
  await send(2, '۰۱۲۳۴۵۶۷۸۹');
  assert.equal((await f.store.getState(2)).step, 'reserve_quantity');
  assert.equal((await f.store.getUser(2)).profile.student_number, '0123456789');
  assert.equal((await f.store.quoteOrder(2, event.id, 1)).unit_price, 25000);
  assert.equal((await f.store.listOrders()).length, 0);
});
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
  const ticketLink = messages.flatMap(message => message.reply_markup?.inline_keyboard || []).flat().find(button => button.text === 'بلیت');
  assert.ok(ticketLink, 'Button text should be بلیت');
  assert.ok(messages.some(m => /^🎫 نام رویداد: [^\n]+\n✅ ثبت‌نام شما تأیید شد\.\n\n/.test(m.text)), 'Ticket notice should lead with the event and confirmation');
  assert.match(ticketLink.url, /^https:\/\/robotics-society\.fum-robotics-ssa\.workers\.dev\/ticket\/[0-9a-f]{64}$/);
  f.db.close();
});

test('paid reserve receipt owner approval and retried update preserve one order', async () => {
  const f = setup(); await f.store.upsertUser({ id: 1, phone: '09123456789', first_name: 'علی' });
  const place = await f.store.savePlace({ name: 'سالن', capacity: 2, map_url: 'https://nshn.ir/example' });
  const event = await f.store.saveEvent({ name: 'نمایش', place_id: place.id, capacity: 2, is_paid: 1, price: 50000, payment_instructions: 'راهنمای نمونهٔ واریز' });
  await f.click('e:' + event.id); const booking = f.message('1');
  await handleUpdate(booking, f.env, f.store); await handleUpdate(booking, f.env, f.store);
  const quoteState = await f.store.getState(1);
  await f.click(`rq:y:${JSON.parse(quoteState.data_json).quote_nonce}`);
  assert.equal((await f.store.listOrders()).length, 1);
  const payment = await f.store.one("SELECT payload FROM outbox WHERE method='sendMessage' ORDER BY rowid DESC LIMIT 1");
  const paymentText = JSON.parse(payment.payload).text;
  assert.match(paymentText, /مبلغ کل: ۵۰٬۰۰۰ تومان\n\n💳 راهنمای واریز\nراهنمای نمونهٔ واریز\n\n⏳ مهلت ارسال رسید:/);
  assert.match(paymentText, /\n\nرسید واریز را به‌صورت عکس یا فایل PDF همین‌جا بفرستید\./);
  const receipt = f.message('', { photo: [{ file_id: 'safe-photo', file_size: 1000 }] }); await handleUpdate(receipt, f.env, f.store);
  const receiptPayload = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendPhoto'").first()).payload;
  assert.ok(receiptPayload.includes('تأیید پرداخت') && receiptPayload.includes('رد درخواست'));
  assert.ok(!receiptPayload.includes('موقعیت در نشان'));
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
  assert.match(caption, /تعداد بلیت‌های قبلاً خریداری‌شده: 1/);
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
  assert.match(adminText, /\u2066\/event_link\u2069/);
  assert.match(adminText, /\u2066\/event_link EVENT_ID\u2069/);

  const adminHelp = f.message('/help', { from: { id: 99 }, chat: { id: 99, type: 'private' } });
  await handleUpdate(adminHelp, f.env, f.store);
  const adminHelpReply = await f.store.one('SELECT payload FROM outbox WHERE dedupe_key=?', `update:${adminHelp.update_id}:reply`);
  assert.match(JSON.parse(adminHelpReply.payload).text, /\/event_link/);

  await f.store.setAdmin(2, 'checkin');
  const checkerMsg = f.message('/checkin_help');
  checkerMsg.message.from.id = 2;
  checkerMsg.message.chat.id = 2;
  await handleUpdate(checkerMsg, f.env, f.store);
  messages = (await f.db.prepare("SELECT payload FROM outbox WHERE method='sendMessage'").all()).results.map(r => JSON.parse(r.payload));
  const checkerText = messages[messages.length - 1].text;
  assert.match(checkerText, /راهنمای پذیرش/);
  assert.match(checkerText, /\u2066\/attend_ticket CODE\u2069/);
  assert.doesNotMatch(checkerText, /\/event_link/);

  f.db.close();
});
test('bot displays poster as photo when event has poster and as text when no poster', async () => {
  const f = setup();
  await f.store.upsertUser({ id: 1, phone: '09123456789', first_name: 'علی' });

  const noPosterEvent = await f.store.saveEvent({ name: 'رویداد ساده', capacity: 5 });
  await f.click(`e:${noPosterEvent.id}`);
  let msg = (await f.db.prepare("SELECT method, payload FROM outbox WHERE method='sendMessage' ORDER BY rowid DESC LIMIT 1").all()).results[0];
  assert.ok(msg);
  assert.equal(msg.method, 'sendMessage');
  assert.match(JSON.parse(msg.payload).text, /رویداد ساده/);

  const posterEvent = await f.store.saveEvent({ name: 'رویداد با پوستر', capacity: 5, poster_url: 'https://example.test/poster.jpg' });
  await f.click(`e:${posterEvent.id}`);
  let photo = (await f.db.prepare("SELECT method, payload FROM outbox WHERE method='sendPhoto' ORDER BY rowid DESC LIMIT 1").all()).results[0];
  assert.ok(photo);
  assert.equal(photo.method, 'sendPhoto');
  const photoPayload = JSON.parse(photo.payload);
  assert.equal(photoPayload.photo, 'https://example.test/poster.jpg');
  assert.match(photoPayload.caption, /رویداد با پوستر/);
  assert.match(photoPayload.caption, /تعداد بلیت مورد نظر را وارد کنید/);

  f.db.close();
});

test('long poster details preserve the description, venue and booking instructions', async t => {
  const f = setup();
  t.after(() => f.db.close());
  await f.store.upsertUser({ id: 1, phone: '09123456789', first_name: 'علی' });
  const place = await f.store.savePlace({ name: 'تالار', address: 'نشانی '.repeat(140).trim(), capacity: 10 });
  const description = 'توضیحات رویداد '.repeat(220) + 'پایان توضیحات';
  const event = await f.store.saveEvent({
    name: 'کارگاه با توضیحات بلند', description, place_id: place.id, capacity: 10, poster_url: 'https://example.test/poster.jpg',
  });
  await f.store.reserve(1, event.id, 1, 'registered');
  await f.store.saveEventQuestionSettings(event.id, { enabled: true, closes_at: Math.floor(Date.now() / 1000) + 3600 });
  await f.click(`e:${event.id}`);

  const rows = await f.store.all("SELECT method,payload FROM outbox WHERE method IN ('sendPhoto','sendMessage') ORDER BY rowid");
  const [poster, intro, booking] = rows.map(row => JSON.parse(row.payload));
  assert.deepEqual(rows.map(row => row.method), ['sendPhoto', 'sendMessage', 'sendMessage']);
  assert.equal(poster.caption, `📅 ${event.name}`);
  assert.ok(intro.text.endsWith(description));
  assert.ok(booking.text.includes(place.address));
  assert.match(booking.text, /\n\nتعداد بلیت مورد نظر را وارد کنید\.\nبرای انصراف، \/cancel/);
  assert.doesNotMatch(booking.text, /ظرفیت باقی‌مانده/);
  assert.equal(booking.reply_markup.inline_keyboard[0][0].callback_data, `eq:${event.id}`);
  assert.equal((await f.store.getState(1)).step, 'reserve_quantity');
});
