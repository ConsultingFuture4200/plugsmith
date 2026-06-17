# plugsmith — Implementation Plan

**Version:** v0.7.0 (tracks PRD v0.7.0)
**Status:** Draft
**Owner:** Dustin Powers (UMB Advisors)
**Date:** 2026-06-15

> Scope: the MVP features in PRD v0.5.0 §4 — the five CLI features plus a read-only web dashboard built after the CLI core. Nothing here builds backlog (§11). The ordering front-loads usable value: you get a working recommender on the CLI first, then a dashboard to view it.

---

## Version history

| Version | Date | Notes |
|---|---|---|
| v0.4.0 | 2026-06-15 | Initial implementation plan for the five-feature recommender MVP. |
| v0.5.0 | 2026-06-15 | Added Milestone E (read-only web dashboard) after the CLI core; updated stack notes and exclusions. |
| v0.6.0 | 2026-06-15 | Milestone A reworked around the canonical `marketplace.extended.json` as primary source (smaller, lower-risk); added a pre-A spike to study pi-pathfinder and the catalog structure; noted ccpi as a possible install backend. |
| v0.7.0 | 2026-06-15 | Milestone C rewritten for the grounded LLM recommender (pre-filter → LLM proposal → validation); added provider adapter + caching/cost guard work; spike (Milestone 0) extended to pick a default provider and sanity-check local-model JSON reliability. |

---

## 0. Stack & conventions
- **Language/runtime:** TypeScript on Node (matches the Claude Code/plugin ecosystem and lets the CLI shell out to `claude` cleanly). Single package, `@plugsmith/core` + a thin `bin/` CLI in the same repo to start — split into packages only if it ever needs it.
- **Store:** SQLite via `better-sqlite3` (synchronous, simple, local-first; no server).
- **CLI framework:** a minimal arg parser (e.g. `commander`). No TUI framework in v1.
- **Web UI (Milestone E):** React + Tailwind + recharts, served locally by `plugsmith serve` over the same SQLite store via a thin read-only core API. No separate backend logic.
- **Recommender model:** grounded LLM (PRD §4.3). Provider is a swappable adapter behind a strict JSON-schema contract (PRD §4.7); core never depends on which provider answered.
- **Provider adapters:** Anthropic API and a local OpenAI-compatible endpoint (the 3090 rig). Default provider per PRD §12 Q3.
- **Testing:** the normalizer and recommender are pure functions — unit-test those hard; everything else gets light smoke tests.
- **Repo bootstrap:** use the `project-bootstrap` skill to scaffold, then this plan drives the build.

## Milestone 0 — Spike: study the prior art *(half-day, before A)*
**Goal:** absorb what exists so the build borrows rather than reinvents.
1. Read `marketplace.extended.json` structure firsthand: confirm the frontmatter fields (`name / description / allowed-tools / version / author / license / compatibility / tags`), how categories are expressed, and how bundled hooks/MCP/skills are declared. This determines the normalizer's primary mapping.
2. Install and run **pi-pathfinder** on 2–3 real tasks. Note exactly where it stops: does it read installed state? reason about conflicts/context-cost? compose a stack or pick one thing? Confirm the §1.1 positioning holds and capture any reasoning-presentation ideas worth borrowing.
3. Skim **ccpi**'s install/list surface to decide whether it's the install backend or whether to shell out to `claude plugin install` directly.
4. **Provider sanity-check:** confirm the local model on the 3090 rig can reliably return strict JSON against a fixed schema for a sample (task, candidate set) prompt, and compare a couple of outputs against the Anthropic API. This decides the default provider (PRD §12 Q3) and surfaces any local-model JSON-reliability issues before they're load-bearing.

**Exit gate:** a one-page note confirming the catalog field mapping, the precise pi-pathfinder gap plugsmith fills, and a provider decision (default + whether local JSON output is trustworthy enough). If pi-pathfinder turns out to already do deconflicted-stack reasoning against live inventory, stop and reassess scope before building.

