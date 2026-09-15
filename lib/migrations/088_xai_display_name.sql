-- Canonical provider display is xAI. Grok remains the model family and legacy
-- key alias, not the provider name shown in Accounts.
UPDATE keychain_integrations
SET display_name = 'xAI',
    keychain_key = 'robotdojo-XAI_API_KEY'
WHERE provider = 'xai';
