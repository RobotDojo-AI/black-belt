import { createHash } from 'node:crypto';

function cleanPart(value) {
  return String(value ?? '').trim();
}

function cleanValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return cleanPart(value);
  return String(Number(n.toPrecision(15)));
}

function sha(parts) {
  return createHash('sha256').update(parts.map(cleanPart).join('|')).digest('hex');
}

export function deriveHealthSpecimenType(markerId = '') {
  const id = cleanPart(markerId);
  if (id.startsWith('urine_')) return 'urine_24hr';
  if (id.startsWith('serum_')) return 'serum';
  return 'unknown';
}

export function healthDataPointSourceId({
  source = 'health',
  markerId,
  date,
  value,
  sourceFile = '',
  sourceRunId = '',
  rowId = '',
  excluded = 0,
} = {}) {
  const src = cleanPart(source) || 'health';
  const marker = cleanPart(markerId);
  const day = cleanPart(date);
  const val = cleanValue(value);

  if (src === 'fhir') return sha(['fhir', marker, day, val]);
  if (src === 'apple-health') return sha(['apple-health', marker, day]);
  if (src === 'oura_sync' || src === 'oura-json' || src === 'eight_sleep_sync') return sha([src, marker, day]);
  if (src === 'pdf-lab' || src === 'pdf') {
    const row = cleanPart(rowId);
    return sha(['pdf-lab', sourceRunId || sourceFile, marker, day, row || val]);
  }
  if (src === 'chat' || Number(excluded) === 1) return sha([src, marker, day, val, sourceFile, rowId]);
  return sha([src, sourceRunId || sourceFile, marker, day, val]);
}
