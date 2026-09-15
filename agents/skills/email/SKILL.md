---
name: email
description: Create Gmail drafts in a connected Google account for batched outreach (recruiter emails, intros, follow-ups); never sends — the owner QCs and schedules every send.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: tool
---

# /email
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

Create Gmail DRAFTS in a connected Google account — it never sends. For batching outreach (recruiter emails, intros, follow-ups) where the owner QCs and schedules every send himself.

## Canonical use cases

- Draft a batch of recruiter or networking outreach emails for the owner to review and send.
- Prepare follow-up or intro email drafts in the owner's voice, staged in Gmail for manual QC and scheduling.

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->

## Safety — drafts only, never send

This skill creates drafts and nothing else. The engine `scripts/create-gmail-drafts.js` calls exactly one Gmail endpoint — `POST /gmail/v1/users/me/drafts` (drafts.create) — and has no send code path anywhere in it. A draft lands in the account's Drafts folder; a human opens and sends it. Do not invoke any send endpoint (`/messages/send`, `/drafts/send`) from this skill under any circumstances — the owner QCs and schedules every send himself. Sending unreviewed outreach in the owner's name is a disaster, not a convenience.

## Contract

Reads: a set of drafts (recipient, subject, plain-text body, optional attachments) and the target Google account.

Writes: one Gmail draft per item in that account, via `scripts/create-gmail-drafts.js`. Nothing is sent.

Stops when: the drafts are created and their ids are reported back.

## Steps

1. **Gather the drafts.** Each needs `to`, `subject`, `body` (plain text, one blank line between paragraphs), and optional absolute-path `attachments`. Confirm the target account — a connected Google OAuth account (see the accounts list / keychain).

2. **Write the payload to a scratch JSON file** (session scratchpad, never the repo):
   ```json
   {
     "account": "owner@gmail.com",
     "drafts": [
       { "to": "x@firm.com", "subject": "Subject line", "body": "Hi X,\n\nParagraph one.\n\nParagraph two.\n\nThank you,\nName", "attachments": ["/absolute/path/Resume.pdf"] }
     ]
   }
   ```

3. **Create the drafts:**
   ```sh
   node ~/robotdojo/scripts/create-gmail-drafts.js --account owner@gmail.com --file <payload.json>
   ```
   Run with `--dry-run` first to preview (recipient, subject, body length, attachments) without touching the API.

4. **Report** the created draft ids per recipient, confirm nothing was sent, and delete the scratch payload.

## Notes

- The account must be connected (Keychain OAuth) with the `gmail.compose` or `gmail.modify` scope. The engine checks and refuses otherwise, telling you to reconnect with compose access.
- Body is `text/plain` — no markdown or HTML. Keep exactly one blank line between paragraphs.
- Attachments are absolute paths; the engine sets the MIME type by extension. If the body says "resume attached," you must pass the resume's absolute path in `attachments` — the sentence alone attaches nothing.
- Multiple recipients: comma-separate in `to`; `cc` is supported.
- The owner always QCs and schedules the send. This skill never schedules or sends.
