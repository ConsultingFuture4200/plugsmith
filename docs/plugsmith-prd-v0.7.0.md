# plugsmith — Product Requirements Document

**Version:** v0.7.0
**Status:** Draft (scope-locked)
**Owner:** Dustin Powers (UMB Advisors)
**Date:** 2026-06-15
**Convention:** Versioned per UMB filename policy. PRD is `.md` (version-controlled artifact).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| v0.1.0 | 2026-06-15 | Dustin Powers / Claude | Initial draft: scope, architecture, telemetry methodology, phased plan. |
| v0.2.0 | 2026-06-15 | Dustin Powers / Claude | Added trending repos + same-capability comparison. |
| v0.3.0 | 2026-06-15 | Dustin Powers / Claude | Expanded to 17 features (audit, budget, regression, profiles, health, digest, conflict-fix, perms, rehydrate). |
| v0.4.0 | 2026-06-15 | Dustin Powers / Claude | **Scope reset.** Refocused on the actual job: recommend which plugins to use for a given task. Cut telemetry, trending, scheduler, and 11 features to backlog (§11). Five-feature MVP. CLAUDE.md generator reduced to a safe managed-block. |
| v0.5.0 | 2026-06-15 | Dustin Powers / Claude | Added a read-only web dashboard (§4.6) as a defined-now/built-after-core milestone. Reads the same store; can run `recommend` for viewing but performs no state changes (no enable/install/write). |
| v0.6.0 | 2026-06-15 | Dustin Powers / Claude | Incorporated prior-art findings. Added §1.1 (positioning vs pi-pathfinder, ccpi, canonical catalog). Registry (§4.1) now consumes the canonical `marketplace.extended.json` as a first-class source while retaining multi-marketplace independence. Sharpened conflict/context-cost reasoning (§4.4) as the explicit differentiator. Added `compatibility` to the index model for future cross-agent awareness. |
| v0.7.0 | 2026-06-15 | Dustin Powers / Claude | **Recommender is now LLM-assisted (grounded), promoted from backlog.** §4.3 rewritten: LLM proposes judgment, deterministic index validates truth (existence + conflict/context-cost as hard post-filters the model cannot override). Added §4.7 (configurable model provider: Anthropic API or local, JSON-schema contract) and §4.8 (cost safeguards: pre-filtered candidate set, cache by task+index version, provider-aware confirm). Sharpened security risk (§10) — persuasive LLM justifications raise the supply-chain stakes. |

---

## 1. The one job

**"Given what I'm working on right now, which plugins/skills should be enabled?"**

That is the product. Everything in this PRD exists to answer that question well. Features that do not directly serve it have been moved to the backlog (§11), regardless of individual merit.

This is a **personal, local-first CLI tool** for an operator running many Claude Code projects across multiple entities. Not a platform, not a service, not a community product (yet).

## 1.1 Prior art & positioning

The ecosystem already contains pieces that overlap parts of this. plugsmith is positioned in the gap they leave.

- **pi-pathfinder** (a *skill*, in the tonsofskills catalog) — scans the marketplace and synthesizes/borrows plugin *patterns* in-session to solve the current task, with transparent reasoning about what it borrowed. It is **ephemeral and in-session**: it does not read your installed state, does not change your configuration, and does not reason about conflicts or context budget. plugsmith is the complement: **out-of-session, deterministic, durable** — it recommends a standing configuration (enable/install/disable) relative to what you actually have installed, and produces config (the CLAUDE.md block), not in-session improvisation. "Solve this now by borrowing" vs. "what should my standing toolkit be."
- **ccpi** (Intent Solutions package manager) — does install/list/upgrade/diagnostics over the canonical catalog. Search is "coming soon"; there is no task→recommendation layer. plugsmith can sit *above* ccpi rather than competing: ccpi handles package management, plugsmith owns the recommendation intelligence.
- **The canonical catalog** (`marketplace.extended.json`) — a single well-structured JSON the Claude Code CLI itself reads, with enforced frontmatter (`name / description / allowed-tools / version / author / license / compatibility / tags`). This largely solves the registry-normalization problem that earlier drafts treated as the top maintenance risk. See §4.1.
- **Adjacent overlaps to respect (not rebuild):** `claudebase` (config backup/restore/profiles → our backlogged setup-rehydrate), `claude-reflect` (auto-updates CLAUDE.md from corrections → adjacent to our gen-claudemd), `promptbook`/`token-optimizer` (session analytics → our cut telemetry). These reinforce keeping those features backlogged or out of scope.

