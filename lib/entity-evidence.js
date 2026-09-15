import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { REPO_ROOT } from './robotdojo-paths.js';

const ENTITY_TYPE_ALIASES = new Map([
  ['person', 'person'],
  ['people', 'person'],
  ['company', 'company'],
  ['companies', 'company'],
  ['place', 'place'],
  ['places', 'place'],
]);

const ENTITY_TABLES = {
  person: { table: 'people', nameColumn: 'display_name' },
  company: { table: 'companies', nameColumn: 'name' },
  place: { table: 'places', nameColumn: 'name' },
};

const SOURCE_LABELS = {
  imessage: 'iMessage',
  email: 'email',
  calendar: 'calendar',
  transcript: 'transcript',
  chat: 'chat',
  conversation: 'chat',
  asana: 'Asana',
  drive: 'Drive',
  file: 'file',
  drop_folder_file: 'file',
  health: 'health note',
};

const DEFAULT_EVIDENCE_LIMIT = 2000;

function normalizeEntityType(value) {
  return ENTITY_TYPE_ALIASES.get(String(value || '').toLowerCase()) || '';
}

function pluralEntityType(type) {
  if (type === 'person') return 'people';
  if (type === 'company') return 'companies';
  if (type === 'place') return 'places';
  return type || '';
}

function parseFrontmatter(body) {
  const match = String(body || '').match(/^---[ \t]*(?:\r?\n)([\s\S]*?)(?:\r?\n)---[ \t]*(?:\r?\n|$)/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const row = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!row) continue;
    out[row[1]] = stripYamlScalar(row[2]);
  }
  return out;
}

function stripYamlScalar(value) {
  const raw = String(value || '').trim();
  const quoted = raw.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2] : raw;
}

function tableExists(db, table) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
  } catch {
    return false;
  }
}

function columnsFor(db, table) {
  try {
    const tableName = String(table || '').replace(/'/g, "''");
    return new Set(db.prepare(`SELECT name FROM pragma_table_info('${tableName}')`).all().map((row) => row.name));
  } catch {
    return new Set();
  }
}

function hasColumns(db, table, names) {
  const columns = columnsFor(db, table);
  return names.every((name) => columns.has(name));
}

function entityRowSelect(db, type) {
  const def = ENTITY_TABLES[type];
  if (!def || !tableExists(db, def.table)) return null;
  const columns = columnsFor(db, def.table);
  if (!columns.has('id')) return null;
  const select = [
    'id',
    columns.has(def.nameColumn) ? `${def.nameColumn} AS name` : 'NULL AS name',
    columns.has('first_seen') ? 'first_seen AS firstSeen' : 'NULL AS firstSeen',
    columns.has('last_seen') ? 'last_seen AS lastSeen' : 'NULL AS lastSeen',
    columns.has('interaction_count') ? 'interaction_count AS interactionCount' : 'NULL AS interactionCount',
    columns.has('people_count') ? 'people_count AS peopleCount' : 'NULL AS peopleCount',
    columns.has('frequency') ? 'frequency AS frequency' : 'NULL AS frequency',
    columns.has('total_visits') ? 'total_visits AS totalVisits' : 'NULL AS totalVisits',
    columns.has('context_file_path') ? 'context_file_path AS contextFilePath' : 'NULL AS contextFilePath',
  ].join(', ');
  return { def, columns, select };
}

function normalizeEntityRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || '').trim(),
    displayName: String(row.name || '').trim(),
    firstSeen: formatEvidenceDate(row.firstSeen),
    lastSeen: formatEvidenceDate(row.lastSeen),
    interactionCount: Number(row.interactionCount || 0) || 0,
    peopleCount: Number(row.peopleCount || 0) || 0,
    frequency: Number(row.frequency || 0) || 0,
    totalVisits: Number(row.totalVisits || 0) || 0,
    contextFilePath: String(row.contextFilePath || '').trim(),
  };
}

function contextPathCandidates(relPath) {
  const clean = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) return [];
  const absPath = join(REPO_ROOT, clean).replace(/\\/g, '/');
  const homeRel = relative(homedir(), absPath).replace(/\\/g, '/');
  const candidates = [clean, `/${clean}`, absPath];
  if (homeRel && !homeRel.startsWith('..') && !homeRel.startsWith('/')) {
    candidates.push(`~/${homeRel}`);
  }
  return Array.from(new Set(candidates));
}

