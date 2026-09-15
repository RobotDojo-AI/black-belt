CREATE TABLE IF NOT EXISTS photos (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  filename     TEXT NOT NULL DEFAULT '',
  mime_type    TEXT NOT NULL DEFAULT '',
  creation_time TEXT,
  width        INTEGER,
  height       INTEGER,
  latitude     REAL,
  longitude    REAL,
  camera_make  TEXT,
  camera_model TEXT,
  product_url  TEXT,
  description  TEXT,
  indexed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_account   ON photos(account_id);
CREATE INDEX IF NOT EXISTS idx_photos_creation  ON photos(creation_time);
CREATE INDEX IF NOT EXISTS idx_photos_location  ON photos(latitude, longitude) WHERE latitude IS NOT NULL;
