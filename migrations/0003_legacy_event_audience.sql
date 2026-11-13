CREATE TABLE IF NOT EXISTS legacy_events (
  id INTEGER PRIMARY KEY CHECK (id > 0),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  place_name TEXT NOT NULL DEFAULT '',
  place_address TEXT NOT NULL DEFAULT '',
  is_paid INTEGER NOT NULL DEFAULT 0 CHECK (is_paid IN (0,1)),
  was_active INTEGER NOT NULL DEFAULT 0 CHECK (was_active IN (0,1)),
  imported_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS legacy_event_participants (
  legacy_event_id INTEGER NOT NULL REFERENCES legacy_events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_count INTEGER NOT NULL CHECK (ticket_count > 0),
  source_status TEXT NOT NULL CHECK (source_status IN ('completed','attended')),
  PRIMARY KEY (legacy_event_id, user_id)
);

CREATE INDEX IF NOT EXISTS legacy_event_participants_user
  ON legacy_event_participants(user_id, legacy_event_id);