function queryEntityRowByContextPath(db, type, relPath) {
  const query = entityRowSelect(db, type);
  if (!query || !relPath || !query.columns.has('context_file_path')) return null;
  const candidates = contextPathCandidates(relPath);
  if (!candidates.length) return null;
  const params = Object.fromEntries(candidates.map((value, index) => [`path${index}`, value]));
  const placeholders = candidates.map((_, index) => `@path${index}`).join(', ');
  try {
    return normalizeEntityRow(db.prepare(`
      SELECT ${query.select}
      FROM ${query.def.table}
      WHERE context_file_path IN (${placeholders})
      LIMIT 1
    `).get(params));
  } catch {
    return null;
  }
}

function queryEntityRowById(db, type, id) {
  const query = entityRowSelect(db, type);
  const cleanId = String(id || '').trim();
  if (!query || !cleanId) return null;
  const clauses = ['id = @id'];
  if (query.columns.has('uuid')) {
    clauses.push('uuid = @id');
    clauses.push("replace(uuid, '-', '') = replace(@id, '-', '')");
  }
  try {
    return normalizeEntityRow(db.prepare(`
      SELECT ${query.select}
      FROM ${query.def.table}
      WHERE ${clauses.join(' OR ')}
      LIMIT 1
    `).get({ id: cleanId }));
  } catch {
    return null;
  }
}

function resolveEntityIdentity(db, doc, body) {
  const frontmatter = parseFrontmatter(body);
  const type = normalizeEntityType(frontmatter.entity_type || doc.entityType);
  const frontmatterId = String(frontmatter.entity_id || '').trim();
  const frontmatterName = String(frontmatter.display_name || doc.title || '').trim();
  const row = (type && frontmatterId ? queryEntityRowById(db, type, frontmatterId) : null)
    || queryEntityRowByContextPath(db, type, doc.relPath);
  const id = String(frontmatterId || row?.id || '').trim();
  const displayName = String(frontmatterName || row?.displayName || '').trim();
  if (!type || !id) return { type, pluralType: pluralEntityType(type), id: '', displayName };
  return {
    type,
    pluralType: pluralEntityType(type),
    id,
    displayName,
    firstSeen: row?.firstSeen || '',
    lastSeen: row?.lastSeen || '',
    interactionCount: row?.interactionCount || 0,
    peopleCount: row?.peopleCount || 0,
    frequency: row?.frequency || 0,
    totalVisits: row?.totalVisits || 0,
    contextFilePath: row?.contextFilePath || '',
  };
}

function sourceLabel(sourceType) {
  const key = String(sourceType || '').toLowerCase();
  return SOURCE_LABELS[key] || key.replace(/_/g, ' ') || 'source';
}

function formatEvidenceDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const isoDay = raw.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (isoDay) return isoDay;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  const year = raw.match(/\b\d{4}\b/)?.[0];
  return year || '';
}

function sortValue(value) {
  const dateText = formatEvidenceDate(value);
  if (!dateText) return 0;
  return Date.parse(`${dateText}T00:00:00Z`) || 0;
}

