CREATE TABLE schools (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  product_name TEXT NOT NULL DEFAULT 'VECTOR',
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  primary_color TEXT NOT NULL DEFAULT '#17324d',
  accent_color TEXT NOT NULL DEFAULT '#ff6b56',
  surface_color TEXT NOT NULL DEFAULT '#f5efe5',
  logo_mime TEXT CHECK (logo_mime IS NULL OR logo_mime = 'image/png'),
  logo_blob BLOB,
  support_email TEXT,
  contact_text TEXT NOT NULL DEFAULT 'Contact your school placement office for access and support.',
  footer_text TEXT NOT NULL DEFAULT 'Self-hosted placement operations.',
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days >= 30),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('school_admin', 'coordinator', 'tutor', 'viewer')),
  data_scope TEXT NOT NULL CHECK (data_scope IN ('school', 'assigned')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (school_id, email),
  CHECK (
    (role IN ('school_admin', 'coordinator') AND data_scope = 'school')
    OR (role = 'tutor' AND data_scope = 'assigned')
    OR (role = 'viewer' AND data_scope = 'school')
  )
) STRICT;

CREATE TABLE cohorts (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  academic_year TEXT NOT NULL,
  track TEXT NOT NULL DEFAULT '',
  tutor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (school_id, name, academic_year)
) STRICT;

CREATE TABLE students (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  cohort_id TEXT REFERENCES cohorts(id) ON DELETE SET NULL,
  external_ref TEXT COLLATE NOCASE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  retention_hold INTEGER NOT NULL DEFAULT 0 CHECK (retention_hold IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (school_id, external_ref)
) STRICT;

CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  sector TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT,
  contact_phone TEXT,
  address TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (school_id, name)
) STRICT;

CREATE TABLE placement_periods (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (date(start_date) IS NOT NULL),
  CHECK (date(end_date) IS NOT NULL),
  CHECK (end_date >= start_date),
  UNIQUE (school_id, name)
) STRICT;

CREATE TABLE placements (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
  period_id TEXT REFERENCES placement_periods(id) ON DELETE SET NULL,
  school_tutor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  host_tutor_name TEXT NOT NULL DEFAULT '',
  host_tutor_email TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  target_minutes INTEGER NOT NULL CHECK (target_minutes > 0 AND target_minutes <= 120000),
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'review', 'complete', 'cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (date(start_date) IS NOT NULL),
  CHECK (date(end_date) IS NOT NULL),
  CHECK (end_date >= start_date),
  UNIQUE (school_id, student_id, start_date, host_id)
) STRICT;

CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  minutes INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  description TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (date(entry_date) IS NOT NULL)
) STRICT;

CREATE TABLE check_ins (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_person', 'phone', 'email', 'video', 'other')),
  summary TEXT NOT NULL,
  next_action TEXT NOT NULL DEFAULT '',
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
  void_reason TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE placement_documents (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'training_agreement',
      'attendance_log',
      'evaluation',
      'completion_certificate',
      'other'
    )
  ),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('missing', 'draft', 'ready', 'signed', 'archived')),
  reference TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  superseded_at TEXT,
  superseded_by_id TEXT REFERENCES placement_documents(id) ON DELETE SET NULL,
  supersede_reason_code TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (due_date IS NULL OR date(due_date) IS NOT NULL)
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at TEXT NOT NULL,
  CHECK (json_valid(metadata_json))
) STRICT;

CREATE INDEX idx_users_school_role ON users(school_id, role, active);
CREATE INDEX idx_students_school_cohort ON students(school_id, cohort_id, active);
CREATE INDEX idx_students_retention ON students(school_id, active, retention_hold, updated_at);
CREATE INDEX idx_hosts_school_active ON hosts(school_id, active);
CREATE INDEX idx_periods_school_dates ON placement_periods(school_id, start_date, end_date);
CREATE INDEX idx_placements_school_status ON placements(school_id, status);
CREATE INDEX idx_placements_tutor ON placements(school_id, school_tutor_id);
CREATE INDEX idx_placements_student ON placements(student_id);
CREATE INDEX idx_time_entries_placement_date ON time_entries(placement_id, entry_date);
CREATE INDEX idx_check_ins_placement_date ON check_ins(placement_id, occurred_at);
CREATE INDEX idx_documents_placement_status ON placement_documents(placement_id, status);
CREATE UNIQUE INDEX idx_documents_singleton_kind
  ON placement_documents(school_id, placement_id, kind)
  WHERE kind != 'other' AND superseded_at IS NULL;
CREATE INDEX idx_sessions_token ON sessions(token_hash, expires_at);
CREATE INDEX idx_audit_school_created ON audit_events(school_id, created_at DESC, id DESC);

CREATE TRIGGER audit_events_immutable_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_immutable_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
