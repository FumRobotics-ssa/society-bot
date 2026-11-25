ALTER TABLE event_question_settings ADD COLUMN max_questions INTEGER NOT NULL DEFAULT 3
  CHECK (max_questions IN (1,2,3));

CREATE INDEX event_questions_by_attendee ON event_questions(event_id,user_id);
