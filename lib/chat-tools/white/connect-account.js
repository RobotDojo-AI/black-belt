import { defineTool, ok, err } from '../registry.js';

defineTool('connect_account', {
  description: 'Start connecting a new account/integration. Google opens OAuth. Microsoft uses tenant-admin Graph app credentials plus mailbox add. API-key providers prompt through secure input.',
  parameters: {
    properties: {
      provider: {
        type: 'string',
        enum: ['google', 'microsoft', 'anthropic', 'openai', 'google_ai', 'xai', 'ollama', 'asana', 'notion', 'oura', 'granola', 'apple', 'monarch'],
        description: 'Service provider to connect',
      },
      account_type: {
        type: 'string',
        enum: ['email', 'calendar', 'drive', 'contacts'],
        description: 'What type of access to request (for OAuth providers)',
      },
    },
    required: ['provider'],
  },
  execute({ provider, account_type }) {
    // This tool returns metadata that the frontend interprets as an action.
    // OAuth: frontend opens a popup to the auth URL.
    // API key: frontend renders a secure password input.
    const providers = {
      google: { auth: 'oauth', url: '/api/auth/google/start?account=personal', types: ['email', 'calendar', 'drive', 'contacts'] },
      microsoft: { auth: 'app_credentials', url: '/account/integrations', types: ['email', 'calendar'] },
      anthropic: { auth: 'api_key', types: ['llm'] },
      openai: { auth: 'api_key', types: ['llm'] },
      google_ai: { auth: 'api_key', types: ['llm'] },
      xai: { auth: 'api_key', types: ['llm'] },
      ollama: { auth: 'local', url: '/account/integrations', types: ['llm'] },
      asana: { auth: 'api_key', types: ['task'] },
      notion: { auth: 'api_key', types: ['document'] },
      oura: { auth: 'api_key', types: ['health'] },
      granola: { auth: 'local', url: '/account/integrations', types: ['meeting'] },
      monarch: { auth: 'local', url: '/account/integrations', types: ['finances'] },
      apple: { auth: 'local', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles', types: ['contacts', 'calendar', 'messages', 'photos'] },
    };

    const p = providers[provider];
    if (!p) return err(`Unknown provider: ${provider}`);

    return ok({
      action: p.auth === 'oauth' ? 'oauth_redirect'
        : p.auth === 'api_key' ? 'secure_input'
          : p.auth === 'app_credentials' ? 'open_local_setup'
          : 'open_local_setup',
      provider,
      auth_type: p.auth,
      auth_url: p.url || null,
      account_type: account_type || p.types[0],
      supported_types: p.types,
    });
  },
});
