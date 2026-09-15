import db from '../../db.js';
import { queueHealthIntelRegeneration } from '../../health-intel-regeneration.js';
import { healthDataPointSourceId } from '../../health-data-point-source.js';
import { defineTool, ok, slugify } from '../registry.js';

defineTool('log_metric', {
  description: 'Log a health metric data point. Examples: weight, blood pressure, blood sugar, sleep hours, A1C, cholesterol. Creates the marker if it doesn\'t exist.',
  parameters: {
    properties: {
      name: { type: 'string', description: 'Metric name (e.g., "Weight", "Blood Pressure Systolic", "A1C")' },
      value: { type: 'number', description: 'Numeric value' },
      unit: { type: 'string', description: 'Unit (e.g., "lbs", "mmHg", "%", "hours")' },
      date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' },
      notes: { type: 'string', description: 'Optional notes about this reading' },
    },
    required: ['name', 'value'],
  },
  execute({ name, value, unit, date, notes }) {
    const measureDate = date || new Date().toISOString().slice(0, 10);

    // Find or create the health marker
    let marker = db.prepare('SELECT id, unit FROM health_markers WHERE LOWER(name) = LOWER(?)').get(name);
    if (!marker) {
      // Auto-create group if needed
      let group = db.prepare("SELECT id FROM health_groups WHERE id = 'user_tracked'").get();
      if (!group) {
        try {
          db.prepare("INSERT INTO health_groups (id, name, description) VALUES ('user_tracked', 'User Tracked', 'Manually tracked health metrics')").run();
        } catch { /* may already exist */ }
        group = { id: 'user_tracked' };
      }
      const markerId = `marker-${slugify(name)}`;
      db.prepare(
        "INSERT INTO health_markers (id, name, unit, group_id) VALUES (?, ?, ?, ?)"
      ).run(markerId, name, unit || '', group.id);
      marker = { id: markerId, unit: unit || '' };
    }

    // WHY: chat-extracted lab values are flagged for verification — they may be
    // misremembered, approximated, or transposed. Only instrument-measured values
    // (source='fhir' / 'pdf' / 'apple_health') get excluded=0. Setting excluded=1
    // with a structured reason keeps the value visible to log-metric callers and
    // still in the DB for trend-line context, but health_intel synthesis filters
    // them out — see /api/health/markers WHERE excluded=0 in routes/health.js.
    // Source is hardcoded to 'chat' here, so the flag applies uniformly.
    const sourceFile = notes || '';
    const sourceId = healthDataPointSourceId({ source: 'chat', markerId: marker.id, date: measureDate, value, sourceFile, excluded: 1 });
    const result = db.prepare(`
      INSERT OR IGNORE INTO health_data_points (marker_id, date, value, source, source_file, source_id, excluded, exclude_reason, created_at)
      VALUES (?, ?, ?, 'chat', ?, ?, 1, 'chat_extracted_needs_verification', datetime('now'))
    `).run(marker.id, measureDate, value, sourceFile, sourceId);
    const regeneration = result.changes > 0
      ? queueHealthIntelRegeneration({ reason: 'user_added_health_data', inserted: result.changes })
      : null;

    return ok({ marker_id: marker.id, name, value, unit: marker.unit || unit, date: measureDate, excluded: true, exclude_reason: 'chat_extracted_needs_verification', regeneration });
  },
});
