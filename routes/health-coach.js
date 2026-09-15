/**
 * Health daily coach API — today, meals, training, pantry, gyms, photos, chat.
 */
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import db from '../lib/db.js';
import {
  advanceWorkout,
  applyChat,
  ensureDayPlan,
  getPhotoFile,
  getTodayPayload,
  interpretPhoto,
  listGyms,
  listPantry,
  logFood,
  logSet,
  readUploadBuffer,
  saveDay,
  savePhotoRecord,
  updateSettings,
  upsertGym,
  upsertPantryItems,
} from '../lib/health-coach.js';

const routes = new Hono();

function jsonError(c, status, error, message) {
  return c.json({ ok: false, error, message: message || error }, status);
}

function dateParam(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

routes.get('/api/health/coach/today', (c) => {
  const date = dateParam(c.req.query('date'));
  return c.json({ ok: true, ...getTodayPayload(db, date) });
});

routes.post('/api/health/coach/day/:date/approve', async (c) => {
  const date = dateParam(c.req.param('date'));
  const day = saveDay(db, date, { status: 'approved' });
  return c.json({ ok: true, day });
});

routes.post('/api/health/coach/day/:date/meals', async (c) => {
  const date = dateParam(c.req.param('date'));
  let body = {};
  try { body = await c.req.json(); } catch { body = {}; }
  if (!Array.isArray(body.meals)) return jsonError(c, 400, 'meals_required');
  const day = saveDay(db, date, { meals: body.meals, status: body.status || 'draft' });
  return c.json({ ok: true, day });
});

routes.post('/api/health/coach/day/:date/workout', async (c) => {
  const date = dateParam(c.req.param('date'));
  let body = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const current = ensureDayPlan(db, date);
  const day = saveDay(db, date, {
    workout: { ...current.workout, ...(body.workout || body) },
    feedback: body.feedback,
  });
  return c.json({ ok: true, day });
});

routes.post('/api/health/coach/day/:date/advance', async (c) => {
  const date = dateParam(c.req.param('date'));
  let body = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const day = advanceWorkout(db, date, body.currentIndex);
  return c.json({ ok: true, day });
});

routes.post('/api/health/coach/food', async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch { return jsonError(c, 400, 'invalid_json'); }
  const result = logFood(db, body);
  return c.json({ ok: true, ...result });
});

routes.post('/api/health/coach/set', async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch { return jsonError(c, 400, 'invalid_json'); }
  if (!body.exercise) return jsonError(c, 400, 'exercise_required');
  const result = logSet(db, body);
  return c.json({ ok: true, ...result });
});

routes.get('/api/health/coach/gyms', (c) => {
  return c.json({ ok: true, gyms: listGyms(db), pantry: listPantry(db) });
});

routes.post('/api/health/coach/gyms', async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch { return jsonError(c, 400, 'invalid_json'); }
  const gym = upsertGym(db, body);
  return c.json({ ok: true, gym, gyms: listGyms(db) });
});

routes.post('/api/health/coach/gyms/:id/activate', (c) => {
  const id = Number(c.req.param('id'));
  updateSettings(db, { active_gym_id: id });
  return c.json({ ok: true, gyms: listGyms(db) });
});

routes.post('/api/health/coach/pantry', async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch { return jsonError(c, 400, 'invalid_json'); }
  const items = Array.isArray(body.items) ? body.items : [];
  const pantry = upsertPantryItems(db, items, { usual: body.usual, inStock: body.in_stock !== false });
  return c.json({ ok: true, pantry });
});

routes.post('/api/health/coach/settings', async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch { return jsonError(c, 400, 'invalid_json'); }
  const settings = updateSettings(db, body);
  return c.json({ ok: true, settings });
});

routes.post('/api/health/coach/chat', async (c) => {
  let body = {};
  try { body = await c.req.json(); } catch { return jsonError(c, 400, 'invalid_json'); }
  const text = String(body.text || '').trim();
  if (!text) return jsonError(c, 400, 'text_required');
  const result = await applyChat(db, text, dateParam(body.date));
  return c.json({ ok: true, ...result });
});

routes.post('/api/health/coach/photo', async (c) => {
  let form;
  try { form = await c.req.formData(); } catch { return jsonError(c, 400, 'invalid_form_data'); }
  const file = form.get('file') || form.get('photo');
  if (!file) return jsonError(c, 400, 'file_required');
  const kind = String(form.get('kind') || 'meal');
  const caption = String(form.get('caption') || '');
  const gymId = form.get('gym_id') ? Number(form.get('gym_id')) : undefined;
  const buffer = await readUploadBuffer(file);
  if (!buffer?.length) return jsonError(c, 400, 'empty_file');
  const mime = file.type || 'image/jpeg';
  const photo = savePhotoRecord(db, { kind, mime, buffer, caption });
  const result = await interpretPhoto(db, { kind, photoId: photo.id, caption, gymId });
  return c.json({ ok: true, photo: { id: photo.id, kind }, result, today: getTodayPayload(db) });
});

routes.get('/api/health/coach/photos/:id', (c) => {
  const photo = getPhotoFile(db, c.req.param('id'));
  if (!photo) return jsonError(c, 404, 'photo_not_found');
  const bytes = readFileSync(photo.path);
  return c.body(bytes, 200, {
    'Content-Type': photo.mime || 'image/jpeg',
    'Cache-Control': 'private, max-age=86400',
  });
});

export default routes;
