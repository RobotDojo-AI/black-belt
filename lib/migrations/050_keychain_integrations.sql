-- WHY: Replaces the static KEY_MAP in routes/accounts.js with a DB-backed catalog.
-- Adding a new integration = INSERT a row here. No code change, no deploy required.
-- keychain_key stores the FULL prefixed name (e.g. robotdojo-ASANA_PAT) to match
-- the existing accounts.keychain_key convention and avoid double-prefix bugs.

CREATE TABLE IF NOT EXISTS keychain_integrations (
  provider     TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  keychain_key TEXT NOT NULL,
  section      TEXT NOT NULL DEFAULT 'productivity',
  source       TEXT NOT NULL DEFAULT 'seed',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- foundation_models section
INSERT OR IGNORE INTO keychain_integrations (provider, display_name, keychain_key, section, source) VALUES
  ('anthropic',   'Anthropic',      'robotdojo-ANTHROPIC_API_KEY',  'foundation_models', 'seed'),
  ('openai',      'OpenAI',         'robotdojo-OPENAI_API_KEY',     'foundation_models', 'seed'),
  ('google',      'Google AI',      'robotdojo-GOOGLE_AI_API_KEY',  'foundation_models', 'seed'),
  ('xai',         'xAI',            'robotdojo-XAI_API_KEY',        'foundation_models', 'seed');

-- productivity section
INSERT OR IGNORE INTO keychain_integrations (provider, display_name, keychain_key, section, source) VALUES
  ('notion',      'Notion',         'robotdojo-NOTION_TOKEN',       'productivity', 'seed'),
  ('asana',       'Asana',          'robotdojo-ASANA_PAT',          'productivity', 'seed'),
  ('asana_secondary',   'Asana (Secondary)',    'robotdojo-ASANA_PAT_SECONDARY',      'productivity', 'seed'),
  ('elevenlabs',  'ElevenLabs',     'robotdojo-ELEVENLABS_API_KEY', 'productivity', 'seed'),
  ('stripe',      'Stripe',         'robotdojo-STRIPE_SECRET_KEY',  'productivity', 'seed'),
  ('telegram',    'Telegram',       'robotdojo-TELEGRAM_BOT_TOKEN', 'productivity', 'seed'),
  ('figma',       'Figma',          'robotdojo-FIGMA_PAT',          'productivity', 'seed'),
  ('brave',       'Brave Search',   'robotdojo-BRAVE_API_KEY',      'productivity', 'seed'),
  ('godaddy',     'GoDaddy',        'robotdojo-GODADDY_API_KEY',    'productivity', 'seed'),
  ('slab',        'Slab',           'robotdojo-SLAB_API_TOKEN',     'productivity', 'seed'),
  ('iproyal',     'iProyal',        'robotdojo-IPROYAL_PROXY',      'productivity', 'seed');

-- health section
INSERT OR IGNORE INTO keychain_integrations (provider, display_name, keychain_key, section, source) VALUES
  ('oura',        'Oura',           'robotdojo-OURA_PAT',           'health', 'seed');
