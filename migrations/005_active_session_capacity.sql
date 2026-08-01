CREATE INDEX idx_sessions_user_recency
  ON sessions(user_id, last_seen_at DESC, created_at DESC, id DESC);

CREATE INDEX idx_sessions_expires_at
  ON sessions(expires_at);

CREATE INDEX idx_sessions_last_seen_at
  ON sessions(last_seen_at);

CREATE TRIGGER sessions_user_capacity
BEFORE INSERT ON sessions
WHEN EXISTS (
  SELECT 1
  FROM sessions
  WHERE user_id = NEW.user_id
  LIMIT 1 OFFSET 9
)
BEGIN
  SELECT RAISE(ABORT, 'active session capacity reached');
END;
