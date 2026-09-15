/**
 * Health daily coach — recovery, meals, training, pantry, logging.
 * Deterministic planning is the load-bearing path. LLM is for photos and chat.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { USER_MEDIA_DIR, REPO_ROOT } from './robotdojo-paths.js';
import { modelFor } from './model-lane.js';
import {
  DEFAULT_MACRO_TARGETS,
  ensureHealthCoachSchema,
} from './health-coach-schema.js';

export const INTELLIGENCE_TIER = 'synthesis';
export { ensureHealthCoachSchema, DEFAULT_MACRO_TARGETS };

const FOOD_ONTOLOGY_PATH = join(REPO_ROOT, 'config/health-food-ontology.json');

const RECOVERY_MARKERS = {
  hrv: ['oura_hrv', 'eight_sleep_hrv', 'hrv'],
  rhr: ['oura_rhr', 'eight_sleep_rhr', 'restingHR'],
  sleep: ['oura_total_sleep', 'eight_sleep_total_sleep'],
};

const EQUIPMENT_ALIASES = [
  ['barbell', /barbell|olympic bar|power bar/i],
  ['rack', /squat rack|power rack|half rack|cage/i],
  ['bench', /\bbench\b|incline bench/i],
  ['dumbbells', /dumbbell|db rack|free weight/i],
  ['cables', /cable|functional trainer|pulley/i],
  ['machines', /leg press|chest press|lat pulldown|smith|selectorized|machine/i],
  ['pullup', /pull-?up|chin-?up bar/i],
  ['bands', /band|trx|suspension/i],
  ['kettlebell', /kettlebell|\bkb\b/i],
  ['cardio', /treadmill|bike|rower|erg|elliptical/i],
  ['trap_bar', /trap bar|hex bar/i],
];

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function todayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(iso, delta) {
  const dt = new Date(`${iso}T12:00:00`);
  dt.setDate(dt.getDate() + delta);
  return todayIso(dt);
}

function weekdayName(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
}

function loadFoodOntology() {
  try {
    return JSON.parse(readFileSync(FOOD_ONTOLOGY_PATH, 'utf8'));
  } catch {
    return { tiers: [], chefNarrative: [], patientDrivers: [] };
  }
}

function pick(list, index) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[Math.abs(index) % list.length];
}

function hashSeed(text) {
  const hex = createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

export function scoreRecovery({ hrv, rhr, sleepHours, hrvBaseline, rhrBaseline } = {}) {
  const parts = [];
  if (Number.isFinite(hrv) && Number.isFinite(hrvBaseline) && hrvBaseline > 0) {
    const ratio = hrv / hrvBaseline;
    parts.push(Math.max(0, Math.min(100, 50 + (ratio - 1) * 120)));
  } else if (Number.isFinite(hrv)) {
    parts.push(Math.max(0, Math.min(100, (hrv / 60) * 70)));
  }
  if (Number.isFinite(rhr) && Number.isFinite(rhrBaseline) && rhrBaseline > 0) {
    const ratio = rhrBaseline / rhr;
    parts.push(Math.max(0, Math.min(100, 50 + (ratio - 1) * 150)));
  } else if (Number.isFinite(rhr)) {
    parts.push(Math.max(0, Math.min(100, 100 - Math.max(0, rhr - 50) * 2.2)));
  }
  if (Number.isFinite(sleepHours)) {
    const delta = Math.abs(sleepHours - 8);
    parts.push(Math.max(0, 100 - delta * 22));
  }
  if (!parts.length) {
    return { score: null, band: 'train', reason: 'No wearable recovery yet — training at a normal dose.' };
  }
  const score = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
  let band = 'train';
  let reason = 'Recovery is in range. Strength work at a normal dose.';
  if (score >= 72) {
    band = 'push';
    reason = 'Sleep and heart-rate variability support a hard strength day.';
  } else if (score < 45) {
    band = 'recover';
    reason = 'Recovery is low. Mobility and easy work today — protect the joints.';
  }
  return { score, band, reason };
}

export function readLatestRecovery(db, now = new Date()) {
  const latest = {};
  const baselines = {};
  const since = addDays(todayIso(now), -30);
  function latestFor(ids) {
    if (!healthTableExists(db, 'health_data_points')) return null;
    const stmt = db.prepare(`
      SELECT marker_id, date, value
      FROM health_data_points
      WHERE excluded = 0 AND marker_id = ?
      ORDER BY date DESC, id DESC
      LIMIT 1
    `);
    for (const id of ids) {
      const row = stmt.get(id);
      if (row) return row;
    }
    return null;
  }
  function baselineFor(ids) {
    if (!healthTableExists(db, 'health_data_points')) return null;
    const stmt = db.prepare(`
      SELECT AVG(value) AS avg
      FROM health_data_points
      WHERE excluded = 0 AND marker_id = ? AND date >= ?
    `);
    for (const id of ids) {
      const row = stmt.get(id, since);
      if (Number.isFinite(row?.avg)) return row.avg;
    }
    return null;
  }

  const hrvRow = latestFor(RECOVERY_MARKERS.hrv);
  const rhrRow = latestFor(RECOVERY_MARKERS.rhr);
  const sleepRow = latestFor(RECOVERY_MARKERS.sleep);
  if (hrvRow) latest.hrv = { value: hrvRow.value, date: hrvRow.date, marker: hrvRow.marker_id };
  if (rhrRow) latest.rhr = { value: rhrRow.value, date: rhrRow.date, marker: rhrRow.marker_id };
  if (sleepRow) latest.sleepHours = { value: sleepRow.value, date: sleepRow.date, marker: sleepRow.marker_id };
  baselines.hrv = baselineFor(RECOVERY_MARKERS.hrv);
  baselines.rhr = baselineFor(RECOVERY_MARKERS.rhr);

  const scored = scoreRecovery({
    hrv: latest.hrv?.value,
    rhr: latest.rhr?.value,
    sleepHours: latest.sleepHours?.value,
    hrvBaseline: baselines.hrv,
    rhrBaseline: baselines.rhr,
  });
  return {
    ...scored,
    hrv: latest.hrv || null,
    rhr: latest.rhr || null,
    sleepHours: latest.sleepHours || null,
    asOf: latest.sleepHours?.date || latest.hrv?.date || latest.rhr?.date || null,
  };
}

function healthTableExists(db, table) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } catch {
    return false;
  }
}

export function getSettings(db) {
  ensureHealthCoachSchema(db);
  const row = db.prepare('SELECT * FROM health_coach_settings WHERE id = 1').get();
  return {
    ...DEFAULT_MACRO_TARGETS,
    ...row,
    constraints: parseJson(row?.constraints_json, []),
  };
}

export function updateSettings(db, patch = {}) {
  ensureHealthCoachSchema(db);
  const current = getSettings(db);
  const next = {
    calories: Number(patch.calories ?? current.calories),
    protein_g: Number(patch.protein_g ?? current.protein_g),
    carbs_g: Number(patch.carbs_g ?? current.carbs_g),
    fat_g: Number(patch.fat_g ?? current.fat_g),
    alcohol_weekly_limit: Number(patch.alcohol_weekly_limit ?? current.alcohol_weekly_limit),
    session_minutes: Number(patch.session_minutes ?? current.session_minutes),
    active_gym_id: patch.active_gym_id === undefined ? current.active_gym_id : patch.active_gym_id,
    constraints_json: JSON.stringify(patch.constraints ?? current.constraints ?? []),
  };
  db.prepare(`
    UPDATE health_coach_settings
    SET calories=@calories, protein_g=@protein_g, carbs_g=@carbs_g, fat_g=@fat_g,
        alcohol_weekly_limit=@alcohol_weekly_limit, session_minutes=@session_minutes,
        active_gym_id=@active_gym_id, constraints_json=@constraints_json,
        updated_at=datetime('now')
    WHERE id = 1
  `).run(next);
  return getSettings(db);
}

export function listGyms(db) {
  ensureHealthCoachSchema(db);
  const settings = getSettings(db);
  return db.prepare('SELECT * FROM health_coach_gyms ORDER BY id').all().map(row => ({
    ...row,
    equipment: parseJson(row.equipment_json, []),
    active: Number(row.id) === Number(settings.active_gym_id),
  }));
}

export function upsertGym(db, gym = {}) {
  ensureHealthCoachSchema(db);
  const equipment = Array.isArray(gym.equipment) ? gym.equipment : parseJson(gym.equipment_json, []);
  if (gym.id) {
    db.prepare(`
      UPDATE health_coach_gyms
      SET name = ?, equipment_json = ?, notes = ?
      WHERE id = ?
    `).run(String(gym.name || 'Gym').trim(), JSON.stringify(equipment), String(gym.notes || ''), gym.id);
    if (gym.active) updateSettings(db, { active_gym_id: gym.id });
    return listGyms(db).find(item => Number(item.id) === Number(gym.id));
  }
  const info = db.prepare(`
    INSERT INTO health_coach_gyms (name, equipment_json, notes)
    VALUES (?, ?, ?)
  `).run(String(gym.name || 'Gym').trim(), JSON.stringify(equipment), String(gym.notes || ''));
  if (gym.active !== false) updateSettings(db, { active_gym_id: info.lastInsertRowid });
  return listGyms(db).find(item => Number(item.id) === Number(info.lastInsertRowid));
}

export function listPantry(db) {
  ensureHealthCoachSchema(db);
  return db.prepare('SELECT * FROM health_coach_pantry ORDER BY name COLLATE NOCASE').all();
}

export function upsertPantryItems(db, items = [], { usual = false, inStock = true } = {}) {
  ensureHealthCoachSchema(db);
  const stmt = db.prepare(`
    INSERT INTO health_coach_pantry (name, usual, in_stock, last_seen)
    VALUES (@name, @usual, @in_stock, @last_seen)
    ON CONFLICT(name) DO UPDATE SET
      usual = MAX(health_coach_pantry.usual, excluded.usual),
      in_stock = excluded.in_stock,
      last_seen = excluded.last_seen
  `);
  const now = todayIso();
  const tx = db.transaction((rows) => {
    for (const raw of rows) {
      const name = String(raw?.name || raw || '').trim();
      if (!name) continue;
      stmt.run({
        name,
        usual: raw.usual || usual ? 1 : 0,
        in_stock: raw.in_stock === 0 || inStock === false ? 0 : 1,
        last_seen: now,
      });
    }
  });
  tx(items);
  return listPantry(db);
}

function ontologyFoods(ontology, tierLevel, category) {
  const tier = (ontology.tiers || []).find(item => item.level === tierLevel);
  const cats = tier?.categories || {};
  return cats[category] || [];
}

function mealMacros(partial = {}) {
  return {
    calories: Number(partial.calories) || 0,
    protein_g: Number(partial.protein_g) || 0,
    carbs_g: Number(partial.carbs_g) || 0,
    fat_g: Number(partial.fat_g) || 0,
  };
}

export function buildMealPlan({ date, settings, ontology, pantryNames = [] } = {}) {
  const ont = ontology || loadFoodOntology();
  const seed = hashSeed(date || 'day');
  const proteins = ontologyFoods(ont, 1, 'Proteins');
  const veggies = ontologyFoods(ont, 1, 'Veggies');
  const fruits = ontologyFoods(ont, 1, 'Fruits');
  const fats = ontologyFoods(ont, 1, 'Fats and Oils');
  const snacks = ontologyFoods(ont, 1, 'Snacks');
  const weeklyCarbs = ontologyFoods(ont, 2, 'Carbs');
  const pantry = new Set(pantryNames.map(name => String(name).toLowerCase()));
  const prefer = (list, offset) => {
    const ranked = [...list].sort((a, b) => {
      const aHit = pantry.has(String(a).toLowerCase()) ? 1 : 0;
      const bHit = pantry.has(String(b).toLowerCase()) ? 1 : 0;
      return bHit - aHit;
    });
    return pick(ranked.length ? ranked : list, seed + offset) || 'protein';
  };

  const targets = { ...DEFAULT_MACRO_TARGETS, ...settings };
  const breakfast = {
    slot: 'breakfast',
    title: 'Breakfast',
    items: [prefer(proteins, 1), prefer(fruits, 2), prefer(fats, 3)].filter(Boolean),
    notes: 'Protein and berries. Fat buffer if the rest of the day is heavier.',
    ...mealMacros({ calories: Math.round(targets.calories * 0.22), protein_g: Math.round(targets.protein_g * 0.22), carbs_g: Math.round(targets.carbs_g * 0.18), fat_g: Math.round(targets.fat_g * 0.25) }),
  };
  const lunch = {
    slot: 'lunch',
    title: 'Lunch',
    items: [prefer(proteins, 4), prefer(veggies, 5), prefer(veggies, 6), prefer(fats, 7)].filter(Boolean),
    notes: 'Fiber and protein first. Citrus squeeze with water.',
    ...mealMacros({ calories: Math.round(targets.calories * 0.32), protein_g: Math.round(targets.protein_g * 0.32), carbs_g: Math.round(targets.carbs_g * 0.28), fat_g: Math.round(targets.fat_g * 0.3) }),
  };
  const dinnerCarbs = weeklyCarbs.length ? [prefer(weeklyCarbs, 8)] : [];
  const dinner = {
    slot: 'dinner',
    title: 'Dinner',
    items: [prefer(proteins, 9), prefer(veggies, 10), ...dinnerCarbs, prefer(fats, 11)].filter(Boolean),
    notes: dinnerCarbs.length
      ? 'Clothe the carbs — starch with olive oil or vegetables, never naked.'
      : 'High-volume vegetables, protein, olive oil.',
    ...mealMacros({ calories: Math.round(targets.calories * 0.36), protein_g: Math.round(targets.protein_g * 0.36), carbs_g: Math.round(targets.carbs_g * 0.42), fat_g: Math.round(targets.fat_g * 0.32) }),
  };
  const snack = {
    slot: 'snack',
    title: 'Snack',
    items: [prefer(fruits, 12), prefer(snacks, 13)].filter(Boolean),
    notes: 'Keep it Tier 1.',
    ...mealMacros({ calories: Math.round(targets.calories * 0.1), protein_g: Math.round(targets.protein_g * 0.1), carbs_g: Math.round(targets.carbs_g * 0.12), fat_g: Math.round(targets.fat_g * 0.13) }),
  };
  const meals = [breakfast, lunch, dinner, snack];
  const totals = meals.reduce((acc, meal) => ({
    calories: acc.calories + meal.calories,
    protein_g: acc.protein_g + meal.protein_g,
    carbs_g: acc.carbs_g + meal.carbs_g,
    fat_g: acc.fat_g + meal.fat_g,
  }), mealMacros());
  return { meals, totals, drivers: ont.patientDrivers || [], chef: (ont.chefNarrative || []).map(item => item.name) };
}

function constraintBlocks(constraints, haystack) {
  const text = String(haystack || '').toLowerCase();
  return (constraints || []).some((item) => {
    const token = String(item?.text || item || '').toLowerCase();
    if (token.length < 3) return false;
    return text.includes(token) || token.split(/\s+/).some(word => word.length > 4 && text.includes(word));
  });
}

const WORKOUT_LIBRARY = [
  { name: 'Back squat', equipment: ['barbell', 'rack'], pattern: 'squat', area: 'legs', push: true },
  { name: 'Goblet squat', equipment: ['dumbbells', 'kettlebell'], pattern: 'squat', area: 'legs', push: true },
  { name: 'Leg press', equipment: ['machines'], pattern: 'squat', area: 'legs', push: true },
  { name: 'Split squat', equipment: ['dumbbells', 'bands'], pattern: 'squat', area: 'legs', push: false },
  { name: 'Romanian deadlift', equipment: ['barbell', 'dumbbells'], pattern: 'hinge', area: 'posterior', push: true },
  { name: 'Trap-bar deadlift', equipment: ['trap_bar'], pattern: 'hinge', area: 'posterior', push: true },
  { name: 'Hip hinge with band', equipment: ['bands'], pattern: 'hinge', area: 'posterior', push: false },
  { name: 'Bench press', equipment: ['barbell', 'bench'], pattern: 'push', area: 'chest', push: true },
  { name: 'Dumbbell bench press', equipment: ['dumbbells', 'bench'], pattern: 'push', area: 'chest', push: true },
  { name: 'Push-up', equipment: [], pattern: 'push', area: 'chest', push: false },
  { name: 'Overhead press', equipment: ['barbell', 'dumbbells'], pattern: 'press', area: 'shoulders', push: true },
  { name: 'Chest-supported row', equipment: ['dumbbells', 'bench'], pattern: 'pull', area: 'back', push: true },
  { name: 'Cable row', equipment: ['cables'], pattern: 'pull', area: 'back', push: true },
  { name: 'One-arm dumbbell row', equipment: ['dumbbells'], pattern: 'pull', area: 'back', push: false },
  { name: 'Lat pulldown', equipment: ['machines', 'cables'], pattern: 'vertical-pull', area: 'back', push: true },
  { name: 'Pull-up', equipment: ['pullup'], pattern: 'vertical-pull', area: 'back', push: true },
  { name: 'Band pulldown', equipment: ['bands'], pattern: 'vertical-pull', area: 'back', push: false },
  { name: 'Walking lunge', equipment: ['dumbbells'], pattern: 'lunge', area: 'legs', push: false },
  { name: 'Calf raise', equipment: ['machines', 'dumbbells'], pattern: 'calves', area: 'legs', push: false },
  { name: 'Pallof press', equipment: ['cables', 'bands'], pattern: 'core', area: 'core', push: false },
  { name: 'Dead bug', equipment: [], pattern: 'core', area: 'core', push: false },
  { name: 'Side plank', equipment: [], pattern: 'core', area: 'core', push: false },
  { name: '90/90 hip switch', equipment: [], pattern: 'mobility', area: 'hips', push: false },
  { name: 'Couch stretch', equipment: [], pattern: 'mobility', area: 'hips', push: false },
  { name: 'T-spine open book', equipment: [], pattern: 'mobility', area: 'spine', push: false },
  { name: 'Shoulder CARs', equipment: [], pattern: 'mobility', area: 'shoulders', push: false },
  { name: 'Easy incline walk', equipment: ['cardio'], pattern: 'cardio', area: 'condition', push: false },
];

function gymHas(equipment, need) {
  if (!need || !need.length) return true;
  if (!equipment || !equipment.length) return true;
  const set = new Set(equipment.map(item => String(item).toLowerCase()));
  return need.some(item => set.has(item));
}

export function buildWorkoutPlan({ date, recovery, gym, settings, recent = [], constraints = [] } = {}) {
  const band = recovery?.band || 'train';
  const equipment = gym?.equipment || [];
  const minutes = Number(settings?.session_minutes) || 60;
  const recentNames = new Set((recent || []).flatMap(day => (day.exercises || []).map(ex => ex.name)));
  const blocked = constraints || [];

  const choose = (pattern, preferPush) => {
    const pool = WORKOUT_LIBRARY.filter(ex => ex.pattern === pattern)
      .filter(ex => gymHas(equipment, ex.equipment))
      .filter(ex => !constraintBlocks(blocked, ex.name + ' ' + ex.area));
    const fresh = pool.filter(ex => !recentNames.has(ex.name));
    const ranked = (fresh.length ? fresh : pool).sort((a, b) => {
      if (preferPush && a.push !== b.push) return a.push ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return ranked[0] || WORKOUT_LIBRARY.find(ex => ex.pattern === pattern && !ex.equipment.length);
  };

  const mobility = ['90/90 hip switch', 'Couch stretch', 'T-spine open book', 'Shoulder CARs']
    .map(name => WORKOUT_LIBRARY.find(ex => ex.name === name))
    .filter(Boolean);

  if (band === 'recover') {
    const exercises = [
      ...mobility,
      choose('core', false),
      choose('cardio', false) || { name: 'Easy walk outdoors', pattern: 'cardio', area: 'condition' },
    ].filter(Boolean).map(ex => ({
      name: ex.name,
      sets: ex.pattern === 'mobility' ? 1 : 2,
      reps: ex.pattern === 'cardio' ? '20-30 min easy' : ex.pattern === 'mobility' ? '8 slow reps/side' : '10-12',
      rest: 45,
      notes: 'Keep effort conversational. No grinding.',
    }));
    return {
      title: 'Recover — mobility and easy work',
      band,
      minutes: Math.min(40, minutes),
      currentIndex: 0,
      restSeconds: 45,
      exercises,
    };
  }

  const push = band === 'push';
  const sets = push ? 5 : 3;
  const reps = push ? '5' : '8-10';
  const rest = push ? 150 : 90;
  const dayKind = hashSeed(date) % 3;
  const patterns = dayKind === 0
    ? ['squat', 'push', 'pull', 'hinge', 'core']
    : dayKind === 1
      ? ['hinge', 'press', 'vertical-pull', 'lunge', 'core']
      : ['push', 'pull', 'squat', 'vertical-pull', 'core'];
  const main = patterns.map(pattern => choose(pattern, push)).filter(Boolean);
  const exercises = [
    ...main.map(ex => ({
      name: ex.name,
      sets,
      reps,
      rest,
      notes: push ? 'Add load if the last set stays clean.' : 'Controlled tempo, full range.',
    })),
    ...mobility.slice(0, 2).map(ex => ({
      name: ex.name,
      sets: 1,
      reps: '8 slow reps/side',
      rest: 30,
      notes: 'Protect hips, spine, and shoulders.',
    })),
  ];
  return {
    title: push ? 'Strength — push the compounds' : 'Build — muscle and control',
    band,
    minutes,
    currentIndex: 0,
    restSeconds: rest,
    exercises,
  };
}

export function shoppingListFromPlan(meals = [], pantry = []) {
  const have = new Map();
  for (const item of pantry) {
    have.set(String(item.name).toLowerCase(), item);
  }
  const needed = [];
  const covered = [];
  const seen = new Set();
  for (const meal of meals) {
    for (const raw of meal.items || []) {
      const name = String(raw).trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      const pantryHit = [...have.entries()].find(([haveName]) => key.includes(haveName) || haveName.includes(key.split('(')[0].trim()));
      if (pantryHit && pantryHit[1].in_stock) covered.push(name);
      else needed.push(name);
    }
  }
  const usualMissing = pantry.filter(item => item.usual && !item.in_stock).map(item => item.name);
  return { needed, covered, usualMissing };
}

export function estimateFromText(text, { alcohol = false } = {}) {
  const raw = String(text || '').toLowerCase();
  if (!raw.trim()) return mealMacros();
  if (alcohol || /\b(wine|beer|cocktail|whiskey|vodka|tequila|negroni|bourbon)\b/.test(raw)) {
    let units = 1;
    if (/two|2\b/.test(raw)) units = 2;
    if (/three|3\b/.test(raw)) units = 3;
    if (/bottle/.test(raw)) units = 5;
    return { ...mealMacros({ calories: Math.round(units * 120), carbs_g: Math.round(units * 4) }), alcohol_units: units };
  }
  let calories = 350;
  let protein = 28;
  let carbs = 20;
  let fat = 14;
  if (/salmon|steak|chicken|turkey|eggs|cod|halibut|bison/.test(raw)) protein += 18;
  if (/rice|potato|bread|sourdough|pasta|quinoa/.test(raw)) { carbs += 30; calories += 140; }
  if (/olive oil|avocado|nuts/.test(raw)) { fat += 12; calories += 110; }
  if (/salad|broccoli|kale|berries/.test(raw)) { carbs += 8; calories += 40; }
  if (/small|half/.test(raw)) { calories *= 0.7; protein *= 0.7; carbs *= 0.7; fat *= 0.7; }
  if (/large|big|extra/.test(raw)) { calories *= 1.25; protein *= 1.2; }
  return {
    ...mealMacros({
      calories: Math.round(calories),
      protein_g: Math.round(protein),
      carbs_g: Math.round(carbs),
      fat_g: Math.round(fat),
    }),
    alcohol_units: 0,
  };
}

export function applyConstraintText(settings, text) {
  const raw = String(text || '').trim();
  if (!raw) return { settings, applied: [] };
  const applied = [];
  const next = { ...settings, constraints: [...(settings.constraints || [])] };
  const minutes = raw.match(/(\d+)\s*(min|minute)/i);
  if (minutes) {
    next.session_minutes = Number(minutes[1]);
    applied.push(`Sessions capped at ${next.session_minutes} minutes.`);
  }
  const calories = raw.match(/(\d{3,4})\s*(kcal|calorie)/i);
  if (calories) {
    next.calories = Number(calories[1]);
    applied.push(`Calories set to ${next.calories}.`);
  }
  const protein = raw.match(/(\d{2,3})\s*g?\s*protein/i);
  if (protein) {
    next.protein_g = Number(protein[1]);
    applied.push(`Protein set to ${next.protein_g} g.`);
  }
  const skip = raw.match(/\b(no|skip|avoid|protect|hurt|injury|injured)\b(.{0,40})/i);
  if (skip) {
    const token = skip[2].replace(/[^\w\s]/g, ' ').trim().slice(0, 48);
    if (token) {
      next.constraints = [...next.constraints.filter(item => (item.text || item) !== token), { text: token, created_at: new Date().toISOString() }];
      applied.push(`Will protect / skip: ${token}.`);
    }
  }
  if (!applied.length) {
    next.constraints = [...next.constraints, { text: raw, created_at: new Date().toISOString() }];
    applied.push('Saved as a standing instruction for the next plan.');
  }
  return { settings: next, applied };
}

function rowDay(row) {
  if (!row) return null;
  return {
    date: row.date,
    status: row.status,
    recovery: parseJson(row.recovery_json, {}),
    meals: parseJson(row.meals_json, []),
    workout: parseJson(row.workout_json, {}),
    feedback: row.feedback || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getDay(db, date) {
  ensureHealthCoachSchema(db);
  return rowDay(db.prepare('SELECT * FROM health_coach_days WHERE date = ?').get(date));
}

function recentWorkouts(db, beforeDate, limit = 4) {
  const rows = db.prepare(`
    SELECT date, workout_json FROM health_coach_days
    WHERE date < ? ORDER BY date DESC LIMIT ?
  `).all(beforeDate, limit);
  return rows.map(row => parseJson(row.workout_json, {}));
}

export function ensureDayPlan(db, date = todayIso()) {
  ensureHealthCoachSchema(db);
  const existing = getDay(db, date);
  if (existing) return hydrateDay(db, existing);
  const settings = getSettings(db);
  const recovery = readLatestRecovery(db);
  const gyms = listGyms(db);
  const gym = gyms.find(item => item.active) || gyms[0] || { equipment: [] };
  const pantry = listPantry(db);
  const planned = buildMealPlan({
    date,
    settings,
    pantryNames: pantry.filter(item => item.in_stock).map(item => item.name),
  });
  const workout = buildWorkoutPlan({
    date,
    recovery,
    gym,
    settings,
    recent: recentWorkouts(db, date),
    constraints: settings.constraints,
  });
  db.prepare(`
    INSERT INTO health_coach_days (date, status, recovery_json, meals_json, workout_json)
    VALUES (?, 'draft', ?, ?, ?)
  `).run(date, JSON.stringify(recovery), JSON.stringify(planned.meals), JSON.stringify(workout));
  return hydrateDay(db, getDay(db, date));
}

function foodLogs(db, date) {
  return db.prepare('SELECT * FROM health_coach_food_logs WHERE date = ? ORDER BY created_at, id').all(date);
}

function setLogs(db, date) {
  return db.prepare('SELECT * FROM health_coach_set_logs WHERE date = ? ORDER BY id').all(date);
}

function sumLogs(logs) {
  return logs.reduce((acc, row) => ({
    calories: acc.calories + (Number(row.calories) || 0),
    protein_g: acc.protein_g + (Number(row.protein_g) || 0),
    carbs_g: acc.carbs_g + (Number(row.carbs_g) || 0),
    fat_g: acc.fat_g + (Number(row.fat_g) || 0),
    alcohol_units: acc.alcohol_units + (Number(row.alcohol_units) || 0),
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, alcohol_units: 0 });
}

export function hydrateDay(db, day) {
  if (!day) return null;
  const settings = getSettings(db);
  const logs = foodLogs(db, day.date);
  const sets = setLogs(db, day.date);
  const pantry = listPantry(db);
  const gyms = listGyms(db);
  const logged = sumLogs(logs);
  const plannedTotals = (day.meals || []).reduce((acc, meal) => ({
    calories: acc.calories + (Number(meal.calories) || 0),
    protein_g: acc.protein_g + (Number(meal.protein_g) || 0),
    carbs_g: acc.carbs_g + (Number(meal.carbs_g) || 0),
    fat_g: acc.fat_g + (Number(meal.fat_g) || 0),
  }), mealMacros());
  return {
    ...day,
    weekday: weekdayName(day.date),
    settings,
    gyms,
    pantry,
    logs,
    sets,
    logged,
    plannedTotals,
    shopping: shoppingListFromPlan(day.meals, pantry),
  };
}

export function saveDay(db, date, patch = {}) {
  const current = ensureDayPlan(db, date);
  const next = {
    status: patch.status || current.status,
    recovery_json: JSON.stringify(patch.recovery || current.recovery),
    meals_json: JSON.stringify(patch.meals || current.meals),
    workout_json: JSON.stringify(patch.workout || current.workout),
    feedback: patch.feedback !== undefined ? String(patch.feedback) : current.feedback,
  };
  db.prepare(`
    UPDATE health_coach_days
    SET status=@status, recovery_json=@recovery_json, meals_json=@meals_json,
        workout_json=@workout_json, feedback=@feedback, updated_at=datetime('now')
    WHERE date = @date
  `).run({ ...next, date });
  return hydrateDay(db, getDay(db, date));
}

export function logFood(db, entry = {}) {
  ensureHealthCoachSchema(db);
  const date = entry.date || todayIso();
  ensureDayPlan(db, date);
  const alcohol = entry.slot === 'alcohol' || Number(entry.alcohol_units) > 0;
  const guessed = estimateFromText(entry.text || entry.caption || '', { alcohol });
  const info = db.prepare(`
    INSERT INTO health_coach_food_logs
      (date, slot, text, calories, protein_g, carbs_g, fat_g, alcohol_units, photo_id, source)
    VALUES (@date, @slot, @text, @calories, @protein_g, @carbs_g, @fat_g, @alcohol_units, @photo_id, @source)
  `).run({
    date,
    slot: entry.slot || (alcohol ? 'alcohol' : 'snack'),
    text: String(entry.text || '').trim(),
    calories: entry.calories ?? guessed.calories,
    protein_g: entry.protein_g ?? guessed.protein_g,
    carbs_g: entry.carbs_g ?? guessed.carbs_g,
    fat_g: entry.fat_g ?? guessed.fat_g,
    alcohol_units: entry.alcohol_units ?? guessed.alcohol_units ?? 0,
    photo_id: entry.photo_id || null,
    source: entry.source || 'text',
  });
  return {
    id: info.lastInsertRowid,
    day: hydrateDay(db, getDay(db, date)),
  };
}

export function logSet(db, entry = {}) {
  ensureHealthCoachSchema(db);
  const date = entry.date || todayIso();
  ensureDayPlan(db, date);
  const prior = db.prepare(`
    SELECT MAX(set_index) AS n FROM health_coach_set_logs
    WHERE date = ? AND exercise = ?
  `).get(date, entry.exercise)?.n || 0;
  const info = db.prepare(`
    INSERT INTO health_coach_set_logs
      (date, exercise, set_index, weight, reps, rpe, notes)
    VALUES (@date, @exercise, @set_index, @weight, @reps, @rpe, @notes)
  `).run({
    date,
    exercise: String(entry.exercise || 'Set').trim(),
    set_index: Number(entry.set_index) || prior + 1,
    weight: entry.weight === '' || entry.weight == null ? null : Number(entry.weight),
    reps: entry.reps === '' || entry.reps == null ? null : Number(entry.reps),
    rpe: entry.rpe === '' || entry.rpe == null ? null : Number(entry.rpe),
    notes: String(entry.notes || '').trim(),
  });
  return { id: info.lastInsertRowid, day: hydrateDay(db, getDay(db, date)) };
}

export function advanceWorkout(db, date, currentIndex) {
  const day = ensureDayPlan(db, date);
  const workout = { ...day.workout, currentIndex: Math.max(0, Number(currentIndex) || 0) };
  return saveDay(db, date, { workout });
}

function mediaDir() {
  const dir = join(USER_MEDIA_DIR, 'health-coach');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function savePhotoRecord(db, { kind, mime, buffer, caption = '' }) {
  ensureHealthCoachSchema(db);
  const id = randomUUID();
  const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
  const path = join(mediaDir(), `${id}${ext}`);
  writeFileSync(path, buffer);
  db.prepare(`
    INSERT INTO health_coach_photos (id, kind, mime, path, caption, result_json)
    VALUES (?, ?, ?, ?, ?, '{}')
  `).run(id, kind, mime, path, caption);
  return { id, path, kind, mime, caption };
}

export function getPhotoFile(db, id) {
  ensureHealthCoachSchema(db);
  const row = db.prepare('SELECT * FROM health_coach_photos WHERE id = ?').get(id);
  if (!row || !existsSync(row.path)) return null;
  return row;
}

function extractEquipment(text) {
  const found = [];
  for (const [id, re] of EQUIPMENT_ALIASES) {
    if (re.test(text)) found.push(id);
  }
  return [...new Set(found)];
}

async function llmJson(system, userContent, label) {
  const { llmCreate } = await import('./llm-gateway.js');
  const resp = await llmCreate({
    model: modelFor('balanced'),
    max_tokens: 900,
    system,
    messages: [{ role: 'user', content: userContent }],
  }, label);
  const text = typeof resp === 'string'
    ? resp
    : resp?.content?.map?.(block => block.text).filter(Boolean).join('\n') || resp?.content?.[0]?.text || '';
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function interpretPhoto(db, { kind, photoId, caption = '', gymId } = {}) {
  const photo = getPhotoFile(db, photoId);
  if (!photo) throw new Error('photo_not_found');
  const buf = readFileSync(photo.path);
  const b64 = buf.toString('base64');
  const mediaType = photo.mime || 'image/jpeg';
  let result = {};
  try {
    if (kind === 'gym') {
      result = await llmJson(
        'Identify gym equipment from a photo. Return JSON only: {"equipment":["barbell"],"name":"optional gym name","notes":"one line"}. Use only ids from: barbell,rack,bench,dumbbells,cables,machines,pullup,bands,kettlebell,cardio,trap_bar. Never invent brands.',
        [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: caption || 'What equipment is visible?' },
        ],
        'health-coach-gym-photo',
      ) || { equipment: extractEquipment(caption), notes: caption };
      const gym = gymId
        ? upsertGym(db, { id: gymId, equipment: result.equipment || [], notes: result.notes || caption, name: result.name })
        : upsertGym(db, { name: result.name || 'Current gym', equipment: result.equipment || [], notes: result.notes || caption, active: true });
      result.gym = gym;
    } else if (kind === 'pantry') {
      result = await llmJson(
        'List distinct food items visible. Return JSON only: {"items":["salmon"]}. Use short grocery names. Prefer the user\'s diet ontology language when obvious (salmon, arugula, olive oil, blueberries).',
        [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: caption || 'What food is stocked?' },
        ],
        'health-coach-pantry-photo',
      ) || { items: String(caption).split(/[,;\n]/).map(s => s.trim()).filter(Boolean) };
      const names = (result.items || []).map(name => ({ name, usual: true, in_stock: true }));
      result.pantry = upsertPantryItems(db, names, { usual: true, inStock: true });
    } else if (kind === 'body') {
      result = await llmJson(
        'Estimate physique from a photo for personal training. Return JSON only: {"body_fat_pct":number,"muscle":"low|moderate|high","symmetry_notes":"one sentence","focus":["area"]}. This is a rough visual estimate, not a DEXA. If the photo is not a body composition photo, say so in symmetry_notes and omit numbers.',
        [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: caption || 'Estimate physique balance. Be conservative.' },
        ],
        'health-coach-body-photo',
      ) || { symmetry_notes: 'Could not estimate. Try a standing photo in even light.' };
    } else {
      result = await llmJson(
        'Estimate the meal macros. Return JSON only: {"text":"short description","calories":number,"protein_g":number,"carbs_g":number,"fat_g":number,"slot":"breakfast|lunch|dinner|snack"}. Prefer the user caption if present.',
        [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: caption || 'What is on the plate? Estimate macros.' },
        ],
        'health-coach-meal-photo',
      ) || { ...estimateFromText(caption), text: caption, slot: 'snack' };
      const logged = logFood(db, {
        ...result,
        text: result.text || caption,
        photo_id: photoId,
        source: 'photo',
      });
      result.log = logged;
    }
  } catch (err) {
    result = { error: err.message || 'interpret_failed', fallback: estimateFromText(caption) };
    if (kind === 'meal' || kind === 'food') {
      result.log = logFood(db, { ...result.fallback, text: caption, photo_id: photoId, source: 'photo' });
    }
  }
  db.prepare('UPDATE health_coach_photos SET caption = ?, result_json = ? WHERE id = ?')
    .run(caption, JSON.stringify(result), photoId);
  return result;
}

export async function applyChat(db, text, date = todayIso()) {
  const settings = getSettings(db);
  const local = applyConstraintText(settings, text);
  updateSettings(db, local.settings);
  db.prepare('DELETE FROM health_coach_days WHERE date >= ? AND status = ?').run(date, 'draft');
  const day = ensureDayPlan(db, date);
  let reply = local.applied.join(' ');
  try {
    const extra = await llmJson(
      'You update a personal training and meal coach. The user typed a constraint or goal. Return JSON only: {"reply":"one short sentence confirming what will change","calories":null,"protein_g":null,"session_minutes":null,"constraint":"optional short token to skip/protect"}. Numbers only when the user named them.',
      `User: ${text}\nCurrent: ${JSON.stringify({
        calories: settings.calories,
        protein_g: settings.protein_g,
        session_minutes: settings.session_minutes,
        constraints: settings.constraints,
      })}`,
      'health-coach-chat',
    );
    if (extra?.reply) reply = extra.reply;
    const patch = {};
    if (Number.isFinite(extra?.calories)) patch.calories = extra.calories;
    if (Number.isFinite(extra?.protein_g)) patch.protein_g = extra.protein_g;
    if (Number.isFinite(extra?.session_minutes)) patch.session_minutes = extra.session_minutes;
    if (extra?.constraint) {
      const current = getSettings(db);
      patch.constraints = [...(current.constraints || []), { text: extra.constraint, created_at: new Date().toISOString() }];
    }
    if (Object.keys(patch).length) {
      updateSettings(db, patch);
      db.prepare('DELETE FROM health_coach_days WHERE date >= ? AND status = ?').run(date, 'draft');
    }
  } catch {
    // Heuristic reply is enough.
  }
  return { reply, day: hydrateDay(db, getDay(db, date)) || ensureDayPlan(db, date) };
}

export function getTodayPayload(db, date = todayIso()) {
  const day = ensureDayPlan(db, date);
  const week = [];
  for (let i = 0; i < 7; i += 1) {
    const iso = addDays(date, i);
    const existing = getDay(db, iso);
    week.push(existing
      ? { date: iso, weekday: weekdayName(iso), status: existing.status, title: existing.workout?.title, band: existing.recovery?.band }
      : { date: iso, weekday: weekdayName(iso), status: 'none' });
  }
  const weekLogs = db.prepare(`
    SELECT date, COALESCE(SUM(alcohol_units),0) AS units
    FROM health_coach_food_logs
    WHERE date >= ? AND date <= ?
    GROUP BY date
  `).all(addDays(date, -6), date);
  return {
    day,
    week,
    alcoholWeek: weekLogs,
    ontologyTitle: loadFoodOntology().title || 'Personal diet',
  };
}

export async function readUploadBuffer(file) {
  if (!file) return null;
  if (typeof file.arrayBuffer === 'function') {
    const ab = await file.arrayBuffer();
    return Buffer.from(ab);
  }
  if (Buffer.isBuffer(file)) return file;
  return null;
}

export function photoExt(filename = '') {
  const ext = extname(String(filename)).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.heic'].includes(ext)) return ext;
  return '.jpg';
}
