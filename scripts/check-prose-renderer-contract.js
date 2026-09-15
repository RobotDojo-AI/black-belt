#!/usr/bin/env node
import { assertIncludes, fail, read } from './frontend-workbench-lib.js';

const errors = [];
errors.push(...assertIncludes('apps/static/shared/utils.js', [
  'function renderProseMarkdown',
  'DOMPurify.sanitize',
  'USE_PROFILES',
  "FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed']",
  "target', '_blank'",
  "rel', 'noopener noreferrer'",
  'rd-table-scroll',
  'hljs.highlightElement',
]));
errors.push(...assertIncludes('apps/static/shared/app-components.js', ['renderProseMarkdown', 'rd-prose']));
errors.push(...assertIncludes('apps/static/shared/app-layout.css', ['.rd-prose', '.rd-table-scroll', '.rd-prose pre', '.rd-prose table']));

const combined = [
  'apps/static/shared/utils.js',
  'apps/static/shared/app-components.js',
  'apps/chat/public-app.js',
  'apps/chat/index.html',
  'apps/ask.html',
  'apps/account/index.html',
  'apps/health/index.html',
  'apps/network/index.html',
].map((file) => read(file)).join('\n');
for (const forbidden of ['markdown-it', 'zero-md', 'ProseMirror', 'TipTap', 'CodeMirror']) {
  if (combined.includes(forbidden)) errors.push(`forbidden markdown/editor dependency present: ${forbidden}`);
}
if (!read('apps/chat/public-app.js').includes('window.renderProseMarkdown')) errors.push('public app bypasses shared prose facade');
if (!read('apps/ask.html').includes('/static/vendor/marked.min.js') || !read('apps/ask.html').includes('/static/vendor/purify.min.js')) {
  errors.push('public Ask missing marked + DOMPurify vendor stack');
}
fail(errors);
