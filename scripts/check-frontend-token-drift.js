#!/usr/bin/env node
import { fail, read } from './frontend-workbench-lib.js';

const errors = [];

const theme = read('apps/static/shared/theme.css');
for (const token of ['--md-primary', '--md-surface', '--md-on-surface', '--md-outline-variant', '--radius-xs', '--font']) {
  if (!theme.includes(token)) errors.push(`theme.css missing token ${token}`);
}

const marketing = read('apps/static/shared/marketing.css');
for (const token of ['--md-primary', '--md-surface', '--md-on-surface', '--accent:    var(--md-primary)', '--bg:        var(--md-surface)']) {
  if (!marketing.includes(token)) errors.push(`marketing.css not adapted to shared token ${token}`);
}

const targetHtml = ['apps/index.html', 'apps/privacy.html', 'apps/terms.html', 'apps/licensing.html', 'apps/install-success.html', 'apps/auth-google-guidance.html', 'apps/ask.html', 'apps/health/index.html'];
for (const file of targetHtml) {
  if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(read(file))) errors.push(`${file} loads live Google fonts`);
}

const inlineStyleFiles = ['apps/auth-google-guidance.html'];
for (const file of inlineStyleFiles) {
  const src = read(file);
  if (/<style[\s\S]*#[0-9a-fA-F]{3,8}/.test(src)) errors.push(`${file} has raw inline colors`);
}

fail(errors);
