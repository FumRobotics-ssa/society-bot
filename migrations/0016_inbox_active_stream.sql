CREATE INDEX IF NOT EXISTS inbox_stream_active ON inbox(stream_key,update_id)
WHERE status IN ('new','processing');