**The differentiator, stated plainly:** the manual checklist users currently run in their heads — *don't run two memory plugins, is it still maintained, what's the token overhead of all these tool schemas* — is exactly what plugsmith's recommender automates against live inventory. Nobody else does the deconflicted-coherent-stack reasoning. That is the product (§4.3, §4.4).

## 2. Goals and non-goals

### Goals (v1)
- Maintain a searchable, categorized index of plugins/skills from a small set of trusted marketplaces.
- Know what is currently installed and enabled.
- Given a task description, recommend a coherent stack: what to enable, what to install, what to turn off.
- Flag conflicts (two plugins doing the same job, colliding hooks) and context-cost (hook-heavy / MCP-heavy stacks).
- Emit a chosen stack as a safe, clearly-delimited managed block in CLAUDE.md.

### Non-goals (v1 — see backlog §11)
- No telemetry, token measurement, or "savings" analysis. The recommender does not need measured data to do its job.
- No trending feed, no daily snapshots, **no background daemon or scheduler of any kind.** Sync runs only when invoked.
- Web UI is **read-only** (§4.6): it views the index, status, and recommendations, and can run `recommend` for display, but performs no state changes — enabling, installing, and CLAUDE.md writes stay CLI-only. Built after the CLI core as its own milestone.
- No baseline/task-class comparison, no regression alerts.
- plugsmith never owns or rewrites a whole CLAUDE.md; it manages only its own delimited block.

## 3. Component taxonomy

Each indexed component carries one or more category tags. The recommender maps task signals to categories, and categories to components.

1. Project management / spec-driven
2. Context management
3. Memory / persistence
4. Code quality / guardrails
5. Security / supply chain
6. Git / VCS workflow
7. Code review
8. Testing / verification
9. Multi-agent / orchestration
10. Observability / telemetry
11. Integrations / MCP connectors *(flagged context-costly)*
12. Domain skills
13. Output styling / formatting

Some categories are effectively **singletons** (memory, context manager) — having two is usually a conflict, not a choice. The taxonomy marks which categories are singleton so the recommender and conflict checker can reason about it.

## 4. MVP features

### 4.1 Registry sync + search
- **Primary source: the canonical catalog.** Consume `marketplace.extended.json` (the same manifest the Claude Code CLI reads) as a first-class, well-structured source with enforced frontmatter (`name / description / allowed-tools / version / author / license / compatibility / tags`). This is the low-maintenance path and largely removes the normalization risk earlier drafts carried.
- **Independence retained: multi-marketplace by config.** Keep a curated, config-file list of additional trusted marketplaces (the official marketplace + a few you name) so plugsmith is never captive to a single catalog's availability, editorial choices, or uptime. The canonical catalog is the default and the richest source, not the only one.
- Normalize every entry into one index model: name, source marketplace, trust tier (`official` / `partner` / `community`), category tags, bundled components (skills / commands / hooks / MCP servers), `compatibility` (which agents/harnesses it targets — carried now for future cross-agent awareness, not acted on in v1), and a derived **context-cost flag**.
- Context-cost flag: a component adding an MCP server or an always-on hook (e.g. `SessionStart`, or a broad/unmatched `PreToolUse`) is flagged costly; a lazily-loaded skill is not. Where `allowed-tools` / tool-schema size is declared, use it to refine the estimate.
- **Malformed entries skip loudly:** sync reports "parsed N, skipped M from source X" rather than silently producing a half-empty index. The normalizer targets the documented schemas; deviations are surfaced, not papered over.
- `plugsmith sync` refreshes the index from all configured sources. `plugsmith search <query> [--category]` queries it.

