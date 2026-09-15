# Robot Dojo Product Vision

Robot Dojo is a local-first personal intelligence system. The customer promise is simple: you are working with an AI that knows your world.

The product should help a person feel like their own life is becoming searchable, usable, and alive. It connects to what they already know, what they already wrote, who they know, where they have been, and what they are trying to become. Then it turns that into fast chat, topic-centered work in the coding agent, and a build system they can keep improving.

## Promise

You are working with an AI that knows your world. It connects to your accounts, learns from what you already have, and gives back answers, focus, and leverage — without surrendering your data to a stranger.

Robot Dojo is local-first. Your raw data stays on your machine. The intelligence layer is yours; the running engine is what you pay for.

Account recovery is local-first. If you lose the login token, open the Robot Dojo folder on the machine that runs the server and use `npm run token -- show` to reveal the current token or `npm run token -- rotate` to create a new one. Rotating a token signs out every browser session.

## Who it's for

The launch cohort is a small group of operators and builders — typically founders, investors, or technical leaders — who have enough context (CRM-style relationships, deep work archives, complex calendars, health data) that a generic chat surface flattens what they could actually do with it.

The first wedge demo is reasoning over a real network: YC companies, top VCs, companies in your portfolio, friends, family, and the people and organizations you have already worked with. The product earns its place by making that context usable from the first session.

The promise scales beyond that wedge — anyone whose life is messy enough that searching it themselves is harder than asking — but the launch cohort is the operator profile that proves it.

## Tiers

**White Belt — open source, MIT-licensed, free.**

White Belt is the local foundation: chat with RAG, user files, chat history, topics, local memory, and user context. The code is public; you can audit, fork, and run it on your own hardware.

White Belt does not include entity extraction, entity enrichment, inline entity recognition, build skills, premium apps, or premium agent/tool runs.

**Black Belt — source-available under the Elastic License v2 (ELv2), runs on subscription.**

Black Belt is the world model and creation layer. It includes White Belt plus entity extraction, enrichment, entity context files, people/places/companies, relationship context, entity-aware chat, coding-agent skills on topics, Health, premium apps, and premium agent/tool runs.

The code is public so you can audit it. Running it requires an active subscription — the relay (remote access) is the hard server-side gate. On subscription lapse, engines pause and the data is preserved read-only; your raw files, local databases, chat history, topics, topic logs and outputs, user-created files/apps, account settings, and existing entity markdowns stay on your machine. Reactivation restores active use.

At launch, every install gets Black Belt for 90 days. Then the key expires. Billing and checkout are not part of the beta surface.

## What you can do

**Chat.** Open a chat and ask anything about your world. The system loads your identity, the selected topic, relevant RAG, and matched entities. Public docs chat at `/ask` answers from generated public truth derived from canonical docs.

The visual north star is a fast, polished, quiet chat interface in the spirit of Gemini: clean, focused, and calm.

**Topics.** Chat is the standing conversation on a topic. The coding agent works the same topic with extra tools. `/topic` opens the topic's last state, log, and next step. Durable conclusions write back to that topic so the next session resumes. There is no separate workbench product.

`/topic health` and `/topic coaching` replace the old `/health` and `/coach` skills. `/work {name}` still routes to `/topic`.

**Build (agent OS).** A six-agent pipeline turns an idea into shipped code: Miyagi orchestrates; Tantei maps the codebase; Hakase researches outside the codebase; Ori designs schema and architecture; Katagami builds; Bunshin audits every stage. Stages are framing, research, scope, plan, build, qa, close — each one writes one artifact, seals it, and stops for explicit owner approval.

Customer-facing build skills are not chat commands. Black Belt topic work in the coding agent uses build skills underneath. The agent OS is shipped portable — skills, personas, and pipeline stages are protocols, not a dependency on one IDE or one coding assistant.

**Apps on the substrate.** Health is the first first-party premium app built on top of the substrate. Future apps reuse the same local data, topic context, RAG, timeline, and chat infrastructure only after they are promoted into the app registry. The app layer specializes; it does not fork the intelligence system.

## Launch scope

People want a chat that knows them. Launch is that, in two places: web chat (memory; topics are the standing conversations) and the coding agent (the same memory, plus shipped skills, the agent's tools, and small scripts as they go).

Nothing else launches. Health, Fitness, Network, and Podcast stay on this machine. Account Integrations is Chat setup so the memory is real.

Work here in `RobotDojo-AI/dev`. Public install clones `RobotDojo-AI/black-belt`, a published subset of a named commit. Tests and founder app UIs do not ship. Do not keep a second working copy. Founder waffle appears because those app folders exist here.

Install on macOS Apple Silicon (16GB RAM minimum). Connect and import fill topics, entities, timeline, and logs. Chat and the coding agent read that same memory. Chat opens without a foundation-model key. Background jobs sync without choking the machine. Data stays local. White Belt and Black Belt promises stay explicit.

## First user to product

The first user is a calibration seed, not a hard-coded product subject.

Product code, skills, personas, pipeline instructions, and public docs refer to the current user, owner, or account through runtime variables and identity context. First-user-specific names, samples, memories, topics, entities, chats, credentials, and voice calibration must remain only in private seed data or explicitly labeled owner/developer files that never ship in customer builds.

The same repo serves the founder as user one, then serves any future user without agents needing to remember which names were hard-coded by accident.

## What makes it feel alive

Robot Dojo should not feel like a static archive. It should feel alive because:

- it keeps syncing
- it remembers recent changes
- it notices repeated topics
- it recognizes entities during chat
- it refreshes context while the user is away
- it lets the user correct important beliefs directly
- it gets better from normal chat, not only from manual setup

The recurring update loop can run overnight, when the user goes idle, or after important imports.

Robot Dojo must never make the user's machine feel slow. RAG, indexing, imports, entity work, and enrichment monitor load, throttle themselves, and prefer idle or overnight windows. Even on a dedicated server, background work should not choke CPU.

RAG runs locally and for free on a bundled embedding model, and chat runs on a local model (selected by machine RAM) — so a new user gets useful context and chat with no API key. A foundation-model key is an optional upgrade, never on the onboarding critical path.

## Non-negotiables

- Local-first data ownership.
- No user data on Robot Dojo servers.
- Mac-only until further notice.
- Apple Silicon and 16GB RAM minimum; 32GB recommended for heavier Black Belt work.
- No CPU-choking background work.
- Fast chat.
- Clear White and Black tier behavior.
- Product intelligence is shipped; founder identity data is not.
- No random agent-built product surfaces.
- No hidden dependence on one coding assistant.
- No hard-coded first-user identity in product behavior.
- Canonical docs stay short and useful.
- Generated docs summarize the codebase; curated docs guide future code.
