-- Current launch scope requires these integrations to be visible and truthful.
-- Migration 060 intentionally trimmed the catalog for an older launch shape;
-- this restores the current first-session contract.

INSERT INTO keychain_integrations (provider, display_name, keychain_key, section, source)
VALUES
  ('mistral', 'Mistral', 'robotdojo-MISTRAL_API_KEY', 'foundation_models', 'seed'),
  ('notion',  'Notion',  'robotdojo-NOTION_TOKEN',    'productivity', 'seed'),
  ('oura',    'Oura',    'robotdojo-OURA_PAT',        'health', 'seed')
ON CONFLICT(provider) DO UPDATE SET
  display_name = excluded.display_name,
  keychain_key = excluded.keychain_key,
  section      = excluded.section,
  source       = excluded.source;

UPDATE keychain_integrations
   SET keychain_key = 'robotdojo-GOOGLE_AI_API_KEY',
       display_name = 'Google AI',
       section = 'foundation_models'
 WHERE provider = 'google';
