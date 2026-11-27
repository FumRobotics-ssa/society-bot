ALTER TABLE events ADD COLUMN pending_booking_limit INTEGER CHECK (pending_booking_limit > 0);

CREATE INDEX IF NOT EXISTS orders_pending_capacity ON orders(event_id,expires_at)
WHERE status IN ('reserved','pending');
