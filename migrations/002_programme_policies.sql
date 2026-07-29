CREATE TABLE programmes (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (school_id, code),
  UNIQUE (school_id, name)
) STRICT;

CREATE TABLE programme_versions (
  id TEXT PRIMARY KEY,
  programme_id TEXT NOT NULL REFERENCES programmes(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  default_target_minutes INTEGER NOT NULL
    CHECK (default_target_minutes > 0 AND default_target_minutes <= 120000),
  minimum_check_ins INTEGER NOT NULL DEFAULT 1
    CHECK (minimum_check_ins >= 0 AND minimum_check_ins <= 100),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  published_at TEXT NOT NULL,
  UNIQUE (programme_id, version)
) STRICT;

CREATE TABLE programme_requirements (
  id TEXT PRIMARY KEY,
  programme_version_id TEXT NOT NULL REFERENCES programme_versions(id) ON DELETE RESTRICT,
  code TEXT NOT NULL COLLATE NOCASE,
  label TEXT NOT NULL,
  accepted_statuses_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0 AND sort_order <= 1000),
  CHECK (json_valid(accepted_statuses_json)),
  CHECK (json_type(accepted_statuses_json) = 'array'),
  UNIQUE (programme_version_id, code),
  UNIQUE (programme_version_id, sort_order)
) STRICT;

ALTER TABLE placements
  ADD COLUMN programme_version_id TEXT REFERENCES programme_versions(id) ON DELETE RESTRICT;

ALTER TABLE placement_documents
  ADD COLUMN requirement_id TEXT REFERENCES programme_requirements(id) ON DELETE RESTRICT;

INSERT INTO programmes (
  id, school_id, code, name, description, active, revision, created_at, updated_at
)
SELECT
  'programme_default_' || id,
  id,
  'VECTOR_DEFAULT',
  'VECTOR default',
  'Compatibility policy matching the VECTOR 3.0 readiness contract.',
  1,
  1,
  created_at,
  updated_at
FROM schools;

INSERT INTO programme_versions (
  id, programme_id, version, default_target_minutes, minimum_check_ins, created_by, published_at
)
SELECT
  'programme_version_default_' || id,
  'programme_default_' || id,
  1,
  9600,
  1,
  NULL,
  created_at
FROM schools;

INSERT INTO programme_requirements (
  id, programme_version_id, code, label, accepted_statuses_json, sort_order
)
SELECT
  'requirement_training_' || id,
  'programme_version_default_' || id,
  'training_agreement',
  'Signed training agreement',
  '["signed","archived"]',
  10
FROM schools
UNION ALL
SELECT
  'requirement_attendance_' || id,
  'programme_version_default_' || id,
  'attendance_log',
  'Signed attendance log',
  '["signed","archived"]',
  20
FROM schools
UNION ALL
SELECT
  'requirement_evaluation_' || id,
  'programme_version_default_' || id,
  'evaluation',
  'Completed evaluation',
  '["ready","signed","archived"]',
  30
FROM schools;

UPDATE placements
SET programme_version_id = 'programme_version_default_' || school_id
WHERE programme_version_id IS NULL;

UPDATE placement_documents
SET requirement_id = CASE kind
  WHEN 'training_agreement' THEN 'requirement_training_' || school_id
  WHEN 'attendance_log' THEN 'requirement_attendance_' || school_id
  WHEN 'evaluation' THEN 'requirement_evaluation_' || school_id
  ELSE NULL
END
WHERE requirement_id IS NULL;

CREATE INDEX idx_programmes_school_active
  ON programmes(school_id, active, code);
CREATE INDEX idx_programme_versions_programme
  ON programme_versions(programme_id, version DESC);
CREATE INDEX idx_programme_requirements_version
  ON programme_requirements(programme_version_id, sort_order);
CREATE INDEX idx_placements_programme_version
  ON placements(programme_version_id);
CREATE UNIQUE INDEX idx_documents_active_requirement
  ON placement_documents(placement_id, requirement_id)
  WHERE requirement_id IS NOT NULL AND superseded_at IS NULL;

CREATE TRIGGER programmes_capacity_insert
BEFORE INSERT ON programmes
WHEN (
  SELECT COUNT(*)
  FROM programmes
  WHERE school_id = NEW.school_id
) >= 200
BEGIN
  SELECT RAISE(ABORT, 'programme capacity reached');
END;

CREATE TRIGGER programme_versions_capacity_insert
BEFORE INSERT ON programme_versions
WHEN (
  SELECT COUNT(*)
  FROM programme_versions
  WHERE programme_id = NEW.programme_id
) >= 100
BEGIN
  SELECT RAISE(ABORT, 'programme version capacity reached');
END;

