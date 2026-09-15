import { Hono } from 'hono';
import db from '../lib/db.js';
import { buildAppRegistryPayload } from '../lib/app-registry.js';

const app = new Hono();

app.get('/api/apps', (c) => {
  return c.json(buildAppRegistryPayload(db));
});

export default app;
