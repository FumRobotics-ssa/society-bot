CREATE TABLE support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_review','waiting_user','closed')),
  assigned_to INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX support_tickets_inbox ON support_tickets(status,updated_at DESC,id DESC);
CREATE INDEX support_tickets_recent ON support_tickets(updated_at DESC,id DESC);

CREATE TABLE support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user','admin')),
  actor_id INTEGER NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL DEFAULT '' CHECK (length(text)<=1000),
  file_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (text<>'' OR file_id<>'')
);
CREATE INDEX support_messages_thread ON support_messages(ticket_id,id DESC);
