/**
 * Chat-tools tool registry + helpers. Separate from index.js so the
 * per-tool White Belt files can import `defineTool` without triggering
 * index.js's own white/*.js imports (which would circularly re-enter this
 * module before TOOLS has been initialised).
 */

export const TOOLS = {};

export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function ok(data = {}) { return { ok: true, ...data }; }
export function err(message) { return { ok: false, error: message }; }

export function defineTool(name, { description, parameters, belt = 'white', execute }) {
  TOOLS[name] = {
    belt,
    schema: {
      name,
      description,
      input_schema: {
        type: 'object',
        ...parameters,
      },
    },
    execute,
  };
}
