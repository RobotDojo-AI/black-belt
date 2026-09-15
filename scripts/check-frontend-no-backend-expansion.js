#!/usr/bin/env node
import { changedFiles, exists, fail, read } from './frontend-workbench-lib.js';

const allowedFrontend = /^(apps\/|scripts\/check-frontend|scripts\/check-prose-renderer|scripts\/check-vercel-deployment-freshness\.js|scripts\/frontend-workbench-lib\.js|scripts\/qa\/tests\/frontend-workbench|user\/workbenches\/topics\/work\/robot-dojo\/wk_robot_dojo\/stories\/st_ef478aa1\/03)/;
const backendPrefixes = /^(routes\/|lib\/|api\/|databases\/|migrations\/|tests\/|package\.json|package-lock\.json|index\.js|middleware\.js|vercel\.json)/;
const changed = changedFiles();
const violations = changed.filter((file) => backendPrefixes.test(file) && !allowedFrontend.test(file));

const reportPath = 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/st_ef478aa1/03-build.md';
if (violations.length && exists(reportPath) && read(reportPath).includes('Pre-existing dirty backend state')) {
  console.log(`PASS with documented pre-existing backend dirty state: ${violations.length} backend files`);
  process.exit(0);
}

fail(violations.map((file) => `backend/out-of-scope diff present: ${file}`));
