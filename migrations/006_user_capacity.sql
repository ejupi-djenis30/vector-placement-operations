CREATE INDEX idx_users_school_listing
  ON users(school_id, active DESC, display_name COLLATE NOCASE, id);

CREATE TRIGGER users_school_capacity
BEFORE INSERT ON users
WHEN EXISTS (
  SELECT 1
  FROM users
  WHERE school_id = NEW.school_id
  LIMIT 1 OFFSET 499
)
BEGIN
  SELECT RAISE(ABORT, 'user capacity reached');
END;
