import { configuredStudentNumberLength, normalizeDigits, resolveEventPricing } from './pricing.js';

export const SUPPORT_CONTACT = 'به اکانت پشتیبانی انجمن رباتیک دانشگاه فردوسی مشهد @FUMrs_admin پیام بدهید.';
export const SUPPORT_STATUSES = { new: 'جدید', in_review: 'در حال بررسی', waiting_user: 'منتظر پاسخ شما', closed: 'بسته' };
const SUPPORT_TICKET = `SELECT s.*, o.user_id, o.status AS order_status, o.quantity, o.unit_price,
  e.name AS event_name, u.first_name, u.last_name
  FROM support_tickets s JOIN orders o ON o.id=s.order_id JOIN events e ON e.id=o.event_id
  JOIN users u ON u.id=o.user_id`;

const OCCUPIED = "(status='approved' OR (status IN ('reserved','pending') AND expires_at>unixepoch()))";
const REGISTRATION_OPEN = 'e.archived=0 AND e.active=1 AND (e.registration_closes_at IS NULL OR e.registration_closes_at>unixepoch())';
const QUESTIONS_OPEN = 'e.archived=0 AND s.enabled=1 AND s.closes_at>unixepoch()';
const QUESTION_WINDOW = `EXISTS (
  SELECT 1 FROM event_question_settings s WHERE s.event_id=e.id AND ${QUESTIONS_OPEN}
)`;
const QUESTION_ACCESS = `FROM events e JOIN event_question_settings s ON s.event_id=e.id
  JOIN users u ON u.id=? AND u.is_deleted=0
  WHERE e.id=? AND ${QUESTIONS_OPEN} AND EXISTS (
    SELECT 1 FROM orders o WHERE o.event_id=e.id AND o.user_id=u.id AND o.status='approved'
  )`;
const QUESTIONS_USED = '(SELECT COUNT(*) FROM event_questions q WHERE q.event_id=e.id AND q.user_id=u.id)';
const TEST_EVENT_NAME = /(?:^|[^\p{L}\p{N}])(?:test(?:ing)?|demo|sample|تست(?:ی)?|آزمایش(?:ی)?|نمونه(?:ی)?)(?=$|[^\p{L}\p{N}])/iu;
const ERRORS = {
  EVENT_FULL: 'ظرفیت رویداد تکمیل شده است',
  USER_LIMIT: 'تعداد بلیت از سقف مجاز هر نفر بیشتر است',
  CAPACITY_BELOW_RESERVED: 'ظرفیت نمیتواند از تعداد بلیتهای رزرو شده کمتر باشد',
  USER_LIMIT_BELOW_RESERVED: 'سقف هر نفر نمیتواند از خریدهای قبلی کمتر باشد',
  STUDENT_PROFILE_INCOMPLETE: 'برای محاسبه تعرفه دانشجویی، شماره دانشجویی را در اطلاعات حساب تکمیل کنید',
  PRICE_CHANGED: 'تعرفه این رویداد از زمان نمایش خلاصه سفارش تغییر کرده است؛ مبلغ جدید را بررسی کنید',
  QUESTION_UNAVAILABLE: 'ارسال سؤال برای این رویداد بسته است یا ثبت‌نام شما در آن تأیید نشده است',
  QUESTION_LIMIT: 'به سقف تعداد سؤال‌های این رویداد رسیده‌اید',
};

export function domainError(code, message) {
  return Object.assign(new Error(message || ERRORS[code] || 'امکان انجام این عملیات وجود ندارد'), { code });
}
const parse = (value) => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const userRow = (row) => row ? { ...row, profile: parse(row.profile_json) } : null;
function randomCheckinCode() {
  const value = new Uint32Array(1);
  const range = 90_000_000;
  const limit = Math.floor(0x100000000 / range) * range;
  do { crypto.getRandomValues(value); } while (value[0] >= limit);
  return String(10_000_000 + (value[0] % range));
}
function ticketBatch(quantity) {
  const used = new Set();
  return Array.from({ length: quantity }, () => {
    let checkin_code;
    do { checkin_code = randomCheckinCode(); } while (used.has(checkin_code));
    used.add(checkin_code);
    return { id: crypto.randomUUID(), token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''), checkin_code };
  });
}
function audienceKey(value) {
  const match = /^(current|legacy):([1-9]\d*)$/.exec(String(value || ''));
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { kind: match[1], id: Number(match[2]) };
}
const int = (v, name, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw domainError('INVALID_INPUT', `${name} معتبر نیست`);
  return n;
};
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
function questionSettingsValues(data) {
  if (typeof data?.enabled !== 'boolean') throw domainError('INVALID_INPUT', 'وضعیت دریافت سؤال را مشخص کنید');
  const closesAt = data.closes_at == null ? null : int(data.closes_at, 'مهلت ارسال سؤال', 253402300799);
  const maxQuestions = data.max_questions == null ? null : int(data.max_questions, 'سقف سؤال هر نفر', 3);
  if (data.enabled && (!closesAt || closesAt <= Math.floor(Date.now() / 1000))) {
    throw domainError('INVALID_INPUT', 'برای فعال کردن دریافت سؤال، مهلتی در آینده انتخاب کنید');
  }
  return [Number(data.enabled), closesAt, maxQuestions];
}
const string = (v, name, max, required = false) => {
  if (v != null && typeof v !== 'string') throw domainError('INVALID_INPUT', `${name} معتبر نیست`);
  const result = (v || '').trim();
  if ((required && !result) || result.length > max) throw domainError('INVALID_INPUT', `${name} معتبر نیست`);
  return result;
};
export function neshanUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || !(
      host === 'neshan.org' || host.endsWith('.neshan.org') ||
      host === 'nshn.ir' || host.endsWith('.nshn.ir')
    )) return '';
    return url.href;
  } catch { return ''; }
}
const paging = (limit, offset) => [Math.min(int(limit, 'تعداد', 1000), 1000), Math.max(0, Number.isSafeInteger(Number(offset)) ? Number(offset) : 0)];
const mapDbError = (e) => {
  for (const code of Object.keys(ERRORS).sort((a, b) => b.length - a.length)) if (String(e.message).includes(code)) return domainError(code);
  return e;
};

