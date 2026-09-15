#!/usr/bin/env node
// Retired fail-closed writer. Do not use.
//
// Dynamic facts are no longer written into canonical docs by a separate writer.

process.stderr.write(
  'generate-facts.js is retired and fail closed. Do not write dynamic facts into canonical docs.\n',
);
process.exit(1);
