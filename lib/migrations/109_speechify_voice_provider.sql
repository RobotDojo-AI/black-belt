-- Register Speechify as a voice-provider API key integration for Podcast TTS.
-- Existing installs need this catalog row so /api/accounts/keys can store
-- robotdojo-SPEECHIFY_API_KEY through the same Keychain-backed path as other
-- provider keys.

INSERT INTO keychain_integrations (provider, display_name, keychain_key, section, source)
VALUES ('speechify', 'Speechify', 'robotdojo-SPEECHIFY_API_KEY', 'productivity', 'seed')
ON CONFLICT(provider) DO UPDATE SET
  display_name = excluded.display_name,
  keychain_key = excluded.keychain_key,
  section      = excluded.section,
  source       = excluded.source;
