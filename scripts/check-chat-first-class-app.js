#!/usr/bin/env node
import { assertIncludes, fail, read } from './frontend-workbench-lib.js';

const errors = [];
errors.push(...assertIncludes('apps/chat/index.html', [
  '/static/shared/app-registry.js',
  '/static/shared/app-layout.css',
  '/static/shared/app-components.js',
]));
errors.push(...assertIncludes('apps/ask.html', [
  '/faq/app.js',
  'data-testid="multimodal-input"',
  'Ask anything about Robot Dojo',
]));
errors.push(...assertIncludes('apps/chat/app.js', ['markAppReady', 'RobotDojoComponents', 'setAppReady']));
errors.push(...assertIncludes('apps/chat/modules/input.js', ['RobotDojoComponents.fileChip']));
errors.push(...assertIncludes('apps/chat/modules/chat.js', ['RobotDojoComponents.emptyState', 'RobotDojoComponents.toolTrace']));
errors.push(...assertIncludes('apps/faq/public-app.js', ['streamChatTurn', '/api/public-chat/stream', 'public-chat-mode']));

const chat = read('apps/chat/modules/chat.js');
if (!chat.includes('/api/chat/stream')) errors.push('private Chat stream endpoint missing');
if (read('apps/faq/public-app.js').includes('/api/chat/stream')) errors.push('public chat must not call private chat stream');
if (!read('apps/faq/public-app.js').includes('/api/public-chat/stream')) errors.push('public chat stream endpoint missing');

fail(errors);
