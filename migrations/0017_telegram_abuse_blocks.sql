CREATE TABLE IF NOT EXISTS telegram_abuse_blocks (
  stream_key TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL,
  repeated_count INTEGER NOT NULL,
  blocked_at INTEGER NOT NULL DEFAULT (unixepoch()),
  unblocked_at INTEGER
);