## Milestone A — Index you can search *(serves PRD §4.1)*
**Goal:** `sync` ingests the canonical catalog (primary) plus configured marketplaces, normalizes, stores; `search` queries it.

1. Repo scaffold, SQLite store, `marketplaces` + `components` tables (PRD §7, incl. `compatibility`).
2. **Canonical-catalog ingester (primary path):** fetch `marketplace.extended.json` and map its enforced frontmatter straight into the `components` model. This is the bulk of the index and the lowest-risk path — mostly field mapping, not heuristics.
3. Source config file (`~/.plugsmith/marketplaces.yaml`): canonical catalog enabled by default; plus the official marketplace and any additional curated entries (pending PRD §12 Q1) for independence.
4. **Normalizer:** primarily targets the canonical schema (step 2); a thinner adapter handles the official-marketplace `.claude-plugin/marketplace.json` shape. Derive trust tier and context-cost flag (using declared `allowed-tools`/schema size where present); carry `compatibility` through unmodified.
5. Skip-loud error handling (PRD §8): per-source parsed/skipped counts surfaced on `sync`.
6. `plugsmith sync` and `plugsmith search`.

**Exit gate (stop and use it):** sync the canonical catalog + the official marketplace; `search memory --category 3` returns sane, normalized results with trust tier and context-cost; a deliberately malformed entry is skipped with a visible count, not silently dropped.

## Milestone B — Know your current setup *(serves PRD §4.2)*
**Goal:** `status` shows what's installed and enabled, annotated from the index.

1. `inventory` table (PRD §7).
2. Scanners for `~/.claude/plugins/`, `~/.claude/skills/`, project `.claude/`, and the three settings files; read enabled/disabled and source scope.
3. Reconcile inventory against the index (annotate category/trust/context-cost); unknown installed items are shown as "installed, not in index."
4. Best-effort parsing (PRD §8): unreadable settings file → report and continue.
5. `plugsmith status`.

**Exit gate:** on your actual machine, `status` correctly lists installed components, enabled state, and scope, and flags anything not in the index. Verify against `/hooks` and your known setup.

## Milestone C — The recommender *(serves PRD §4.3, §4.4, §4.7, §4.8 — this is the product)*
**Goal:** `recommend "<task>"` runs pre-filter → grounded LLM proposal → validation, outputting enable/install/disable with reasons, conflict + context-cost annotations, cheaply.

1. **Deterministic pre-filter:** from the task prose + flags (`--tight`, `--integrations`, `--scope`), narrow the index to a plausible candidate set (likely categories → real components, preferring installed/higher-trust). Keeps the prompt small and bounds what the model can choose. Breadth is tunable (PRD §12 Q2).
2. **Provider adapter** (PRD §4.7): implement the JSON-schema contract; wire the default provider chosen in Milestone 0 plus the other as opt-in (`--provider`). Malformed output → loud failure, never a silent degraded result.
3. **LLM proposal:** send (task + candidate set + inventory); receive structured enable/install/disable with per-line reasons as strict JSON.
4. **Grounding/validation (the guardrail):** drop any proposed component that doesn't resolve to a real catalog entry (hallucination), loudly. Then run the **conflict + context-cost checker** (PRD §4.4) as hard facts on the validated set — singleton-collision → `conflict`; hook/command collisions → `warn`; context-cost summary, with a `--tight` note. The model cannot override these.
5. **Cache + cost guard** (PRD §4.8): cache by (task-signature + index-version), invalidated on `sync`; paid-provider confirm with token estimate (`--yes` to bypass), no guard for local; `--no-cache` to force a fresh call.
6. **Explanations:** the LLM's per-line reasoning is the explanation, each anchored to a real catalog entry. Non-negotiable.
7. `plugsmith recommend`.

**Exit gate (the real test):** run `recommend` against 5–10 real tasks from your own work across entities, on both providers. Judge honestly: are the picks sensible and grounded (no invented plugins), are the reasons legible, do the conflict flags catch the obvious "two memory plugins" case, does the cache make re-runs free? **This milestone is where the project succeeds or fails** — spend time here. The pre-filter breadth and prompt are the iteration surface (replacing the old rule-table tuning).

