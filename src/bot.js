import { createLoginCode } from './auth.js';
import { neshanUrl } from './store.js';
import { configuredStudentNumberLength, isFumStudent, isValidStudentNumber, normalizeStudentNumber, pricingGroupLabel } from './pricing.js';

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const STATUS = { reserved: 'در انتظار رسید', pending: 'در انتظار بررسی', approved: 'تأیید شده', rejected: 'رد شده', cancelled: 'لغو شده', expired: 'مهلت گذشته' };
const FACULTIES = ['ادبیات و علوم انسانی', 'الهیات و معارف اسلامی', 'حقوق و علوم سیاسی', 'دامپزشکی', 'علوم', 'علوم اداری و اقتصادی', 'علوم تربیتی و روانشناسی', 'علوم ریاضی', 'علوم ورزشی', 'کشاورزی', 'معماری و شهرسازی', 'منابع طبیعی و محیط زیست', 'مهندسی', 'هنر نیشابور'];
const YES_NO = [[{ text: 'بله', callback_data: 's:yes' }, { text: 'خیر', callback_data: 's:no' }]];
const MENU = { keyboard: [[{ text: 'رویدادها' }, { text: 'بلیت‌های من' }], [{ text: 'حساب من' }, { text: 'راهنما' }]], resize_keyboard: true };
const EVENT_LINK_PREFIX = 'getTicket_';
const EVENT_LINK_PAGE_SIZE = 20;
const eventQuestionButton = eventId => ({ text: 'پرسش از مهمان', callback_data: `eq:${eventId}` });
const MESSAGE_LIMIT = 4000;
const CAPTION_LIMIT = 1024;
const ACCOUNT_REQUIRED = '👤 برای ادامه به حساب کاربری نیاز دارید.\n\nبرای ساخت حساب، /add_account را بفرستید.';
const STUDENT_NUMBER_NOTE = 'این شماره را خودتان اعلام می‌کنید و از دانشگاه استعلام نمی‌شود.';
const STUDENT_RATE_NOTE = 'این تعرفه بر اساس اطلاعات خوداظهاری حساب شماست و از دانشگاه استعلام نمی‌شود.';
const PAYMENT_INSTRUCTIONS = 'اطلاعات واریز در توضیحات رویداد آمده است.';
const UNKNOWN_COMMAND = 'این دستور موجود نیست یا اجازه اجرای آن را ندارید';
const BOT_USERNAME_CACHE_MS = 60 * 60 * 1000;

let botIdentity;
async function botUsername(token) {
  if (!token) throw new Error('BOT_TOKEN is not configured');
  if (botIdentity?.token === token && botIdentity.expiresAt > Date.now()) return botIdentity.username;
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  const username = data.result?.username;
  if (!response.ok || !data.ok || typeof username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    throw new Error('Telegram getMe did not return a valid bot username');
  }
  botIdentity = { token, username, expiresAt: Date.now() + BOT_USERNAME_CACHE_MS };
  return username;
}

