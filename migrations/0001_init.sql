PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  profile_json TEXT NOT NULL DEFAULT '{}',
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS conversation_states (
  user_id INTEGER PRIMARY KEY,
  step TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  place_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  max_per_user INTEGER NOT NULL DEFAULT 1 CHECK (max_per_user BETWEEN 1 AND 100),
  is_paid INTEGER NOT NULL DEFAULT 0 CHECK (is_paid IN (0,1)),
  price INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  payment_instructions TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  unit_price INTEGER NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved','pending','approved','rejected','cancelled','expired')),
  expires_at INTEGER,
  receipt_file_id TEXT,
  receipt_type TEXT,
  receipt_key TEXT,
  reviewed_by INTEGER,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS orders_event_occupancy ON orders(event_id,status,expires_at,user_id);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status,expires_at);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  legacy_code TEXT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  checked_in_at INTEGER,
  checked_in_by INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS tickets_order ON tickets(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_legacy_code ON tickets(legacy_code) WHERE legacy_code IS NOT NULL;
CREATE TABLE IF NOT EXISTS admins (
  user_id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','checkin')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS inbox (
  update_id INTEGER PRIMARY KEY,
  stream_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_until INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(status,available_at,lease_until);
CREATE INDEX IF NOT EXISTS inbox_stream ON inbox(stream_key,update_id,status);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_until INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT UNIQUE,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,available_at,lease_until);
CREATE TABLE IF NOT EXISTS login_codes (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- These guards also protect imports and direct SQL writes from overselling.
CREATE TRIGGER IF NOT EXISTS orders_capacity_insert
BEFORE INSERT ON orders
WHEN NEW.status = 'approved' OR (NEW.status IN ('reserved','pending') AND NEW.expires_at > unixepoch())
BEGIN
  SELECT CASE WHEN NEW.quantity + COALESCE((
    SELECT SUM(quantity) FROM orders WHERE event_id=NEW.event_id
    AND (status='approved' OR (status IN ('reserved','pending') AND expires_at>unixepoch()))
  ),0) > (SELECT capacity FROM events WHERE id=NEW.event_id)
  THEN RAISE(ABORT,'EVENT_FULL') END;
  SELECT CASE WHEN NEW.quantity + COALESCE((
    SELECT SUM(quantity) FROM orders WHERE event_id=NEW.event_id AND user_id=NEW.user_id
    AND (status='approved' OR (status IN ('reserved','pending') AND expires_at>unixepoch()))
  ),0) > (SELECT max_per_user FROM events WHERE id=NEW.event_id)
  THEN RAISE(ABORT,'USER_LIMIT') END;
END;
CREATE TRIGGER IF NOT EXISTS orders_capacity_update
BEFORE UPDATE OF status,expires_at,quantity,event_id,user_id ON orders
WHEN NEW.status = 'approved' OR (NEW.status IN ('reserved','pending') AND NEW.expires_at > unixepoch())
BEGIN
  SELECT CASE WHEN NEW.quantity + COALESCE((
    SELECT SUM(quantity) FROM orders WHERE event_id=NEW.event_id AND id<>OLD.id
    AND (status='approved' OR (status IN ('reserved','pending') AND expires_at>unixepoch()))
  ),0) > (SELECT capacity FROM events WHERE id=NEW.event_id)
  THEN RAISE(ABORT,'EVENT_FULL') END;
  SELECT CASE WHEN NEW.quantity + COALESCE((
    SELECT SUM(quantity) FROM orders WHERE event_id=NEW.event_id AND user_id=NEW.user_id AND id<>OLD.id
    AND (status='approved' OR (status IN ('reserved','pending') AND expires_at>unixepoch()))
  ),0) > (SELECT max_per_user FROM events WHERE id=NEW.event_id)
  THEN RAISE(ABORT,'USER_LIMIT') END;
END;
CREATE TRIGGER IF NOT EXISTS event_capacity_update
BEFORE UPDATE OF capacity,max_per_user ON events
BEGIN
  SELECT CASE WHEN NEW.capacity < COALESCE((
    SELECT SUM(quantity) FROM orders WHERE event_id=OLD.id
    AND (status='approved' OR (status IN ('reserved','pending') AND expires_at>unixepoch()))
  ),0) THEN RAISE(ABORT,'CAPACITY_BELOW_RESERVED') END;
  SELECT CASE WHEN EXISTS (
    SELECT user_id FROM orders WHERE event_id=OLD.id
    AND (status='approved' OR (status IN ('reserved','pending') AND expires_at>unixepoch()))
    GROUP BY user_id HAVING SUM(quantity)>NEW.max_per_user
  ) THEN RAISE(ABORT,'USER_LIMIT_BELOW_RESERVED') END;
END;
