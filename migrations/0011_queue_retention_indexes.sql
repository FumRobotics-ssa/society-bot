-- Only completed jobs are eligible for the seven-day cleanup.
CREATE INDEX IF NOT EXISTS inbox_retention ON inbox(status, processed_at) WHERE status = 'done';
CREATE INDEX IF NOT EXISTS outbox_retention ON outbox(status, sent_at) WHERE status = 'sent';
