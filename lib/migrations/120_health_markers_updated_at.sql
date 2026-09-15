-- Marker ontology edits affect health intelligence. Track marker-level changes
-- so cached intel stales when labels, groups, ranges, targets, or review flags
-- change.

ALTER TABLE health_markers ADD COLUMN updated_at TEXT;

UPDATE health_markers
SET updated_at = datetime('now')
WHERE updated_at IS NULL OR updated_at = '';

CREATE TRIGGER IF NOT EXISTS trg_health_markers_updated_at_insert
AFTER INSERT ON health_markers
FOR EACH ROW
WHEN NEW.updated_at IS NULL OR NEW.updated_at = ''
BEGIN
  UPDATE health_markers
  SET updated_at = datetime('now')
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_health_markers_updated_at_update
AFTER UPDATE OF
  name,
  unit,
  group_id,
  view,
  ref_low,
  ref_high,
  target,
  trend,
  description,
  recommendations,
  auto_created
ON health_markers
FOR EACH ROW
BEGIN
  UPDATE health_markers
  SET updated_at = datetime('now')
  WHERE id = NEW.id;
END;