### 4.2 Inventory
- Scan `~/.claude/plugins/`, `~/.claude/skills/`, project `.claude/`, and settings files (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`) to determine installed components and enabled/disabled state.
- Reconcile against the index so each installed item is annotated with category, trust tier, and context-cost.
- `plugsmith status` shows the current effective setup (installed, enabled, what each provides, what scope it came from).
- The recommender depends on this: recommendations are relative to what is already present.

### 4.3 Recommender (the product) — grounded LLM-assisted
- Input: a task description (prose) plus optional explicit flags (scope system/project, required integrations, "keep context tight").
- **Architecture: the LLM does judgment, the index does truth.** The flow is:
  1. **Deterministic pre-filter.** From the task and flags, the index narrows to a plausible candidate set (likely categories → real components, preferring already-installed and higher-trust). This keeps the model's prompt small and cheap and bounds what it can choose from.
  2. **LLM proposal.** The model receives the task + the candidate set + current inventory and returns a structured proposal (enable / install / disable, each with a reason), as strict JSON (§4.7).
  3. **Deterministic validation (hard post-filters the model cannot override).** Every proposed component must resolve to a real catalog entry — anything that doesn't is dropped as a hallucination, loudly. The conflict/singleton/context-cost checks (§4.4) run as facts on the validated set; the LLM cannot wave away a two-memory-plugin conflict or hide context cost. The index is the source of truth; the model only proposes within it.
- Output, in plain terms: **Enable** (installed-but-disabled fits), **Install** (uncovered category), **Disable / consider off** (irrelevant or conflicting — annotate, never auto-act).
- **Explainability is now native and better:** the LLM's reasoning *is* the explanation, in prose, per line — "added a TDD guardrail because the task involves refactoring untested code." This was table stakes (the closest prior art, pi-pathfinder, leads with transparent reasoning); the LLM does it more naturally than a rule table. Every reason is still anchored to a real catalog entry, so reasons can't reference plugins that don't exist.
- **Why LLM over the previously-planned rule table:** a hand-tuned `rules.yaml` keyword map rots as the ecosystem shifts and is an unbounded maintenance treadmill (it was the plan's main long-term cost). An LLM interpreting the task against a fresh index ages far better — the index updates on `sync`, the model needs no re-tuning. The deterministic layer survives as the *grounding/guardrail*, not as the matcher.
- **Determinism caveat (stated honestly):** recommendations are no longer perfectly reproducible run-to-run. The cache (§4.8) makes identical task+index inputs return identical output, and the validation layer bounds the variance to "which real, valid components," never to invented ones. For a personal adviser this is an acceptable trade for far better task understanding.

### 4.4 Conflict + context-cost annotation — the differentiator
This is the reasoning no other tool automates. The ecosystem's own guidance frames it as a manual checklist users run in their heads before installing anything: *don't run two memory plugins, check it's still maintained, watch the token overhead of stacked tool schemas.* plugsmith runs that checklist automatically, against live inventory. Falls directly out of the recommender; not a separate engine.
- **Singleton-category collision** — two memory engines, two context managers → `conflict`. (The canonical "pick one" case.)
- **Hook collision** — two components registering hooks on the same event+matcher → `warn` (ordering/precedence surprise).
- **Command-name collision** — two components exposing the same command → `warn`.
- **Context-cost summary** — count of context-costly components in the recommended stack, using declared `allowed-tools`/schema size where available, with a note when a stack is hook-/MCP-heavy and the task flagged "keep context tight."
- Severity levels: `info` / `warn` / `conflict`. Annotate and explain; the operator decides. No hard blocking, no auto-resolution (resolution suggestions are backlog).
- **Stack coherence over single-plugin picking:** the recommender composes a small, deconflicted set, not a grab-bag. This is the behavioral difference from pattern-borrowing tools like pi-pathfinder (§1.1).

### 4.5 CLAUDE.md managed-block generator
- Turn a chosen stack into config that actually takes effect — **safely.**
- plugsmith writes **only** between delimiters: `<!-- plugsmith:start v<version> -->` … `<!-- plugsmith:end -->`. It never reads, edits, or overwrites a byte outside that block.
- If no block exists, it appends one. If a block exists, it replaces only that block's contents and bumps the embedded version.
- If the live CLAUDE.md doesn't exist, it offers to create one containing just the block.
- Everything outside the block — your hand-tuned content — is untouched and never parsed for meaning.
- `plugsmith gen-claudemd [--scope system|project] [--path <file>]`. Default behavior prints the block to stdout for review; `--write` performs the in-place managed-block update. Review-first by default.

### 4.6 Read-only web dashboard
A local, read-only dashboard that views what the CLI produces. **Defined now, built after the CLI core (Milestone E in the implementation plan).** Its purpose is visibility, not control.

- **Launched by** `plugsmith serve` (local only; binds localhost). React + Tailwind + recharts, served from `@plugsmith/core` data.
- **Views:**
  - **Index** — browse/search the synced component index, filter by category and trust tier, see context-cost flags.
  - **Status** — the current installed/enabled setup with annotations (the visual form of `plugsmith status`).
  - **Recommendation** — a task input box that calls the same deterministic recommender core and renders enable/install/disable with reasons, conflict flags, and the context-cost summary.
- **Strict read-only boundary:** the dashboard performs **no state changes.** It does not enable, install, disable, or write CLAUDE.md. Those remain CLI-only. Running `recommend` for display is allowed because it changes nothing on the machine; acting on the result is a CLI step. This is the honest line between "read-only" and "useless."
- **Architectural rule (non-negotiable):** the UI computes nothing the CLI cannot. It calls the same `@plugsmith/core` functions and renders their output. Every recommendation on screen is reproducible from a CLI command. No business logic in the UI layer.
- **Reads the same store** (`~/.plugsmith/plugsmith.db`). No separate data path, no divergence.

### 4.7 Model provider (configurable)
The recommender's model is a swappable component behind a single contract, so it runs wherever you want.
- **Contract:** given (task, candidate set, inventory), return a structured proposal as **strict JSON** against a fixed schema. The validator (§4.3 step 3) treats every provider's output identically, so the rest of the system is provider-agnostic.
- **Providers (config, `~/.plugsmith/config.yaml`):**
  - **Anthropic API (Claude)** — paid, highest quality, best for nuanced task interpretation.
  - **Local model on your own hardware** (e.g. the dual-3090 rig via an OpenAI-compatible endpoint) — free per call, private, no data leaves the machine.
- **Provider-adapter seam:** each provider is an adapter implementing the contract; adding one (or pointing at a different local endpoint) is a config change, not a code change to core. If a provider returns malformed JSON, that's a loud failure surfaced to the operator, not a silent degraded recommendation.
- The recommender does not depend on which provider answered — only on a schema-valid, index-grounded proposal.

### 4.8 Cost & caching safeguards
Per-call token cost changes the UX; these keep it cheap and predictable, scaled to the provider.
- **Small prompts by construction:** the model only ever sees the deterministic pre-filtered candidate set (§4.3 step 1), never the whole index. The prompt is bounded regardless of catalog size.
- **Cache by (task-signature + index-version):** an identical task against an unchanged index returns the cached proposal with zero tokens. Most re-runs cost nothing. The cache invalidates automatically on `sync` (index-version changes).
- **Provider-aware guard:** for the **paid** provider, `recommend` shows an estimated token cost and requires a per-session confirm (bypass with `--yes`); for the **local** provider, no guard — it's free. The guard is keyed to actual cost, not applied blanket.
- **UI routes through the same path:** the read-only dashboard may trigger a recommend, but it goes through the identical cache + cost guard, so it cannot silently accrue spend.

## 5. CLI surface (v1, complete)

```
plugsmith sync                              # refresh index from configured marketplaces
plugsmith search <query> [--category <c>]   # query the index
plugsmith status                            # show installed + enabled components
plugsmith recommend "<task>" [--scope ...] [--tight] [--integrations a,b] [--provider anthropic|local] [--yes] [--no-cache]
                                            # the product: what to enable/install/disable, with reasons (grounded LLM)
plugsmith gen-claudemd [--scope system|project] [--path <f>] [--write]
                                            # emit managed block (stdout by default; --write updates in place)
plugsmith serve [--port <n>]                # launch the read-only dashboard (localhost; no state changes)
```

That is the entire v1 command surface. No `report`, no `trending`, no `audit`. `serve` is read-only.

## 6. Architecture

- **`@plugsmith/core`** — registry index, normalizer, inventory scanner, recommender (pre-filter + grounding/validation), conflict checker, CLAUDE.md block writer. No UI assumptions. Pure functions over a local store where possible.
- **Model provider adapter** (§4.7) — a swappable component behind a JSON-schema contract; the only non-deterministic, network-or-GPU-touching part. Anthropic API or local endpoint, by config. Core depends on the contract, not the provider.
- **`plugsmith` CLI** — thin wrapper over core. Source of truth for all state changes.
- **Read-only web UI** (§4.6) — React/Tailwind/recharts dashboard launched by `plugsmith serve`, reading the same store and calling the same core functions. No state changes; no logic of its own.
- **Store** — SQLite at `~/.plugsmith/plugsmith.db` for the index and a cached inventory snapshot. Modest; no telemetry tables.
- **Install** — when the operator accepts an "install" recommendation, plugsmith shells out to the official `claude plugin install` (official CLI is source of truth) and re-runs inventory. plugsmith does not reimplement plugin installation. (Where present, `ccpi` could be used as the install backend instead — plugsmith owns recommendation, not package management; see §1.1.)

Design rule retained from earlier drafts: core is fully usable headless; the UI is a read-only view over core, never a place where important logic lives.

## 7. Data model (SQLite — minimal)

- `marketplaces` — id, name, git_url, trust_default, last_synced.
- `components` — id, name, marketplace_id, trust_tier, category_tags (json), bundles (json: skills/commands/hooks/mcp), context_cost_flag, singleton_categories (json), compatibility (json: target agents/harnesses; stored, not acted on in v1), last_synced.
- `inventory` — component_ref, scope (system|project), project_path, enabled, source_file, scanned_at.
- `rec_cache` — task_signature, index_version, scope, proposal (json), provider, created_at. Backs §4.8 caching; invalidated when index_version changes on `sync`.

Four tables. The fourth (`rec_cache`) exists only to keep LLM cost near zero; it is derived/disposable and can be cleared anytime.

## 8. Error-handling philosophy (set once, here)
- **Sync:** skip-loud. Report counts of parsed vs. skipped per marketplace; never fail the whole sync for one bad entry; never silently drop.
- **Inventory:** best-effort; if a settings file is unparseable, report it and continue with what's readable.
- **Recommender:** always produce a recommendation from available data; state when the index is stale ("last synced N days ago") rather than refusing.
- **gen-claudemd:** review-first; `--write` only ever touches the managed block; back up the file to `CLAUDE.md.bak` before any in-place write.

## 9. Locked decisions (this revision)
1. Product = recommender. Telemetry/trending/scheduler cut to backlog. A read-only web dashboard is in scope but built after the CLI core (§4.6).
2. Registry = curated config list, skip-loud on malformed entries.
3. Recommender = **grounded LLM-assisted**: LLM proposes, deterministic index validates (existence + conflict/context-cost as hard post-filters). Model provider configurable (Anthropic API or local). Replaces the earlier deterministic-rule-table plan; the deterministic layer survives as the grounding guardrail.
4. Conflicts = annotate/warn, never block or auto-fix.
5. CLAUDE.md = managed-block only, review-first, never owns the whole file.
6. Install = shell out to official CLI.
7. No background process of any kind; sync is invocation-only.

## 10. Risks & mitigations (v1)
- **Marketplace schema drift** (now a *reduced* risk) → primary source is the canonical `marketplace.extended.json` with enforced frontmatter, so the normalizer mostly targets one stable schema; additional marketplaces are few and curated; version the normalizer; skip-loud. The risk moved from "top" to "manageable" once the canonical catalog became the default source (§4.1).
- **Over-reliance on the canonical catalog** (new) → it's maintained by a third party and could change format, gate access, or shift editorial standards. Mitigation: the multi-marketplace design (§4.1) keeps plugsmith functional from the official marketplace + curated sources even if the canonical catalog changes or disappears.
- **LLM hallucinates a plugin** → grounding (§4.3 step 3): every recommended component must resolve to a real catalog entry or it's dropped loudly. The model proposes only within the deterministic candidate set; it cannot invent your toolchain.
- **Persuasive LLM makes a *bad* recommendation more convincing** (the sharpened supply-chain risk) → grounding stops hallucination but not bad judgment, and a fluent justification can sell a poor or risky install. Mitigations: every reason is anchored to a real catalog entry; conflict/context-cost run as facts the model can't override; recommendations are advice the operator reviews, never auto-applied. **This is the strongest case for promoting the backlogged permission-surface review (§11) — note it, don't silently expand scope.**
- **Non-determinism / reproducibility** → cache by task+index version (§4.8) makes identical inputs return identical output; validation bounds variance to real, valid components. Accepted trade for better task understanding (§4.3 caveat).
- **Token cost surprises** → small pre-filtered prompts, cache, provider-aware confirm (§4.8); local provider option is free.
- **Provider/output fragility** → strict JSON schema with loud failure on malformed output (§4.7); no silent degraded recommendation.
- **gen-claudemd corrupts a hand-tuned file** → managed-block isolation + `.bak` backup + review-first default. Structurally cannot touch outside content.
- **Scope creep back toward 17 features** → §11 backlog is the holding pen; nothing leaves it without displacing something or proving the MVP shipped.

## 11. Backlog (deliberately deferred, not rejected)
Ordered roughly by likelihood of promotion:
1. **Same-capability comparison** — side-by-side of components in one category. Strong; needs the index, which v1 builds.
2. **Stack profiles / presets** — save/switch named stacks per task type. Natural once recommend works.
3. **Security / permission surface review** — what each component can execute/connect/access (static analysis). On-brand, scarce.
4. **Setup export / rehydrate** — portable harness for new machines. Builds on profiles.
5. **Context-budget simulator** — pre-install always-on overhead projection.
6. **Conflict resolution suggestions** — propose orderings/disables, not just flag.
7. **Update / changelog digest** — what changed upstream since last sync.
8. **Health / staleness scoring** — maintenance health from GitHub signals.
9. **Trending feed** — daily top repos (requires the scheduler/snapshot machinery deliberately excluded from v1).
10. **Telemetry + earning-its-keep audit + regression alerts** — the measured-value layer; the honest-attribution problems in v0.1–0.3 are unresolved and gating.
11. *(The LLM-assisted recommender, previously backlog item 11, is now the core product — see §4.3, §4.7, §4.8.)*

*(The read-only web dashboard, previously backlog item 12, is now in scope as §4.6.)*

## 12. Open questions (small, scoped)
1. Which additional marketplaces (beyond the canonical catalog + official marketplace) seed the trusted config list at launch?
2. Pre-filter breadth: how wide should the deterministic candidate set be before the LLM sees it — narrow (cheaper, risks excluding a good option) vs. generous (better proposals, more tokens)? Tune during the build.
3. Default provider out of the box — paid Anthropic for quality, or local for zero-cost/private? Leaning local-default given the available rig, with Anthropic opt-in.
4. Does `recommend` operate per-project by default (reads the project's `.claude/`) or against system scope unless told otherwise? Leaning per-project, since the question is contextual.
