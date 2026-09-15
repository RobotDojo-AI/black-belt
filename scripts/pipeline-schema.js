import { existsSync, readFileSync } from 'fs';
import { PIPELINE_FALLBACK_SCHEMA_PATH, PIPELINE_SCHEMA_PATH } from '../lib/robotdojo-paths.js';

function schemaCandidates() {
  if (process.env.ROBOTDOJO_SCHEMA_PATH) return [PIPELINE_SCHEMA_PATH];
  return [PIPELINE_SCHEMA_PATH, PIPELINE_FALLBACK_SCHEMA_PATH];
}

function loadSchema() {
  const tried = [];
  for (const candidate of schemaCandidates()) {
    tried.push(candidate);
    if (!existsSync(candidate)) continue;
    return { path: candidate, schema: JSON.parse(readFileSync(candidate, 'utf8')) };
  }
  throw new Error(`STORY_SCHEMA.json not found. Tried: ${tried.join(', ')}`);
}

const { path: schemaPath, schema } = loadSchema();

// Map stage keys to filenames: { scope: '00-scope.md', criteria: '03b-criteria.md', ... }
export const ARTIFACTS = Object.fromEntries(
  Object.entries(schema.stages).map(([k, v]) => [k, v.file])
);

export const SCHEMA = schema;
export const SCHEMA_SOURCE_PATH = schemaPath;
