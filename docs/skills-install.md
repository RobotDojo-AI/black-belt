# Skills Install

## Overview

Two tiers:

**Identity only** — Miyagi plus the specialist persona roster injected into Claude Code, Codex, or Cursor. No pipeline scripts. Works on any machine, no clone required. Best for team members who want the cognitive profile without the build pipeline.

**Full pipeline** — Core skills (/story, /defect, /work, /framing, /research, /scope, /plan, /build, /qa, /close, /write, /format, /kanban) plus identity. Requires Node 20+. Uses sparse checkout if ~/robotdojo isn't already on the machine.

---

## Full Pipeline Install (Claude Code)

```bash
# If you don't have ~/robotdojo yet:
bash <(curl -fsSL https://raw.githubusercontent.com/RobotDojo-AI/black-belt/main/scripts/install-skills.sh)

# Or if you already have it cloned:
bash ~/robotdojo/scripts/install-skills.sh
```

Open a new terminal after install. Try `/story your-first-story`.

---

## Identity Only (no pipeline)

For team members who want the agent operating system without the pipeline scripts.

**Claude Code:** Copy `agents/dist/claude.md` anywhere on your machine, then add this line to `~/.claude/CLAUDE.md`:

```
@/path/to/claude.md
```

**Cursor:** Copy `agents/dist/cursor-identity.mdc` to your project's `.cursor/rules/identity.mdc`. Cursor picks it up automatically on next reload.

**Codex:** Copy `agents/dist/AGENTS.md` to `~/.codex/AGENTS.md`, or import it from a project/root `AGENTS.md` if your Codex environment supports local imports.

**Claude subagents:** Copy or symlink `agents/dist/claude-agents/*.md` into `~/.claude/agents/`. Those files are generated adapters; edit `agents/personas/*.md` instead.

---

## Cursor Installation

**Per-project:** Copy `cursor-identity.mdc` into `.cursor/rules/` of each project you want Miyagi active in.

**All projects on this machine:** Run `bash ~/robotdojo/scripts/install-skills.sh`. The installer creates a `~/.cursor/rules/identity.mdc` symlink that applies globally to all Cursor projects on the machine.

---

## What is NOT shared (machine-local only)

These files are intentionally excluded from `install-skills.sh`. They are personal to each machine and must not be shared.

- `~/robotdojo/user/memory/MEMORY.md` — your personal memory log. Each machine generates its own from your conversations and corrections.
- `~/robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/kanban.md` — your active project board. Reflects your local story state.
- `cursor-memory.mdc` — compiled from your local memory log. Do not share.

The identity and skills are universal. Memory is personal.