export class Store {
  constructor(db) { this.db = db; }
  stmt(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  async one(sql, ...args) { return this.stmt(sql, ...args).first(); }
  async all(sql, ...args) { return (await this.stmt(sql, ...args).all()).results || []; }
  async run(sql, ...args) { try { return await this.stmt(sql, ...args).run(); } catch (e) { throw mapDbError(e); } }

  async getUser(id) { return userRow(await this.one('SELECT * FROM users WHERE id=? AND is_deleted=0', Number(id))); }
  async upsertUser(data) {
    const id = int(data.id, 'شناسه کاربر');
    const old = await this.getUser(id);
    const merged = { ...(old || {}), ...data };
    const profile = { ...(old?.profile || {}), ...(data.profile || {}) };
    if (profile.student_number != null) profile.student_number = String(normalizeDigits(profile.student_number)).trim();
    const json = JSON.stringify(profile);
    if (json.length > 20000) throw domainError('INVALID_INPUT', 'اطلاعات حساب بیش از حد طولانی است');
    await this.run(`INSERT INTO users(id,username,first_name,last_name,phone,profile_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,
      last_name=excluded.last_name,phone=excluded.phone,profile_json=excluded.profile_json,is_deleted=0,updated_at=unixepoch()`,
      id, string(merged.username, 'نام کاربری', 64), string(merged.first_name, 'نام', 100),
      string(merged.last_name, 'نام خانوادگی', 100), string(merged.phone, 'تلفن', 30), json);
    return this.getUser(id);
  }
  async deleteUser(id) {
    await this.db.batch([
      this.stmt("UPDATE users SET username='',first_name='کاربر حذف شده',last_name='',phone='',profile_json='{}',is_deleted=1,updated_at=unixepoch() WHERE id=?", Number(id)),
      this.stmt('DELETE FROM conversation_states WHERE user_id=?', Number(id)),
    ]);
    return { deleted: true };
  }
  async listUsers({ limit = 100, offset = 0, search = '', audienceKey: selectedAudience = '', confirmedOnly = false } = {}) {
    const where = ['u.is_deleted=0'], values = [];
    const term = normalizeDigits(string(search, 'جستجو', 100)).replace(/^@/, '').toLowerCase();
    if (term) {
      const pattern = `%${term}%`;
      const fields = [
        'CAST(u.id AS TEXT)', 'LOWER(u.username)', 'LOWER(u.first_name)', 'LOWER(u.last_name)',
        "LOWER(u.first_name || ' ' || u.last_name)", 'u.phone',
        "CAST(json_extract(u.profile_json,'$.student_number') AS TEXT)",
        "LOWER(json_extract(u.profile_json,'$.student_major'))",
        "LOWER(json_extract(u.profile_json,'$.fum_faculty'))",
        "LOWER(json_extract(u.profile_json,'$.university_name'))",
      ];
      where.push(`(${fields.map(field => `${field} LIKE ?`).join(' OR ')})`);
      values.push(...fields.map(() => pattern));
      const numeric = term.replace(/\D/g, '');
      if (numeric) {
        where.push("(CAST(u.id AS TEXT) LIKE ? OR replace(replace(replace(u.phone,'+',''),' ',''),'-','') LIKE ? OR ('0' || substr(replace(u.phone,'+',''),3)) LIKE ?)");
        values.push(`%${numeric}%`, `%${numeric}%`, `%${numeric}%`);
      }
    }
    if (confirmedOnly && selectedAudience === 'no-event') throw domainError('INVALID_INPUT', 'برای خروجی قطعی یک رویداد یا همهٔ رویدادها را انتخاب کنید');
    if (selectedAudience === 'no-event') {
      where.push(`NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.status='approved')
        AND NOT EXISTS (SELECT 1 FROM legacy_event_participants ep WHERE ep.user_id=u.id)`);
    } else if (selectedAudience) {
      const selected = audienceKey(selectedAudience);
      if (!selected) throw domainError('INVALID_INPUT', 'دسته رویداد معتبر نیست');
      if (selected.kind === 'legacy') {
        where.push(`EXISTS (SELECT 1 FROM legacy_event_participants ep WHERE ep.legacy_event_id=? AND ep.user_id=u.id)`);
      } else {
        where.push(`EXISTS (SELECT 1 FROM orders o WHERE o.event_id=? AND o.user_id=u.id AND o.status='approved')`);
      }
      values.push(selected.id);
    } else if (confirmedOnly) {
      where.push(`(EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.status='approved')
        OR EXISTS (SELECT 1 FROM legacy_event_participants ep WHERE ep.user_id=u.id))`);
    }
    if (confirmedOnly) {
      return this.all(`SELECT u.id,u.first_name,u.last_name,u.username,u.phone
        FROM users u WHERE ${where.join(' AND ')} ORDER BY u.created_at DESC,u.id LIMIT ? OFFSET ?`,
        ...values, ...paging(limit, offset));
    }
    const eventNames = `(
      SELECT GROUP_CONCAT(label, '، ') FROM (
        SELECT DISTINCT e.name AS label FROM orders o JOIN events e ON e.id=o.event_id
        WHERE o.user_id=u.id AND o.status='approved'
        UNION
        SELECT DISTINCT le.name AS label FROM legacy_event_participants ep
        JOIN legacy_events le ON le.id=ep.legacy_event_id WHERE ep.user_id=u.id
      )`;
    return (await this.all(`SELECT u.*,${eventNames}) AS event_names
      FROM users u WHERE ${where.join(' AND ')}
      ORDER BY u.created_at DESC,u.id LIMIT ? OFFSET ?`, ...values, ...paging(limit, offset))).map(userRow);
  }
  async listAudienceEvents({ limit = 1000, offset = 0 } = {}) {
    const events = await this.all(`SELECT audience_key,id,name,kind,participant_count FROM (
      SELECT 'current:' || e.id AS audience_key,e.id,e.name,'current' AS kind,
        (SELECT COUNT(DISTINCT o.user_id) FROM orders o JOIN users u ON u.id=o.user_id
          WHERE o.event_id=e.id AND o.status='approved' AND u.phone<>'') AS participant_count
      FROM events e WHERE e.archived=0
      UNION ALL
      SELECT 'legacy:' || le.id,le.id,le.name,'legacy',
        (SELECT COUNT(DISTINCT ep.user_id) FROM legacy_event_participants ep JOIN users u ON u.id=ep.user_id
          WHERE ep.legacy_event_id=le.id AND u.phone<>'')
      FROM legacy_events le
    ) ORDER BY kind,id DESC LIMIT ? OFFSET ?`, ...paging(limit, offset));
    return events.map(event => ({ ...event, is_test: TEST_EVENT_NAME.test(String(event.name || '')) }));
  }
  async getAudienceEvent(key) {
    const selected = audienceKey(key);
    if (!selected) return null;
    return selected.kind === 'legacy'
      ? this.one('SELECT id,name FROM legacy_events WHERE id=?', selected.id)
      : this.one('SELECT id,name FROM events WHERE id=? AND archived=0', selected.id);
  }
  async getState(userId) {
    const row = await this.one('SELECT * FROM conversation_states WHERE user_id=?', Number(userId));
    return row ? { ...row, data: parse(row.data_json) } : null;
  }
  async setState(userId, step, data = {}) {
    await this.run(`INSERT INTO conversation_states(user_id,step,data_json) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET step=excluded.step,data_json=excluded.data_json,updated_at=unixepoch()`,
      int(userId, 'شناسه کاربر'), string(step, 'مرحله', 100, true), JSON.stringify(data));
  }
  async clearState(userId) { await this.run('DELETE FROM conversation_states WHERE user_id=?', Number(userId)); }

  async listPlaces() { return this.all('SELECT * FROM places ORDER BY id DESC'); }
  async savePlace(data, id = null) {
    const old = id ? await this.one('SELECT * FROM places WHERE id=?', int(id, 'شناسه مکان')) : null;
    if (id && !old) throw domainError('NOT_FOUND', 'مکان پیدا نشد');
    const v = { ...(old || {}), ...data };
    const rawMapUrl = string(v.map_url, 'لینک نشان', 1000);
    const mapUrl = neshanUrl(rawMapUrl);
    if (rawMapUrl && !mapUrl) throw domainError('INVALID_INPUT', 'لینک نشان باید HTTPS و متعلق به نشان باشد');
    const values = [string(v.name, 'نام مکان', 200, true), string(v.address, 'نشانی', 1000), int(v.capacity, 'ظرفیت', 1000000), mapUrl];
    if (id) await this.run('UPDATE places SET name=?,address=?,capacity=?,map_url=? WHERE id=?', ...values, Number(id));
    else {
      const r = await this.run('INSERT INTO places(name,address,capacity,map_url) VALUES(?,?,?,?)', ...values);
      id = r.meta.last_row_id;
    }
    return this.one('SELECT * FROM places WHERE id=?', Number(id));
  }
  async deletePlace(id) {
    try { await this.run('DELETE FROM places WHERE id=?', int(id, 'شناسه مکان')); }
    catch (e) {
      if (String(e.message).includes('FOREIGN KEY')) throw domainError('PLACE_IN_USE', 'این مکان برای یک رویداد استفاده شده است');
      throw e;
    }
    return { deleted: true };
  }
  eventSelect() {
    return `SELECT e.*,p.name AS place_name,p.address AS place_address,p.map_url AS place_map_url,
      (${REGISTRATION_OPEN}) AS registration_open,
      ${QUESTION_WINDOW} AS questions_open,
      COALESCE((SELECT SUM(quantity) FROM orders WHERE event_id=e.id AND ${OCCUPIED}),0) AS occupied,
      e.capacity-COALESCE((SELECT SUM(quantity) FROM orders WHERE event_id=e.id AND ${OCCUPIED}),0) AS remaining
      FROM events e LEFT JOIN places p ON p.id=e.place_id`;
  }
  async listEvents({ activeOnly = false, limit = 100, offset = 0 } = {}) {
    return this.all(`${this.eventSelect()} WHERE ${activeOnly ? REGISTRATION_OPEN : 'e.archived=0'} ORDER BY e.id DESC LIMIT ? OFFSET ?`, ...paging(limit, offset));
  }
  async listEventsWithRegistrationStats({ limit = 100, offset = 0 } = {}) {
    return this.all(`WITH page AS (
      SELECT * FROM events WHERE archived=0 ORDER BY id DESC LIMIT ? OFFSET ?
    ), reservations AS (
      SELECT o.event_id, SUM(o.quantity) AS occupied,
        SUM(CASE WHEN o.status='approved' THEN o.quantity ELSE 0 END) AS approved_tickets,
        COUNT(DISTINCT CASE WHEN o.status='approved' THEN o.user_id END) AS registered_users
      FROM page e JOIN orders o ON o.event_id=e.id
      WHERE ${OCCUPIED}
      GROUP BY o.event_id
    ), attendance AS (
      SELECT o.event_id, COUNT(*) AS checked_in_tickets
      FROM page e JOIN orders o ON o.event_id=e.id
      JOIN tickets t ON t.order_id=o.id
      WHERE o.status='approved' AND t.checked_in_at IS NOT NULL
      GROUP BY o.event_id
    )
    SELECT e.*,p.name AS place_name,p.address AS place_address,p.map_url AS place_map_url,
      (${REGISTRATION_OPEN}) AS registration_open,
      COALESCE(s.enabled,0) AS questions_enabled,s.closes_at AS questions_closes_at,
      COALESCE(s.max_questions,3) AS questions_max,
      COALESCE(r.occupied,0) AS occupied, e.capacity-COALESCE(r.occupied,0) AS remaining,
      COALESCE(r.registered_users,0) AS registered_users, COALESCE(r.approved_tickets,0) AS approved_tickets,
      COALESCE(r.occupied-r.approved_tickets,0) AS held_tickets, COALESCE(a.checked_in_tickets,0) AS checked_in_tickets
    FROM page e
    LEFT JOIN places p ON p.id=e.place_id
    LEFT JOIN event_question_settings s ON s.event_id=e.id
    LEFT JOIN reservations r ON r.event_id=e.id
    LEFT JOIN attendance a ON a.event_id=e.id
    ORDER BY e.id DESC`, ...paging(limit, offset));
  }
  async listEventSummaries({ limit = 100, offset = 0 } = {}) {
    return this.all(`SELECT id,name,active,(${REGISTRATION_OPEN}) AS registration_open FROM events e WHERE archived=0 ORDER BY id DESC LIMIT ? OFFSET ?`, ...paging(limit, offset));
  }
  async getEventSummary(id) {
    return this.one(`SELECT id,name,active,(${REGISTRATION_OPEN}) AS registration_open FROM events e WHERE id=? AND archived=0`, Number(id));
  }
  async getEvent(id) { return this.one(`${this.eventSelect()} WHERE e.id=?`, Number(id)); }
  async saveEvent(data, id = null) {
    const old = id ? await this.getEvent(int(id, 'شناسه رویداد')) : null;
    if (id && !old) throw domainError('NOT_FOUND', 'رویداد پیدا نشد');
    const v = { active: 1, max_per_user: 1, is_paid: 0, price: 0, ...(old || {}), ...data };
    const placeId = v.place_id ? int(v.place_id, 'شناسه مکان') : null;
    const place = placeId ? await this.one('SELECT * FROM places WHERE id=?', placeId) : null;
    if (placeId && !place) throw domainError('NOT_FOUND', 'مکان پیدا نشد');
    const capacity = int(v.capacity ?? place?.capacity, 'ظرفیت', 1000000);
    const pricingMode = String(v.pricing_mode || 'fixed');
    if (!['fixed', 'differentiated'].includes(pricingMode)) throw domainError('INVALID_INPUT', 'مدل قیمت‌گذاری معتبر نیست');
    const checkedPrice = value => {
      const amount = Number(value || 0);
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1000000000000) throw domainError('INVALID_INPUT', 'مبلغ معتبر نیست');
      return amount;
    };
    const submittedPrice = checkedPrice(v.price);
    const fumStudentPrice = pricingMode === 'differentiated' ? checkedPrice(v.fum_student_price) : 0;
    const paid = pricingMode === 'differentiated'
      ? Number(submittedPrice > 0 || fumStudentPrice > 0)
      : flag(v.is_paid);
    const price = pricingMode === 'differentiated' ? submittedPrice : paid ? submittedPrice : 0;
    const startsAt = string(v.starts_at, 'زمان رویداد', 100);
    if (startsAt && !Number.isFinite(Date.parse(startsAt))) throw domainError('INVALID_INPUT', 'زمان رویداد معتبر نیست');
    const endsAt = string(v.ends_at, 'زمان پایان رویداد', 100);
    if (endsAt) {
      const endTime = Date.parse(endsAt);
      if (!Number.isFinite(endTime)) throw domainError('INVALID_INPUT', 'زمان پایان رویداد معتبر نیست');
      if (!startsAt) throw domainError('INVALID_INPUT', 'برای ثبت زمان پایان، زمان شروع را هم مشخص کنید');
      if (endTime <= Date.parse(startsAt)) throw domainError('INVALID_INPUT', 'زمان پایان باید بعد از زمان شروع باشد');
    }
    const posterUrl = string(v.poster_url || '', 'پوستر رویداد', 500000);
    const registrationClosesAt = v.registration_closes_at == null ? null : int(v.registration_closes_at, 'مهلت ثبت‌نام', 253402300799);
    const values = [string(v.name, 'نام رویداد', 200, true), string(v.description, 'توضیحات', 3500), placeId, capacity,
      int(v.max_per_user, 'سقف هر نفر', 100), paid, price, pricingMode, fumStudentPrice,
      string(v.payment_instructions, 'دستور پرداخت', 1500), startsAt, endsAt, posterUrl, flag(v.active), registrationClosesAt];
    const settings = data.question_settings === undefined ? null : questionSettingsValues(data.question_settings);
    const event = id
      ? this.stmt(`UPDATE events SET name=?,description=?,place_id=?,capacity=?,max_per_user=?,is_paid=?,price=?,
        pricing_mode=?,fum_student_price=?,payment_instructions=?,starts_at=?,ends_at=?,poster_url=?,active=?,registration_closes_at=?,updated_at=unixepoch()
        WHERE id=?${settings ? ' AND archived=0' : ''}`, ...values, Number(id))
      : this.stmt(`INSERT INTO events(name,description,place_id,capacity,max_per_user,is_paid,price,pricing_mode,fum_student_price,payment_instructions,starts_at,ends_at,poster_url,active,registration_closes_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...values);
    let saved, savedSettings;
    try {
      if (settings) {
        // On create, the second statement uses the id inserted by the first in the same transaction.
        const [eventResult, questionResult] = await this.db.batch([event, this.eventQuestionSettingsStatement(id, settings)]);
        saved = eventResult;
        savedSettings = questionResult.results[0];
      } else {
        saved = await event.run();
      }
    } catch (error) { throw mapDbError(error); }
    if (settings && !savedSettings) throw domainError('NOT_FOUND', 'رویداد پیدا نشد');
    const item = await this.getEvent(id || saved.meta.last_row_id);
    return savedSettings ? { ...item, question_settings: savedSettings } : item;
  }
  async deleteEvent(id) {
    await this.run('UPDATE events SET archived=1,active=0,updated_at=unixepoch() WHERE id=?', int(id, 'شناسه رویداد'));
    return { archived: true };
  }
  async getEventQuestionSettings(eventId) {
    const settings = await this.one(`SELECT e.id,e.name,COALESCE(s.enabled,0) AS enabled,s.closes_at,
      COALESCE(s.max_questions,3) AS max_questions
      FROM events e LEFT JOIN event_question_settings s ON s.event_id=e.id WHERE e.id=? AND e.archived=0`,
    int(eventId, 'شناسه رویداد'));
    if (!settings) throw domainError('NOT_FOUND', 'رویداد پیدا نشد');
    return settings;
  }
  eventQuestionSettingsStatement(eventId, [enabled, closesAt, maxQuestions]) {
    return this.stmt(`INSERT INTO event_question_settings(event_id,enabled,closes_at,max_questions)
      SELECT id,?,?,COALESCE(?,3) FROM events WHERE id=${eventId ? '?' : 'last_insert_rowid()'} AND archived=0
      ON CONFLICT(event_id) DO UPDATE SET enabled=excluded.enabled,closes_at=excluded.closes_at,
        max_questions=COALESCE(?,event_question_settings.max_questions)
      RETURNING enabled,closes_at,max_questions`, enabled, closesAt, maxQuestions,
      ...(eventId ? [Number(eventId)] : []), maxQuestions);
  }
  async saveEventQuestionSettings(eventId, data) {
    const settings = await this.eventQuestionSettingsStatement(int(eventId, 'شناسه رویداد'), questionSettingsValues(data)).first();
    if (!settings) throw domainError('NOT_FOUND', 'رویداد پیدا نشد');
    return settings;
  }
  async getEventQuestionAccess(eventId, userId) {
    return this.one(`SELECT e.name, s.max_questions-${QUESTIONS_USED} AS remaining ${QUESTION_ACCESS}`,
      int(userId, 'شناسه کاربر'), int(eventId, 'شناسه رویداد'));
  }
  async submitEventQuestion(eventId, userId, question, requestKey) {
    const id = int(eventId, 'شناسه رویداد');
    const user = int(userId, 'شناسه کاربر');
    const text = string(question, 'متن سؤال', 1000, true);
    const key = string(requestKey, 'شناسه درخواست', 200, true);
    const result = await this.run(`INSERT INTO event_questions(event_id,user_id,request_key,question)
      SELECT e.id,u.id,?,? ${QUESTION_ACCESS} AND ${QUESTIONS_USED}<s.max_questions
      ON CONFLICT(request_key) DO NOTHING`, key, text, user, id);
    if (result.meta.changes) return;
    const existing = await this.one('SELECT 1 FROM event_questions WHERE request_key=? AND event_id=? AND user_id=?', key, id, user);
    if (existing) return;
    const access = await this.getEventQuestionAccess(id, user);
    if (access?.remaining <= 0) throw domainError('QUESTION_LIMIT');
    throw domainError('QUESTION_UNAVAILABLE');
  }
  async listEventQuestions(eventId, { limit = 50, offset = 0, status } = {}) {
    const selected = status === 'approved' ? 1 : status === 'pending' ? 0 : null;
    return this.all(`SELECT id,question,topic,selected,created_at FROM event_questions
      WHERE event_id=? AND (? IS NULL OR selected=?) ORDER BY id DESC LIMIT ? OFFSET ?`,
    int(eventId, 'شناسه رویداد'), selected, selected, ...paging(limit, offset));
  }
  async selectEventQuestion(eventId, questionId, data) {
    const result = await this.run(`UPDATE event_questions SET topic=?,selected=? WHERE event_id=? AND id=?
      AND EXISTS(SELECT 1 FROM events WHERE id=event_questions.event_id AND archived=0)`,
    string(data.topic, 'موضوع سؤال', 100), flag(data.selected), int(eventId, 'شناسه رویداد'), int(questionId, 'شناسه سؤال'));
    if (!result.meta.changes) throw domainError('NOT_FOUND', 'سؤال پیدا نشد');
  }
  async selectedEventQuestions(eventId) {
    return this.all('SELECT question,topic FROM event_questions WHERE event_id=? AND selected=1 ORDER BY topic,id',
      int(eventId, 'شناسه رویداد'));
  }

  orderSelect() {
    return `SELECT o.*,e.name AS event_name,e.description AS event_description,e.payment_instructions,e.starts_at,
      ${QUESTION_WINDOW} AS questions_open,
      e.is_paid,e.price,e.capacity,e.max_per_user,p.name AS place_name,p.address AS place_address,p.map_url AS place_map_url,
      u.first_name,u.last_name,u.phone,u.username FROM orders o JOIN events e ON e.id=o.event_id
      JOIN users u ON u.id=o.user_id LEFT JOIN places p ON p.id=e.place_id`;
  }
  async getEventPricing(userId, eventId, exactStudentNumberLength = null, { requirePhone = false, allowGuest = false } = {}) {
    userId = int(userId, 'شناسه کاربر'); eventId = int(eventId, 'شناسه رویداد');
    const [user, event] = await Promise.all([this.getUser(userId), this.getEvent(eventId)]);
    if (!event?.registration_open) throw domainError('EVENT_INACTIVE', 'این رویداد موجود نیست یا ثبت‌نام آن متوقف شده است');
    if (!user || (requirePhone && !user.phone)) {
      if (allowGuest) return { event, account_required: true };
      throw domainError('ACCOUNT_REQUIRED', 'ابتدا حساب کاربری بسازید');
    }
    return { event, ...resolveEventPricing(event, user.profile, configuredStudentNumberLength(exactStudentNumberLength)),
      requires_tariff_choice: event.pricing_mode === 'differentiated' && user.profile.short_registration === true
        && !Object.hasOwn(user.profile, 'is_fum_student') };
  }
  async quoteOrder(userId, eventId, quantity, exactStudentNumberLength = null) {
    quantity = int(quantity, 'تعداد بلیت', 100);
    const pricing = await this.getEventPricing(userId, eventId, exactStudentNumberLength);
    if (pricing.requires_student_number) throw domainError('STUDENT_PROFILE_INCOMPLETE');
    const total_price = pricing.unit_price * quantity;
    if (!Number.isSafeInteger(total_price)) throw domainError('INVALID_INPUT', 'مبلغ کل معتبر نیست');
    return { event_id: pricing.event.id, quantity, pricing_group: pricing.pricing_group, unit_price: pricing.unit_price, total_price };
  }
  async reserve(userId, eventId, quantity, key, expectedQuote = null, exactStudentNumberLength = null) {
    userId = int(userId, 'شناسه کاربر'); eventId = int(eventId, 'شناسه رویداد'); quantity = int(quantity, 'تعداد بلیت', 100);
    key = string(key, 'شناسه درخواست', 200, true);
    const existing = await this.one('SELECT id,user_id,event_id,quantity FROM orders WHERE request_key=?', key);
    if (existing) return this.existingReservation(existing, userId, eventId, quantity);
    const quote = await this.quoteOrder(userId, eventId, quantity, exactStudentNumberLength);
    if (expectedQuote && (expectedQuote.pricing_group !== quote.pricing_group || Number(expectedQuote.unit_price) !== quote.unit_price || Number(expectedQuote.quantity) !== quantity)) {
      throw domainError('PRICE_CHANGED');
    }
    const id = crypto.randomUUID();
    const fumFlag = "COALESCE(json_extract(u.profile_json,'$.is_fum_student'),0) IN (1,'1','true')";
    const studentNumber = "CAST(json_extract(u.profile_json,'$.student_number') AS TEXT)";
    let pricingGuard;
    let pricingValues;
    if (quote.pricing_group === 'fixed') {
      pricingGuard = "e.pricing_mode='fixed' AND (CASE WHEN e.is_paid=1 THEN e.price ELSE 0 END)=?";
      pricingValues = [quote.unit_price];
    } else if (quote.pricing_group === 'general') {
      pricingGuard = `e.pricing_mode='differentiated' AND e.price=? AND NOT (${fumFlag})`;
      pricingValues = [quote.unit_price];
    } else {
      pricingGuard = `e.pricing_mode='differentiated' AND e.fum_student_price=? AND (${fumFlag})
        AND length(${studentNumber})=? AND ${studentNumber} NOT GLOB '*[^0-9۰-۹٠-٩]*'`;
      pricingValues = [quote.unit_price, configuredStudentNumberLength(exactStudentNumberLength)];
    }
    let tickets;
    for (let attempt = 0; attempt < 5; attempt++) {
      tickets = ticketBatch(quantity);
      try {
        const results = await this.db.batch([
          this.stmt(`INSERT INTO orders(id,request_key,user_id,event_id,quantity,unit_price,pricing_group,status,expires_at)
            SELECT ?,?,u.id,e.id,?,?,?,?,CASE WHEN ?>0 THEN unixepoch()+900 ELSE NULL END
            FROM events e,users u WHERE e.id=? AND u.id=? AND ${REGISTRATION_OPEN} AND u.is_deleted=0 AND ${pricingGuard}`,
            id, key, quantity, quote.unit_price, quote.pricing_group,
            quote.unit_price > 0 ? 'reserved' : 'approved', quote.unit_price,
            eventId, userId, ...pricingValues),
          this.stmt(`INSERT INTO tickets(id,token,checkin_code,order_id)
            SELECT json_extract(value,'$.id'),json_extract(value,'$.token'),json_extract(value,'$.checkin_code'),? FROM json_each(?)
            WHERE EXISTS(SELECT 1 FROM orders WHERE id=?)`, id, JSON.stringify(tickets), id),
        ]);
        if (Number(results[0]?.meta?.changes) !== 1) {
          const event = await this.getEvent(eventId);
          if (!event?.registration_open) throw domainError('EVENT_INACTIVE', 'این رویداد موجود نیست یا ثبت‌نام آن متوقف شده است');
          throw domainError('PRICE_CHANGED');
        }
        break;
      } catch (e) {
        // A retry racing the original request returns its booking; only short-code collisions are retried.
        const retry = await this.one('SELECT id,user_id,event_id,quantity FROM orders WHERE request_key=?', key);
        if (retry) return this.existingReservation(retry, userId, eventId, quantity);
        if (!/tickets\.checkin_code/i.test(String(e)) || attempt === 4) throw mapDbError(e);
      }
    }
    const order = await this.getOrder(id);
    if (!order) {
      if (!await this.getUser(userId)) throw domainError('ACCOUNT_REQUIRED', 'ابتدا حساب کاربری بسازید');
      throw domainError('EVENT_INACTIVE', 'رویداد پیدا نشد یا فعال نیست');
    }
    return { order, tickets: order.tickets };
  }
  async existingReservation(existing, userId, eventId, quantity) {
    if (existing.user_id !== userId || existing.event_id !== eventId || existing.quantity !== quantity)
      throw domainError('IDEMPOTENCY_CONFLICT', 'شناسه درخواست قبلا برای رزرو دیگری استفاده شده است');
    const order = await this.getOrder(existing.id);
    return { order, tickets: order.tickets, duplicate: true };
  }
  async getOrder(id) {
    const row = await this.one(`${this.orderSelect()} WHERE o.id=?`, String(id));
    return row ? { ...row, tickets: await this.getTicketsByOrder(id) } : null;
  }
  async countApprovedTickets(userId, eventId) {
    const row = await this.one("SELECT COALESCE(SUM(quantity),0) AS count FROM orders WHERE user_id=? AND event_id=? AND status='approved'", Number(userId), Number(eventId));
    return Number(row?.count || 0);
  }
  async listOrders({ eventId, status, userId, limit = 100, offset = 0 } = {}) {
    const where = [], values = [];
    if (eventId != null) { where.push('o.event_id=?'); values.push(Number(eventId)); }
    if (status) { where.push('o.status=?'); values.push(String(status)); }
    if (userId != null) { where.push('o.user_id=?'); values.push(Number(userId)); }
    return this.all(`${this.orderSelect()} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC,o.id LIMIT ? OFFSET ?`, ...values, ...paging(limit, offset));
  }
  async submitReceipt(orderId, userId, fileId, type = 'photo', key = '') {
    if (!['photo', 'document'].includes(type)) throw domainError('INVALID_INPUT', 'نوع رسید معتبر نیست');
    const order = await this.getOrder(orderId);
    if (!order || order.user_id !== Number(userId)) throw domainError('NOT_FOUND', 'رزرو پیدا نشد');
    if (order.status === 'pending' && order.receipt_file_id === fileId) return { ...order, duplicate: true };
    const r = await this.run(`UPDATE orders SET status='pending',receipt_file_id=?,receipt_type=?,receipt_key=?,
      expires_at=unixepoch()+86400,updated_at=unixepoch() WHERE id=? AND user_id=? AND status='reserved' AND expires_at>unixepoch()`,
      string(fileId, 'رسید', 1000, true), type, String(key), String(orderId), Number(userId));
    if (!r.meta.changes) throw domainError('ORDER_EXPIRED', 'رزرو منقضی شده یا قبلا بررسی شده است');
    return this.getOrder(orderId);
  }
  async reviewOrder(id, approve, actorId) {
    const next = approve ? 'approved' : 'rejected';
    const r = await this.run(`UPDATE orders SET status=?,reviewed_by=?,reviewed_at=unixepoch(),
      expires_at=NULL,updated_at=unixepoch() WHERE id=? AND status='pending' AND expires_at>unixepoch()`,
      next, Number(actorId), String(id));
    const order = await this.getOrder(id);
    if (!order) throw domainError('NOT_FOUND', 'رزرو پیدا نشد');
    if (!r.meta.changes) {
      if (order.status === next) return { ...order, already_reviewed: true, previous_status: next };
      if (['reserved', 'pending'].includes(order.status) && order.expires_at <= Math.floor(Date.now() / 1000))
        throw domainError('ORDER_EXPIRED', 'مهلت رزرو تمام شده است و امکان تایید آن وجود ندارد');
      throw domainError('ORDER_ALREADY_REVIEWED', 'این رزرو آماده بررسی نیست یا قبلا تعیین تکلیف شده است');
    }
    await this.audit(actorId, approve ? 'approve_order' : 'reject_order', id, { quantity: order.quantity });
    return { ...order, previous_status: 'pending', already_reviewed: false };
  }
  async cancelOrder(id, userId) {
    const r = await this.run(`UPDATE orders SET status='cancelled',updated_at=unixepoch() WHERE id=? AND user_id=? AND status IN ('reserved','pending')`, String(id), Number(userId));
    const order = await this.getOrder(id);
    if (!order || order.user_id !== Number(userId)) throw domainError('NOT_FOUND', 'رزرو پیدا نشد');
    if (!r.meta.changes && order.status !== 'cancelled') throw domainError('CANNOT_CANCEL', 'امکان لغو این رزرو وجود ندارد');
    return order;
  }
  ticketSelect() {
    return `SELECT t.*,o.user_id,o.event_id,o.quantity,o.status AS order_status,o.expires_at,o.unit_price,o.pricing_group,
      CASE WHEN t.checked_in_at IS NOT NULL THEN 'attended' ELSE o.status END AS status,
      e.name AS event_name,e.starts_at,e.poster_url,p.name AS place_name,p.address AS place_address,p.map_url AS place_map_url,
      u.first_name,u.last_name,u.phone,u.username
      FROM tickets t JOIN orders o ON o.id=t.order_id JOIN events e ON e.id=o.event_id
      JOIN users u ON u.id=o.user_id LEFT JOIN places p ON p.id=e.place_id`;
  }
  async getTicketsByOrder(id) { return this.all(`${this.ticketSelect()} WHERE t.order_id=? ORDER BY t.rowid`, String(id)); }
  async listTickets({ eventId, userId, limit = 100, offset = 0 } = {}) {
    const where = [], values = [];
    if (eventId != null) { where.push('o.event_id=?'); values.push(Number(eventId)); }
    if (userId != null) { where.push('o.user_id=?'); values.push(Number(userId)); }
    return this.all(`${this.ticketSelect()} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC,t.rowid DESC LIMIT ? OFFSET ?`, ...values, ...paging(limit, offset));
  }
  async getTicket(tokenOrId) {
    // Full tokens remain the private ticket-link credential; numeric codes are for authenticated check-in.
    const input = String(tokenOrId || '').trim();
    const exact = await this.one(`${this.ticketSelect()} WHERE t.token=? OR t.id=? LIMIT 1`, input, input);
    if (exact) return exact;
    const code = normalizeDigits(input).replace(/\D/g, '');
    if (/^\d{8}$/.test(code)) {
      const coded = await this.one(`${this.ticketSelect()} WHERE t.checkin_code=? LIMIT 1`, code);
      if (coded) return coded;
    }
    return this.one(`${this.ticketSelect()} WHERE t.legacy_code=? LIMIT 1`, input);
  }
  async checkIn(tokenOrId, actorId) {
    const ticket = await this.getTicket(tokenOrId);
    if (!ticket) throw domainError('NOT_FOUND', 'بلیت پیدا نشد');
    const r = await this.run(`UPDATE tickets SET checked_in_at=unixepoch(),checked_in_by=? WHERE id=? AND checked_in_at IS NULL
      AND EXISTS(SELECT 1 FROM orders WHERE id=tickets.order_id AND status='approved')`, Number(actorId), ticket.id);
    const current = await this.getTicket(ticket.id);
    if (current.order_status !== 'approved') throw domainError('INVALID_TICKET', 'این بلیت تایید نشده یا لغو شده است');
    if (r.meta.changes) await this.audit(actorId, 'checkin', ticket.id, {});
    return { ...current, already_checked_in: !r.meta.changes };
  }
  async undoCheckIn(tokenOrId, actorId) {
    const ticket = await this.getTicket(tokenOrId);
    if (!ticket) throw domainError('NOT_FOUND', 'بلیت پیدا نشد');
    await this.run('UPDATE tickets SET checked_in_at=NULL,checked_in_by=NULL WHERE id=?', ticket.id);
    await this.audit(actorId, 'undo_checkin', ticket.id, {});
    return this.getTicket(ticket.id);
  }
  async deleteTicket() { throw domainError('USE_ORDER_CANCELLATION', 'برای حفظ سوابق بلیت را حذف نمیکنیم و رزرو باید لغو یا رد شود'); }
  async flushReserves(eventId, actorId) {
    const result = await this.run("UPDATE orders SET status='cancelled',updated_at=unixepoch() WHERE event_id=? AND status IN ('reserved','pending')", int(eventId, 'شناسه رویداد'));
    await this.audit(actorId, 'flush_reserves', String(eventId), { orders: result.meta.changes });
    return { cancelled: result.meta.changes };
  }
  async expireOrders() {
    const cutoff = Math.floor(Date.now() / 1000);
    const notice = `⏳ مهلت ارسال رسید برای «%s» تمام شد و جای رزروشده آزاد شد.\n\nاگر مبلغ را واریز کرده‌اید، «پیگیری پرداخت» را بزنید. در صورت اختلال ربات، ${SUPPORT_CONTACT}\n\nاگر هنوز پرداخت نکرده‌اید، می‌توانید از «رویدادها» دوباره برای ثبت‌نام اقدام کنید.`;
    const [, expired] = await this.db.batch([
      this.stmt(`INSERT INTO outbox(id,method,payload,dedupe_key)
        SELECT 'receipt-expired:' || o.id,'sendMessage',json_object('chat_id',o.user_id,'text',printf(?,e.name),
          'reply_markup',json_object('inline_keyboard',json_array(json_array(
            json_object('text','پیگیری پرداخت','callback_data','sp:o:' || o.id))))),
          'receipt-expired:' || o.id
        FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
        WHERE o.status='reserved' AND o.expires_at<=? AND u.is_deleted=0
        ON CONFLICT(dedupe_key) DO NOTHING`, notice, cutoff),
      this.stmt(`UPDATE orders SET status='expired',updated_at=unixepoch()
        WHERE status IN ('reserved','pending') AND expires_at<=?`, cutoff),
    ]);
    return { expired: expired.meta.changes };
  }
  async getSupportOrder(orderId, userId) {
    return this.one(`SELECT o.id,e.name AS event_name,s.id AS ticket_id FROM orders o
      JOIN events e ON e.id=o.event_id JOIN users u ON u.id=o.user_id AND u.is_deleted=0
      LEFT JOIN support_tickets s ON s.order_id=o.id
      WHERE o.id=? AND o.user_id=? AND o.unit_price>0 AND (o.status='expired' OR s.id IS NOT NULL)`,
      String(orderId), int(userId, 'شناسه کاربر'));
  }
  async getSupportTicket(ticketId, userId = null) {
    const own = userId != null ? 'AND o.user_id=? AND u.is_deleted=0' : '';
    return this.one(`${SUPPORT_TICKET} WHERE s.id=? ${own}`, int(ticketId, 'شماره تیکت'),
      ...(userId != null ? [int(userId, 'شناسه کاربر')] : []));
  }
  async listSupportTickets({ userId = null, status = '', limit = 25, offset = 0 } = {}) {
    const where = [], args = [];
    if (userId != null) { where.push('o.user_id=? AND u.is_deleted=0'); args.push(int(userId, 'شناسه کاربر')); }
    if (Object.hasOwn(SUPPORT_STATUSES, status)) { where.push('s.status=?'); args.push(status); }
    return this.all(`${SUPPORT_TICKET} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.updated_at DESC,s.id DESC LIMIT ? OFFSET ?`, ...args, ...paging(limit, offset));
  }
  async listSupportMessages(ticketId, { limit = 25, offset = 0 } = {}) {
    return this.all(`SELECT id,sender,text,file_id<>'' AS has_file,created_at
      FROM support_messages WHERE ticket_id=? ORDER BY id DESC LIMIT ? OFFSET ?`,
      int(ticketId, 'شماره تیکت'), ...paging(limit, offset));
  }
  async getSupportAttachment(ticketId, messageId) {
    return this.one('SELECT file_id FROM support_messages WHERE ticket_id=? AND id=?',
      int(ticketId, 'شماره تیکت'), int(messageId, 'شناسه پیام'));
  }
  async submitSupportMessage(orderId, userId, { text, fileId, requestKey }) {
    const id = String(orderId), actor = int(userId, 'شناسه کاربر');
    const message = string(text, 'متن تیکت', 1000), file = string(fileId, 'پیوست تیکت', 1000);
    const key = string(requestKey, 'شناسه درخواست', 200, true);
    if (!message && !file) throw domainError('INVALID_INPUT', 'توضیح یا فایل رسید را بفرستید');
    await this.db.batch([
      this.stmt(`INSERT INTO support_tickets(order_id)
        SELECT o.id FROM orders o JOIN users u ON u.id=o.user_id AND u.is_deleted=0
        WHERE o.id=? AND o.user_id=? AND o.unit_price>0 AND o.status='expired'
        ON CONFLICT(order_id) DO NOTHING`, id, actor),
      this.stmt(`INSERT INTO support_messages(ticket_id,sender,actor_id,request_key,text,file_id)
        SELECT s.id,'user',o.user_id,?,?,? FROM support_tickets s
        JOIN orders o ON o.id=s.order_id JOIN users u ON u.id=o.user_id AND u.is_deleted=0
        WHERE s.order_id=? AND o.user_id=?
        ON CONFLICT(request_key) DO NOTHING`, key, message, file, id, actor),
      this.stmt(`UPDATE support_tickets SET status=CASE
        WHEN status IN ('waiting_user','closed') THEN CASE WHEN assigned_to IS NULL THEN 'new' ELSE 'in_review' END
        ELSE status END, updated_at=unixepoch()
        WHERE order_id=? AND changes()>0`, id),
    ]);
    const result = await this.one(`SELECT m.ticket_id AS id FROM support_messages m JOIN support_tickets s ON s.id=m.ticket_id
      WHERE m.request_key=? AND m.sender='user' AND m.actor_id=? AND s.order_id=?`, key, actor, id);
    if (!result) throw domainError('NOT_FOUND', 'سفارش برای پیگیری در دسترس نیست');
    return result.id;
  }
  async changeSupportTicket(ticketId, actorId, action, isOwner = false) {
    const id = int(ticketId, 'شماره تیکت'), actor = int(actorId, 'شناسه مدیر');
    const actions = {
      claim: [`assigned_to=?,status=CASE WHEN status='new' THEN 'in_review' ELSE status END`,
        '(assigned_to IS NULL OR assigned_to=?)', [actor], [actor]],
      release: ['assigned_to=NULL', '(assigned_to=? OR ?=1)', [], [actor, Number(isOwner)]],
      close: ["status='closed'", 'assigned_to=?', [], [actor]],
    };
    if (!Object.hasOwn(actions, action)) throw domainError('INVALID_INPUT', 'عملیات تیکت معتبر نیست');
    const [update, guard, values, conditions] = actions[action];
    const updated = await this.one(`UPDATE support_tickets SET ${update},updated_at=unixepoch()
      WHERE id=? AND status<>'closed' AND ${guard} RETURNING id`, ...values, id, ...conditions);
    if (!updated) throw domainError('SUPPORT_UNAVAILABLE', 'تیکت بسته است یا در اختیار مدیر دیگری است');
    await this.audit(actor, `support.${action}`, id);
  }
  async replyToSupportTicket(ticketId, actorId, { text, requestKey, waitForUser }) {
    const id = int(ticketId, 'شماره تیکت'), actor = int(actorId, 'شناسه مدیر');
    const message = string(text, 'متن پاسخ', 1000, true);
    if (!/^[a-f0-9-]{36}$/.test(String(requestKey || ''))) throw domainError('INVALID_INPUT', 'شناسه پاسخ معتبر نیست');
    const key = `support-reply:${actor}:${requestKey}`;
    const [saved] = await this.db.batch([
      this.stmt(`INSERT INTO support_messages(ticket_id,sender,actor_id,request_key,text)
        SELECT s.id,'admin',?,?,? FROM support_tickets s JOIN orders o ON o.id=s.order_id
        JOIN users u ON u.id=o.user_id AND u.is_deleted=0
        WHERE s.id=? AND s.assigned_to=? AND s.status<>'closed'
        ON CONFLICT(request_key) DO NOTHING`, actor, key, message, id, actor),
      this.stmt(`INSERT INTO outbox(id,method,payload,dedupe_key)
        SELECT ?, 'sendMessage', json_object('chat_id',o.user_id,'text',?,
          'reply_markup',json_object('inline_keyboard',json_array(json_array(
            json_object('text','مشاهده و پاسخ','callback_data',?))))), ?
        FROM support_tickets s JOIN orders o ON o.id=s.order_id
        WHERE s.id=? AND changes()>0`, key, `💬 پاسخ پشتیبانی به تیکت #${id}\n\n${message}`, `sp:v:${id}:0`, key, id),
      this.stmt('UPDATE support_tickets SET status=?,updated_at=unixepoch() WHERE id=? AND changes()>0',
        waitForUser ? 'waiting_user' : 'in_review', id),
    ]);
    if (!saved.meta.changes && !await this.one('SELECT id FROM support_messages WHERE ticket_id=? AND request_key=?', id, key)) {
      throw domainError('SUPPORT_UNAVAILABLE', 'برای پاسخ، تیکت باز را به خودتان اختصاص دهید و دسترسی کاربر را بررسی کنید');
    }
  }
  async listAdmins() { return this.all('SELECT * FROM admins ORDER BY user_id'); }
  async getAdmin(userId) { return this.one('SELECT * FROM admins WHERE user_id=?', Number(userId)); }
  async setAdmin(userId, role = 'admin') {
    if (!['admin', 'checkin'].includes(role)) throw domainError('INVALID_INPUT', 'نقش معتبر نیست');
    await this.run('INSERT INTO admins(user_id,role) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role', int(userId, 'شناسه مدیر'), role);
    return this.getAdmin(userId);
  }
  async removeAdmin(userId) { await this.run('DELETE FROM admins WHERE user_id=?', int(userId, 'شناسه مدیر')); return { deleted: true }; }
  async stats() {
    return this.one(`SELECT
      (SELECT COUNT(*) FROM users WHERE is_deleted=0) AS users,
      (SELECT COUNT(*) FROM events WHERE archived=0) AS events,
      (SELECT COUNT(*) FROM events WHERE active=1 AND archived=0) AS active_events,
      (SELECT COUNT(*) FROM orders WHERE status='pending' AND expires_at>unixepoch()) AS pending_orders,
      (SELECT COUNT(*) FROM tickets t JOIN orders o ON o.id=t.order_id WHERE o.status='approved') AS tickets,
      (SELECT COUNT(*) FROM tickets t JOIN orders o ON o.id=t.order_id WHERE o.status='approved' AND t.checked_in_at IS NOT NULL) AS attended,
      (SELECT COALESCE(SUM(quantity*unit_price),0) FROM orders WHERE status='approved') AS revenue`);
  }
  async audit(actorId, action, target = '', details = {}) {
    await this.run('INSERT INTO audit_log(actor_id,action,target,details_json) VALUES(?,?,?,?)', actorId == null ? null : Number(actorId), String(action), String(target), JSON.stringify(details));
  }
  async enqueue(method, payload, dedupeKey = null) {
    const id = crypto.randomUUID();
    await this.run('INSERT OR IGNORE INTO outbox(id,method,payload,dedupe_key) VALUES(?,?,?,?)', id, method, JSON.stringify(payload), dedupeKey);
    return id;
  }
}