function trimPlain(value, maxChars) {
  const clean = String(value || '')
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars).trim()}...` : clean;
}

function isLowValueEvidenceText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return true;
  return /^\+?\d[\d\s().-]{6,}\s*[:—-]?\s*(?:\uFFFC|\[?attachment\]?|)$/i.test(text)
    || /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(text)
    || /(?:\+\d{10,}|\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)\s*[:—-]?\s*(?:\uFFFC|\[?attachment\]?|)$/i.test(text)
    || /^Invitation:|^Accepted:|^Updated invitation:/i.test(text)
    || /\b(?:calendar|google)\.com\/(?:calendar|maps)\b/i.test(text);
}

function containsContactArtifact(value) {
  const text = String(value || '');
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /(?:\+\d{10,}|\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/.test(text);
}

function capitalize(value) {
  const text = String(value || '').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

function cleanChunkContent(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[^\]]+\]$/.test(line))
    .filter((line) => !/^(subject|from|to|cc|bcc|date|sent):\s/i.test(line))
    .map(stripChatSpeakerPrefix)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripChatSpeakerPrefix(line) {
  return String(line || '').replace(/^(?:Me|You|[A-Z][A-Za-z .'-]{1,40}|\+?\d[\d\s().-]{6,})\s*:\s+/, '').trim();
}

function entityNeedles(displayName) {
  const tokens = String(displayName || '')
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z0-9'-]/g, ''))
    .filter((token) => token.length >= 3);
  const needles = [];
  if (displayName) needles.push(displayName);
  if (tokens.length) needles.push(tokens[0]);
  if (tokens.length > 1) needles.push(tokens.at(-1));
  return Array.from(new Set(needles.map((needle) => needle.toLowerCase())));
}

function chunkExcerpt(content, displayName, maxChars = 300) {
  const clean = cleanChunkContent(content);
  if (!clean) return '';
  const segments = clean
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const needles = entityNeedles(displayName);
  const match = segments.find((segment) => needles.some((needle) => segment.toLowerCase().includes(needle)));
  return trimPlain(match || segments[0] || clean, maxChars);
}

function excerptMentionsEntity(excerpt, displayName) {
  const lower = String(excerpt || '').toLowerCase();
  const needles = entityNeedles(displayName);
  return needles.length > 0 && needles.some((needle) => lower.includes(needle));
}

function evidenceTitle(excerpt) {
  const clean = trimPlain(excerpt, 140);
  if (!clean) return 'Mentioned in source evidence';
  const sentenceEnd = clean.search(/[.!?](?:\s|$)/);
  if (sentenceEnd > 24 && sentenceEnd < 120) return clean.slice(0, sentenceEnd + 1);
  return clean;
}

function timelineEventTitle(row) {
  const summary = trimPlain(row.summary, 160);
  if (summary) return summary;
  const type = String(row.event_type || '').replace(/_/g, ' ').trim();
  return type ? type[0].toUpperCase() + type.slice(1) : 'Timeline event';
}

function fallbackTimelineEventTitle(row) {
  const source = sourceLabel(row.source_type);
  const type = String(row.event_type || '').replace(/_/g, ' ').trim();
  if (/^Invitation:|^Accepted:|^Updated invitation:/i.test(String(row.summary || ''))) {
    return 'Calendar invitation recorded';
  }
  if (String(row.source_type || '').toLowerCase() === 'imessage') return 'iMessage interaction recorded';
  if (String(row.source_type || '').toLowerCase() === 'email') return 'Email interaction recorded';
  if (type) return `${capitalize(type)} recorded`;
  return `${capitalize(source)} event recorded`;
}

function entityMatchClause(alias, identity, columns) {
  const clauses = [];
  const params = {
    entityId: identity.id,
    entityType: identity.type,
    pluralEntityType: identity.pluralType,
  };
  if (columns.has('entity_id')) {
    if (columns.has('entity_type')) {
      clauses.push(`(${alias}.entity_id = @entityId AND ${alias}.entity_type IN (@entityType, @pluralEntityType))`);
    } else {
      clauses.push(`${alias}.entity_id = @entityId`);
    }
  }
  if (identity.type === 'person' && columns.has('person_id')) {
    clauses.push(`${alias}.person_id = @entityId`);
  }
  return { where: clauses.length ? `(${clauses.join(' OR ')})` : '', params };
}

function mapParticipantRows(rows) {
  return rows.map((row) => {
    const rawTitle = timelineEventTitle(row);
    return {
      id: `timeline:${row.id}`,
      evidenceType: 'timeline_event',
      role: row.role || 'participant',
      sourceType: row.source_type || '',
      sourceId: row.source_id || '',
      sourceLabel: `${capitalize(row.role || 'participant')} in ${sourceLabel(row.source_type)}`,
      dateText: formatEvidenceDate(row.event_date),
      title: isLowValueEvidenceText(rawTitle) || containsContactArtifact(rawTitle)
        ? fallbackTimelineEventTitle(row)
        : rawTitle,
      body: '',
      sort: sortValue(row.event_date),
    };
  }).filter((item) => item.dateText && item.title && !isLowValueEvidenceText(item.title));
}

function participantEvidence(db, identity, limit) {
  if (!tableExists(db, 'timeline_events') || !tableExists(db, 'timeline_event_entities')) return [];
  const teeColumns = columnsFor(db, 'timeline_event_entities');
  const teColumns = columnsFor(db, 'timeline_events');
  if (!teColumns.has('id') || !teColumns.has('event_date')) return [];
  const match = entityMatchClause('tee', identity, teeColumns);
  if (!match.where) return [];
  const summarySelect = teColumns.has('summary') ? 'te.summary' : "'' AS summary";
  const eventTypeSelect = teColumns.has('event_type') ? 'te.event_type' : "'' AS event_type";
  const sourceTypeSelect = teColumns.has('source_type') ? 'te.source_type' : "'' AS source_type";
  const sourceIdSelect = teColumns.has('source_id') ? 'te.source_id' : "'' AS source_id";
  const roleSelect = teeColumns.has('role') ? 'tee.role' : "'participant' AS role";
  try {
    const safeLimit = Math.max(0, Number(limit) || DEFAULT_EVIDENCE_LIMIT);
    const latestRows = db.prepare(`
      SELECT te.id, ${sourceTypeSelect}, ${sourceIdSelect}, te.event_date, ${eventTypeSelect}, ${summarySelect}, ${roleSelect}
      FROM timeline_event_entities tee
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE ${match.where}
        AND te.event_date IS NOT NULL
        AND te.event_date <> ''
      ORDER BY te.event_date DESC
      LIMIT @limit
    `).all({ ...match.params, limit: safeLimit });
    const originLimit = Math.min(96, Math.max(0, Math.ceil(safeLimit * 0.12)));
    const originRows = originLimit > 0 ? db.prepare(`
      SELECT te.id, ${sourceTypeSelect}, ${sourceIdSelect}, te.event_date, ${eventTypeSelect}, ${summarySelect}, ${roleSelect}
      FROM timeline_event_entities tee
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE ${match.where}
        AND te.event_date IS NOT NULL
        AND te.event_date <> ''
      ORDER BY te.event_date ASC
      LIMIT @limit
    `).all({ ...match.params, limit: originLimit }) : [];
    return dedupeEvidence(mapParticipantRows([...latestRows, ...originRows]));
  } catch {
    return [];
  }
}

function participantEvidenceCount(db, identity) {
  if (!tableExists(db, 'timeline_events') || !tableExists(db, 'timeline_event_entities')) return 0;
  const teeColumns = columnsFor(db, 'timeline_event_entities');
  const teColumns = columnsFor(db, 'timeline_events');
  if (!teColumns.has('id') || !teColumns.has('event_date')) return 0;
  const match = entityMatchClause('tee', identity, teeColumns);
  if (!match.where) return 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n
      FROM timeline_event_entities tee
      JOIN timeline_events te ON te.id = tee.event_id
      WHERE ${match.where}
        AND te.event_date IS NOT NULL
        AND te.event_date <> ''
    `).get(match.params);
    return Number(row?.n || 0);
  } catch {
    return 0;
  }
}

