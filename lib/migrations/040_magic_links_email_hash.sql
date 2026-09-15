-- Expire any magic_links rows still storing plaintext email (pre-hash migration).
-- These tokens are short-lived (15min); expiring them is safe — users simply re-request.
UPDATE magic_links SET used_at = COALESCE(used_at, datetime('now')) WHERE email LIKE '%@%';
