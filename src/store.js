const OCCUPIED = "(status='approved' OR (status IN ('reserved','pending') AND expires_at>unixepoch()))";
const ERRORS = {
  EVENT_FULL: 'ظرفیت رویداد تکمیل شده است',
  USER_LIMIT: 'تعداد بلیت از سقف مجاز هر نفر بیشتر است',
  CAPACITY_BELOW_RESERVED: 'ظرفیت نمیتواند از تعداد بلیتهای رزرو شده کمتر باشد',
  USER_LIMIT_BELOW_RESERVED: 'سقف هر نفر نمیتواند از خریدهای قبلی کمتر باشد',
};

export function domainError(code, message) {
  return Object.assign(new Error(message || ERRORS[code] || 'امکان انجام این عملیات وجود ندارد'), { code });
}
const parse = (value) => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const userRow = (row) => row ? { ...row, profile: parse(row.profile_json) } : null;
const int = (v, name, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw domainError('INVALID_INPUT', `${name} معتبر نیست`);
  return n;
};
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
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
  async listUsers({ limit = 100, offset = 0 } = {}) {
    return (await this.all('SELECT * FROM users WHERE is_deleted=0 ORDER BY created_at DESC,id LIMIT ? OFFSET ?', ...paging(limit, offset))).map(userRow);
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
      COALESCE((SELECT SUM(quantity) FROM orders WHERE event_id=e.id AND ${OCCUPIED}),0) AS occupied,
      e.capacity-COALESCE((SELECT SUM(quantity) FROM orders WHERE event_id=e.id AND ${OCCUPIED}),0) AS remaining
      FROM events e LEFT JOIN places p ON p.id=e.place_id`;
  }
  async listEvents({ activeOnly = false, limit = 100, offset = 0 } = {}) {
    return this.all(`${this.eventSelect()} WHERE e.archived=0 ${activeOnly ? 'AND e.active=1' : ''} ORDER BY e.id DESC LIMIT ? OFFSET ?`, ...paging(limit, offset));
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
    const paid = flag(v.is_paid);
    const price = Number(v.price || 0);
    if (!Number.isSafeInteger(price) || price < 0 || price > 1000000000000) throw domainError('INVALID_INPUT', 'مبلغ معتبر نیست');
    const startsAt = string(v.starts_at, 'زمان رویداد', 100);
    if (startsAt && !Number.isFinite(Date.parse(startsAt))) throw domainError('INVALID_INPUT', 'زمان رویداد معتبر نیست');
    const values = [string(v.name, 'نام رویداد', 200, true), string(v.description, 'توضیحات', 3500), placeId, capacity,
      int(v.max_per_user, 'سقف هر نفر', 100), paid, paid ? price : 0,
      string(v.payment_instructions, 'دستور پرداخت', 1500), startsAt, flag(v.active)];
    if (id) await this.run(`UPDATE events SET name=?,description=?,place_id=?,capacity=?,max_per_user=?,is_paid=?,price=?,
      payment_instructions=?,starts_at=?,active=?,updated_at=unixepoch() WHERE id=?`, ...values, Number(id));
    else {
      const r = await this.run(`INSERT INTO events(name,description,place_id,capacity,max_per_user,is_paid,price,payment_instructions,starts_at,active)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, ...values);
      id = r.meta.last_row_id;
    }
    return this.getEvent(id);
  }
  async deleteEvent(id) {
    await this.run('UPDATE events SET archived=1,active=0,updated_at=unixepoch() WHERE id=?', int(id, 'شناسه رویداد'));
    return { archived: true };
  }

  orderSelect() {
    return `SELECT o.*,e.name AS event_name,e.description AS event_description,e.payment_instructions,e.starts_at,
      e.is_paid,e.price,e.capacity,e.max_per_user,p.name AS place_name,p.address AS place_address,p.map_url AS place_map_url,
      u.first_name,u.last_name,u.phone,u.username FROM orders o JOIN events e ON e.id=o.event_id
      JOIN users u ON u.id=o.user_id LEFT JOIN places p ON p.id=e.place_id`;
  }
  async reserve(userId, eventId, quantity, key) {
    userId = int(userId, 'شناسه کاربر'); eventId = int(eventId, 'شناسه رویداد'); quantity = int(quantity, 'تعداد بلیت', 100);
    key = string(key, 'شناسه درخواست', 200, true);
    const existing = await this.one('SELECT id,user_id,event_id,quantity FROM orders WHERE request_key=?', key);
    if (existing) return this.existingReservation(existing, userId, eventId, quantity);
    const id = crypto.randomUUID();
    const tickets = Array.from({ length: quantity }, () => ({ id: crypto.randomUUID(), token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '') }));
    try {
      await this.db.batch([
        this.stmt(`INSERT INTO orders(id,request_key,user_id,event_id,quantity,unit_price,status,expires_at)
          SELECT ?,?,u.id,e.id,?,CASE WHEN e.is_paid=1 THEN e.price ELSE 0 END,
          CASE WHEN e.is_paid=1 THEN 'reserved' ELSE 'approved' END,
          CASE WHEN e.is_paid=1 THEN unixepoch()+900 ELSE NULL END
          FROM events e,users u WHERE e.id=? AND u.id=? AND e.active=1 AND e.archived=0 AND u.is_deleted=0`,
          id, key, quantity, eventId, userId),
        this.stmt(`INSERT INTO tickets(id,token,order_id)
          SELECT json_extract(value,'$.id'),json_extract(value,'$.token'),? FROM json_each(?)
          WHERE EXISTS(SELECT 1 FROM orders WHERE id=?)`, id, JSON.stringify(tickets), id),
      ]);
    } catch (e) {
      // A retry racing the original request returns the original booking even if capacity is now full.
      const retry = await this.one('SELECT id,user_id,event_id,quantity FROM orders WHERE request_key=?', key);
      if (retry) return this.existingReservation(retry, userId, eventId, quantity);
      throw mapDbError(e);
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
    return `SELECT t.*,o.user_id,o.event_id,o.quantity,o.status AS order_status,o.expires_at,o.unit_price,
      CASE WHEN t.checked_in_at IS NOT NULL THEN 'attended' ELSE o.status END AS status,
      e.name AS event_name,e.starts_at,p.name AS place_name,p.address AS place_address,p.map_url AS place_map_url,
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
    // legacy_code is only an administrator lookup convenience, never a bearer credential.
    return this.one(`${this.ticketSelect()} WHERE t.token=? OR t.id=? OR t.legacy_code=? LIMIT 1`, String(tokenOrId), String(tokenOrId), String(tokenOrId));
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
    const r = await this.run("UPDATE orders SET status='expired',updated_at=unixepoch() WHERE status IN ('reserved','pending') AND expires_at<=unixepoch()");
    return { expired: r.meta.changes };
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
