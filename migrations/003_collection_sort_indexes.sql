CREATE INDEX idx_students_school_name
  ON students(school_id, LOWER(last_name), LOWER(first_name), id);

CREATE INDEX idx_hosts_school_name
  ON hosts(school_id, LOWER(name), id);
