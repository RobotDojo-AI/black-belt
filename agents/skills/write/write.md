# Write Skill

Prose generation using the owner's voice and canonical samples.

## Voice docs
`~/robotdojo/user/workbenches/user/wk_user/user-voice/`

Voice profiles and samples are owner-specific (PII) — gitignored, not tracked. Restore from your local backup as needed.

## Available channels and registers

See `SKILL.md` for the full routing table — the four channels (linkedin, gmail, email, sms) and the document-type registers — and `user-voice/INDEX.md` for the one listing of all of them.

## Sample management protocol

1. Drop writing samples (`.txt`, `.md`, `.pdf`, `.docx`) into `~/robotdojo/user/workbenches/user/wk_user/user-voice/samples/`
2. Run the ingest script to classify samples and augment the voice docs:

```bash
node ~/robotdojo/scripts/ingest-voices.js
```

Dry-run to preview classification without API calls:

```bash
node ~/robotdojo/scripts/ingest-voices.js --dry-run
```

Include Gmail sent mail as additional samples:

```bash
node ~/robotdojo/scripts/ingest-voices.js --source gmail:<your@email.com>
```

Force-replace existing evidence sections (re-run after adding new samples):

```bash
node ~/robotdojo/scripts/ingest-voices.js --force-augment
```

## Write CLI

Generate prose directly:

```bash
node ~/robotdojo/agents/skills/write/write.js --voice <channel-or-register> --brief "<text>"
```

Examples:

```bash
node ~/robotdojo/agents/skills/write/write.js --voice linkedin --brief "thoughts on deterministic entity resolution vs LLM guessing"
node ~/robotdojo/agents/skills/write/write.js --voice gmail --brief "follow up with the prospect: confirm the 3pm call and send the one-pager"
node ~/robotdojo/agents/skills/write/write.js --voice memo --brief "Q1 update for the team: shipping is ahead of schedule"
node ~/robotdojo/agents/skills/write/write.js --voice essay --brief "the 20-year thesis finally executes"
```
