-- Replace the old zero-padded sequential codes while preserving ticket IDs and bearer tokens.
DROP INDEX tickets_checkin_code;

WITH random_codes AS (
  SELECT id, printf('%08d', 10000000 + ((random() & 9223372036854775807) % 90000000)) AS code
  FROM tickets
)
UPDATE tickets
SET checkin_code = (SELECT code FROM random_codes WHERE random_codes.id = tickets.id);

CREATE UNIQUE INDEX tickets_checkin_code ON tickets(checkin_code);
