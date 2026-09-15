#!/usr/bin/env node
// Retired fail-closed writer. Do not use.
//
// CLAUDE.md assembly is owned by scripts/claude.js, which routes writes through
// canonicalWrite('CLAUDE.md', ...). This legacy generator is intentionally dead.

process.stderr.write(
  'generate-claude.js is retired and fail closed. Use scripts/claude.js for CLAUDE.md assembly.\n',
);
process.exit(1);
