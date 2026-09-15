# Robot Dojo

Robot Dojo is a Mac-first, local-first personal intelligence system. Chat is the product. Memory is what makes it different.

It connects to your real data, organizes it into topics, entities, timeline, and logs, then uses that same memory in web chat and in a coding agent. The coding agent has the shipped skills, its own tools, and can write small scripts as you go. Black Belt adds the living world model underneath that chat: people, places, companies, and relationships.

## Install

One command, from a fresh clone on an Apple Silicon Mac:

```bash
git clone https://github.com/RobotDojo-AI/black-belt.git
cd black-belt
./install.sh
```

The installer checks prerequisites, installs Homebrew, Node, and the local embedding model, provisions local TLS, starts the background service, and opens your browser to Account Integrations at `https://localhost:4338`. From there you connect your own foundation-model key, your Google workspace, and any API-key tools you already use.

You can also install directly from the hosted script:

```bash
curl -fsSL https://robotdojo.ai/install.sh | bash
```

Because you clone first, `install.sh` is local, readable code you can inspect before running it.

Requirements: Apple Silicon Mac, 16GB RAM minimum, 8GB free disk, Xcode Command Line Tools (the installer stops early and tells you to run `xcode-select --install` if they are missing).

## Belts

| Belt | Promise | Included |
| --- | --- | --- |
| White | Knows you | Local chat with RAG, files, topics, local memory, user context, and chat history |
| Black | Knows your world | White plus entities, enrichment, entity-aware chat, Health, premium apps, and premium tool runs |

If Black Belt expires, the engines pause. Your raw data and local artifacts are preserved on your machine, read-only, and resubscribing re-animates them.

## Licensing

Robot Dojo is a dual-licensed repository. The nearest license governs each file.

- **White Belt is open source under the MIT License** (root [`LICENSE`](LICENSE)). Run it locally, forever, with your own AI keys.
- **Black Belt is source-available under the Elastic License 2.0** ([`LICENSE-BLACKBELT`](LICENSE-BLACKBELT)). Source-available means the code is public so you can audit it — it is **not** open source. Black Belt runs only while you hold an active subscription; the Elastic License 2.0's license-key clause is the legal form of that gate. Your data stays yours across both tiers.

## Known rough edges

This is a private beta. The path a first tester runs works end to end, but some edges are still rough:

- **Google connect shows an "unverified app" warning.** Formal Google app verification is pending; the warning is expected for beta and safe to accept. Google connect also depends on operator-provided OAuth credentials — if your machine has none, connect the workspace path is unavailable and you should reach a first personally-aware chat through Apple-local data, an API-key tool, or dropped files instead.
- **Remote access is a Black Belt feature that needs a beta invite secret.** Without it, the app runs local-only at `https://localhost:4338`; the "reach from anywhere" relay degrades silently to local.
- **macOS is the supported target.** Linux is best-effort; Windows is not supported (use WSL2 at your own risk).
- **First-run wants Full Disk Access.** The installer opens the macOS privacy pane so Apple-local sources (Contacts, iMessage, Calendar) can sync into your personal context.

## Architecture

Start here:

- [architecture/product.md](architecture/product.md) - product promise, launch scope, tier model
- [architecture/architecture.md](architecture/architecture.md) - human-readable system architecture
- [architecture/structure.md](architecture/structure.md) - repository placement contract
- [architecture/sitemap.md](architecture/sitemap.md) - generated file inventory
- [architecture/ontology.md](architecture/ontology.md) - generated directory ontology

## Repository Shape

Core runtime code lives in `lib/`, `routes/`, `api/`, and `apps/`.

Local user data, generated contexts, imports, logs, and pipeline artifacts are gitignored. Canonical docs are short, curated surfaces. Generated inventory docs are regenerated from code and config.

## Development

Install dependencies:

```bash
npm install
```

Run focused tests for the build pipeline:

```bash
node --test tests/story-preflight.test.js tests/story-pipeline.test.js
```

Regenerate inventory docs after structural changes:

```bash
node scripts/generate-sitemap.js --write
node scripts/generate-ontology.js --write
```

Run checks before shipping:

```bash
npm test
```