CREATE TRIGGER placements_freeze_programme_policy
BEFORE UPDATE OF programme_version_id ON placements
WHEN NEW.programme_version_id <> OLD.programme_version_id
  AND (
    EXISTS (
      SELECT 1
      FROM time_entries
      WHERE placement_id = OLD.id AND school_id = OLD.school_id
    )
    OR EXISTS (
      SELECT 1
      FROM check_ins
      WHERE placement_id = OLD.id AND school_id = OLD.school_id
    )
    OR EXISTS (
      SELECT 1
      FROM placement_documents
      WHERE placement_id = OLD.id
        AND school_id = OLD.school_id
        AND (
          requirement_id IS NULL
          OR status <> 'missing'
          OR reference <> ''
          OR revision <> 1
          OR superseded_at IS NOT NULL
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'programme policy is frozen after recorded activity');
END;

CREATE TRIGGER programme_versions_immutable_update
BEFORE UPDATE ON programme_versions
BEGIN
  SELECT RAISE(ABORT, 'programme versions are immutable');
END;

CREATE TRIGGER programme_versions_immutable_delete
BEFORE DELETE ON programme_versions
BEGIN
  SELECT RAISE(ABORT, 'programme versions are immutable');
END;

CREATE TRIGGER programme_requirements_immutable_update
BEFORE UPDATE ON programme_requirements
BEGIN
  SELECT RAISE(ABORT, 'programme requirements are immutable');
END;

CREATE TRIGGER programme_requirements_immutable_delete
BEFORE DELETE ON programme_requirements
BEGIN
  SELECT RAISE(ABORT, 'programme requirements are immutable');
END;

CREATE TRIGGER placements_require_programme_insert
BEFORE INSERT ON placements
WHEN NEW.programme_version_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'placements require a programme version');
END;

CREATE TRIGGER placements_require_programme_update
BEFORE UPDATE OF programme_version_id ON placements
WHEN NEW.programme_version_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'placements require a programme version');
END;

CREATE TRIGGER placements_validate_programme_insert
BEFORE INSERT ON placements
WHEN NOT EXISTS (
  SELECT 1
  FROM programme_versions pv
  JOIN programmes p ON p.id = pv.programme_id
  WHERE pv.id = NEW.programme_version_id
    AND p.school_id = NEW.school_id
)
BEGIN
  SELECT RAISE(ABORT, 'programme version belongs to another school');
END;

CREATE TRIGGER placements_validate_programme_update
BEFORE UPDATE OF programme_version_id, school_id ON placements
WHEN NOT EXISTS (
  SELECT 1
  FROM programme_versions pv
  JOIN programmes p ON p.id = pv.programme_id
  WHERE pv.id = NEW.programme_version_id
    AND p.school_id = NEW.school_id
)
BEGIN
  SELECT RAISE(ABORT, 'programme version belongs to another school');
END;

CREATE TRIGGER documents_validate_requirement_insert
BEFORE INSERT ON placement_documents
WHEN NEW.requirement_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM placements p
    JOIN programme_requirements pr
      ON pr.programme_version_id = p.programme_version_id
    WHERE p.id = NEW.placement_id
      AND p.school_id = NEW.school_id
      AND pr.id = NEW.requirement_id
  )
BEGIN
  SELECT RAISE(ABORT, 'document requirement does not belong to the placement programme');
END;

CREATE TRIGGER documents_validate_requirement_update
BEFORE UPDATE OF requirement_id, placement_id, school_id ON placement_documents
WHEN NEW.requirement_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM placements p
    JOIN programme_requirements pr
      ON pr.programme_version_id = p.programme_version_id
    WHERE p.id = NEW.placement_id
      AND p.school_id = NEW.school_id
      AND pr.id = NEW.requirement_id
  )
BEGIN
  SELECT RAISE(ABORT, 'document requirement does not belong to the placement programme');
END;

CREATE TRIGGER schools_seed_default_programme
AFTER INSERT ON schools
BEGIN
  INSERT INTO programmes (
    id, school_id, code, name, description, active, revision, created_at, updated_at
  ) VALUES (
    'programme_default_' || NEW.id,
    NEW.id,
    'VECTOR_DEFAULT',
    'VECTOR default',
    'Compatibility policy matching the VECTOR 3.0 readiness contract.',
    1,
    1,
    NEW.created_at,
    NEW.updated_at
  );

  INSERT INTO programme_versions (
    id, programme_id, version, default_target_minutes, minimum_check_ins, created_by, published_at
  ) VALUES (
    'programme_version_default_' || NEW.id,
    'programme_default_' || NEW.id,
    1,
    9600,
    1,
    NULL,
    NEW.created_at
  );

  INSERT INTO programme_requirements (
    id, programme_version_id, code, label, accepted_statuses_json, sort_order
  ) VALUES
    (
      'requirement_training_' || NEW.id,
      'programme_version_default_' || NEW.id,
      'training_agreement',
      'Signed training agreement',
      '["signed","archived"]',
      10
    ),
    (
      'requirement_attendance_' || NEW.id,
      'programme_version_default_' || NEW.id,
      'attendance_log',
      'Signed attendance log',
      '["signed","archived"]',
      20
    ),
    (
      'requirement_evaluation_' || NEW.id,
      'programme_version_default_' || NEW.id,
      'evaluation',
      'Completed evaluation',
      '["ready","signed","archived"]',
      30
    );
END;
