-- Auto-created import markers are review-needed lab values, not a separate
-- user-facing health group. Reviewability lives on health_markers.auto_created.

INSERT OR IGNORE INTO health_groups (id, name, description)
VALUES ('labs', 'Lab Results', 'Blood and clinical laboratory results');

UPDATE health_markers
SET group_id = 'labs'
WHERE group_id = 'auto_imported';

DELETE FROM health_groups
WHERE id = 'auto_imported';