function mentionEvidence(db, identity, limit) {
  if (!tableExists(db, 'chunks') || !tableExists(db, 'chunk_entities')) return [];
  const chunkColumns = columnsFor(db, 'chunks');
  const ceColumns = columnsFor(db, 'chunk_entities');
  if (!chunkColumns.has('id') || !chunkColumns.has('content') || !ceColumns.has('chunk_id') || !ceColumns.has('entity_id')) return [];
  if (!chunkColumns.has('event_time')) return [];
  const match = entityMatchClause('ce', identity, ceColumns);
  if (!match.where) return [];
  const sourceTypeSelect = chunkColumns.has('source_type') ? 'c.source_type' : "'' AS source_type";
  const sourceIdSelect = chunkColumns.has('source_id') ? 'c.source_id' : "'' AS source_id";
  const contentRankOrder = chunkColumns.has('content_rank') ? ', c.content_rank ASC' : '';
  try {
    return db.prepare(`
      SELECT c.id, ${sourceTypeSelect}, ${sourceIdSelect}, c.event_time, c.content
      FROM chunk_entities ce
      JOIN chunks c ON c.id = ce.chunk_id
      WHERE ${match.where}
        AND c.event_time IS NOT NULL
        AND c.event_time <> ''
        AND c.content IS NOT NULL
        AND length(trim(c.content)) > 40
      ORDER BY c.event_time DESC${contentRankOrder}, c.id DESC
      LIMIT @limit
    `).all({ ...match.params, limit }).map((row) => {
      const excerpt = chunkExcerpt(row.content, identity.displayName);
      if (!excerptMentionsEntity(excerpt, identity.displayName)) return null;
      return {
        id: `chunk:${row.id}`,
        evidenceType: 'body_mention',
        role: 'mentioned',
        sourceType: row.source_type || '',
        sourceId: row.source_id || '',
        sourceLabel: `Mentioned in ${sourceLabel(row.source_type)}`,
        dateText: formatEvidenceDate(row.event_time),
        title: evidenceTitle(excerpt),
        body: excerpt && evidenceTitle(excerpt) !== excerpt ? excerpt : '',
        sort: sortValue(row.event_time),
      };
    }).filter((item) => item && item.dateText && item.title && !isLowValueEvidenceText(`${item.title} ${item.body}`));
  } catch {
    return [];
  }
}

