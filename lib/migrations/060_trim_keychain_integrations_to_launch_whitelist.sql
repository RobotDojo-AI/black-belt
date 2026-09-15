-- Trim keychain_integrations to the v1 launch whitelist.
-- The original seed in migration 050 had 16 rows. For launch the approved set is
-- smaller: foundation_models (anthropic, google, openai, xai) + productivity
-- (asana, brave). Granola and Ollama are handled outside this table (granola via
-- the static "Add" picker, Ollama via /api/models + ollama-lifecycle). Workspace
-- (google email/cal/drive, microsoft, apple) is OAuth-based and not in this table.
--
-- WHY DELETE rather than a launch flag: keychain_integrations IS the catalog. A row
-- here means "approved for the integrations page." Adding a flag would split the
-- truth across two columns; keeping the table as the single source of truth keeps
-- the contract clear — present = available; absent = not on the launch list.
--
-- Story: st_42799dbe. Surfaced during post-deploy QA when the integrations page
-- showed providers outside the v1 launch scope.

DELETE FROM keychain_integrations
 WHERE provider IN (
   'notion',
   'asana_secondary',
   'elevenlabs',
   'stripe',
   'telegram',
   'oura',
   'figma',
   'godaddy',
   'slab',
   'iproyal'
 );