## Milestone D — Make it safe to act on *(serves PRD §4.5)*
**Goal:** turn an accepted recommendation into config, safely.

1. CLAUDE.md managed-block writer: locate/insert the `<!-- plugsmith:start v… -->`…`<!-- plugsmith:end -->` block; replace only its contents; bump embedded version.
2. Hard guarantee: never read for meaning or modify anything outside the block. Unit-test this against files with content above and below the block, no block, and an empty file.
3. `.bak` backup before any `--write`; stdout review-first by default (PRD §8).
4. Optional: `recommend` → accepted "install" items shell out to `claude plugin install`, then re-run inventory (PRD §6). Keep this behind an explicit confirm; it's the only state-changing path besides gen-claudemd.
5. `plugsmith gen-claudemd`.

**Exit gate:** generate a block, edit content above and below it by hand, regenerate, and confirm your hand edits survive byte-for-byte and a `.bak` exists. This is the trust-defining test.

## Milestone E — Read-only dashboard *(serves PRD §4.6)*
**Goal:** `plugsmith serve` launches a localhost dashboard that views the index, status, and recommendations — and changes nothing.

1. Thin read-only core API: expose the existing core functions (index query, inventory read, recommend) over a local HTTP layer the UI calls. No new logic — these are the same functions the CLI uses.
2. React + Tailwind + recharts app with three views: **Index** (browse/filter/search), **Status** (visual `status`), **Recommendation** (task input box → renders enable/install/disable + reasons + conflict/context-cost).
3. Enforce the read-only boundary in code: the served API exposes no mutating endpoints. No enable/install/disable/write paths exist server-side, so the UI structurally cannot change machine state.
4. `plugsmith serve [--port]`, binds localhost only.

**Why last:** it depends on A–C existing (nothing to display otherwise) and must not distract from Milestone C, where the product succeeds or fails. Building it after the core also proves the "UI computes nothing the CLI can't" rule — if a view needs data the CLI can't produce, that's a core gap to fix in core, not in the UI.

**Exit gate:** every view renders from the live store; the Recommendation view's output for a given task matches `plugsmith recommend "<task>"` exactly; there is no UI action that alters installed/enabled state or touches CLAUDE.md.

## Sequencing logic
A→B→C→D→E is dependency- and value-ordered: index (A) and inventory (B) feed the recommender (C), which is the product; D makes C's output safe to act on; E makes it pleasant to view. You can stop after C and have a useful advice tool, after D and have a safe one, after E and have a comfortable one. Each milestone is independently shippable.

## Explicitly NOT in this plan
Telemetry, token measurement, trending, scheduler/daemon, profiles, comparison, audit, regression, perms, budget simulator, and any *interactive/state-changing* UI. All in PRD §11 backlog. The grounded LLM recommender is now **in scope** (Milestone C). The web UI that IS in scope (Milestone E) is strictly read-only. Note: the **permission-surface review (perms)** is the backlog item most worth promoting next, because the LLM's persuasive justifications sharpen the supply-chain risk (PRD §10) — but it stays backlogged unless you decide otherwise. Promotion of backlog items requires the MVP to have shipped and earned it.

## Open questions to close (Milestone 0 settles most)
1. Which additional marketplaces beyond the canonical catalog + official marketplace seed the config (PRD §12 Q1) — the spike's catalog review informs this.
2. Pre-filter breadth before the LLM sees candidates (PRD §12 Q2) — tuned in Milestone C.
3. Default provider: local vs Anthropic (PRD §12 Q3) — Milestone 0 step 4 decides.
4. Install backend: shell out to `claude plugin install` vs. use `ccpi` — Milestone 0 step 3 decides.

None block scaffolding; Milestone 0 (the spike) closes the provider and install-backend questions and gates whether to proceed at all.
