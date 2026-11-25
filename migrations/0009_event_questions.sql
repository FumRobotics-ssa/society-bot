CREATE TABLE event_question_settings (
  event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  closes_at INTEGER,
  CHECK (enabled=0 OR (closes_at IS NOT NULL AND closes_at>0))
);

CREATE TABLE event_questions (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_key TEXT NOT NULL UNIQUE,
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 1000),
  topic TEXT NOT NULL DEFAULT '' CHECK (length(topic)<=100),
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX event_questions_by_event ON event_questions(event_id,id DESC);
CREATE INDEX event_questions_export ON event_questions(event_id,topic,id) WHERE selected=1;
