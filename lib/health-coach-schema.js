/**
 * Schema for the Health daily coach (meals, training, pantry, gyms, logs).
 * Keep this file free of db.js and llm imports so migrate() can load it.
 */
export const INTELLIGENCE_TIER = 'structure';

export const HEALTH_COACH_SETTINGS_ID = 1;

export const DEFAULT_MACRO_TARGETS = Object.freeze({
  calories: 2200,
  protein_g: 170,
  carbs_g: 160,
  fat_g: 75,
  alcohol_weekly_limit: 7,
  session_minutes: 60,
});

export function ensureHealthCoachSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_coach_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      calories INTEGER NOT NULL DEFAULT 2200,
      protein_g INTEGER NOT NULL DEFAULT 170,
      carbs_g INTEGER NOT NULL DEFAULT 160,
      fat_g INTEGER NOT NULL DEFAULT 75,
      alcohol_weekly_limit REAL NOT NULL DEFAULT 7,
      session_minutes INTEGER NOT NULL DEFAULT 60,
      active_gym_id INTEGER,
      constraints_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS health_coach_gyms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      equipment_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS health_coach_pantry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      usual INTEGER NOT NULL DEFAULT 0,
      in_stock INTEGER NOT NULL DEFAULT 1,
      last_seen TEXT,
      UNIQUE(name COLLATE NOCASE)
    );

    CREATE TABLE IF NOT EXISTS health_coach_days (
      date TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'draft',
      recovery_json TEXT NOT NULL DEFAULT '{}',
      meals_json TEXT NOT NULL DEFAULT '[]',
      workout_json TEXT NOT NULL DEFAULT '{}',
      feedback TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS health_coach_food_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      slot TEXT NOT NULL DEFAULT 'snack',
      text TEXT NOT NULL DEFAULT '',
      calories REAL,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      alcohol_units REAL,
      photo_id TEXT,
      source TEXT NOT NULL DEFAULT 'text',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS health_coach_set_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      exercise TEXT NOT NULL,
      set_index INTEGER NOT NULL DEFAULT 1,
      weight REAL,
      reps INTEGER,
      rpe REAL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS health_coach_photos (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      mime TEXT NOT NULL,
      path TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_health_coach_food_date
      ON health_coach_food_logs(date, created_at);
    CREATE INDEX IF NOT EXISTS idx_health_coach_sets_date
      ON health_coach_set_logs(date, exercise, set_index);
  `);

  const settings = db.prepare('SELECT id FROM health_coach_settings WHERE id = 1').get();
  if (!settings) {
    db.prepare(`
      INSERT INTO health_coach_settings
        (id, calories, protein_g, carbs_g, fat_g, alcohol_weekly_limit, session_minutes, constraints_json)
      VALUES (1, @calories, @protein_g, @carbs_g, @fat_g, @alcohol_weekly_limit, @session_minutes, '[]')
    `).run(DEFAULT_MACRO_TARGETS);
  }

  const gymCount = db.prepare('SELECT COUNT(*) AS n FROM health_coach_gyms').get()?.n || 0;
  if (!gymCount) {
    const info = db.prepare(`
      INSERT INTO health_coach_gyms (name, equipment_json, notes)
      VALUES (?, '[]', ?)
    `).run('Current gym', 'Photograph the floor and rack so the plan uses what is actually here.');
    db.prepare('UPDATE health_coach_settings SET active_gym_id = ? WHERE id = 1').run(info.lastInsertRowid);
  }
}
