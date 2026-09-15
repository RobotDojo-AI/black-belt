// One-time repair for st_abf246e4 regression: the reconcile→reclassify path
// un-hid one-sided coding sessions and mis-stamped top-level persona spawns as
// owner. Re-applies the correct classification + visibility to existing rows.
// INTELLIGENCE_TIER: extraction — deterministic, no LLM; writes to DB.
export const INTELLIGENCE_TIER = 'extraction';
import db from '../lib/db.js';
import { isSpawnedAgentSession } from '../lib/conversations.js';

const rows = db.prepare(
  "SELECT id FROM conversations WHERE (model='claude-code' OR thread_id LIKE 'claude-code:%') AND deleted_at IS NULL",
).all();
const firstUserStmt = db.prepare(
  "SELECT content FROM messages WHERE conversation_id = ? AND role='user' ORDER BY seq, id LIMIT 1",
);
const hasAsstStmt = db.prepare(
  "SELECT 1 FROM messages WHERE conversation_id = ? AND role='assistant' LIMIT 1",
);
let stampedSub = 0, hiddenOneSided = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    const first = firstUserStmt.get(r.id)?.content || '';
    if (isSpawnedAgentSession(first)) {
      const res = db.prepare("UPDATE conversations SET origin='subagent' WHERE id=? AND (origin IS NULL OR origin='owner')").run(r.id);
      if (res.changes) stampedSub += res.changes;
    }
    const twoSided = hasAsstStmt.get(r.id);
    if (!twoSided) {
      const res = db.prepare("UPDATE conversations SET archived=1 WHERE id=? AND (archived IS NULL OR archived=0)").run(r.id);
      if (res.changes) hiddenOneSided += res.changes;
    }
  }
});
tx();
console.log('repair: stamped subagent=' + stampedSub + ' hidden one-sided=' + hiddenOneSided + ' scanned=' + rows.length);
