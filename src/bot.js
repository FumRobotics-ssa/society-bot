import { createLoginCode } from './auth.js';

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const STATUS = { reserved: 'در انتظار رسید', pending: 'در انتظار بررسی', approved: 'تأیید شده', rejected: 'رد شده', cancelled: 'لغو شده', expired: 'منقضی شده' };
const FACULTIES = ['ادبیات و علوم انسانی', 'الهیات و معارف اسلامی', 'حقوق و علوم سیاسی', 'دامپزشکی', 'علوم', 'علوم اداری و اقتصادی', 'علوم تربیتی و روانشناسی', 'علوم ریاضی', 'علوم ورزشی', 'کشاورزی', 'معماری و شهرسازی', 'منابع طبیعی و محیط زیست', 'مهندسی', 'هنر نیشابور'];
const YES_NO = [[{ text: 'بله', callback_data: 's:yes' }, { text: 'خیر', callback_data: 's:no' }]];
const MENU = { keyboard: [[{ text: 'رویدادها' }, { text: 'بلیت‌های من' }], [{ text: 'حساب من' }, { text: 'راهنما' }]], resize_keyboard: true };

function digits(value = '') {
  return String(value).replace(/[۰-۹٠-٩]/g, c => String(Math.max(FA_DIGITS.indexOf(c), AR_DIGITS.indexOf(c))));
}
function ownerIds(env) {
  return String(env.OWNER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
}
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
  const fields = [`شناسه: ${user.id}`, `نام و نام خانوادگی: ${[user.first_name, user.last_name].filter(Boolean).join(' ') || 'ثبت نشده'}`, `تلفن: ${user.phone || 'ثبت نشده'}`];
  for (const [key, title] of [['is_fum_student', 'دانشجوی دانشگاه فردوسی مشهد؟'], ['is_student', 'دانشجو هستید؟'], ['is_mashhad_student', 'در دانشگاهی در مشهد تحصیل می‌کنید؟'], ['is_graduate_student', 'فارغ‌التحصیل هستید؟'], ['is_student_relative', 'عضو خانواده دانشجویان یا کارکنان فردوسی هستید؟'], ['university_name', 'دانشگاه'], ['student_number', 'شماره دانشجویی'], ['fum_faculty', 'دانشکده'], ['entrance_year', 'سال ورود'], ['is_mast_phd', 'دانشجوی کارشناسی ارشد یا دکتری هستید؟'], ['student_major', 'رشته']]) {
    if (p[key] !== undefined && p[key] !== '' && !(p.is_fum_student && ['is_student', 'is_mashhad_student', 'is_graduate_student', 'is_student_relative', 'university_name'].includes(key))) fields.push(`${title}${key.startsWith('is_') ? '' : ':'} ${typeof p[key] === 'boolean' || typeof p[key] === 'number' && key.startsWith('is_') ? p[key] ? 'بله' : 'خیر' : p[key]}`);
  }
  return fields.join('\n');
}
function eventTime(value) {
  if (!value) return 'اعلام نشده';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', calendar: 'gregory', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}
function eventText(event) {
  return [event.name, event.description || '', `شناسه: ${event.id}`, `مکان: ${event.place_name || 'بدون مکان مشخص'}`, event.address || event.place_address ? `نشانی: ${event.address || event.place_address}` : '', `زمان: ${eventTime(event.starts_at)}`, `ظرفیت: ${event.capacity}`, event.remaining != null ? `ظرفیت باقی‌مانده: ${event.remaining}` : '', `سقف بلیت برای هر نفر: ${event.max_per_user}`, event.is_paid ? `قیمت هر بلیت: ${money(event.price)} تومان` : 'قیمت: رایگان', `وضعیت: ${event.active ? 'فعال' : 'غیرفعال'}`].filter(Boolean).join('\n');
}
function orderText(order) {
  return `${order.event_name || 'رویداد'}\nشناسه سفارش: ${order.id}\nتعداد بلیت: ${order.quantity}\nوضعیت: ${STATUS[order.status] || order.status}`;
}
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
    await store.enqueue('sendMessage', { chat_id: order.user_id, text: orderText(order) }, `${key}:${order.status}`);
    return;
  }
  for (let start = 0; start < Math.max(tickets.length, 1); start += 20) {
    await store.enqueue('sendMessage', { chat_id: order.user_id, text: `ثبت نام شما تأیید شد\n${orderText(order)}\nبرای مشاهده بلیت و کد QR دکمه‌های زیر را باز کنید`, reply_markup: { inline_keyboard: tickets.slice(start, start + 20).map((ticket, i) => [{ text: `بلیت ${start + i + 1}`, url: link(env, `/ticket/${ticket.token}`) }]) } }, `${key}:approved:${start}`);
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
  const send = (text, markup = undefined, tag = 'reply', chatId = chat.id) => store.enqueue('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), ...(markup ? { reply_markup: markup } : {}) }, `${updateKey}:${tag}`);
  const answer = (text = '') => callback && store.enqueue('answerCallbackQuery', { callback_query_id: callback.id, text: text.slice(0, 190) }, `${updateKey}:answer`);
  const panel = async () => {
    if (!isChecker || chat.type !== 'private') return send('این بخش فقط برای مدیران مجاز در گفتگوی خصوصی فعال است');
    const token = await createLoginCode(store.db, from.id);
    await send('این لینک ورود اختصاصی شماست و مدت کوتاهی اعتبار دارد\nآن را برای فرد دیگری ارسال نکنید', { inline_keyboard: [[{ text: 'ورود به پنل مدیریت', url: link(env, `/admin#login=${token}`) }]] });
  };
  const needAccount = async () => {
    const user = await store.getUser(from.id);
    if (!user?.phone) {
      await send('برای ادامه ابتدا با دستور /add_account ثبت‌نام کنید');
      return null;
    }
    return user;
  };
  const showEvents = async (offset = 0) => {
    if (!await needAccount()) return;
    const events = await store.listEvents({ activeOnly: true, limit: 20, offset });
    if (!events.length) return send('در حال حاضر رویداد فعالی نداریم', MENU);
    const buttons = events.map(e => [{ text: String(e.name).slice(0, 70), callback_data: `e:${e.id}` }]);
    if (events.length === 20) buttons.push([{ text: 'صفحه بعد', callback_data: `le:${offset + 20}` }]);
    if (offset > 0) buttons.push([{ text: 'صفحه قبل', callback_data: `le:${Math.max(0, offset - 20)}` }]);
    await send('برای دیدن جزئیات و دریافت بلیت یک رویداد را انتخاب کنید', { inline_keyboard: buttons });
  };
  const selectEvent = async eventId => {
    if (!await needAccount()) return;
    const event = await store.getEvent(positive(eventId));
    if (!event || !event.active || event.archived) return send('این رویداد موجود نیست یا ثبت‌نام آن متوقف شده است');
    if (event.is_paid && !env.VERIFICATION_CHAT) return send('ثبت نام رویدادهای پولی تا تنظیم گروه بررسی پرداخت متوقف است');
    await send(eventText(event) + '\n\nتعداد بلیت مورد نظر را وارد کنید\nبرای توقف /cancel را بفرستید');
    await store.setState(from.id, 'reserve_quantity', { event_id: event.id, last_update_id: update.update_id });
  };
  const showOrders = async (offset = 0) => {
    if (!await needAccount()) return;
    const orders = await store.listOrders({ userId: from.id, limit: 15, offset });
    if (!orders.length) return send('هنوز سفارشی ثبت نکرده‌اید', MENU);
    const buttons = orders.map(o => [{ text: `${o.event_name || 'سفارش'} ${STATUS[o.status] || o.status}`.slice(0, 65), callback_data: `o:${o.id}` }]);
    if (orders.length === 15) buttons.push([{ text: 'صفحه بعد', callback_data: `ls:${offset + 15}` }]);
    if (offset > 0) buttons.push([{ text: 'صفحه قبل', callback_data: `ls:${Math.max(0, offset - 15)}` }]);
    await send('برای مشاهده بلیت و وضعیت هر سفارش دکمه مربوط به آن را باز کنید', { inline_keyboard: buttons });
  };
  const transition = async (step, data, text, markup) => {
    await send(text, markup);
    await store.setState(from.id, step, { ...data, last_update_id: update.update_id });
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
        return answer(parts[2] === 'y' ? 'پرداخت تأیید شد' : 'درخواست رد شد');
      }
      if (chat.type !== 'private') return answer('این کار را در گفتگوی خصوصی ربات انجام دهید');
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
        await send(`سفارش لغو شد\n${orderText(order)}`, MENU);
        await store.clearState(from.id);
        return answer();
      }
      if (data.startsWith('p:')) {
        const order = await store.getOrder(data.slice(2));
        if (!order || String(order.user_id) !== String(from.id) || order.status !== 'reserved' || order.expires_at <= Math.floor(Date.now() / 1000)) return answer('این سفارش قابل پرداخت نیست');
        const event = await store.getEvent(order.event_id);
        await transition('payment_receipt', { order_id: order.id }, `مبلغ ${money(Number(order.unit_price) * order.quantity)} تومان\n${event.payment_instructions || 'اطلاعات واریز در توضیحات رویداد آمده است'}\n\nعکس یا فایل رسید واریز را همینجا ارسال کنید`);
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

    if (/^\/chatid(?:@[a-z\d_]+)?\s*$/i.test(String(message?.text || '').trim())) return send(`شناسه این گفتگو ${chat.id}`);
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
        if (String(state.step).startsWith('signup:')) return await signupStep(state.step.slice(7), text, data, false);
        if (state.step === 'reserve_quantity') {
          const result = await store.reserve(from.id, data.event_id, positive(text), `${updateKey}:reserve`);
          if (result.order.status === 'approved') await notifyOrder({ ...result.order, tickets: result.tickets }, env, store);
          else {
            const event = await store.getEvent(data.event_id);
            await send(`سفارش شما موقتا رزرو شد\n${orderText(result.order)}\nمبلغ کل ${money(Number(result.order.unit_price) * result.order.quantity)} تومان\n${event.payment_instructions || ''}\n\nعکس یا فایل رسید واریز را ارسال کنید\nاگر رسید را تا پایان مهلت رزرو نفرستید ظرفیت آزاد میشود`, { inline_keyboard: [[{ text: 'لغو سفارش', callback_data: `c:${result.order.id}` }]] });
          }
          if (result.order.status === 'reserved') await store.setState(from.id, 'payment_receipt', { order_id: result.order.id, last_update_id: update.update_id });
          else await store.setState(from.id, 'idle', { last_update_id: update.update_id });
          return;
        }
        if (state.step === 'payment_receipt') {
          const photo = message.photo?.at(-1);
          const document = message.document;
          if (!photo && (!document || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(document.mime_type))) return send('عکس رسید یا فایل PDF را ارسال کنید');
          if ((photo?.file_size || document?.file_size || 0) > 10 * 1024 * 1024) return send('حجم رسید باید کمتر از ۱۰ مگابایت باشد');
          if (!env.VERIFICATION_CHAT) return send('گروه بررسی پرداخت تنظیم نشده است لطفا با مدیر تماس بگیرید');
          const receiptType = photo ? 'photo' : 'document';
          const order = await store.submitReceipt(data.order_id, from.id, photo?.file_id || document.file_id, receiptType, `${updateKey}:receipt`);
          const user = await store.getUser(from.id);
          const isFumStudent = profileOf(user).is_fum_student;
          const previousTickets = await store.countApprovedTickets(from.id, order.event_id);
          const receiptCaption = [
            `کد سفارش ${order.id}`,
            `شناسه کاربر ${order.user_id}`,
            `نام و نام خانوادگی ${[order.first_name, order.last_name].filter(Boolean).join(' ') || 'ثبت نشده'}`,
            `دانشجوی فردوسی ${isFumStudent == null ? 'نامشخص' : isFumStudent ? 'بله' : 'خیر'}`,
            `نام رویداد ${order.event_name || 'نامشخص'}`,
            `تعداد بلیت درخواستی ${order.quantity}`,
            `تعداد بلیت‌های قبلا خریداری شده ${previousTickets}`,
            `مبلغ کل ${money(Number(order.unit_price) * Number(order.quantity))} تومان`,
          ].join('\n');
          await store.enqueue(photo ? 'sendPhoto' : 'sendDocument', { chat_id: env.VERIFICATION_CHAT, [photo ? 'photo' : 'document']: order.receipt_file_id, caption: receiptCaption, reply_markup: { inline_keyboard: [[{ text: 'تأیید پرداخت', callback_data: `r:${order.id}:y` }, { text: 'رد درخواست', callback_data: `r:${order.id}:n` }]] } }, `receipt:${order.id}:${order.receipt_file_id}`);
          await send('رسید شما برای بررسی فرستاده شد\nنتیجه از همین ربات به شما اطلاع داده می‌شود', MENU);
          await store.setState(from.id, 'idle', { last_update_id: update.update_id });
          return;
        }
      }
      return send('از دکمه‌ها استفاده کنید یا برای دیدن راهنما /help را بفرستید', MENU);
    }

    const command = match[1].toLowerCase();
    const arg = (match[2] || '').trim();
    if (command === 'start') {
      if (/^getTicket_\d+$/.test(arg)) return selectEvent(arg.slice(10));
      if (arg === 'availableEvents') return showEvents();
      return send('به سامانه ثبت‌نام رویدادها خوش آمدید\nبرای ساخت حساب /add_account و برای دیدن رویدادها /available_events را بفرستید', MENU);
    }
    if (command === 'id') return send(`شناسه تلگرام شما ${from.id}`);
    if (command === 'help') return send('ثبت نام /add_account\nاطلاعات حساب /get_account\nرویدادها /available_events\nسفارشها و بلیتهای من /my_tickets\nشناسه گفتگو /chatid\nتوقف مرحله جاری /cancel\nحذف اطلاعات حساب /delete_account' + (isChecker ? '\nپنل مدیریت /admin\nبرای راهنمای مدیر /admin_help' : ''), MENU);
    if (command === 'cancel') {
      await send('مرحله جاری متوقف شد\nبرای لغو رزرو از بخش بلیتهای من وارد سفارش شوید', MENU);
      await store.clearState(from.id);
      return;
    }
    if (command === 'add_account') {
      const user = await store.getUser(from.id);
      if (user?.phone) return send('قبلاً ثبت‌نام کرده‌اید\nبرای دیدن اطلاعات /get_account را بفرستید');
      return transition('signup:first_name', { profile: {}, username: from.username || '' }, 'نام خود را وارد کنید');
    }
    if (command === 'get_account') {
      const user = await needAccount();
      if (user) return send(userText(user), MENU);
      return;
    }
    if (command === 'delete_account') {
      const user = await store.getUser(from.id);
      if (!user) return send('حسابی برای شما ثبت نشده است');
      if (arg !== 'confirm') return send('با حذف حساب اطلاعات پروفایل پاک میشود\nسوابق ضروری سفارشها طبق سیاست نگهداری سامانه باقی میماند\nبرای تأیید دستور زیر را بفرستید\n/delete_account confirm');
      await store.deleteUser(from.id);
      await store.clearState(from.id);
      return send('اطلاعات حساب شما حذف شد', MENU);
    }
    if (command === 'available_events') return showEvents();
    if (['my_tickets', 'my_orders'].includes(command)) return showOrders();
    if (command === 'admin') return panel();
    if (command === 'promote_me') return send('رمز مشترک ارتقای مدیر در این نسخه حذف شده است\nمالک ربات باید دسترسی مدیر را تعیین کند');
    if (!isChecker) return send('این دستور موجود نیست یا اجازه اجرای آن را ندارید');
    if (command === 'admin_help') return send('پنل مدیریت /admin\nبررسی بلیت /get_ticket CODE\nثبت ورود /attend_ticket CODE' + (isAdmin ? '\nفهرست رویدادها /get_events\nفهرست مکانها /get_places\nگزارش ظرفیت /count_tickets\nراهنمای ساخت مکان /add_place\nراهنمای ساخت رویداد /add_event\nخروجی کاربران /export_users\nخروجی بلیتها /export_tickets EVENT_ID\nپیام به همه /message_all\nپیام به رویداد /message_event' : ''));
    if (command === 'get_ticket') {
      const ticket = await store.getTicket(arg);
      if (!ticket) return send('بلیت پیدا نشد');
      return send(`شناسه ${ticket.id}\nرویداد ${ticket.event_name || ticket.event_id || ''}\nوضعیت ${STATUS[ticket.status || ticket.order_status] || ticket.status || ticket.order_status || ''}\nورود ${ticket.checked_in_at ? 'ثبت شده' : 'ثبت نشده'}\nصاحب بلیت ${ticket.first_name || ''} ${ticket.last_name || ''}`);
    }
    if (command === 'attend_ticket') {
      const ticket = await store.checkIn(arg, from.id);
      return send(`ورود ثبت شد\n${ticket.event_name || ''}\n${ticket.first_name || ''} ${ticket.last_name || ''}`);
    }
    if (!isAdmin) return send('این بخش فقط برای مدیر رویداد فعال است');
    if (command === 'promote' || command === 'demote') {
      if (role !== 'owner') return send('تغییر مدیر فقط توسط مالک ربات انجام میشود');
      const [id, requestedRole = 'admin'] = arg.split(/\s+/);
      const target = positive(id);
      if (ownerIds(env).includes(String(target))) return send('مالک از تنظیمات سرور مدیریت میشود');
      if (command === 'promote') {
        if (!['admin', 'checkin'].includes(requestedRole)) return send('نقش باید admin یا checkin باشد');
        await store.setAdmin(target, requestedRole);
      } else await store.removeAdmin(target);
      await store.audit(from.id, command, String(target), { role: requestedRole });
      return send('دسترسی مدیر به روز شد');
    }
    if (command === 'get_user') {
      const user = await store.getUser(positive(arg));
      return send(user ? userText(user) : 'کاربر پیدا نشد');
    }
    if (command === 'delete_user') {
      const target = positive(arg);
      await store.deleteUser(target);
      await store.audit(from.id, 'delete_user', String(target), {});
      return send('اطلاعات شخصی کاربر حذف شد');
    }
    if (command === 'get_places') {
      const places = await store.listPlaces();
      return send(places.length ? places.map(p => `${p.id}  ${p.name}  ظرفیت ${p.capacity}`).join('\n') : 'مکانی ثبت نشده است');
    }
    if (command === 'get_place') {
      const place = (await store.listPlaces()).find(p => Number(p.id) === positive(arg));
      return send(place ? `${place.id}\n${place.name}\n${place.address}\nظرفیت ${place.capacity}` : 'مکان پیدا نشد');
    }
    if (command === 'add_place') {
      const parts = arg.split(/\r?\n\s*-\s*\r?\n/).map(x => x.trim());
      if (parts.length !== 3) return send('اطلاعات مکان را به شکل زیر بفرستید\n/add_place\nنام مکان\n-\nآدرس\n-\nظرفیت');
      const place = await store.savePlace({ name: name(parts[0]), address: parts[1], capacity: positive(parts[2]) });
      await store.audit(from.id, 'create_place', String(place.id), {});
      return send(`مکان ثبت شد\nشناسه ${place.id}`);
    }
    if (command === 'delete_place') {
      await store.deletePlace(positive(arg));
      await store.audit(from.id, 'delete_place', arg, {});
      return send('مکان حذف شد');
    }
    if (command === 'get_events') {
      const events = await store.listEvents({ limit: 100 });
      return send(events.length ? events.map(e => `${e.id}  ${e.name}  ${e.active ? 'فعال' : 'غیرفعال'}`).join('\n') : 'رویدادی ثبت نشده است');
    }
    if (command === 'get_event') {
      const event = await store.getEvent(positive(arg));
      return send(event ? eventText(event) : 'رویداد پیدا نشد');
    }
    if (command === 'add_event') {
      const parts = arg.split(/\r?\n\s*-\s*\r?\n/).map(x => x.trim());
      if (![5, 8].includes(parts.length)) return send('اطلاعات رویداد را به شکل زیر بفرستید\n/add_event\nنام رویداد\n-\nتوضیحات\n-\nپرداخت دارد بله یا خیر\n-\nسقف بلیت هر نفر\n-\nشناسه مکان\n-\nقیمت هر بلیت به تومان\n-\nراهنمای پرداخت\n-\nتاریخ و زمان رویداد\n\nبرای رویداد رایگان پنج بخش اول کافی است');
      const paid = yes(parts[2]);
      if (paid && parts.length !== 8) return send('برای رویداد پولی قیمت و راهنمای پرداخت و زمان را هم وارد کنید');
      const placeId = positive(parts[4]);
      const place = (await store.listPlaces()).find(p => Number(p.id) === placeId);
      if (!place) return send('مکان پیدا نشد');
      const event = await store.saveEvent({ name: name(parts[0]), description: parts[1], is_paid: paid, max_per_user: positive(parts[3]), place_id: placeId, capacity: place.capacity, price: paid ? positive(parts[5]) : 0, payment_instructions: parts[6] || '', starts_at: parts[7] || '', active: 1 });
      await store.audit(from.id, 'create_event', String(event.id), {});
      return send(`رویداد ثبت شد\n${eventText(event)}\nلینک ثبت نام را از بخش رویدادها در ربات یا پنل بردارید`);
    }
    if (command === 'activate_event' || command === 'deactivate_event') {
      const event = await store.getEvent(positive(arg));
      if (!event || event.archived) return send('رویداد پیدا نشد');
      await store.saveEvent({ ...event, active: command === 'activate_event' ? 1 : 0 }, event.id);
      await store.audit(from.id, command, String(event.id), {});
      return send('وضعیت رویداد به روز شد');
    }
    if (command === 'delete_event') {
      await store.deleteEvent(positive(arg));
      await store.audit(from.id, 'archive_event', arg, {});
      return send('رویداد بایگانی شد و سوابق آن باقی ماند');
    }
    if (command === 'export_users') {
      const users = await collectPages(opts => store.listUsers(opts));
      await store.enqueue('sendDocument', { chat_id: chat.id, filename: 'users.csv', _documentText: csv(users, [['id', 'شناسه'], ['first_name', 'نام'], ['last_name', 'نام خانوادگی'], ['phone', 'شماره'], [u => JSON.stringify(profileOf(u)), 'اطلاعات تحصیلی']]) }, `${updateKey}:csv`);
      return send(`خروجی ${users.length} کاربر آماده شد\nخروجی هر درخواست حداکثر هزار ردیف است`, undefined, 'export_info');
    }
    if (['export_tickets', 'preview_tickets'].includes(command)) {
      const eventId = positive(arg);
      const tickets = await collectPages(opts => store.listTickets({ ...opts, eventId }));
      if (command === 'preview_tickets') return send(tickets.slice(0, 50).map(t => `${t.legacy_code || t.id}  ${t.first_name || ''} ${t.last_name || ''}  ${t.checked_in_at ? 'حاضر' : 'ثبت ورود نشده'}`).join('\n') || 'بلیت پیدا نشد');
      await store.enqueue('sendDocument', { chat_id: chat.id, filename: `tickets-${eventId}.csv`, _documentText: csv(tickets, [['id', 'شناسه'], ['legacy_code', 'کد قدیمی'], ['event_name', 'رویداد'], ['first_name', 'نام'], ['last_name', 'نام خانوادگی'], ['user_id', 'شناسه کاربر'], ['order_status', 'وضعیت سفارش'], ['checked_in_at', 'زمان ورود']]) }, `${updateKey}:csv`);
      return send(`خروجی ${tickets.length} بلیت آماده شد\nخروجی هر درخواست حداکثر هزار ردیف است`, undefined, 'export_info');
    }
    if (command === 'print_tickets') return send('برای چاپ بلیتهای رویداد وارد پنل شوید و از بخش بلیتهای رویداد گزینه چاپ را انتخاب کنید\n/admin');
    if (command === 'backup') {
      if (!env.BACKUP_CHAT) return send('گروه بکاپ تنظیم نشده است');
      await store.enqueue('__backup', { actor_id: from.id }, `${updateKey}:backup`);
      return send('درخواست تهیه بکاپ در صف قرار گرفت');
    }
    if (command === 'count_tickets' || command === 'database_storage') {
      const stats = await store.stats();
      const events = await store.listEvents({ limit: 50 });
      return send(`آمار سامانه\n${Object.entries(stats).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k} ${v}`).join('\n')}\n\n${events.map(e => `${e.name}\nظرفیت ${e.capacity}  باقی مانده ${e.remaining ?? ''}`).join('\n')}`);
    }
    if (command === 'message_all' || command === 'message_event') {
      const parts = arg.split(/\r?\n\s*-\s*\r?\n/).map(x => x.trim()).filter(Boolean);
      if (command === 'message_all' && !arg) return send('پیام را بعد از دستور بنویسید\n/message_all متن پیام');
      if (command === 'message_event' && parts.length !== 2) return send('پیام رویداد را به شکل زیر بفرستید\n/message_event\nشناسه رویداد\n-\nمتن پیام');
      const eventId = command === 'message_event' ? positive(parts[0]) : null;
      const broadcastText = command === 'message_event' ? parts[1] : arg.replace(/^\s*-\s*\n/, '');
      if (broadcastText.length > 3500) return send('متن پیام حداکثر ۳۵۰۰ نویسه باشد');
      if (eventId && !await store.getEvent(eventId)) return send('رویداد پیدا نشد');
      await store.enqueue('__broadcast', { text: broadcastText, event_id: eventId, actor_id: from.id }, `${updateKey}:broadcast`);
      await store.audit(from.id, 'broadcast', String(eventId || 'all'), {});
      return send('پیام برای ارسال تدریجی در صف قرار گرفت');
    }
    if (command === 'unattend_ticket' && typeof store.undoCheckIn === 'function') {
      await store.undoCheckIn(arg, from.id);
      return send('ثبت ورود بلیت برگردانده شد');
    }
    if (command === 'delete_ticket' && typeof store.deleteTicket === 'function') {
      await store.deleteTicket(arg, from.id);
      return send('بلیت لغو شد');
    }
    if (command === 'flush_reserves' && typeof store.flushReserves === 'function') {
      await store.flushReserves(positive(arg), from.id);
      return send('رزروهای تأیید نشده آزاد شدند');
    }
    return send('این دستور در این نسخه از پنل مدیریت انجام میشود\n/admin');
  } catch (error) {
    // Infrastructure failures must reach the durable inbox so it can retry them.
    // Only domain failures and our Persian input-validation errors are handled here.
    const messageText = String(error?.message || '');
    const domainFailure = typeof error?.code === 'string' && !error.code.startsWith('ERR_') && /[\u0600-\u06ff]/u.test(messageText);
    const inputFailure = /^[\u0600-\u06ff]/u.test(messageText) && !/sql|sqlite|constraint|binding|internal|fetch|network|token|secret|session/i.test(messageText);
    if (!domainFailure && !inputFailure) throw error;
    if (callback) await answer('درخواست انجام نشد');
    await send(messageText, undefined, 'error', chat.type === 'private' ? chat.id : from.id);
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
      if (!isCallback || !['yes', 'no'].includes(input)) throw new Error('از دکمه بله یا خیر استفاده کنید');
      return input === 'yes';
    };
    const confirm = () => next('confirm', `اطلاعات زیر را تأیید می‌کنید؟\n\n${userText({ ...d, id: from.id })}`, { inline_keyboard: YES_NO });
    if (step === 'first_name') {
      if (isCallback) throw new Error('نام خود را به صورت متن بفرستید');
      d.first_name = name(input);
      return next('last_name', 'نام خانوادگی خود را وارد کنید');
    }
    if (step === 'last_name') {
      if (isCallback) throw new Error('نام خانوادگی را به صورت متن بفرستید');
      d.last_name = name(input);
      return next('phone', 'شماره خود را با دکمه زیر به اشتراک بگذارید', { keyboard: [[{ text: 'ارسال شماره من', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true });
    }
    if (step === 'phone') {
      if (isCallback || !message?.contact || message.contact.user_id !== from.id) throw new Error('با دکمه ارسال شماره من شماره متعلق به همین حساب را بفرستید');
      d.phone = digits(message.contact.phone_number).replace(/\s/g, '');
      if (!/^\+?\d{7,15}$/.test(d.phone)) throw new Error('شماره معتبر نیست دوباره با دکمه ارسال کنید');
      await send('شماره ثبت شد', { remove_keyboard: true }, 'phone_saved');
      return next('gender', 'جنسیت را انتخاب کنید', { inline_keyboard: [[{ text: 'آقا', callback_data: 's:boy' }, { text: 'خانم', callback_data: 's:girl' }]] });
    }
    if (step === 'gender') {
      if (!isCallback || !['boy', 'girl'].includes(input)) throw new Error('از دکمه‌ها استفاده کنید');
      p.is_boy = input === 'boy';
      return askYesNo('is_fum_student', 'دانشجوی دانشگاه فردوسی مشهد هستید؟');
    }
    if (step === 'is_fum_student') {
      p.is_fum_student = bool();
      if (p.is_fum_student) {
        Object.assign(p, { is_student: true, is_mashhad_student: true, university_name: 'دانشگاه فردوسی مشهد', is_graduate_student: false, is_student_relative: false });
        return next('student_number', 'شماره دانشجویی خود را وارد کنید');
      }
      return askYesNo('is_student', 'دانشجو هستید؟');
    }
    if (step === 'student_number') {
      const number = digits(input);
      if (isCallback || !/^\d{3,20}$/.test(number)) throw new Error('شماره دانشجویی را با ۳ تا ۲۰ رقم وارد کنید');
      p.student_number = number;
      return next('fum_faculty', 'دانشکده خود را انتخاب کنید', { inline_keyboard: FACULTIES.map((f, i) => [{ text: f, callback_data: `s:f${i}` }]) });
    }
    if (step === 'fum_faculty') {
      if (!isCallback || !/^f\d+$/.test(input) || !FACULTIES[Number(input.slice(1))]) throw new Error('دانشکده را از دکمه‌ها انتخاب کنید');
      p.fum_faculty = FACULTIES[Number(input.slice(1))];
      return next('entrance_year', 'سال ورود به دانشگاه را وارد کنید');
    }
    if (step === 'is_student') {
      p.is_student = bool();
      return p.is_student ? askYesNo('is_mashhad_student', 'در دانشگاهی در مشهد تحصیل می‌کنید؟') : askYesNo('is_graduate_student', 'فارغ التحصیل دانشگاه هستید');
    }
    if (step === 'is_mashhad_student') {
      p.is_mashhad_student = bool();
      return next('university_name', 'نام دانشگاه را وارد کنید');
    }
    if (step === 'university_name') {
      if (isCallback) throw new Error('نام دانشگاه را به صورت متن بفرستید');
      p.university_name = name(input);
      return next('entrance_year', 'سال ورود به دانشگاه را وارد کنید');
    }
    if (step === 'entrance_year') {
      const year = Number(digits(input));
      if (isCallback || !Number.isInteger(year) || !(year >= 1300 && year <= 1500 || year >= 1900 && year <= 2100)) throw new Error('سال ورود را به صورت سال چهار رقمی وارد کنید');
      p.entrance_year = String(year);
      return askYesNo('is_mast_phd', 'دانشجوی کارشناسی ارشد یا دکتری هستید؟');
    }
    if (step === 'is_mast_phd') {
      p.is_mast_phd = bool();
      return next('student_major', 'رشته تحصیلی خود را وارد کنید');
    }
    if (step === 'student_major') {
      if (isCallback) throw new Error('رشته را به صورت متن بفرستید');
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
        await send('ثبت‌نام لغو شد\nبرای شروع دوباره /add_account را بفرستید', MENU);
        return store.setState(from.id, 'idle', { last_update_id: update.update_id });
      }
      await store.upsertUser({ id: from.id, username: from.username || d.username, first_name: d.first_name, last_name: d.last_name, phone: d.phone, profile: p });
      await send('ثبت‌نام شما انجام شد\nبرای انتخاب رویداد /available_events را بفرستید', MENU);
      return store.setState(from.id, 'idle', { last_update_id: update.update_id });
    }
    throw new Error('این مرحله معتبر نیست با /cancel متوقف کنید و دوباره ثبت نام کنید');
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
