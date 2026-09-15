#!/usr/bin/env node
import { fail, read } from './frontend-workbench-lib.js';

const errors = [];
for (const file of ['apps/chat/index.html', 'apps/ask.html', 'apps/account/index.html', 'apps/health/index.html']) {
  const src = read(file);
  if (/body\{opacity:0\}/.test(src)) {
    errors.push(`${file} must paint the static shell before async hydration`);
  }
  if (!src.includes('RobotDojoBootFallback')) errors.push(`${file} missing bounded boot fallback`);
  if (!src.includes('app-boot-fallback')) errors.push(`${file} missing fallback ready class`);
}

for (const file of ['apps/index.html', 'apps/privacy.html', 'apps/terms.html', 'apps/licensing.html', 'apps/install-success.html', 'apps/auth-google-guidance.html']) {
  const src = read(file);
  if (/body\{opacity:0\}/.test(src) && !src.includes('RobotDojoBootFallback')) errors.push(`${file} has unbounded opacity gate`);
  if (!/<main\b/.test(src)) errors.push(`${file} missing visible main fallback content`);
}

fail(errors);
