CREATE INDEX idx_time_entries_placement_detail
  ON time_entries(placement_id, entry_date DESC, created_at DESC, id);

CREATE INDEX idx_check_ins_placement_detail
  ON check_ins(placement_id, occurred_at DESC, id);

CREATE INDEX idx_documents_placement_detail
  ON placement_documents(placement_id, (due_date IS NULL), due_date, title, id);

CREATE INDEX idx_documents_placement_fingerprint
  ON placement_documents(placement_id, kind, id);

CREATE TRIGGER time_entries_placement_capacity
BEFORE INSERT ON time_entries
WHEN EXISTS (
  SELECT 1
  FROM time_entries
  WHERE placement_id = NEW.placement_id
  LIMIT 1 OFFSET 499
)
BEGIN
  SELECT RAISE(ABORT, 'placement time-entry capacity reached');
END;

CREATE TRIGGER check_ins_placement_capacity
BEFORE INSERT ON check_ins
WHEN EXISTS (
  SELECT 1
  FROM check_ins
  WHERE placement_id = NEW.placement_id
  LIMIT 1 OFFSET 199
)
BEGIN
  SELECT RAISE(ABORT, 'placement check-in capacity reached');
END;

CREATE TRIGGER documents_placement_capacity
BEFORE INSERT ON placement_documents
WHEN EXISTS (
  SELECT 1
  FROM placement_documents
  WHERE placement_id = NEW.placement_id
  LIMIT 1 OFFSET 199
)
BEGIN
  SELECT RAISE(ABORT, 'placement document capacity reached');
END;
