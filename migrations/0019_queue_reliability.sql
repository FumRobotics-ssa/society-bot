ALTER TABLE inbox ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

ALTER TABLE outbox ADD COLUMN queue_lane TEXT GENERATED ALWAYS AS (
  CASE
    WHEN method='editMessageMedia' OR (method='sendPhoto' AND dedupe_key LIKE 'update:%:photo') THEN 'poster'
    WHEN method IN ('sendPhoto','sendDocument') THEN 'media'
    WHEN method IN ('__broadcast','__backup') OR (method='sendMessage' AND dedupe_key LIKE '%:user:%') THEN 'bulk'
    ELSE 'interactive'
  END
) VIRTUAL;

CREATE INDEX outbox_active ON outbox(created_at) WHERE status IN ('pending','processing');
CREATE INDEX outbox_ready_lane ON outbox(queue_lane,available_at,created_at,id) WHERE status='pending';
CREATE INDEX outbox_processing_lane ON outbox(queue_lane,lease_until) WHERE status='processing';
CREATE INDEX inbox_failed_retention ON inbox(created_at) WHERE status='failed';
CREATE INDEX outbox_failed_retention ON outbox(created_at) WHERE status='failed';

CREATE TABLE queue_control (
  name TEXT PRIMARY KEY,
  paused INTEGER NOT NULL CHECK (paused IN (0,1))
);
INSERT INTO queue_control(name,paused) VALUES ('outbox',0);
