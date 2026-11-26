import { formatEventSchedule, formatJalaliDate, jalaliFirstWeekday, jalaliMonthLength, jalaliMonths, jalaliTimeToIso, latinNumber, parseJalaliDate, persianNumber, tehranDateTime } from './jalali.js';

/* Admin credentials live only in an HttpOnly server session; no persistent browser tokens. */
const $ = (id) => document.getElementById(id);
const state = { me: null, view: 'overview', events: [], audienceEvents: [], places: [], camera: null, timer: null, loading: 0, pages: { orders: 0, tickets: 0, users: 0 } };
const titles = { overview: 'نمای کلی', events: 'رویدادها', places: 'مکان‌ها', orders: 'بررسی پرداخت‌ها', tickets: 'بلیت‌ها', checkin: 'ثبت ورود', users: 'شرکت‌کنندگان', broadcast: 'پیام‌رسانی', admins: 'مدیران', settings: 'داده‌ها و پشتیبان' };
const statusNames = { pending: 'در انتظار بررسی', pending_payment: 'در انتظار پرداخت', reserved: 'رزروشده', confirmed: 'تأییدشده', completed: 'تکمیل‌شده', paid: 'پرداخت‌شده', approved: 'تأییدشده', rejected: 'ردشده', cancelled: 'لغوشده', expired: 'منقضی‌شده', attended: 'واردشده', issued: 'صادرشده', valid: 'معتبر', active: 'فعال' };
const roleNames = { owner: 'مالک', admin: 'مدیر', checkin: 'مسئول پذیرش' };
const faNumber = new Intl.NumberFormat('fa-IR');
const number = (value) => faNumber.format(Number(value) || 0);
const array = (value, key) => Array.isArray(value) ? value : (value?.[key] || value?.items || value?.data || []);
const yes = (value) => value === true || value === 1 || value === '1';
let toastTimer;
let userSearchTimer;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== null && text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
function empty(container, title, message = '') {
  const box = el('div', null, 'empty');
  box.append(el('strong', title), el('span', message));
  container.replaceChildren(box);
}
function badge(status) {
  let style = 'badge';
  if (['pending', 'pending_payment', 'reserved'].includes(status)) style += ' warn';
  if (['rejected', 'cancelled'].includes(status)) style += ' error';
  if (status === 'expired') style += ' muted';
  return el('span', statusNames[status] || status || '—', style);
}
function date(value) {
  if (!value) return 'زمان تعیین نشده';
  const d = new Date(typeof value === 'number' && value < 100000000000 ? value * 1000 : value);
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
function ticketCode(value) {
  const code = String(value || '');
  return /^\d{8}$/.test(code) ? code : '';
}
const calendar = { year: 0, month: 0, day: 1 };
let dateInput, timeInput;
function selectedJalaliDate(input) {
  try { return parseJalaliDate(input.value); } catch { return null; }
}
function syncJalaliSelects() {
  const currentYear = tehranDateTime().year;
  const firstYear = Math.max(1200, currentYear - 20);
  const lastYear = Math.min(1700, currentYear + 20);
  const years = new Set(Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index));
  years.add(calendar.year);
  $('jalali-year').replaceChildren(...[...years].sort((a, b) => a - b).map(year => {
    const option = el('option', persianNumber(year)); option.value = String(year); return option;
  }));
  $('jalali-month').replaceChildren(...jalaliMonths.map((month, index) => {
    const option = el('option', month); option.value = String(index + 1); return option;
  }));
  const length = jalaliMonthLength(calendar.year, calendar.month);
  calendar.day = Math.min(calendar.day, length);
  $('jalali-day').replaceChildren(...Array.from({ length }, (_, index) => {
    const day = index + 1, option = el('option', persianNumber(day)); option.value = String(day); return option;
  }));
  $('jalali-year').value = String(calendar.year);
  $('jalali-month').value = String(calendar.month);
  $('jalali-day').value = String(calendar.day);
}
function renderJalaliCalendar(focusDay = null) {
  if (focusDay !== null) calendar.day = focusDay;
  const { year, month } = calendar;
  calendar.day = Math.min(calendar.day, jalaliMonthLength(year, month));
  syncJalaliSelects();
  $('jalali-dialog-title').textContent = `${jalaliMonths[month - 1]} ${persianNumber(year)}`;
  const days = $('jalali-days');
  days.replaceChildren();
  for (let i = 0; i < jalaliFirstWeekday(year, month); i++) days.append(el('span', null, 'jalali-empty'));
  const today = tehranDateTime();
  for (let day = 1; day <= jalaliMonthLength(year, month); day++) {
    const current = calendar.day === day;
    const isToday = today.year === year && today.month === month && today.day === day;
    const item = el('button', persianNumber(day), 'jalali-day' + (current ? ' selected' : '') + (isToday ? ' today' : ''));
    item.type = 'button'; item.dataset.day = String(day);
    item.setAttribute('aria-label', `${persianNumber(day)} ${jalaliMonths[month - 1]} ${persianNumber(year)}`);
    item.setAttribute('aria-pressed', String(Boolean(current)));
    item.addEventListener('click', () => renderJalaliCalendar(day));
    days.append(item);
  }
  while (days.children.length < 42) days.append(el('span', null, 'jalali-empty'));
  if (focusDay) days.querySelector(`[data-day="${focusDay}"]`)?.focus();
}
function chooseJalaliDate(day) {
  dateInput.value = formatJalaliDate({ year: calendar.year, month: calendar.month, day });
  $('jalali-dialog').close();
  dateInput.focus();
}
function shiftJalaliMonth(amount, focusDay = calendar.day) {
  const index = calendar.year * 12 + calendar.month - 1 + amount;
  const year = Math.floor(index / 12), month = index - year * 12 + 1;
  if (year < 1200 || year > 1700) return;
  calendar.year = year; calendar.month = month; calendar.day = focusDay;
  renderJalaliCalendar(Math.min(focusDay, jalaliMonthLength(year, month)));
}
function openJalaliCalendar(input) {
  dateInput = input;
  const startDate = input.id === 'event-end-date' ? selectedJalaliDate($('event-jalali-date')) : null;
  const selected = selectedJalaliDate(input) || startDate || tehranDateTime();
  calendar.year = selected.year; calendar.month = selected.month; calendar.day = selected.day;
  renderJalaliCalendar();
  $('jalali-dialog').showModal();
  $('jalali-days').querySelector(`[data-day="${selected.day}"]`)?.focus();
}
function openTimePicker(input) {
  timeInput = input;
  const label = input.dataset.pickerLabel || 'ساعت';
  $('time-dialog-title').textContent = `انتخاب ${label}`;
  $('time-hour').setAttribute('aria-label', label);
  const parsed = /^(\d{2}):(\d{2})$/.exec(latinNumber(input.value || input.placeholder).trim());
  const current = tehranDateTime();
  const selectedHour = parsed ? Number(parsed[1]) : current.hour;
  const selectedMinute = parsed ? Number(parsed[2]) : current.minute;
  $('time-hour').replaceChildren(...Array.from({ length: 24 }, (_, hour) => {
    const option = el('option', persianNumber(String(hour).padStart(2, '0'))); option.value = String(hour).padStart(2, '0'); return option;
  }));
  $('time-minute').replaceChildren(...Array.from({ length: 60 }, (_, minute) => {
    const option = el('option', persianNumber(String(minute).padStart(2, '0'))); option.value = String(minute).padStart(2, '0'); return option;
  }));
  $('time-hour').value = String(selectedHour).padStart(2, '0');
  $('time-minute').value = String(selectedMinute).padStart(2, '0');
  $('time-dialog').showModal();
}
function chooseTime() {
  timeInput.value = persianNumber(`${$('time-hour').value}:${$('time-minute').value}`);
  $('time-dialog').close();
  timeInput.focus();
}
function connectPicker(field, buttonId, open) {
  const input = $(field);
  const show = () => open(input);
  $(buttonId).addEventListener('click', show);
  input.addEventListener('click', show);
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    show();
  });
}
async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store', body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/session')) showLogin('نشست شما تمام شده است یک لینک ورود جدید از ربات بگیرید');
    const detail = typeof data.error === 'string' ? data.error : data.error?.message || data.message;
    throw new Error(detail || (response.status === 429 ? 'تعداد درخواست‌ها زیاد است کمی بعد دوباره تلاش کنید' : 'انجام درخواست ممکن نشد'));
  }
  return data;
}
async function action(button, task) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { await task(); } catch (error) { toast(error.message || 'خطایی رخ داد'); }
  finally { if (button) button.disabled = false; }
}
function button(label, handler, classes = 'button secondary small') {
  const node = el('button', label, classes);
  node.type = 'button';
  node.addEventListener('click', () => action(node, handler));
  return node;
}
function link(label, href, classes = 'button secondary small', newTab = false) {
  const node = el('a', label, classes);
  node.href = href;
  if (newTab) { node.target = '_blank'; node.rel = 'noopener noreferrer'; }
  return node;
}
function table(container, headings, rows) {
  if (!rows.length) return empty(container, 'هنوز موردی ثبت نشده', 'با تغییر فیلترها می‌توانید موارد دیگر را ببینید');
  const wrap = el('div', null, 'table-wrap');
  const t = el('table');
  const head = el('thead');
  const tr = el('tr');
  headings.forEach((heading) => { const th = el('th', heading); th.scope = 'col'; tr.append(th); });
  head.append(tr);
  const body = el('tbody');
  rows.forEach((values) => {
    const row = el('tr');
    values.forEach((value) => { const cell = el('td'); if (value instanceof Node) cell.append(value); else cell.textContent = value === null || value === undefined || value === '' ? '—' : String(value); row.append(cell); });
    body.append(row);
  });
  t.append(head, body); wrap.append(t); container.replaceChildren(wrap);
}
function person(item) { return [item.first_name || item.user_first_name || item.name, item.last_name || item.user_last_name].filter(Boolean).join(' ') || item.user_id || 'کاربر'; }
function eventName(item) { return item.event_name || state.events.find((event) => String(event.id) === String(item.event_id))?.name || 'رویداد'; }
function userEventLabels(value) {
  const labels = String(value || '').split('، ').filter(Boolean);
  if (!labels.length) return '—';
  const list = el('div', null, 'user-event-labels');
  labels.forEach((name) => list.append(el('span', name, 'badge')));
  return list;
}
function query(path, params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => { if (value !== '' && value !== undefined && value !== null) search.set(key, value); });
  return path + (search.size ? '?' + search.toString() : '');
}
function fillFilters() {
  document.querySelectorAll('.event-filter').forEach((select) => {
    const previous = select.value;
    const option = el('option', 'همه رویدادها'); option.value = '';
    select.replaceChildren(option);
    state.events.forEach((event) => { const item = el('option', event.name); item.value = event.id; select.append(item); });
    if (state.events.some((event) => String(event.id) === previous)) select.value = previous;
  });
  document.querySelectorAll('.audience-event-filter').forEach((select) => {
    const previous = select.value;
    const participantsFilter = select.id === 'users-event';
    const option = el('option', select.dataset.allLabel || 'همه رویدادها'); option.value = '';
    select.replaceChildren(option);
    if (participantsFilter) {
      const noEvent = el('option', 'بدون سابقهٔ شرکت در رویداد');
      noEvent.value = 'no-event'; select.append(noEvent);
    }
    const visibleEvents = state.audienceEvents.filter((event) => !participantsFilter || (!event.is_test && Number(event.participant_count) > 0));
    visibleEvents.forEach((event) => {
      const oldLabel = event.kind === 'legacy' ? ' · رویداد قدیمی' : '';
      const item = el('option', `${event.name} · ${number(event.participant_count)} نفر${oldLabel}`);
      item.value = event.audience_key; select.append(item);
    });
    if (participantsFilter && previous === 'no-event') select.value = previous;
    else if (visibleEvents.some((event) => event.audience_key === previous)) select.value = previous;
  });
  const select = $('event-place'); const old = select.value;
  const option = el('option', 'بدون مکان مشخص'); option.value = '';
  select.replaceChildren(option);
  state.places.forEach((place) => { const item = el('option', place.name); item.value = place.id; select.append(item); });
  select.value = old;
}
async function catalogs() {
  const [events, audienceEvents, places] = await Promise.all([allEvents(), allAudienceEvents(), api('/api/places')]);
  state.events = events; state.audienceEvents = audienceEvents; state.places = array(places, 'places'); fillFilters();
}
async function allEvents() {
  const events = [];
  for (let offset = 0; ; offset += 200) {
    const page = array(await api(query('/api/events', { limit: 200, offset })), 'events');
    events.push(...page);
    if (page.length < 200) return events;
  }
}
async function allAudienceEvents() {
  const events = [];
  for (let offset = 0; ; offset += 200) {
    const page = array(await api(query('/api/audience-events', { limit: 200, offset })), 'events');
    events.push(...page);
    if (page.length < 200) return events;
  }
}
function pager(container, key, count) {
  const row = el('div', null, 'pagination');
  const previous = button('صفحه قبل', async () => { state.pages[key] = Math.max(0, state.pages[key] - 1); await load(); });
  const next = button('صفحه بعد', async () => { state.pages[key] += 1; await load(); });
  previous.disabled = state.pages[key] === 0;
  next.disabled = count < 50;
  row.append(previous, el('span', 'صفحه ' + number(state.pages[key] + 1), 'muted'), next);
  container.append(row);
}
function eventRegistrationStats(event) {
  const stats = el('div', null, 'event-registration-stats');
  const summary = el('div', null, 'event-capacity-summary');
  summary.append(el('span', 'ظرفیت آزاد'), el('strong', `${number(event.remaining)} از ${number(event.capacity)} نفر`));

  const meter = el('meter', null, 'event-capacity-meter');
  meter.max = Number(event.capacity);
  meter.value = Number(event.occupied);
  meter.setAttribute('aria-label', 'ظرفیت اشغال‌شده');

  const metrics = el('dl', null, 'event-registration-metrics');
  const values = [
    ['ثبت‌نام‌کنندهٔ قطعی', event.registered_users, 'نفر'],
    ['حضور ثبت‌شده', event.checked_in_tickets, 'نفر'],
    ['بلیت تأییدشده', event.approved_tickets, 'بلیت'],
    ['رزرو موقت', event.held_tickets, 'بلیت'],
  ];
  for (const [label, value, unit] of values) {
    const item = el('div');
    item.append(el('dt', label), el('dd', `${number(value)} ${unit}`));
    metrics.append(item);
  }
  stats.append(summary, meter, metrics);
  return stats;
}
function eventCard(event, editable) {
  const card = el('article', null, 'event-card');
  const top = el('div', null, 'card-top');
  const prices = event.pricing_mode === 'differentiated'
    ? `عموم ${number(event.price)} تومان · فردوسی ${number(event.fum_student_price)} تومان`
    : yes(event.is_paid) && Number(event.price) > 0 ? number(event.price) + ' تومان' : 'رایگان';
  top.append(el('span', prices, 'muted'), el('span', yes(event.active) ? 'رزرو فعال' : 'رزرو غیرفعال', 'badge' + (yes(event.active) ? '' : ' muted')));
  card.append(top);
  if (event.poster_url) {
    const posterImg = el('img', null, 'event-card-poster-thumb');
    posterImg.src = event.poster_url.startsWith('data:') || /^https?:\/\//i.test(event.poster_url)
      ? event.poster_url
      : `/api/events/${event.id}/poster`;
    posterImg.alt = `پوستر ${event.name}`;
    posterImg.loading = 'lazy';
    card.append(posterImg);
  }
  card.append(el('h3', event.name), el('p', event.description || 'توضیحی برای این رویداد ثبت نشده', 'description'));
  const meta = el('div', null, 'event-meta');
  const place = state.places.find((place) => String(place.id) === String(event.place_id));
  const fields = [
    ['زمان برگزاری', formatEventSchedule(event.starts_at, event.ends_at) || 'زمان تعیین نشده'],
    ['مکان', place?.name || event.place_name || 'تعیین نشده'],
    ['سقف هر نفر', number(event.max_per_user) + ' بلیت'],
  ];
  for (const [label, value] of fields) {
    const cell = el('div', label); cell.append(el('strong', value)); meta.append(cell);
  }
  card.append(meta, eventRegistrationStats(event));
  const actions = el('div', null, 'actions');
  if (editable) {
    actions.append(button('ویرایش', () => editEvent(event)), button(yes(event.active) ? 'توقف رزرو' : 'فعال کردن رزرو', async () => { await api('/api/events/' + encodeURIComponent(event.id), { method: 'PATCH', body: { active: !yes(event.active) } }); await load(); toast('وضعیت رزرو به‌روز شد'); }));
    actions.append(button('حذف', async () => { if (!confirm('این رویداد حذف شود؟ سوابق سفارش‌ها باید در سرور حفظ شوند')) return; await api('/api/events/' + encodeURIComponent(event.id), { method: 'DELETE' }); await load(); toast('رویداد حذف شد'); }, 'button danger small'));
  } else actions.append(button('مشاهده بلیت‌ها', async () => { await navigate('tickets'); $('tickets-event').value = event.id; await load(); }));
  if (yes(event.questions_enabled)) actions.append(button('بررسی پرسش‌ها', () => openEventQuestions(event)));
  card.append(actions); return card;
}
const QUESTION_PAGE_SIZE = 25;
const questionApi = eventId => `/api/events/${encodeURIComponent(eventId)}/questions`;
async function questionFeedback(task, success = '') {
  const status = $('questions-status');
  status.textContent = '';
  try { await task(); status.textContent = success; }
  catch (error) { status.textContent = error.message || 'انجام درخواست ممکن نشد'; }
}
function renderEventQuestions(eventId, page, offset, status) {
  const container = $('question-list');
  const cards = page.items.map(question => {
    const card = el('article', null, 'question-item');
    const controls = el('div', null, 'question-controls');
    const topicLabel = el('label', 'موضوع');
    const topic = el('input'); topic.maxLength = 100; topic.value = question.topic;
    topicLabel.append(topic);
    const selectionLabel = el('label', null, 'check');
    const selected = el('input'); selected.type = 'checkbox'; selected.checked = yes(question.selected);
    selectionLabel.append(selected, document.createTextNode('تأیید برای خروجی'));
    controls.append(topicLabel, selectionLabel, button('ذخیره', () => questionFeedback(async () => {
      await api(`${questionApi(eventId)}/${question.id}`, { method: 'PATCH', body: { topic: topic.value.trim(), selected: selected.checked } });
      if (yes(question.selected) !== selected.checked && $('questions-filter').value === status) {
        await loadEventQuestions(eventId, offset);
      }
    }, 'سؤال به‌روز شد')));
    card.append(el('p', question.question, 'question-text'), controls);
    return card;
  });
  if (cards.length) container.replaceChildren(...cards);
  else empty(container, status === 'approved' ? 'هنوز سؤالی تأیید نشده' : 'سؤالی در انتظار تأیید نیست');
  if (!offset && !page.has_more) return;
  const pager = el('div', null, 'pagination');
  const previous = button('صفحه قبل', () => questionFeedback(() => loadEventQuestions(eventId, offset - QUESTION_PAGE_SIZE)));
  const next = button('صفحه بعد', () => questionFeedback(() => loadEventQuestions(eventId, offset + QUESTION_PAGE_SIZE)));
  previous.disabled = offset === 0;
  next.disabled = !page.has_more;
  pager.append(previous, next);
  container.append(pager);
}
async function loadEventQuestions(eventId, offset = 0) {
  const status = $('questions-filter').value;
  const page = await api(query(questionApi(eventId), { limit: QUESTION_PAGE_SIZE, offset, status }));
  const dialog = $('questions-dialog');
  if (!dialog.open || dialog.dataset.eventId !== String(eventId)) return;
  if ($('questions-filter').value !== status) return;
  if (!page.items.length && offset) return loadEventQuestions(eventId, offset - QUESTION_PAGE_SIZE);
  renderEventQuestions(eventId, page, offset, status);
}
async function openEventQuestions(event) {
  const dialog = $('questions-dialog');
  dialog.dataset.eventId = event.id;
  $('questions-title').textContent = `پرسش‌های «${event.name}»`;
  $('questions-filter').value = 'pending';
  $('question-list').replaceChildren(el('p', 'در حال دریافت سؤال‌ها', 'muted'));
  $('questions-download').href = `${questionApi(event.id)}/export`;
  dialog.showModal();
  await questionFeedback(() => loadEventQuestions(event.id));
}
async function showOverview() {
  const stats = await api('/api/stats');
  const data = stats.stats || stats;
  $('stats').replaceChildren();
  [['users', 'شرکت‌کننده'], ['events', 'رویداد'], ['tickets', 'بلیت صادرشده'], ['pending', 'پرداخت در انتظار']].forEach(([key, label]) => { const card = el('div', null, 'stat'); card.append(el('span', number(data[key] ?? (key === 'pending' ? data.pending_orders : 0)), 'value'), el('span', label, 'label')); $('stats').append(card); });
  if (!state.events.length) empty($('overview-events'), 'اولین رویداد را بسازید', 'با ثبت یک رویداد می‌توانید رزرو بلیت را شروع کنید');
  else $('overview-events').replaceChildren(...state.events.slice(0, 6).map((event) => eventCard(event, false)));
}
function showEvents() {
  if (!state.events.length) empty($('events-list'), 'رویدادی ثبت نشده', 'با دکمه رویداد جدید شروع کنید');
  else $('events-list').replaceChildren(...state.events.map((event) => eventCard(event, true)));
}
function readQuestionFields() {
  return {
    enabled: $('questions-enabled').checked,
    day: $('questions-date').value.trim(),
    time: $('questions-time').value.trim(),
    maxQuestions: Number($('questions-max').value),
  };
}
function toggleQuestionFields() {
  $('questions-options').hidden = !$('questions-enabled').checked;
}
function fillDateTime(dateId, timeId, value) {
  const local = value ? tehranDateTime(value) : null;
  $(dateId).value = local ? formatJalaliDate(local) : '';
  $(timeId).value = local ? persianNumber(`${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`) : '';
}
function editEvent(event = null) {
  const form = $('event-form'); form.reset();
  form.elements.namedItem('id').value = event?.id || '';
  $('event-form-title').textContent = event ? 'ویرایش رویداد' : 'رویداد جدید';
  ['name', 'description', 'place_id', 'capacity', 'max_per_user', 'price', 'payment_instructions'].forEach((key) => { form.elements.namedItem(key).value = event?.[key] ?? (key === 'max_per_user' ? 1 : key === 'price' ? 0 : ''); });
  form.elements.namedItem('pricing_mode').value = event?.pricing_mode || 'fixed';
  form.elements.namedItem('public_price').value = event?.price ?? 0;
  form.elements.namedItem('fum_student_price').value = event?.fum_student_price ?? 0;
  form.elements.namedItem('active').checked = event ? yes(event.active) : true;
  form.elements.namedItem('is_paid').checked = yes(event?.is_paid);
  const posterUrl = event?.poster_url || '';
  $('event-poster-url').value = posterUrl;
  $('event-poster-url-input').value = /^https?:\/\//i.test(posterUrl) ? posterUrl : '';
  $('event-poster-file').value = '';
  if (posterUrl) {
    $('event-poster-preview').src = posterUrl.startsWith('data:') || /^https?:\/\//i.test(posterUrl)
      ? posterUrl
      : `/api/events/${event.id}/poster`;
    $('poster-preview-wrap').hidden = false;
  } else {
    $('poster-preview-wrap').hidden = true;
    $('event-poster-preview').src = '';
  }
  updateEventPricingFields();
  form.dataset.requiresStart = String(!event || Boolean(event.starts_at));
  fillDateTime('event-jalali-date', 'event-start-time', event?.starts_at);
  fillDateTime('event-end-date', 'event-end-time', event?.ends_at);
  fillDateTime('questions-date', 'questions-time', event?.questions_closes_at * 1000);
  $('questions-enabled').checked = yes(event?.questions_enabled);
  $('questions-max').value = event?.questions_max ?? 3;
  toggleQuestionFields();
  form.dataset.questionFields = JSON.stringify(readQuestionFields());
  form.hidden = false; form.scrollIntoView({ behavior: 'smooth', block: 'start' }); form.elements.namedItem('name').focus();
}
function updateEventPricingFields() {
  const differentiated = $('event-pricing-mode').value === 'differentiated';
  $('fixed-price-fields').hidden = differentiated;
  $('differentiated-price-fields').hidden = !differentiated;
  $('is-paid-label').hidden = differentiated;
  $('fixed-price-fields').querySelectorAll('input').forEach((input) => { input.disabled = differentiated; });
  $('differentiated-price-fields').querySelectorAll('input').forEach((input) => { input.disabled = !differentiated; });
}
function showPlaces() {
  table($('places-list'), ['مکان', 'نشانی', 'نشان', 'ظرفیت', 'مدیریت'], state.places.map((place) => {
    const actions = el('div', null, 'actions');
    actions.append(button('ویرایش', () => { const form = $('place-form'); ['id', 'name', 'capacity', 'address', 'map_url'].forEach((key) => { form.elements.namedItem(key).value = place[key] ?? ''; }); $('place-form-title').textContent = 'ویرایش مکان'; form.scrollIntoView({ behavior: 'smooth' }); form.elements.namedItem('name').focus(); }), button('حذف', async () => { if (!confirm('این مکان حذف شود؟')) return; await api('/api/places/' + encodeURIComponent(place.id), { method: 'DELETE' }); await load(); }, 'button danger small'));
    const map = place.map_url ? el('a', 'باز کردن در نشان', 'receipt-link') : el('span', '—');
    if (place.map_url) { map.href = place.map_url; map.target = '_blank'; map.rel = 'noopener noreferrer'; }
    return [place.name, el('span', place.address || '', 'description'), map, number(place.capacity), actions];
  }));
}
async function showOrders() {
  const data = array(await api(query('/api/orders', { status: $('order-status').value, eventId: $('orders-event').value, limit: 50, offset: state.pages.orders * 50 })), 'orders');
  const tariff = order => order.pricing_group === 'fum_student' ? 'فردوسی (خوداظهاری)' : order.pricing_group === 'general' ? 'عموم' : 'یکسان برای همه';
  table($('orders-list'), ['سفارش', 'شرکت‌کننده', 'رویداد', 'تعداد', 'گروه تعرفه', 'مبلغ به تومان', 'وضعیت', 'بررسی'], data.map((order) => {
    const actions = el('div', null, 'actions');
    if (order.receipt_file_id) actions.append(link('مشاهده رسید', '/api/orders/' + encodeURIComponent(order.id) + '/receipt', 'button secondary small', true));
    if (order.status === 'pending') {
      [true, false].forEach((approve) => actions.append(button(approve ? 'تأیید پرداخت' : 'رد پرداخت', async () => {
        if (!confirm(approve ? 'واریز این مبلغ را در حساب مقصد بررسی کرده‌اید و پرداخت تأیید شود؟' : 'رسید این سفارش رد شود؟')) return;
        await api('/api/orders/' + encodeURIComponent(order.id) + '/review', { method: 'POST', body: { approve } }); await load(); toast(approve ? 'پرداخت تأیید شد' : 'پرداخت رد شد');
      }, approve ? 'button small' : 'button danger small')));
    }
    return [order.id, person(order), eventName(order), number(order.quantity), tariff(order), number(Number(order.quantity) * Number(order.unit_price)), badge(order.status), actions];
  }));
  pager($('orders-list'), 'orders', data.length);
}
async function showTickets() {
  const eventId = $('tickets-event').value;
  $('export-tickets').href = query('/api/export/tickets', { eventId });
  $('print-tickets').href = query('/api/print', { eventId });
  const data = array(await api(query('/api/tickets', { eventId, limit: 50, offset: state.pages.tickets * 50 })), 'tickets');
  table($('tickets-list'), ['بلیت', 'شرکت‌کننده', 'رویداد', 'وضعیت', 'زمان ورود', 'پذیرش'], data.map((ticket) => {
    const token = ticket.token || ticket.checkin_token || ticket.qr_token;
    const actions = el('div', null, 'actions');
    if (token && !ticket.checked_in_at && !ticket.attended_at && ticket.status !== 'attended') actions.append(button('ثبت ورود', async () => { await navigate('checkin'); $('checkin-token').value = token; $('checkin-token').focus(); }));
    return [ticketCode(ticket.checkin_code) || ticket.id, person(ticket), eventName(ticket), badge(ticket.status || (ticket.checked_in_at ? 'attended' : 'issued')), ticket.checked_in_at || ticket.attended_at ? date(ticket.checked_in_at || ticket.attended_at) : 'هنوز وارد نشده', actions];
  }));
  pager($('tickets-list'), 'tickets', data.length);
}
async function showUsers() {
  const data = array(await api(query('/api/users', { limit: 50, offset: state.pages.users * 50, search: $('users-search').value.trim(), audienceKey: $('users-event').value })), 'users');
  table($('users-list'), ['نام', 'شناسه تلگرام', 'نام کاربری', 'شماره تماس', 'رویدادهای مرتبط', 'ثبت‌نام'], data.map((user) => [person(user), el('span', user.telegram_id || user.user_id || user.id, 'mono'), user.username ? '@' + user.username : '—', user.phone || '—', userEventLabels(user.event_names), date(user.created_at)]));
  pager($('users-list'), 'users', data.length);
}
async function showAdmins() {
  const data = await api('/api/admins');
  table($('admins-list'), ['شناسه تلگرام', 'نقش', 'مدیریت'], array(data, 'admins').map((admin) => {
    const actions = el('div', null, 'actions');
    if (admin.role !== 'owner') actions.append(button('حذف دسترسی', async () => { if (!confirm('دسترسی این مدیر حذف شود؟')) return; await api('/api/admins/' + encodeURIComponent(admin.user_id), { method: 'DELETE' }); await load(); toast('دسترسی حذف شد'); }, 'button danger small'));
    return [el('span', admin.user_id, 'mono'), roleNames[admin.role] || admin.role, actions];
  }));
}
async function load() {
  const id = ++state.loading;
  $('loading').hidden = false; $('page-error').hidden = true;
  try {
    if (state.me.role !== 'checkin' && !['checkin', 'settings'].includes(state.view)) await catalogs();
    switch (state.view) {
      case 'overview': await showOverview(); break;
      case 'events': showEvents(); break;
      case 'places': showPlaces(); break;
      case 'orders': await showOrders(); break;
      case 'tickets': await showTickets(); break;
      case 'users': await showUsers(); break;
      case 'admins': await showAdmins(); break;
    }
  } catch (error) {
    if (id === state.loading) { $('page-error').textContent = error.message; $('page-error').hidden = false; }
  } finally { if (id === state.loading) $('loading').hidden = true; }
}
async function navigate(view) {
  if (!titles[view]) view = 'overview';
  if (state.me.role === 'checkin') view = 'checkin';
  if (view === 'admins' && state.me.role !== 'owner') view = 'overview';
  stopCamera(); state.view = view;
  document.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
  document.querySelectorAll('[data-view]').forEach((item) => { const active = item.dataset.view === view; item.classList.toggle('active', active); if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
  $('page-title').textContent = titles[view];
  await load();
}
function showLogin(message) {
  stopCamera();
  for (const id of ['jalali-dialog', 'time-dialog', 'questions-dialog']) if ($(id).open) $(id).close();
  $('app').hidden = true; $('login').hidden = false; $('login-message').textContent = message;
}
async function session() {
  $('login-message').textContent = 'در حال بررسی ورود شما';
  try {
    state.me = await api('/api/me');
    if (!roleNames[state.me.role]) throw new Error('این حساب دسترسی مدیریت ندارد');
    $('identity').textContent = roleNames[state.me.role] + ' · ' + state.me.user_id;
    document.querySelectorAll('[data-view]').forEach((node) => { node.hidden = (state.me.role === 'checkin' && node.dataset.view !== 'checkin') || (node.dataset.view === 'admins' && state.me.role !== 'owner'); });
    $('login').hidden = true; $('app').hidden = false;
    await navigate(state.me.role === 'checkin' ? 'checkin' : state.view);
    return true;
  } catch (error) { showLogin(error.message || 'برای ورود یک لینک جدید از ربات بگیرید'); return false; }
}
function extractToken(value) {
  const raw = String(value || '').trim();
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new Error('لینک بلیت معتبر نیست'); }
    const hash = new URLSearchParams(url.hash.slice(1));
    if (hash.has('ticket')) return hash.get('ticket');
    const match = url.pathname.match(/\/ticket\/([^/]+)\/?$/);
    if (match) return decodeURIComponent(match[1]);
    throw new Error('کد بلیت در این لینک پیدا نشد');
  }
  if (!raw || raw.length > 256 || /\s/.test(raw)) throw new Error('کد بلیت معتبر نیست');
  return raw;
}
async function checkin() {
  const result = $('checkin-result');
  try {
    const token = extractToken($('checkin-token').value);
    const data = await api('/api/check-in', { method: 'POST', body: { token } });
    const ticket = data.ticket || data;
    result.className = 'panel scan-result success';
    result.replaceChildren(el('span', '✓', 'scan-symbol'), el('h2', data.already_checked_in || data.already ? 'ورود قبلا ثبت شده' : 'ورود ثبت شد'), el('p', person(ticket)), el('p', eventName(ticket)), el('p', ticket.code ? 'کد بلیت ' + ticket.code : 'بلیت معتبر است'));
    $('checkin-token').value = ''; $('checkin-token').focus();
  } catch (error) {
    result.className = 'panel scan-result failure'; result.replaceChildren(el('span', '×', 'scan-symbol'), el('h2', 'ورود ثبت نشد'), el('p', error.message));
  }
}
function stopCamera() {
  clearTimeout(state.timer); state.timer = null;
  if (state.camera) state.camera.getTracks().forEach((track) => track.stop());
  state.camera = null;
  if ($('camera')) { $('camera').srcObject = null; $('camera').hidden = true; $('camera-stop').hidden = true; $('camera-start').hidden = false; }
}
async function startCamera() {
  $('camera-message').textContent = '';
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) { $('camera-message').textContent = 'اسکن در این مرورگر در دسترس نیست کد یا لینک بلیت را دستی وارد کنید'; return; }
  try {
    const supported = await BarcodeDetector.getSupportedFormats();
    if (!supported.includes('qr_code')) throw new Error('QR در این مرورگر پشتیبانی نمی‌شود کد را دستی وارد کنید');
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    state.camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (state.view !== 'checkin') { stopCamera(); return; }
    const video = $('camera'); video.srcObject = state.camera; video.hidden = false; $('camera-stop').hidden = false; $('camera-start').hidden = true; await video.play();
    const scan = async () => {
      if (!state.camera) return;
      try {
        const codes = video.readyState >= 2 ? await detector.detect(video) : [];
        if (codes.length) { $('checkin-token').value = codes[0].rawValue; stopCamera(); await action($('checkin-form').querySelector('[type=submit]'), checkin); return; }
      } catch { /* A frame can be unavailable during camera initialization. */ }
      if (state.camera) state.timer = setTimeout(scan, 250);
    };
    scan();
  } catch (error) { stopCamera(); $('camera-message').textContent = error.name === 'NotAllowedError' ? 'دسترسی دوربین داده نشد می‌توانید کد را دستی وارد کنید' : error.message || 'دوربین در دسترس نیست کد را دستی وارد کنید'; }
}

