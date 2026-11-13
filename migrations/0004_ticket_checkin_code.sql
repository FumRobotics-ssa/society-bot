ALTER TABLE tickets ADD COLUMN checkin_code TEXT;

WITH numbered_tickets AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS code_number
  FROM tickets
)
UPDATE tickets
SET checkin_code = printf('%08d', (
  SELECT code_number FROM numbered_tickets WHERE numbered_tickets.id = tickets.id
))
WHERE checkin_code IS NULL;

CREATE UNIQUE INDEX tickets_checkin_code ON tickets(checkin_code);
