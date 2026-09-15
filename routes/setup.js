/**
 * Local setup API facade. Implementation lives in routes/setup/ with one file
 * per step under routes/setup/steps/.
 *
 * index.js mounts `app.route('/api/setup', setupRoutes)` for Account
 * Integrations and chat helper data. There is no browser `/setup` route.
 */
export { default } from './setup/index.js';