document.querySelectorAll('[data-view]').forEach((node) => node.addEventListener('click', () => navigate(node.dataset.view)));
document.querySelectorAll('[data-go]').forEach((node) => node.addEventListener('click', () => navigate(node.dataset.go)));
$('refresh').addEventListener('click', () => action($('refresh'), load));
$('retry-session').addEventListener('click', () => action($('retry-session'), session));
$('logout').addEventListener('click', () => action($('logout'), async () => { await api('/api/logout', { method: 'POST' }); state.me = null; showLogin('از حساب خارج شدید برای ورود دوباره لینک تازه بگیرید'); }));
$('new-event').addEventListener('click', () => editEvent());
$('cancel-event').addEventListener('click', () => { $('event-form').hidden = true; });
$('questions-enabled').addEventListener('change', toggleQuestionFields);
$('questions-filter').addEventListener('change', () => questionFeedback(() => loadEventQuestions($('questions-dialog').dataset.eventId)));
connectPicker('event-jalali-date', 'jalali-open', openJalaliCalendar);
connectPicker('event-start-time', 'time-open', openTimePicker);
connectPicker('event-end-date', 'end-date-open', openJalaliCalendar);
connectPicker('event-end-time', 'end-time-open', openTimePicker);
$('event-end-clear').addEventListener('click', () => fillDateTime('event-end-date', 'event-end-time'));
connectPicker('questions-date', 'questions-date-open', openJalaliCalendar);
connectPicker('questions-time', 'questions-time-open', openTimePicker);
$('time-confirm').addEventListener('click', chooseTime);
$('time-cancel').addEventListener('click', () => $('time-dialog').close());
$('time-dialog').addEventListener('click', (event) => { if (event.target === $('time-dialog')) $('time-dialog').close(); });
$('jalali-prev').addEventListener('click', () => shiftJalaliMonth(-1));
$('jalali-next').addEventListener('click', () => shiftJalaliMonth(1));
$('jalali-year').addEventListener('change', (event) => { calendar.year = Number(event.currentTarget.value); renderJalaliCalendar(); });
$('jalali-month').addEventListener('change', (event) => { calendar.month = Number(event.currentTarget.value); renderJalaliCalendar(); });
$('jalali-day').addEventListener('change', (event) => { calendar.day = Number(event.currentTarget.value); renderJalaliCalendar(); });
$('jalali-confirm').addEventListener('click', () => chooseJalaliDate(calendar.day));
$('jalali-today').addEventListener('click', () => { const today = tehranDateTime(); calendar.year = today.year; calendar.month = today.month; calendar.day = today.day; chooseJalaliDate(today.day); });
$('jalali-close').addEventListener('click', () => $('jalali-dialog').close());
$('jalali-dialog').addEventListener('click', (event) => { if (event.target === $('jalali-dialog')) $('jalali-dialog').close(); });
$('jalali-dialog').addEventListener('keydown', (event) => {
  const current = document.activeElement?.dataset?.day;
  if (!current) return;
  const step = { ArrowLeft: 1, ArrowRight: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
  if (step === undefined) return;
  event.preventDefault();
  const next = Number(current) + step, length = jalaliMonthLength(calendar.year, calendar.month);
  if (next < 1) {
    const previousYear = calendar.month === 1 ? calendar.year - 1 : calendar.year;
    const previousMonth = calendar.month === 1 ? 12 : calendar.month - 1;
    if (previousYear >= 1200) shiftJalaliMonth(-1, jalaliMonthLength(previousYear, previousMonth) + next);
  }
  else if (next > length) shiftJalaliMonth(1, next - length);
  else { calendar.day = next; renderJalaliCalendar(next); }
});
$('event-form').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
  action(event.submitter, async () => {
    const id = values.get('id');
    const startDay = values.get('starts_at_jalali');
    const startTime = values.get('starts_at_time');
    const startsAt = form.dataset.requiresStart === 'true' || startDay || startTime
      ? jalaliTimeToIso(parseJalaliDate(startDay), startTime)
      : '';
    const endDay = values.get('ends_at_jalali');
    const endTime = values.get('ends_at_time');
    if (endDay && !endTime) throw new Error('ساعت پایان را انتخاب کنید');
    if (endTime && !startsAt) throw new Error('برای ثبت زمان پایان، زمان شروع را هم مشخص کنید');
    const endsAt = endTime ? jalaliTimeToIso(parseJalaliDate(endDay || startDay), endTime) : '';
    const pricingMode = values.get('pricing_mode') || 'fixed';
    const fixedPaid = values.has('is_paid');
    const publicPrice = pricingMode === 'differentiated' ? Number(values.get('public_price')) : fixedPaid ? Number(values.get('price')) : 0;
    const studentPrice = pricingMode === 'differentiated' ? Number(values.get('fum_student_price')) : 0;
    const isPaid = pricingMode === 'differentiated' ? publicPrice > 0 || studentPrice > 0 : fixedPaid;
    const posterUrl = values.get('poster_url') || '';
    const body = { name: values.get('name').trim(), description: values.get('description').trim(), place_id: values.get('place_id') ? Number(values.get('place_id')) : null, capacity: Number(values.get('capacity')), max_per_user: Number(values.get('max_per_user')), price: publicPrice, fum_student_price: studentPrice, pricing_mode: pricingMode, poster_url: posterUrl, payment_instructions: values.get('payment_instructions').trim(), starts_at: startsAt, ends_at: endsAt, is_paid: isPaid, active: values.has('active') };
    const questionFields = readQuestionFields();
    if (JSON.stringify(questionFields) !== form.dataset.questionFields) {
      const { enabled, day, time, maxQuestions } = questionFields;
      if (enabled && !day) throw new Error('تاریخ پایان دریافت سؤال را انتخاب کنید');
      const closesAt = day ? Date.parse(jalaliTimeToIso(parseJalaliDate(day), time || '23:59')) / 1000 : null;
      body.question_settings = { enabled, closes_at: closesAt, max_questions: maxQuestions };
    }
    await api('/api/events' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PATCH' : 'POST', body });
    form.hidden = true; await load(); toast('رویداد ذخیره شد');
  });
});
$('event-pricing-mode').addEventListener('change', updateEventPricingFields);
$('event-poster-file').addEventListener('change', () => {
  const file = $('event-poster-file').files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1200;
      let w = img.width, h = img.height;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
        else { w = Math.round((w * maxDim) / h); h = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      $('event-poster-url').value = dataUrl;
      $('event-poster-url-input').value = '';
      $('event-poster-preview').src = dataUrl;
      $('poster-preview-wrap').hidden = false;
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
});
$('event-poster-url-input').addEventListener('input', () => {
  const val = $('event-poster-url-input').value.trim();
  if (val) {
    $('event-poster-url').value = val;
    $('event-poster-file').value = '';
    $('event-poster-preview').src = val;
    $('poster-preview-wrap').hidden = false;
  } else if (!$('event-poster-file').files?.length) {
    $('event-poster-url').value = '';
    $('poster-preview-wrap').hidden = true;
    $('event-poster-preview').src = '';
  }
});
$('event-poster-remove').addEventListener('click', () => {
  $('event-poster-url').value = '';
  $('event-poster-url-input').value = '';
  $('event-poster-file').value = '';
  $('poster-preview-wrap').hidden = true;
  $('event-poster-preview').src = '';
});
$('place-form').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  action(event.submitter, async () => { const id = data.get('id'); await api('/api/places' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PATCH' : 'POST', body: { name: data.get('name').trim(), address: data.get('address').trim(), map_url: data.get('map_url').trim(), capacity: Number(data.get('capacity')) } }); form.reset(); form.elements.namedItem('id').value = ''; $('place-form-title').textContent = 'افزودن مکان'; await load(); toast('مکان ذخیره شد'); });
});
$('reset-place').addEventListener('click', () => { $('place-form').reset(); $('place-form').elements.namedItem('id').value = ''; $('place-form-title').textContent = 'افزودن مکان'; });
['order-status', 'orders-event', 'tickets-event'].forEach((id) => $(id).addEventListener('change', () => { state.pages[id === 'tickets-event' ? 'tickets' : 'orders'] = 0; load(); }));
$('users-search').addEventListener('input', () => {
  clearTimeout(userSearchTimer); state.pages.users = 0;
  userSearchTimer = setTimeout(() => { if (state.view === 'users') load(); }, 300);
});
$('users-event').addEventListener('change', () => { state.pages.users = 0; load(); });
$('print-tickets').addEventListener('click', (event) => { if (!$('tickets-event').value) { event.preventDefault(); toast('برای چاپ ابتدا یک رویداد را انتخاب کنید'); } });
$('checkin-form').addEventListener('submit', (event) => { event.preventDefault(); stopCamera(); action(event.submitter, checkin); });
$('camera-start').addEventListener('click', () => action($('camera-start'), startCamera));
$('camera-stop').addEventListener('click', stopCamera);
$('broadcast-form').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  action(event.submitter, async () => { const body = { text: data.get('text').trim() }; if (data.get('audience_key')) body.audience_key = data.get('audience_key'); const result = await api('/api/broadcast', { method: 'POST', body }); const count = typeof result.queued === 'number' ? result.queued : result.count; $('broadcast-result').textContent = count !== undefined ? 'پیام برای ' + number(count) + ' دریافت‌کننده در صف قرار گرفت' : 'درخواست ارسال ثبت شد پیام‌ها به تدریج از صف ارسال می‌شوند'; form.elements.namedItem('confirm').checked = false; toast('پیام در صف ارسال قرار گرفت'); });
});
$('admin-form').addEventListener('submit', (event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); action(event.submitter, async () => { await api('/api/admins', { method: 'POST', body: { user_id: Number(data.get('user_id')), role: data.get('role') } }); form.reset(); await load(); toast('دسترسی ثبت شد'); }); });
$('expire').addEventListener('click', () => action($('expire'), async () => { const result = await api('/api/expire', { method: 'POST' }); $('expire-result').textContent = 'پاکسازی انجام شد' + (result.expired !== undefined ? ' تعداد رزرو آزادشده ' + number(result.expired) : ''); toast('رزروهای منقضی بررسی شدند'); }));
window.addEventListener('pagehide', stopCamera);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });

async function start() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const loginToken = fragment.get('login');
  const ticket = fragment.get('ticket');
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (loginToken) {
    try { await api('/api/session', { method: 'POST', body: { token: loginToken } }); }
    catch (error) { showLogin(error.message + ' یک لینک ورود جدید از ربات بگیرید'); return; }
  }
  if (ticket) state.view = 'checkin';
  const loggedIn = await session();
  if (loggedIn && ticket) { $('checkin-token').value = ticket; $('checkin-token').focus(); }
}
start();