function digits(value = '') {
  return String(value).replace(/[۰-۹٠-٩]/g, c => String(Math.max(FA_DIGITS.indexOf(c), AR_DIGITS.indexOf(c))));
}
function shortTicketCode(value) {
  const code = String(value || '');
  return /^\d{8}$/.test(code) ? code : '';
}
function ownerIds(env) {
  return String(env.OWNER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
}
const paragraphs = (...parts) => parts.filter(Boolean).join('\n\n');
const commandGuide = (title, entries) => paragraphs(title, entries.map(([label, command]) => `${label}: \u2066${command}\u2069`).join('\n'));
async function roleOf(id, env, store) {
  if (ownerIds(env).includes(String(id))) return 'owner';
  return (await store.getAdmin(id))?.role || 'user';
}
function positive(value) {
  const n = Number(digits(value));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('شناسه یا تعداد را به صورت عدد مثبت وارد کنید');
  return n;
}
function yes(value) {
  const t = String(value).trim().toLowerCase();
  if (['بله', 'yes', 'true', '1', '۱'].includes(t)) return 1;
  if (['خیر', 'نه', 'no', 'false', '0', '۰'].includes(t)) return 0;
  throw new Error('مقدار را بله یا خیر وارد کنید');
}
function name(value) {
  const text = String(value || '').trim();
  if (text.length < 2 || text.length > 80 || /[\u0000-\u001f]/u.test(text)) throw new Error('نام را با طول ۲ تا ۸۰ نویسه وارد کنید');
  return text;
}
function money(value) { return Number(value || 0).toLocaleString('fa-IR'); }
function studentNumberPrompt(exactLength) {
  return paragraphs('🎓 شمارهٔ دانشجویی فردوسی', `شمارهٔ دانشجویی ${money(exactLength)} رقمی خود را وارد کنید. ${STUDENT_NUMBER_NOTE}`);
}
function invalidStudentNumber(exactLength) {
  return new Error(`شمارهٔ دانشجویی را با ${money(exactLength)} رقم وارد کنید. صفرهای ابتدای شماره را هم بنویسید.`);
}
function link(env, path) { return String(env.PUBLIC_URL || '').replace(/\/$/, '') + path; }
function profileOf(user) {
  if (user?.profile && typeof user.profile === 'object') return user.profile;
  try { return JSON.parse(user?.profile_json || '{}'); } catch { return {}; }
}
function stateData(state) {
  if (state?.data && typeof state.data === 'object') return state.data;
  try { return JSON.parse(state?.data || state?.data_json || '{}'); } catch { return {}; }
}
function userText(user) {
  const p = profileOf(user);
  const contact = [`شناسه: ${user.id}`, `نام و نام خانوادگی: ${[user.first_name, user.last_name].filter(Boolean).join(' ') || 'ثبت نشده'}`, `تلفن: ${user.phone || 'ثبت نشده'}`];
  const education = [];
  for (const [key, title] of [['is_fum_student', 'دانشجوی دانشگاه فردوسی مشهد؟'], ['is_student', 'دانشجو هستید؟'], ['is_mashhad_student', 'در دانشگاهی در مشهد تحصیل می‌کنید؟'], ['is_graduate_student', 'فارغ‌التحصیل هستید؟'], ['is_student_relative', 'عضو خانواده دانشجویان یا کارکنان فردوسی هستید؟'], ['university_name', 'دانشگاه'], ['student_number', 'شماره دانشجویی'], ['fum_faculty', 'دانشکده'], ['entrance_year', 'سال ورود'], ['is_mast_phd', 'دانشجوی کارشناسی ارشد یا دکتری هستید؟'], ['student_major', 'رشته']]) {
    if (p[key] !== undefined && p[key] !== '' && !(p.is_fum_student && ['is_student', 'is_mashhad_student', 'is_graduate_student', 'is_student_relative', 'university_name'].includes(key))) education.push(`${title}${key.startsWith('is_') ? '' : ':'} ${typeof p[key] === 'boolean' || typeof p[key] === 'number' && key.startsWith('is_') ? p[key] ? 'بله' : 'خیر' : p[key]}`);
  }
  return paragraphs(contact.join('\n'), education.length && `🎓 اطلاعات تحصیلی\n${education.join('\n')}`);
}
const tehranDate = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', calendar: 'persian', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function eventTime(value) {
  if (!value) return 'اعلام نشده';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return tehranDate.format(date);
}
function eventText(event, { forAdmin = false, includeDescription = true } = {}) {
  const prices = event.pricing_mode === 'differentiated'
    ? `🎫 قیمت هر بلیت\nعموم: ${money(event.price)} تومان\nدانشجوی فردوسی: ${money(event.fum_student_price)} تومان`
    : event.is_paid && Number(event.price) > 0 ? `🎫 قیمت هر بلیت: ${money(event.price)} تومان` : '🎫 ثبت‌نام رایگان است.';
  const address = event.address || event.place_address;
  const mapUrl = neshanUrl(event.place_map_url);
  const schedule = [
    `🕒 زمان شروع: ${eventTime(event.starts_at)}`,
    event.ends_at ? `زمان پایان: ${eventTime(event.ends_at)}` : '',
    `📍 مکان: ${event.place_name || 'اعلام نشده'}`,
    address ? `نشانی: ${address}` : '',
    mapUrl ? `موقعیت در نشان: ${mapUrl}` : '',
  ].filter(Boolean).join('\n');
  const registration = [
    forAdmin ? `شناسه: ${event.id}` : '',
    `ظرفیت: ${event.capacity}`,
    forAdmin && event.remaining != null ? `ظرفیت باقی‌مانده: ${event.remaining}` : '',
    `سقف بلیت برای هر نفر: ${event.max_per_user}`,
    `وضعیت ثبت‌نام: ${event.active ? 'فعال' : 'غیرفعال'}`,
  ].filter(Boolean).join('\n');
  return paragraphs(`📅 ${event.name}`, includeDescription && event.description, schedule, registration, prices);
}
function orderText(order, prefixName = true) {
  const amount = Number(order.unit_price) * Number(order.quantity);
  return paragraphs(
    prefixName && `🎫 نام رویداد: ${order.event_name || 'رویداد'}`,
    `وضعیت: ${STATUS[order.status] || order.status}\nشناسه سفارش: ${order.id}`,
    `گروه تعرفه: ${pricingGroupLabel(order.pricing_group)}\nقیمت هر بلیت: ${money(order.unit_price)} تومان\nتعداد بلیت: ${order.quantity}\nمبلغ کل: ${money(amount)} تومان`,
  );
}
const paymentGuide = (event, order) => paragraphs(
  `💳 راهنمای واریز\n${event.payment_instructions || PAYMENT_INSTRUCTIONS}`,
  order.expires_at && `⏳ مهلت ارسال رسید: ${eventTime(order.expires_at * 1000)}`,
  'رسید واریز را به‌صورت عکس یا فایل PDF همین‌جا بفرستید.',
);
function csv(rows, columns) {
  const cell = v => {
    let text = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [columns.map(c => cell(c[1])).join(','), ...rows.map(row => columns.map(c => cell(typeof c[0] === 'function' ? c[0](row) : row[c[0]])).join(','))].join('\r\n');
}

export async function notifyOrder(order, env, store, key = `order:${order.id}`) {
  if (!order) return;
  const tickets = order.tickets || (await store.getOrder(order.id))?.tickets || [];
  if (order.status !== 'approved') {
    const outcome = order.status === 'rejected' ? 'ℹ️ پرداخت این سفارش تأیید نشد.' : '';
    await store.enqueue('sendMessage', { chat_id: order.user_id, text: paragraphs(outcome, orderText(order)) }, `${key}:${order.status}`);
    return;
  }
  const mapUrl = neshanUrl(order.place_map_url);
  for (let start = 0; start < Math.max(tickets.length, 1); start += 20) {
    const ticketButtons = tickets.slice(start, start + 20).map((ticket, i) => [
      { text: tickets.length === 1 ? 'بلیت' : `بلیت ${start + i + 1}`, url: link(env, `/ticket/${ticket.token}`) }
    ]);
    if (mapUrl) ticketButtons.push([{ text: 'موقعیت مکان در نشان', url: mapUrl }]);
    if (start === 0 && order.questions_open) ticketButtons.push([eventQuestionButton(order.event_id)]);
    await store.enqueue('sendMessage', {
      chat_id: order.user_id,
      text: paragraphs(
        `🎫 نام رویداد: ${order.event_name || 'رویداد'}\n✅ ثبت‌نام شما تأیید شد.`,
        orderText(order, false),
        'برای دیدن بلیت و کد QR، دکمهٔ بلیت را بزنید.',
      ),
      reply_markup: { inline_keyboard: ticketButtons }
    }, `${key}:approved:${start}`);
  }
}

export async function handleUpdate(update, env, store) {
  const message = update.message;
  const callback = update.callback_query;
  const from = callback?.from || message?.from;
  if (!from || from.is_bot) return;
  const chat = callback?.message?.chat || message?.chat;
  if (!chat) return;
  const updateKey = `update:${update.update_id}`;
  const role = await roleOf(from.id, env, store);
  const isAdmin = role === 'admin' || role === 'owner';
  const isChecker = isAdmin || role === 'checkin';
  const send = (text, markup = undefined, tag = 'reply', chatId = chat.id) => store.enqueue('sendMessage', { chat_id: chatId, text: String(text).slice(0, MESSAGE_LIMIT), ...(markup ? { reply_markup: markup } : {}) }, `${updateKey}:${tag}`);
  const sendPhoto = (photo, caption, markup) => store.enqueue('sendPhoto', { chat_id: chat.id, photo, caption, ...(markup ? { reply_markup: markup } : {}) }, `${updateKey}:photo`);
  const answer = (text = '') => callback && store.enqueue('answerCallbackQuery', { callback_query_id: callback.id, text: text.slice(0, 190) }, `${updateKey}:answer`);
  const panel = async () => {
    if (!isChecker || chat.type !== 'private') return send('🔒 پنل فقط برای افراد مجاز و از گفت‌وگوی خصوصی ربات در دسترس است.');
    const token = await createLoginCode(store.db, from.id);
    await send('🔐 ورود به پنل\n\nاین لینک اختصاصی است و مدت کوتاهی اعتبار دارد. آن را برای کسی نفرستید.', { inline_keyboard: [[{ text: 'ورود به پنل مدیریت', url: link(env, `/admin#login=${token}`) }]] });
  };
  const needAccount = async () => {
    const user = await store.getUser(from.id);
    if (!user?.phone) {
      await send(ACCOUNT_REQUIRED);
      return null;
    }
    return user;
  };
  const showEvents = async (offset = 0) => {
    if (!await needAccount()) return;
    const events = await store.listEvents({ activeOnly: true, limit: 20, offset });
    if (!events.length) return send('📅 فعلاً ثبت‌نام هیچ رویدادی باز نیست.', MENU);
    const buttons = events.map(e => [{ text: String(e.name).slice(0, 70), callback_data: `e:${e.id}` }]);
    if (events.length === 20) buttons.push([{ text: 'صفحه بعد', callback_data: `le:${offset + 20}` }]);
    if (offset > 0) buttons.push([{ text: 'صفحه قبل', callback_data: `le:${Math.max(0, offset - 20)}` }]);
    await send('📅 رویدادهای فعال\n\nبرای دیدن جزئیات و رزرو بلیت، رویداد را انتخاب کنید.', { inline_keyboard: buttons });
  };
  const showEventLinks = async (offset = 0) => {
    const events = await store.listEventSummaries({ limit: EVENT_LINK_PAGE_SIZE + 1, offset });
    const buttons = events.slice(0, EVENT_LINK_PAGE_SIZE).map(event => {
      const title = Array.from(event.name).slice(0, 40).join('');
      const status = event.active ? 'فعال' : 'غیرفعال';
      return [{ text: `${title} · ${status} · #${event.id}`, callback_data: `el:${event.id}` }];
    });
    if (events.length > EVENT_LINK_PAGE_SIZE) buttons.push([{ text: 'صفحه بعد', callback_data: `elp:${offset + EVENT_LINK_PAGE_SIZE}` }]);
    if (offset > 0) buttons.push([{ text: 'صفحه قبل', callback_data: `elp:${Math.max(0, offset - EVENT_LINK_PAGE_SIZE)}` }]);
    if (!buttons.length) return send('رویدادی ثبت نشده است', MENU);
    return send('🔗 لینک ثبت‌نام رویداد\n\nرویداد را از فهرست انتخاب کنید.', { inline_keyboard: buttons });
  };
  const sendEventLink = async eventId => {
    const event = await store.getEventSummary(positive(eventId));
    if (!event) return send('رویداد پیدا نشد یا بایگانی شده است', MENU);
    const username = await botUsername(env.BOT_TOKEN);
    const url = `https://t.me/${username}?start=${EVENT_LINK_PREFIX}${event.id}`;
    const status = event.active ? '' : 'پس از باز شدن ثبت‌نام، همین لینک کار می‌کند.';
    return send(paragraphs(`🔗 لینک ثبت‌نام «${event.name}»`, url, status), {
      inline_keyboard: [[{ text: 'کپی لینک ثبت‌نام', copy_text: { text: url } }]],
    });
  };
  const selectEvent = async (eventId, { linked = false, afterSignup = false } = {}) => {
    const id = positive(eventId);
    let pricing;
    try {
      pricing = await store.getEventPricing(from.id, id, env.FUM_STUDENT_NUMBER_LENGTH, { requirePhone: true });
    } catch (error) {
      if (afterSignup && error.code === 'EVENT_INACTIVE') return transition('idle', {}, `ℹ️ ${error.message}`, MENU);
      if (error.code !== 'ACCOUNT_REQUIRED') throw error;
      if (!linked) return send(ACCOUNT_REQUIRED);
      const existing = await store.getState(from.id);
      if (existing?.step.startsWith('signup:')) {
        return transition(existing.step, { ...stateData(existing), registration_event_id: id },
          '👤 مرحلهٔ فعلی ساخت حساب را ادامه دهید. پس از تکمیل حساب، به همین رویداد برمی‌گردید.');
      }
      return startSignup(id);
    }
    const { event } = pricing;
    if (pricing.requires_student_number) return promptFumStudentNumber(event.id);
    if (pricing.unit_price > 0 && !env.VERIFICATION_CHAT) {
      const message = 'ℹ️ ثبت‌نام این رویداد موقتاً بسته است. بخش بررسی پرداخت هنوز آماده نیست.';
      return afterSignup ? transition('idle', {}, message, MENU) : send(message);
    }
    const appliedPrice = event.pricing_mode === 'differentiated' && paragraphs(
      `تعرفهٔ شما: ${pricingGroupLabel(pricing.pricing_group)}\nقیمت هر بلیت برای شما: ${money(pricing.unit_price)} تومان`,
      pricing.pricing_group === 'fum_student' && STUDENT_RATE_NOTE,
    );
    const nextStep = 'تعداد بلیت مورد نظر را وارد کنید.\nبرای انصراف، /cancel را بفرستید.';
    const details = paragraphs(eventText(event), appliedPrice, nextStep);
    const markup = event.questions_open && await store.getEventQuestionAccess(event.id, from.id)
      ? { inline_keyboard: [[eventQuestionButton(event.id)]] } : undefined;
    let poster = event.poster_url;
    if (poster && !/^https?:\/\//i.test(poster)) poster = link(env, `/api/events/${event.id}/poster`);
    if (poster && details.length <= CAPTION_LIMIT) {
      await sendPhoto(poster, details, markup);
    } else {
      if (poster) await sendPhoto(poster, `📅 ${event.name}`);
      if (details.length > MESSAGE_LIMIT && event.description) {
        await send(`📝 توضیحات «${event.name}»\n\n${event.description}`, undefined, 'event_description');
        await send(paragraphs(eventText(event, { includeDescription: false }), appliedPrice, nextStep), markup);
      } else {
        await send(details, markup);
      }
    }
    await store.setState(from.id, 'reserve_quantity', { event_id: event.id, last_update_id: update.update_id });
  };
  const showOrders = async (offset = 0) => {
    if (!await needAccount()) return;
    const orders = await store.listOrders({ userId: from.id, limit: 15, offset });
    if (!orders.length) return send('🎫 هنوز سفارشی ثبت نکرده‌اید.\n\nبرای دیدن رویدادهای قابل رزرو، «رویدادها» را بزنید.', MENU);
    const buttons = orders.map(o => [{ text: `${o.event_name || 'سفارش'} ${STATUS[o.status] || o.status}`.slice(0, 65), callback_data: `o:${o.id}` }]);
    if (orders.length === 15) buttons.push([{ text: 'صفحه بعد', callback_data: `ls:${offset + 15}` }]);
    if (offset > 0) buttons.push([{ text: 'صفحه قبل', callback_data: `ls:${Math.max(0, offset - 15)}` }]);
    await send('🎫 بلیت‌ها و سفارش‌های من\n\nبرای دیدن وضعیت سفارش یا باز کردن بلیت، یکی را انتخاب کنید.', { inline_keyboard: buttons });
  };
  const transition = async (step, data, text, markup) => {
    await send(text, markup);
    await store.setState(from.id, step, { ...data, last_update_id: update.update_id });
  };
  const finishQuestion = (data, text) => transition(data.resume?.step || 'idle', data.resume?.data || {}, text, MENU);
  const startSignup = (eventId = null) => transition('signup:first_name', {
    profile: {}, username: from.username || '', ...(eventId ? { registration_event_id: eventId } : {}),
  }, paragraphs('👤 ساخت حساب کاربری', eventId && 'پس از ساخت حساب، ثبت‌نام همین رویداد را ادامه می‌دهید.', 'نام خود را وارد کنید.'));
  const promptFumStudentNumber = async (eventId = null) => transition('fum_student_number', { event_id: eventId ? Number(eventId) : null },
    paragraphs(studentNumberPrompt(configuredStudentNumberLength(env.FUM_STUDENT_NUMBER_LENGTH)),
      'برای انصراف، /cancel را بفرستید.'));
  const saveFumStudentNumber = async (value, data = {}) => {
    const user = await needAccount();
    if (!user) return;
    if (!isFumStudent(user.profile)) {
      await store.setState(from.id, 'idle', { last_update_id: update.update_id });
      return send('ℹ️ در حساب شما وضعیت دانشجویی فردوسی ثبت نشده است. تعرفهٔ عمومی برای این رویداد اعمال می‌شود.');
    }
    const number = normalizeStudentNumber(value);
    const exactLength = configuredStudentNumberLength(env.FUM_STUDENT_NUMBER_LENGTH);
    if (!isValidStudentNumber(number, exactLength)) {
      throw invalidStudentNumber(exactLength);
    }
    await store.upsertUser({ id: from.id, username: user.username, profile: { student_number: number } });
    if (data.event_id) {
      await send('✅ شمارهٔ دانشجویی در حساب شما ذخیره شد.');
      return selectEvent(data.event_id);
    }
    await store.setState(from.id, 'idle', { last_update_id: update.update_id });
    return send('✅ شمارهٔ دانشجویی در حساب شما ذخیره شد.', MENU);
  };
  const completeReservation = async (result, eventId) => {
    if (result.order.status === 'approved') {
      await notifyOrder({ ...result.order, tickets: result.tickets }, env, store);
      await store.setState(from.id, 'idle', { last_update_id: update.update_id });
      return;
    }
    const event = await store.getEvent(eventId);
    await send(paragraphs('بلیت‌ها موقتاً برای شما رزرو شدند.', orderText(result.order), paymentGuide(event, result.order)),
      { inline_keyboard: [[{ text: 'لغو سفارش', callback_data: `c:${result.order.id}` }]] });
    await store.setState(from.id, 'payment_receipt', { order_id: result.order.id, last_update_id: update.update_id });
  };
  try {
    if (callback) {
      const data = String(callback.data || '');
      if (data.startsWith('r:')) {
        if (!isAdmin || String(chat.id) !== String(env.VERIFICATION_CHAT)) return answer('اجازه بررسی پرداخت ندارید');
        const parts = data.split(':');
        if (parts.length !== 3 || !['y', 'n'].includes(parts[2]) || !/^[\da-f-]{36}$/i.test(parts[1])) return answer('درخواست نامعتبر است');
        const order = await store.reviewOrder(parts[1], parts[2] === 'y', from.id);
        await notifyOrder(order, env, store);
        await store.enqueue('editMessageReplyMarkup', { chat_id: chat.id, message_id: callback.message.message_id, reply_markup: { inline_keyboard: [] } }, `${updateKey}:reviewed`);
        return answer(parts[2] === 'y' ? '✅ پرداخت تأیید شد' : 'درخواست رد شد');
      }
      if (chat.type !== 'private') return answer('این گزینه از گفت‌وگوی خصوصی ربات در دسترس است');
      const question = /^eq:(\d{1,16})$/.exec(data);
      if (question) {
        const eventId = positive(question[1]);
        const access = await store.getEventQuestionAccess(eventId, from.id);
        if (!access) return answer('ارسال سؤال بسته است یا ثبت‌نام شما در این رویداد تأیید نشده است');
        if (access.remaining <= 0) return answer('به سقف تعداد سؤال‌های این رویداد رسیده‌اید');
        const state = await store.getState(from.id);
        const previous = stateData(state);
        const resume = state?.step === 'event_question' ? previous.resume
          : state ? { step: state.step, data: previous } : null;
        await transition('event_question', { event_id: eventId, resume }, paragraphs(
          `💬 پرسش از مهمان «${access.name}»`,
          'سؤال خود را در یک پیام متنی تا ۱۰۰۰ نویسه بفرستید.',
          `تعداد سؤال‌های باقی‌مانده: ${money(access.remaining)}\nبرای انصراف، /cancel را بفرستید.`,
        ));
        return answer();
      }
      const eventLinkAction = /^(el|elp):(\d{1,16})$/.exec(data);
      if (eventLinkAction) {
        if (!isAdmin) return answer('دریافت لینک فقط برای مدیر رویداد فعال است');
        if (eventLinkAction[1] === 'elp') await showEventLinks(Number(eventLinkAction[2]));
        else await sendEventLink(eventLinkAction[2]);
        return answer();
      }
      if (/^(le|ls):\d{1,6}$/.test(data)) {
        const [kind, offset] = data.split(':');
        if (kind === 'le') await showEvents(Number(offset));
        else await showOrders(Number(offset));
        return answer();
      }
      if (data.startsWith('e:')) {
        await selectEvent(data.slice(2));
        return answer();
      }
      if (data.startsWith('o:')) {
        const order = await store.getOrder(data.slice(2));
        if (!order || String(order.user_id) !== String(from.id)) return answer('سفارش پیدا نشد');
        if (order.status === 'approved') await notifyOrder(order, env, store, `${updateKey}:view`);
        else {
          const buttons = [];
          if (order.status === 'reserved') buttons.push([{ text: 'ارسال رسید', callback_data: `p:${order.id}` }]);
          if (['reserved', 'pending'].includes(order.status)) buttons.push([{ text: 'لغو سفارش', callback_data: `c:${order.id}` }]);
          await send(orderText(order), buttons.length ? { inline_keyboard: buttons } : MENU);
        }
        return answer();
      }
      if (data.startsWith('c:')) {
        const order = await store.cancelOrder(data.slice(2), from.id);
        await send(paragraphs('سفارش لغو شد.', orderText(order)), MENU);
        await store.clearState(from.id);
        return answer();
      }
      if (data.startsWith('rq:')) {
        const confirmation = /^rq:([yn]):([a-f0-9]{12})$/.exec(data);
        if (!confirmation) return answer('درخواست تأیید نامعتبر است');
        const state = await store.getState(from.id);
        const current = stateData(state);
        if (current.last_update_id === update.update_id) return answer();
        if (state?.step !== 'reserve_confirm') return answer('این خلاصه سفارش دیگر فعال نیست');
        if (current.quote_nonce !== confirmation[2]) return answer('این خلاصه سفارش دیگر فعال نیست');
        if (confirmation[1] === 'n') {
          await store.setState(from.id, 'idle', { last_update_id: update.update_id });
          await send('از ثبت این سفارش انصراف دادید.', MENU);
          return answer('سفارش لغو شد');
        }
        let result;
        try {
          result = await store.reserve(from.id, current.event_id, current.quantity, `${updateKey}:reserve`, current, configuredStudentNumberLength(env.FUM_STUDENT_NUMBER_LENGTH));
        } catch (error) {
          if (error.code === 'PRICE_CHANGED') {
            await answer('مبلغ تغییر کرده است');
            await store.setState(from.id, 'idle', { last_update_id: update.update_id });
            return selectEvent(current.event_id);
          }
          if (error.code === 'STUDENT_PROFILE_INCOMPLETE') {
            await answer('اطلاعات حساب را تکمیل کنید');
            return promptFumStudentNumber(current.event_id);
          }
          throw error;
        }
        await completeReservation(result, current.event_id);
        return answer('سفارش ثبت شد');
      }
      if (data.startsWith('p:')) {
        const order = await store.getOrder(data.slice(2));
        if (!order || String(order.user_id) !== String(from.id) || order.status !== 'reserved' || order.expires_at <= Math.floor(Date.now() / 1000)) return answer('این سفارش قابل پرداخت نیست');
        const event = await store.getEvent(order.event_id);
        await transition('payment_receipt', { order_id: order.id }, paragraphs(
          `مبلغ قابل پرداخت: ${money(Number(order.unit_price) * order.quantity)} تومان`,
          paymentGuide(event, order),
        ));
        return answer();
      }
      if (data.startsWith('s:')) {
        const state = await store.getState(from.id);
        const current = stateData(state);
        if (current.last_update_id === update.update_id) return answer();
        if (!state || !String(state.step).startsWith('signup:')) return answer('این مرحله دیگر فعال نیست');
        await signupStep(state.step.slice(7), data.slice(2), current, true);
        return answer();
      }
      return answer('این دکمه دیگر معتبر نیست');
    }

    if (/^\/chatid(?:@[a-z\d_]+)?\s*$/i.test(String(message?.text || '').trim())) return send(`شناسهٔ این گفت‌وگو: ${chat.id}`);
    if (chat.type !== 'private') return;
    const rawText = String(message.text || '').trim();
    const aliases = { 'رویدادها': '/available_events', 'بلیت‌های من': '/my_tickets', 'حساب من': '/get_account', 'راهنما': '/help' };
    const text = aliases[rawText] || rawText;
    const match = /^\/([a-z_]+)(?:@[a-z\d_]+)?(?:\s+([\s\S]*))?$/i.exec(text);
    if (!match) {
      const state = await store.getState(from.id);
      if (state) {
        const data = stateData(state);
        if (data.last_update_id === update.update_id) return;
        if (state.step === 'event_question') {
          if (!rawText || rawText.length > 1000) return send('سؤال را در یک پیام متنی حداکثر ۱۰۰۰ نویسه‌ای بفرستید.');
          try {
            await store.submitEventQuestion(data.event_id, from.id, rawText, `${updateKey}:event-question`);
          } catch (error) {
            if (!['QUESTION_UNAVAILABLE', 'QUESTION_LIMIT'].includes(error.code)) throw error;
            return finishQuestion(data, `ℹ️ ${error.message}`);
          }
          return finishQuestion(data, '✅ سؤالت ثبت شد. تیم برگزارکننده آن را بررسی می‌کند.');
        }
        if (String(state.step).startsWith('signup:')) return await signupStep(state.step.slice(7), text, data, false);
        if (state.step === 'fum_student_number') return await saveFumStudentNumber(text, data);
        if (state.step === 'reserve_quantity') {
          const quote = await store.quoteOrder(from.id, data.event_id, positive(text), configuredStudentNumberLength(env.FUM_STUDENT_NUMBER_LENGTH));
          const quoteNonce = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
          await send(paragraphs(
            '🧾 خلاصهٔ سفارش',
            `گروه تعرفه: ${pricingGroupLabel(quote.pricing_group)}\nقیمت هر بلیت: ${money(quote.unit_price)} تومان\nتعداد بلیت: ${quote.quantity}\nمبلغ کل: ${money(quote.total_price)} تومان`,
            quote.pricing_group === 'fum_student' && STUDENT_RATE_NOTE,
            'اگر اطلاعات سفارش درست است، «تأیید و رزرو» را بزنید.',
          ), { inline_keyboard: [[{ text: 'تأیید و رزرو', callback_data: `rq:y:${quoteNonce}` }, { text: 'انصراف', callback_data: `rq:n:${quoteNonce}` }]] });
          await store.setState(from.id, 'reserve_confirm', { ...quote, quote_nonce: quoteNonce, last_update_id: update.update_id });
          return;
        }
        if (state.step === 'reserve_confirm') {
          return send('برای ادامه، در پیام خلاصهٔ سفارش «تأیید و رزرو» یا «انصراف» را بزنید.');
        }
        if (state.step === 'payment_receipt') {
          const photo = message.photo?.at(-1);
          const document = message.document;
          if (!photo && (!document || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(document.mime_type))) return send('📎 رسید را به‌صورت عکس یا فایل PDF بفرستید.');
          if ((photo?.file_size || document?.file_size || 0) > 10 * 1024 * 1024) return send('حجم فایل بیشتر از ۱۰ مگابایت است. نسخهٔ کم‌حجم‌تری از رسید بفرستید.');
          if (!env.VERIFICATION_CHAT) return send('ℹ️ بررسی پرداخت فعلاً در دسترس نیست. با برگزارکنندهٔ رویداد تماس بگیرید.');
          const receiptType = photo ? 'photo' : 'document';
          const order = await store.submitReceipt(data.order_id, from.id, photo?.file_id || document.file_id, receiptType, `${updateKey}:receipt`);
          const previousTickets = await store.countApprovedTickets(from.id, order.event_id);
          const receiptCaption = paragraphs('🧾 رسید در انتظار بررسی', [
            `کد سفارش: ${order.id}`,
            `شناسه کاربر: ${order.user_id}`,
            `نام و نام خانوادگی: ${[order.first_name, order.last_name].filter(Boolean).join(' ') || 'ثبت نشده'}`,
          ].join('\n'), [
            `نام رویداد: ${order.event_name || 'نامشخص'}`,
            order.place_name ? `مکان: ${String(order.place_name).slice(0, 120)}` : '',
            order.place_address ? `نشانی: ${String(order.place_address).slice(0, 160)}` : '',
          ].filter(Boolean).join('\n'), [
            `گروه تعرفه هنگام سفارش: ${pricingGroupLabel(order.pricing_group)}`,
            `تعداد بلیت درخواستی: ${order.quantity}`,
            `تعداد بلیت‌های قبلاً خریداری‌شده: ${previousTickets}`,
            `مبلغ هر بلیت مورد انتظار: ${money(order.unit_price)} تومان`,
            `مبلغ کل مورد انتظار: ${money(Number(order.unit_price) * Number(order.quantity))} تومان`,
          ].join('\n'));
          await store.enqueue(photo ? 'sendPhoto' : 'sendDocument', { chat_id: env.VERIFICATION_CHAT, [photo ? 'photo' : 'document']: order.receipt_file_id, caption: receiptCaption.slice(0, 1000), reply_markup: { inline_keyboard: [[{ text: 'تأیید پرداخت', callback_data: `r:${order.id}:y` }, { text: 'رد درخواست', callback_data: `r:${order.id}:n` }]] } }, `receipt:${order.id}:${order.receipt_file_id}`);
          await send('📨 رسید شما برای بررسی فرستاده شد.\n\nنتیجه را همین‌جا به شما اطلاع می‌دهیم.', MENU);
          await store.setState(from.id, 'idle', { last_update_id: update.update_id });
          return;
        }
      }
      return send('برای ادامه، یکی از دکمه‌های منو را بزنید.\nاگر راهنما لازم دارید، /help را بفرستید.', MENU);
    }

    const command = match[1].toLowerCase();
    const arg = (match[2] || '').trim();
    if (command === 'start') {
      const eventId = arg.startsWith(EVENT_LINK_PREFIX) ? arg.slice(EVENT_LINK_PREFIX.length) : '';
      if (/^\d+$/.test(eventId)) return await selectEvent(eventId, { linked: true });
      if (arg.startsWith(EVENT_LINK_PREFIX)) return send('⚠️ لینک ثبت‌نام رویداد معتبر نیست.\n\nمی‌توانید رویدادهای فعال را از منوی «رویدادها» ببینید.', MENU);
      if (arg === 'availableEvents') return showEvents();
      return send('👋 به ربات انجمن علمی رباتیک خوش آمدید!\n\nبرای دیدن برنامه‌ها، «رویدادها» را بزنید. اگر هنوز حساب ندارید، با /add_account حساب بسازید.\n\nبلیت‌های صادرشده را در «بلیت‌های من» پیدا می‌کنید.', MENU);
    }
    if (command === 'id') return send(`شناسهٔ تلگرام شما: ${from.id}`);
    if (command === 'help') {
      const events = commandGuide('🎫 رویدادها و بلیت‌ها', [
        ['رویدادهای فعال', '/available_events'],
        ['سفارش‌ها و بلیت‌های من', '/my_tickets'],
      ]);
      const account = commandGuide('👤 حساب کاربری', [
        ['ساخت حساب', '/add_account'],
        ['اطلاعات حساب', '/get_account'],
        ['تکمیل شمارهٔ دانشجویی فردوسی', '/complete_student_info'],
        ['حذف حساب', '/delete_account'],
      ]);
      const other = commandGuide('سایر دستورها', [
        ['توقف مرحلهٔ جاری', '/cancel'],
        ['شناسهٔ گفت‌وگو', '/chatid'],
      ]);
      const staff = isAdmin ? commandGuide('🔐 مدیریت', [
        ['پنل مدیریت', '/admin'],
        ['راهنمای مدیر', '/admin_help'],
        ['گرفتن لینک ثبت‌نام رویداد', '/event_link'],
      ]) : isChecker ? commandGuide('پذیرش', [
        ['پنل پذیرش', '/admin'],
        ['راهنمای پذیرش', '/checkin_help'],
      ]) : '';
      return send(paragraphs('📖 راهنمای ربات انجمن', events, account, other, staff), MENU);
    }
    if (command === 'cancel') {
      const state = await store.getState(from.id);
      if (state?.step === 'event_question') return finishQuestion(stateData(state), 'ارسال سؤال لغو شد.');
      await send('مرحلهٔ فعلی متوقف شد.\n\nبرای لغو یک رزرو، از «بلیت‌های من» وارد سفارش شوید.', MENU);
      await store.clearState(from.id);
      return;
    }
    if (command === 'add_account') {
      const user = await store.getUser(from.id);
      if (user?.phone) return send('👤 از قبل حساب دارید.\n\nبرای دیدن اطلاعات، /get_account را بفرستید.');
      return startSignup();
    }
    if (command === 'get_account') {
      const user = await needAccount();
      if (user) return send(paragraphs('👤 حساب من', userText(user)), MENU);
      return;
    }
    if (command === 'complete_student_info') {
      const user = await needAccount();
      if (!user) return;
      if (!isFumStudent(user.profile)) return send('ℹ️ در حساب شما وضعیت دانشجویی فردوسی ثبت نشده است. برای رویدادهای دارای تعرفهٔ دانشجویی، قیمت عمومی برای شما اعمال می‌شود.', MENU);
      return promptFumStudentNumber();
    }
    if (command === 'delete_account') {
      const user = await store.getUser(from.id);
      if (!user) return send('حسابی برای شما ثبت نشده است.');
      if (arg !== 'confirm') return send('⚠️ حذف حساب\n\nبا حذف حساب، اطلاعات پروفایل پاک می‌شود. سوابق ضروری سفارش‌ها طبق سیاست نگهداری سامانه باقی می‌ماند.\n\nبرای تأیید، دستور زیر را بفرستید.\n/delete_account confirm');
      await store.deleteUser(from.id);
      await store.clearState(from.id);
      return send('اطلاعات حساب شما حذف شد.', MENU);
    }
    if (command === 'available_events') return showEvents();
    if (['my_tickets', 'my_orders'].includes(command)) return showOrders();
    if (command === 'admin') return panel();
    if (command === 'promote_me') return send('🔒 مالک ربات دسترسی مدیر را تعیین می‌کند.');
    if (!isChecker) return send(UNKNOWN_COMMAND);
    if (command === 'admin_help') {
      if (!isAdmin) return send(UNKNOWN_COMMAND);
      return send(paragraphs('📖 راهنمای مدیر سامانه', commandGuide('مدیریت رویداد', [
        ['پنل مدیریت', '/admin'],
        ['گرفتن لینک ثبت‌نام با انتخاب رویداد از فهرست', '/event_link'],
        ['گرفتن لینک ثبت‌نام با شناسهٔ رویداد', '/event_link EVENT_ID'],
        ['فهرست رویدادها', '/get_events'],
        ['فهرست مکان‌ها', '/get_places'],
        ['راهنمای افزودن مکان', '/add_place'],
        ['راهنمای افزودن رویداد', '/add_event'],
      ]), commandGuide('پذیرش و گزارش‌ها', [
        ['بررسی بلیت', '/get_ticket CODE'],
        ['ثبت ورود', '/attend_ticket CODE'],
        ['گزارش ظرفیت', '/count_tickets'],
        ['خروجی کاربران', '/export_users'],
        ['خروجی بلیت‌های رویداد', '/export_tickets EVENT_ID'],
      ]), commandGuide('اطلاع‌رسانی', [
        ['ارسال پیام همگانی', '/message_all'],
        ['ارسال پیام به شرکت‌کنندگان رویداد', '/message_event'],
      ])));
    }
    if (command === 'checkin_help') return send(commandGuide('📖 راهنمای پذیرش', [
      ['پنل پذیرش', '/admin'],
      ['بررسی بلیت', '/get_ticket CODE'],
      ['ثبت ورود', '/attend_ticket CODE'],
    ]));
    if (command === 'get_ticket') {
      const ticket = await store.getTicket(arg);
      if (!ticket) return send('بلیت پیدا نشد. کد پذیرش را بررسی کنید.');
      const status = ticket.status || ticket.order_status;
      return send(paragraphs(
        `🎫 بلیت «${ticket.event_name || ticket.event_id || ''}»`,
        `کد پذیرش: ${shortTicketCode(ticket.checkin_code)}\nصاحب بلیت: ${[ticket.first_name, ticket.last_name].filter(Boolean).join(' ')}`,
        `وضعیت بلیت: ${STATUS[status] || status || ''}\nورود: ${ticket.checked_in_at ? 'ثبت شده' : 'ثبت نشده'}`,
      ));
    }
    if (command === 'attend_ticket') {
      const ticket = await store.checkIn(arg, from.id);
      const status = ticket.already_checked_in ? 'ورود این بلیت قبلاً ثبت شده است.' : '✅ ورود ثبت شد.';
      const attendee = [ticket.first_name, ticket.last_name].filter(Boolean).join(' ');
      return send(paragraphs(status, [ticket.event_name, attendee].filter(Boolean).join('\n')));
    }
    if (!isAdmin) return send('🔒 این بخش فقط برای مدیران رویداد در دسترس است.');
    if (command === 'promote' || command === 'demote') {
      if (role !== 'owner') return send('🔒 فقط مالک ربات می‌تواند دسترسی مدیران را تغییر دهد.');
      const [id, requestedRole = 'admin'] = arg.split(/\s+/);
      const target = positive(id);
      if (ownerIds(env).includes(String(target))) return send('دسترسی مالک از طریق تنظیمات سرور تعیین می‌شود.');
      if (command === 'promote') {
        if (!['admin', 'checkin'].includes(requestedRole)) return send('نقش را با admin برای مدیر یا checkin برای پذیرش مشخص کنید.');
        await store.setAdmin(target, requestedRole);
      } else await store.removeAdmin(target);
      await store.audit(from.id, command, String(target), { role: requestedRole });
      return send('✅ دسترسی به‌روز شد.');
    }
    if (command === 'get_user') {
      const user = await store.getUser(positive(arg));
      return send(user ? paragraphs('👤 اطلاعات حساب', userText(user)) : 'کاربر پیدا نشد.');
    }
    if (command === 'delete_user') {
      const target = positive(arg);
      await store.deleteUser(target);
      await store.audit(from.id, 'delete_user', String(target), {});
      return send('اطلاعات شخصی کاربر حذف شد.');
    }
    if (command === 'get_places') {
      const places = await store.listPlaces();
      return send(places.length ? paragraphs('📍 مکان‌های ثبت‌شده', places.map(p => `#${p.id} · ${p.name} · ظرفیت ${p.capacity}`).join('\n')) : 'هنوز مکانی ثبت نشده است.');
    }
    if (command === 'get_place') {
      const place = (await store.listPlaces()).find(p => Number(p.id) === positive(arg));
      return send(place ? paragraphs(`📍 ${place.name}`, place.address, `شناسه: ${place.id}\nظرفیت: ${place.capacity}`) : 'مکان پیدا نشد.');
    }
    if (command === 'add_place') {
      const parts = arg.split(/\r?\n\s*-\s*\r?\n/).map(x => x.trim());
      if (parts.length !== 3) return send('📍 ثبت مکان\n\nاطلاعات را با همین قالب بفرستید.\n\n/add_place\nنام مکان\n-\nنشانی\n-\nظرفیت');
      const place = await store.savePlace({ name: name(parts[0]), address: parts[1], capacity: positive(parts[2]) });
      await store.audit(from.id, 'create_place', String(place.id), {});
      return send(`✅ مکان ثبت شد.\n\nشناسه: ${place.id}`);
    }
    if (command === 'delete_place') {
      await store.deletePlace(positive(arg));
      await store.audit(from.id, 'delete_place', arg, {});
      return send('مکان حذف شد.');
    }
    if (command === 'get_events') {
      const events = await store.listEventSummaries();
      return send(events.length ? paragraphs('📅 رویدادهای ثبت‌شده', events.map(e => `#${e.id} · ${e.name} · ${e.active ? 'فعال' : 'غیرفعال'}`).join('\n')) : 'هنوز رویدادی ثبت نشده است.');
    }
    if (command === 'event_link') {
      if (!arg) return showEventLinks();
      return await sendEventLink(arg);
    }
    if (command === 'get_event') {
      const event = await store.getEvent(positive(arg));
      return send(event ? eventText(event, { forAdmin: true }) : 'رویداد پیدا نشد.');
    }
    if (command === 'add_event') {
      const parts = arg.split(/\r?\n\s*-\s*\r?\n/).map(x => x.trim());
      if (![5, 8].includes(parts.length)) return send('📅 ثبت رویداد\n\nبرای رویداد رایگان، پنج بخش اول را بفرستید.\n\n/add_event\nنام رویداد\n-\nتوضیحات\n-\nپرداخت دارد؟ (بله یا خیر)\n-\nسقف بلیت هر نفر\n-\nشناسهٔ مکان\n-\nقیمت هر بلیت به تومان\n-\nراهنمای پرداخت\n-\nتاریخ و زمان رویداد');
      const paid = yes(parts[2]);
      if (paid && parts.length !== 8) return send('برای رویداد دارای هزینه، قیمت بلیت، راهنمای پرداخت و زمان را هم وارد کنید.');
      const placeId = positive(parts[4]);
      const place = (await store.listPlaces()).find(p => Number(p.id) === placeId);
      if (!place) return send('مکان پیدا نشد. شناسهٔ مکان را بررسی کنید.');
      const event = await store.saveEvent({ name: name(parts[0]), description: parts[1], is_paid: paid, max_per_user: positive(parts[3]), place_id: placeId, capacity: place.capacity, price: paid ? positive(parts[5]) : 0, payment_instructions: parts[6] || '', starts_at: parts[7] || '', active: 1 });
      await store.audit(from.id, 'create_event', String(event.id), {});
      return send(paragraphs('✅ رویداد ثبت شد.', eventText(event, { forAdmin: true }), `برای گرفتن لینک ثبت‌نام، /event_link ${event.id} را بفرستید.`));
    }
    if (command === 'activate_event' || command === 'deactivate_event') {
      const event = await store.getEvent(positive(arg));
      if (!event || event.archived) return send('رویداد پیدا نشد.');
      await store.saveEvent({ ...event, active: command === 'activate_event' ? 1 : 0 }, event.id);
      await store.audit(from.id, command, String(event.id), {});
      return send(command === 'activate_event' ? '✅ ثبت‌نام رویداد باز شد.' : 'ثبت‌نام رویداد بسته شد.');
    }
    if (command === 'delete_event') {
      await store.deleteEvent(positive(arg));
      await store.audit(from.id, 'archive_event', arg, {});
      return send('رویداد بایگانی شد. سوابق آن در سامانه باقی می‌ماند.');
    }
    if (command === 'export_users') {
      const users = await collectPages(opts => store.listUsers(opts));
      await store.enqueue('sendDocument', { chat_id: chat.id, filename: 'users.csv', _documentText: csv(users, [['id', 'شناسه'], ['first_name', 'نام'], ['last_name', 'نام خانوادگی'], ['phone', 'شماره'], [u => JSON.stringify(profileOf(u)), 'اطلاعات تحصیلی']]) }, `${updateKey}:csv`);
      return send(`📎 فایل ${money(users.length)} کاربر آماده است.\nهر فایل حداکثر هزار ردیف دارد.`, undefined, 'export_info');
    }
    if (['export_tickets', 'preview_tickets'].includes(command)) {
      const eventId = positive(arg);
      const tickets = await collectPages(opts => store.listTickets({ ...opts, eventId }));
      if (command === 'preview_tickets') return send(tickets.length ? paragraphs('🎫 پیش‌نمایش بلیت‌ها', tickets.slice(0, 50).map(t => `${shortTicketCode(t.checkin_code)} · ${t.first_name || ''} ${t.last_name || ''} · ${t.checked_in_at ? 'ورود ثبت شده' : 'ورود ثبت نشده'}`).join('\n')) : 'بلیت پیدا نشد.');
      await store.enqueue('sendDocument', { chat_id: chat.id, filename: `tickets-${eventId}.csv`, _documentText: csv(tickets, [[t => shortTicketCode(t.checkin_code), 'کد پذیرش'], ['legacy_code', 'کد قدیمی'], ['event_name', 'رویداد'], ['first_name', 'نام'], ['last_name', 'نام خانوادگی'], ['user_id', 'شناسه کاربر'], ['order_status', 'وضعیت سفارش'], ['checked_in_at', 'زمان ورود']]) }, `${updateKey}:csv`);
      return send(`📎 فایل ${money(tickets.length)} بلیت آماده است.\nهر فایل حداکثر هزار ردیف دارد.`, undefined, 'export_info');
    }
    if (command === 'print_tickets') return send('🖨 چاپ بلیت‌ها\n\nبا /admin وارد پنل شوید و در بخش بلیت‌های رویداد، «چاپ» را انتخاب کنید.');
    if (command === 'backup') {
      if (!env.BACKUP_CHAT) return send('گروه پشتیبان تنظیم نشده است.');
      await store.enqueue('__backup', { actor_id: from.id }, `${updateKey}:backup`);
      return send('⏳ درخواست تهیهٔ نسخهٔ پشتیبان در صف است.');
    }
    if (command === 'count_tickets' || command === 'database_storage') {
      const stats = await store.stats();
      const events = await store.listEvents({ limit: 50 });
      const overview = [
        `کاربران: ${money(stats.users)}`,
        `رویدادها: ${money(stats.events)} (${money(stats.active_events)} فعال)`,
        `پرداخت‌های در انتظار بررسی: ${money(stats.pending_orders)}`,
        `بلیت‌های صادرشده: ${money(stats.tickets)}\nورودهای ثبت‌شده: ${money(stats.attended)}`,
        `درآمد: ${money(stats.revenue)} تومان`,
      ].join('\n');
      const capacity = events.map(event => `${event.name}\nظرفیت: ${money(event.capacity)} · باقی‌مانده: ${money(event.remaining)}`).join('\n\n');
      return send(paragraphs('📊 آمار سامانه', overview, capacity && paragraphs('ظرفیت رویدادها', capacity)));
    }
    if (command === 'message_all' || command === 'message_event') {
      const parts = arg.split(/\r?\n\s*-\s*\r?\n/).map(x => x.trim()).filter(Boolean);
      if (command === 'message_all' && !arg) return send('📣 ارسال پیام همگانی\n\nمتن را بعد از دستور بنویسید.\n/message_all متن پیام');
      if (command === 'message_event' && parts.length !== 2) return send('📣 پیام به شرکت‌کنندگان رویداد\n\nپیام را با این قالب بفرستید.\n\n/message_event\nشناسهٔ رویداد\n-\nمتن پیام');
      const eventId = command === 'message_event' ? positive(parts[0]) : null;
      const broadcastText = command === 'message_event' ? parts[1] : arg.replace(/^\s*-\s*\n/, '');
      if (broadcastText.length > 3500) return send('متن پیام را به حداکثر ۳۵۰۰ نویسه کوتاه کنید.');
      if (eventId && !await store.getEvent(eventId)) return send('رویداد پیدا نشد. شناسهٔ رویداد را بررسی کنید.');
      await store.enqueue('__broadcast', { text: broadcastText, event_id: eventId, actor_id: from.id }, `${updateKey}:broadcast`);
      await store.audit(from.id, 'broadcast', String(eventId || 'all'), {});
      return send('📨 پیام در صف ارسال است و به‌تدریج به دریافت‌کنندگان می‌رسد.');
    }
    if (command === 'unattend_ticket' && typeof store.undoCheckIn === 'function') {
      await store.undoCheckIn(arg, from.id);
      return send('ثبت ورود این بلیت لغو شد.');
    }
    if (command === 'delete_ticket' && typeof store.deleteTicket === 'function') {
      await store.deleteTicket(arg, from.id);
      return send('بلیت لغو شد.');
    }
    if (command === 'flush_reserves' && typeof store.flushReserves === 'function') {
      await store.flushReserves(positive(arg), from.id);
      return send('رزروهای تأییدنشده آزاد شدند.');
    }
    return send('این کار از پنل مدیریت انجام می‌شود.\n\nبرای ورود به پنل، /admin را بفرستید.');
  } catch (error) {
    // Infrastructure failures must reach the durable inbox so it can retry them.
    // Only domain failures and our Persian input-validation errors are handled here.
    const messageText = String(error?.message || '');
    const domainFailure = typeof error?.code === 'string' && !error.code.startsWith('ERR_') && /[\u0600-\u06ff]/u.test(messageText);
    const inputFailure = /^[\u0600-\u06ff]/u.test(messageText) && !/sql|sqlite|constraint|binding|internal|fetch|network|token|secret|session/i.test(messageText);
    if (!domainFailure && !inputFailure) throw error;
    if (callback) await answer('درخواست انجام نشد');
    await send(`⚠️ ${messageText}`, undefined, 'error', chat.type === 'private' ? chat.id : from.id);
  }

  async function signupStep(step, input, data, isCallback) {
    const p = { ...(data.profile || {}) };
    const d = { ...data, profile: p };
    const next = async (target, prompt, markup) => {
      if (isCallback && callback?.message?.message_id) {
        const choice = step === 'gender' ? `جنسیت: ${input === 'boy' ? 'آقا' : 'خانم'}` : step === 'fum_faculty' ? `دانشکده: ${p.fum_faculty}` : `پاسخ: ${input === 'yes' ? 'بله' : 'خیر'}`;
        await store.enqueue('editMessageText', { chat_id: chat.id, message_id: callback.message.message_id, text: `${callback.message.text || 'انتخاب شما'}\n\n✅ ${choice}`, reply_markup: { inline_keyboard: [] } }, `${updateKey}:choice`);
      }
      return transition(`signup:${target}`, d, prompt, markup);
    };
    const askYesNo = (target, prompt) => next(target, prompt, { inline_keyboard: YES_NO });
    const bool = () => {
      if (!isCallback || !['yes', 'no'].includes(input)) throw new Error('برای پاسخ، دکمهٔ «بله» یا «خیر» را بزنید.');
      return input === 'yes';
    };
    const confirm = () => next('confirm', paragraphs(
      '📝 بررسی اطلاعات حساب',
      userText({ ...d, id: from.id }),
      'اگر اطلاعات درست است، «بله» را بزنید.',
    ), { inline_keyboard: YES_NO });
    if (step === 'first_name') {
      if (isCallback) throw new Error('نام خود را در یک پیام متنی بفرستید.');
      d.first_name = name(input);
      return next('last_name', 'حالا نام خانوادگی‌تان را وارد کنید.');
    }
    if (step === 'last_name') {
      if (isCallback) throw new Error('نام خانوادگی را در یک پیام متنی بفرستید.');
      d.last_name = name(input);
      return next('phone', '📱 شمارهٔ تماس\n\nبرای فرستادن شمارهٔ همین حساب تلگرام، «ارسال شماره من» را بزنید.', { keyboard: [[{ text: 'ارسال شماره من', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true });
    }
    if (step === 'phone') {
      if (isCallback || !message?.contact || message.contact.user_id !== from.id) throw new Error('برای فرستادن شمارهٔ همین حساب تلگرام، «ارسال شماره من» را بزنید.');
      d.phone = digits(message.contact.phone_number).replace(/\s/g, '');
      if (!/^\+?\d{7,15}$/.test(d.phone)) throw new Error('شماره معتبر نیست. دوباره «ارسال شماره من» را بزنید.');
      await send('✅ شمارهٔ تماس ثبت شد.', { remove_keyboard: true }, 'phone_saved');
      return next('gender', 'جنسیت را از گزینه‌های زیر انتخاب کنید.', { inline_keyboard: [[{ text: 'آقا', callback_data: 's:boy' }, { text: 'خانم', callback_data: 's:girl' }]] });
    }
    if (step === 'gender') {
      if (!isCallback || !['boy', 'girl'].includes(input)) throw new Error('جنسیت را از دکمه‌های زیر پیام انتخاب کنید.');
      p.is_boy = input === 'boy';
      return askYesNo('is_fum_student', '🎓 وضعیت تحصیلی\n\nدانشجوی دانشگاه فردوسی مشهد هستید؟');
    }
    if (step === 'is_fum_student') {
      p.is_fum_student = bool();
      if (p.is_fum_student) {
        Object.assign(p, { is_student: true, is_mashhad_student: true, university_name: 'دانشگاه فردوسی مشهد', is_graduate_student: false, is_student_relative: false });
        return next('student_number', studentNumberPrompt(configuredStudentNumberLength(env.FUM_STUDENT_NUMBER_LENGTH)));
      }
      return askYesNo('is_student', 'دانشجو هستید؟');
    }
    if (step === 'student_number') {
      const number = normalizeStudentNumber(input);
      const exactLength = configuredStudentNumberLength(env.FUM_STUDENT_NUMBER_LENGTH);
      if (isCallback || !isValidStudentNumber(number, exactLength)) {
        throw invalidStudentNumber(exactLength);
      }
      p.student_number = number;
      return next('fum_faculty', 'دانشکده‌تان را از فهرست انتخاب کنید.', { inline_keyboard: FACULTIES.map((f, i) => [{ text: f, callback_data: `s:f${i}` }]) });
    }
    if (step === 'fum_faculty') {
      if (!isCallback || !/^f\d+$/.test(input) || !FACULTIES[Number(input.slice(1))]) throw new Error('دانشکده‌تان را از فهرست زیر پیام انتخاب کنید.');
      p.fum_faculty = FACULTIES[Number(input.slice(1))];
      return next('entrance_year', 'سال ورود به دانشگاه را به‌صورت چهار رقمی وارد کنید.');
    }
    if (step === 'is_student') {
      p.is_student = bool();
      return p.is_student ? askYesNo('is_mashhad_student', 'در دانشگاهی در مشهد تحصیل می‌کنید؟') : askYesNo('is_graduate_student', 'فارغ‌التحصیل دانشگاه هستید؟');
    }
    if (step === 'is_mashhad_student') {
      p.is_mashhad_student = bool();
      return next('university_name', 'نام دانشگاهتان را وارد کنید.');
    }
    if (step === 'university_name') {
      if (isCallback) throw new Error('نام دانشگاه را در یک پیام متنی بفرستید.');
      p.university_name = name(input);
      return next('entrance_year', 'سال ورود به دانشگاه را به‌صورت چهار رقمی وارد کنید.');
    }
    if (step === 'entrance_year') {
      const year = Number(digits(input));
      if (isCallback || !Number.isInteger(year) || !(year >= 1300 && year <= 1500 || year >= 1900 && year <= 2100)) throw new Error('سال ورود را به‌صورت چهار رقمی وارد کنید، مثلاً ۱۴۰۳.');
      p.entrance_year = String(year);
      return askYesNo('is_mast_phd', 'دانشجوی کارشناسی ارشد یا دکتری هستید؟');
    }
    if (step === 'is_mast_phd') {
      p.is_mast_phd = bool();
      return next('student_major', 'نام رشتهٔ تحصیلی‌تان را وارد کنید.');
    }
    if (step === 'student_major') {
      if (isCallback) throw new Error('نام رشته را در یک پیام متنی بفرستید.');
      p.student_major = name(input);
      return confirm();
    }
    if (step === 'is_graduate_student') {
      p.is_graduate_student = bool();
      return askYesNo('is_student_relative', 'عضو خانواده دانشجویان یا کارکنان دانشگاه فردوسی هستید؟');
    }
    if (step === 'is_student_relative') {
      p.is_student_relative = bool();
      return confirm();
    }
    if (step === 'confirm') {
      if (!bool()) {
        await send('ساخت حساب متوقف شد.\n\nبرای شروع دوباره، /add_account را بفرستید.', MENU);
        return store.setState(from.id, 'idle', { last_update_id: update.update_id });
      }
      await store.upsertUser({ id: from.id, username: from.username || d.username, first_name: d.first_name, last_name: d.last_name, phone: d.phone, profile: p });
      if (d.registration_event_id) {
        await send('✅ حساب شما ساخته شد. حالا می‌توانید ثبت‌نام رویداد را ادامه دهید.', MENU, 'signup_complete');
        return selectEvent(d.registration_event_id, { afterSignup: true });
      }
      await send('✅ حساب شما آماده است.\n\nبرای دیدن برنامه‌ها، «رویدادها» را بزنید.', MENU);
      return store.setState(from.id, 'idle', { last_update_id: update.update_id });
    }
    throw new Error('این مرحله دیگر فعال نیست. با /cancel خارج شوید و برای ساخت حساب دوباره /add_account را بفرستید.');
  }
}

async function collectPages(load) {
  const rows = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await load({ limit: 100, offset });
    rows.push(...page);
    if (page.length < 100) break;
  }
  return rows;
}
