-- Add billing period start to subscriptions.
-- Used as HKDF info input for server-assisted BB bundle decryption.
-- Nullable: pre-existing rows and perpetual subscriptions have no period start.
ALTER TABLE subscriptions ADD COLUMN current_period_start TEXT;
