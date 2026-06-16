# Milestone 0 — Spike findings

**Date:** 2026-06-16
**Status:** Closed. Settles the open questions from the implementation plan's Milestone 0 and PRD §12, grounded in the operator's real machine and the real local model.

This is the one-page exit-gate note the plan called for. It records what running real data taught us, including where reality diverged from the PRD's assumptions.

## 1. Best index source: the local CLI catalog cache

The richest, lowest-risk primary source is **`~/.claude/plugins/plugin-catalog-cache.json`** — the catalog the Claude Code CLI already maintains on disk. It is wired as `kind: "local-cache"` and is the first, enabled marketplace in `DEFAULT_CONFIG`.

Why it beats fetching a remote `marketplace.extended.json`:

- **Real per-model token costs** — each entry has `tokens.<model>.{always_on, on_invoke}`. `always_on` is the persistent context overhead, so the §4.4 context-cost differentiator is a **measured number** (`Component.contextTokens`), not a heuristic. On this machine: 223 plugins, `always_on` min 0 / median 354 / max 15 925 (opus ref model).
- **Enumerated bundles** — `components.{commands,agents,skills,hooks,mcpServers,lspServers}` per plugin, so conflict/context-cost have real input.
- Zero fetch/auth; always in sync with what the CLI reads; trust tier derives from the `@marketplace` suffix.

**Caveats (real):**
- It only contains marketplaces the operator has actually pulled. On this machine that is **only `claude-plugins-official`** (223 plugins). The operator's other marketplaces (parslee, context-mode, understand-anything, staqs, agentmemory) are **absent from the cache**, so their installed plugins cannot resolve from this source alone.
- Schema is a derived CLI artifact, not a public contract — keep remote sources as fallback (§4.1 independence).

## 2. Hook-collision data is coarse (event-level only)

The PRD §4.4 hook-collision check assumes `(event, matcher)` granularity. **The data does not carry matchers.**

- In the local cache, `components.hooks` elements are **bare event-name strings** (88 hooks across 35 of 223 plugins, 16%). Events seen: `SessionStart` (21), `PostToolUse` (15), `PreToolUse` (14), `Stop` (8), `UserPromptSubmit` (8), plus a long tail.
- In the canonical `marketplace.extended.json`, `components.hooks` is an **integer count** — worse still (no event names at all).

**Implication:** hook-collision detection is realistically **event-level** ("two plugins both register `SessionStart`"), which the real-data run confirmed fires. Matcher-precise collision would require reading raw per-plugin hook configs, not any catalog. The normalizer maps hooks defensively (string or `{event,matcher}`); the limitation is documented, not papered over.

## 3. Category mapping

- Local cache: `category` present on 209/223 (93%) but `keywords`/`tags` effectively absent — `category` is the only signal. Its vocabulary (`development`, `productivity`, `database`, `security`, `monitoring`, `deployment`, `design`, …) only partially maps to our 13-key taxonomy.
- After adding the cache vocabulary to `TAG_TO_CATEGORY` and the rule **"a plugin bundling an MCP server is category 11 (integrations)"**, coverage is **64% categorized (142/223), 125 tagged integrations**. The generic `development`/`productivity` buckets (~36%) are deliberately left unmapped — mapping them to any single key would flood it.
- The canonical **`marketplace.extended.json`** (jeremylongshore, 448 plugins) carries `keywords` on 98% and 19 categories — materially richer. It is the right **supplement** for category precision, via a dedicated adapter (it is a 448-entry array, a different/overlapping marketplace, not a drop-in). Tracked as follow-up; remote sources are currently `enabled: false` pending that adapter + correct raw URLs.

## 4. Provider decision (PRD §12 Q3): local default, with a reliability caveat

Validated the real local provider (Ollama) over 8 real operator tasks:

| Model | First-call valid JSON | Needed 1 repair | Hard failures |
|---|---|---|---|
| `qwen3:4b` (run A) | 8/8 | 0 | 0 |
| `qwen3:4b` (run B) | 6/8 | 1 | **1** (after repair) |
| `qwen2.5:3b` | 1/8 | 7/8 | **0** |

`qwen3:4b` is **non-deterministic** at strict JSON — it leaks `<think>` traces intermittently and can hard-fail even after the single repair. `qwen2.5:3b` is verbose (almost always burns the repair round-trip) but **never hard-failed**.

**Decisions:**
- **Default local model = `qwen2.5:3b`** (zero hard failures prioritized for a strict-JSON contract).
- Added **`<think>` stripping** in `providers/shared.ts` so `qwen3:4b` (and similar) are viable if preferred.
- The single-repair discipline does real work but is not always sufficient alone — both fixes together are the mitigation.
- **Anthropic** provider was not run (`ANTHROPIC_API_KEY` unset). The local half of the exit gate is otherwise cleared; the paid half remains pending a key.

## 5. What the real-data run proved about the product

On the real 223-plugin index with the real local model, the deterministic guardrails all fired:
- **Grounding** dropped components the model invented from its own knowledge (`vault`, `gsd-forensics`, …) that are not in the index.
- **Context-cost** reported real token budgets (~2.5k–3.6k always-on) and the `--tight` warning escalated correctly.
- **Hook collisions** (`SessionStart` pile-ups) fired on real plugins.
- **Conflict-vs-live-inventory** is wired (annotates the effective post-action stack); no singleton conflict appeared only because the single official catalog has no two same-singleton candidates.
- **Cache** returned a free hit (zero round-trips) on a re-run.

The pipeline is sound on real data. The remaining real limits are **data coverage** (one marketplace in the cache) and **small-model JSON reliability**, both addressed above.

## Open follow-ups

1. Canonical `marketplace.extended.json` adapter (448-entry array, rich `keywords`) → re-enable remote sources for breadth + better categories.
2. Verify each remote marketplace's raw `marketplace.json` URL/branch before enabling.
3. Anthropic provider run once a key is available (closes the paid half of UMB-138).
