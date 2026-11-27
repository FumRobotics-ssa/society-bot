ALTER TABLE inbox ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE INDEX outbox_active ON outbox(status) WHERE status IN ('pending','processing');
CREATE INDEX outbox_ready ON outbox(available_at,created_at,id) WHERE status='pending';
CREATE INDEX outbox_processing ON outbox(lease_until) WHERE status='processing';
CREATE INDEX inbox_failed_retention ON inbox(created_at) WHERE status='failed';
CREATE INDEX outbox_failed_retention ON outbox(created_at) WHERE status='failed';