function mentionEvidenceCount(db, identity) {
  if (!tableExists(db, 'chunks') || !tableExists(db, 'chunk_entities')) return 0;
  const chunkColumns = columnsFor(db, 'chunks');
  const ceColumns = columnsFor(db, 'chunk_entities');
  if (!chunkColumns.has('id') || !chunkColumns.has('content') || !ceColumns.has('chunk_id') || !ceColumns.has('entity_id')) return 0;
  if (!chunkColumns.has('event_time')) return 0;
  const match = entityMatchClause('ce', identity, ceColumns);
  if (!match.where) return 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n
      FROM chunk_entities ce
      JOIN chunks c ON c.id = ce.chunk_id
      WHERE ${match.where}
        AND c.event_time IS NOT NULL
        AND c.event_time <> ''
        AND c.content IS NOT NULL
        AND length(trim(c.content)) > 40
    `).get(match.params);
    return Number(row?.n || 0);
  } catch {
    return 0;
  }
}

function dedupeEvidence(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id
      ? `${item.evidenceType}|${item.id}`.toLowerCase()
      : evidenceKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function evidenceKey(item) {
  return `${item.dateText}|${item.title}|${item.evidenceType}`.toLowerCase();
}

function phaseAwareTimeline(items, limit) {
  const safeLimit = Math.max(16, Number(limit) || 0);
  if (!safeLimit || items.length <= safeLimit) return items;
  const selected = new Map();
  const add = (item) => {
    if (item) selected.set(evidenceKey(item), item);
  };
  const latestCount = Math.max(16, Math.floor(safeLimit * 0.72));
  const originCount = Math.max(8, Math.min(96, Math.floor(safeLimit * 0.14)));
  items.slice(0, latestCount).forEach(add);
  items.slice(-originCount).forEach(add);
  const perYear = new Map();
  for (const item of items) {
    const year = String(item.dateText || '').match(/\b\d{4}\b/)?.[0];
    if (!year || perYear.has(year)) continue;
    perYear.set(year, item);
    add(item);
  }
  for (const item of [...items].reverse()) {
    const year = String(item.dateText || '').match(/\b\d{4}\b/)?.[0];
    if (!year) continue;
    add(item);
  }
  const ranked = Array.from(selected.values()).sort((a, b) => (b.sort || 0) - (a.sort || 0));
  if (ranked.length <= safeLimit) return ranked;
  const originKeys = new Set(items.slice(-originCount).map(evidenceKey));
  const kept = [];
  const late = ranked.filter((item) => !originKeys.has(evidenceKey(item)));
  const old = ranked.filter((item) => originKeys.has(evidenceKey(item)));
  for (const item of late) {
    if (kept.length >= safeLimit - old.length) break;
    kept.push(item);
  }
  kept.push(...old);
  return kept.sort((a, b) => (b.sort || 0) - (a.sort || 0)).slice(0, safeLimit);
}

export function entityEvidenceForDocument(db, doc, body, options = {}) {
  const identity = resolveEntityIdentity(db, doc, body);
  const mentionLimit = Math.max(0, Number(options.mentionLimit ?? DEFAULT_EVIDENCE_LIMIT));
  const participantLimit = Math.max(0, Number(options.participantLimit ?? DEFAULT_EVIDENCE_LIMIT));
  const timelineLimit = Math.max(0, Number(options.timelineLimit ?? (mentionLimit + participantLimit)));
  const countTotals = options.countTotals !== false;
  if (!db || doc?.kind !== 'entity' || !identity.id || !identity.type) {
    return { entity: identity, timeline: [], counts: { mentions: 0, participants: 0, totalMentions: 0, totalParticipants: 0, truncated: false } };
  }
  const participants = participantLimit > 0 ? participantEvidence(db, identity, participantLimit) : [];
  const mentions = mentionLimit > 0 ? mentionEvidence(db, identity, mentionLimit) : [];
  const deduped = dedupeEvidence([...participants, ...mentions])
    .sort((a, b) => (b.sort || 0) - (a.sort || 0))
  const timeline = phaseAwareTimeline(deduped, timelineLimit);
  const totalParticipants = countTotals && participantLimit > 0
    ? participantEvidenceCount(db, identity)
    : participants.length;
  const totalMentions = countTotals && mentionLimit > 0
    ? mentionEvidenceCount(db, identity)
    : mentions.length;
  return {
    entity: identity,
    timeline,
    counts: {
      mentions: mentions.length,
      participants: participants.length,
      totalMentions,
      totalParticipants,
      timeline: timeline.length,
      total: totalMentions + totalParticipants,
      truncated: participants.length < totalParticipants
        || mentions.length < totalMentions
        || timeline.length < deduped.length,
    },
  };
}
