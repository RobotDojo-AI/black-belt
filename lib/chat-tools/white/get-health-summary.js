import db from '../../db.js';
import { defineTool, ok } from '../registry.js';

defineTool('get_health_summary', {
  description: 'Get a summary of recent health data: latest metrics, active medications, recent notes. Use to answer health questions.',
  parameters: {
    properties: {
      days: { type: 'number', description: 'Look back N days (default 30)' },
    },
    required: [],
  },
  execute({ days }) {
    const lookback = days || 30;

    // Recent data points
    const recentMetrics = db.prepare(`
      SELECT m.name, m.unit, dp.value, dp.date, dp.source_file as notes
      FROM health_data_points dp
      JOIN health_markers m ON dp.marker_id = m.id
      WHERE dp.date >= date('now', '-' || ? || ' days') AND dp.excluded = 0
      ORDER BY dp.date DESC LIMIT 20
    `).all(lookback);

    // Active medications
    const meds = db.prepare("SELECT name, type, dose, frequency, status, notes FROM curated_medications WHERE status = 'active' ORDER BY name").all();

    // Recent notes
    const notes = db.prepare(`
      SELECT date, content, tags FROM health_notes
      WHERE date >= date('now', '-' || ? || ' days')
      ORDER BY date DESC LIMIT 10
    `).all(lookback);

    return ok({
      recent_metrics: recentMetrics,
      active_medications: meds,
      recent_notes: notes.map(n => ({ ...n, tags: JSON.parse(n.tags || '[]') })),
      period_days: lookback,
    });
  },
});
