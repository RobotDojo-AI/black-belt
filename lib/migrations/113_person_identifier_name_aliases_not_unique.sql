-- st_entity_quality_name_aliases (2026-06-26)
--
-- person_identifiers(type,value) was globally UNIQUE. That is correct for
-- hard identifiers such as email/phone, but wrong for type='name': many real
-- humans can share the same name or alias. Rebuild the table without the table
-- constraint, then restore uniqueness for non-name identifiers through a
-- partial unique index.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS person_identifiers_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  value       TEXT NOT NULL,
  is_primary  INTEGER DEFAULT 0,
  source      TEXT DEFAULT 'unknown',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO person_identifiers_new
  (id, person_id, type, value, is_primary, source, created_at)
SELECT id, person_id, type, value, is_primary, source, created_at
FROM person_identifiers;

DROP TABLE person_identifiers;
ALTER TABLE person_identifiers_new RENAME TO person_identifiers;

CREATE INDEX IF NOT EXISTS idx_pid_person ON person_identifiers(person_id);
CREATE INDEX IF NOT EXISTS idx_pid_type_value ON person_identifiers(type, value);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pid_unique_non_name
  ON person_identifiers(type, value)
  WHERE type != 'name';

CREATE UNIQUE INDEX IF NOT EXISTS idx_pid_unique_name_per_person
  ON person_identifiers(person_id, type, value)
  WHERE type = 'name';

CREATE INDEX IF NOT EXISTS idx_pi_lower_value
  ON person_identifiers(LOWER(value))
  WHERE type = 'email';

PRAGMA foreign_keys = ON;
