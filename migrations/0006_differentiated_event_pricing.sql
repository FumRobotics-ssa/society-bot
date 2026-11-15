ALTER TABLE events ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'fixed'
  CHECK (pricing_mode IN ('fixed','differentiated'));
ALTER TABLE events ADD COLUMN fum_student_price INTEGER NOT NULL DEFAULT 0
  CHECK (fum_student_price BETWEEN 0 AND 1000000000000);

ALTER TABLE orders ADD COLUMN pricing_group TEXT NOT NULL DEFAULT 'fixed'
  CHECK (pricing_group IN ('fixed','general','fum_student'));
