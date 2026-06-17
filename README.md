<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
    <img alt="plugsmith" src="assets/logo-light.svg" width="400">
  </picture>
</p>
<!-- Place logo-light.svg and logo-dark.svg in an assets/ folder at the repo root -->

<h1 align="center">plugsmith</h1>

<p align="center">
  <a href="https://github.com/ConsultingFuture4200/plugsmith/releases"><img src="https://img.shields.io/github/v/release/ConsultingFuture4200/plugsmith?style=flat-square" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <a href="https://www.npmjs.com/package/plugsmith"><img src="https://img.shields.io/npm/v/plugsmith?style=flat-square" alt="npm version"></a>
  <img src="https://img.shields.io/badge/TypeScript-98%25-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
</p>

<p align="center"><strong>Forge a leaner plugin set for Claude Code — load the right plugins per task and cut the token cost of the ones you don't need.</strong></p>

---

<details>
<summary>Table of Contents</summary>

- [About](#about)
- [Why](#why)
- [Features](#features)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Roadmap](#roadmap)
- [Development](#development)
- [License](#license)

</details>

## About

`plugsmith` is a CLI that optimizes plugin usage inside [Claude Code](https://github.com/topics/claude-code). Every installed plugin — its commands, skills, MCP servers, and hooks — consumes context tokens on every turn, whether or not the current task needs it. plugsmith does two things about that:

1. **Selects** the right plugins for a given task, so Claude Code loads a focused set instead of everything you've ever installed.
2. **Measures** the token cost of each plugin and surfaces the waste, so you can trim the set that isn't earning its place in the context window.

It is local-first: clone the repo, install with pnpm, and run it against your own machine's plugin inventory. Nothing leaves your machine, and it changes no state you didn't ask it to.

> [!NOTE]
> plugsmith optimizes *how plugins are used* — it does not replace Claude Code or wrap it. Claude Code is the harness; plugsmith makes its plugin loadout lean.

## Why

As your plugin list grows, every session pays for it. Skills get auto-suggested, MCP tools are advertised, and commands are registered — all of it spent from the same context budget, on every request. plugsmith gives you grounded control over what each task actually needs, and a cost breakdown so the trade-offs are visible instead of invisible.

## Features

- **Task-grounded recommendations** — describe the work and plugsmith proposes a coherent enable/install/disable set, each line with a reason, validated against a real catalog (no hallucinated plugins).
- **Conflict & context-cost checks** — flags singleton collisions (e.g. two memory plugins), hook/command clashes, and surfaces the always-on token cost of the stack as hard facts.
- **Token cost surfaced** — `status` and `recommend` annotate context-costly components and total always-on tokens for the enabled stack.
- **Safe CLAUDE.md generation** — writes only inside a delimited managed block; review-first by default, never touches a byte outside its own block.
- **Read-only dashboard** — `serve` launches a localhost view of the index, status, and recommendations; it changes no state.
- **Local-first** — runs against your own machine; configurable to a local model provider so recommendations never need to leave it.

## Quick Start

> [!IMPORTANT]
> plugsmith is local-first. Clone the repo and install with [pnpm](https://pnpm.io/) (Node.js 20+). Run commands with `pnpm dev -- <command>` during development, or build once (`pnpm build`) and invoke the `plugsmith` bin from `dist/`.

```bash
git clone https://github.com/ConsultingFuture4200/plugsmith.git
cd plugsmith
pnpm install

# Refresh the index from your configured marketplaces
pnpm dev -- sync

# See what your installed plugins cost in context tokens
pnpm dev -- status

# Get a grounded recommendation for the task at hand
pnpm dev -- recommend "review a TypeScript PR for security issues"
```

## Commands

### `sync`

Refresh the local index from the configured marketplaces.

```bash
plugsmith sync
```

### `search`

Query the index.

```bash
plugsmith search <query> [--category <c>]
```

| Option | Description |
|--------|-------------|
| `-c, --category <c>` | Filter by category id or key. |

### `status`

Show installed and enabled components, annotated — what each provides, its trust tier, and its context-token cost.

```bash
plugsmith status
```

### `recommend`

The core command: propose what to enable, install, or disable for a task, each line with a reason, grounded against the real catalog.

```bash
plugsmith recommend "<task>" [options]
```

| Option | Description |
|--------|-------------|
| `--scope <scope>` | `system` or `project`. |
| `--tight` | Prefer a tight context budget. |
| `--integrations <a,b>` | Comma-separated required integrations. |
| `--provider <provider>` | `anthropic` or `local`. |
| `--yes` | Bypass the paid-provider cost confirm. |
| `--no-cache` | Force a fresh model call. |

### `gen-claudemd`

Emit the managed CLAUDE.md block. Prints to stdout for review by default; `--write` performs the in-place managed-block update.

```bash
plugsmith gen-claudemd [--scope system|project] [--path <file>] [--write]
```

| Option | Description |
|--------|-------------|
| `--scope <scope>` | `system` or `project`. |
| `--path <file>` | Target CLAUDE.md path. |
| `--write` | Perform the in-place managed-block update (default: print to stdout). |

### `serve`

Launch the read-only dashboard on localhost.

```bash
plugsmith serve [--port <n>]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--port <n>` | Port to bind (localhost only). | `4575` |

> [!NOTE]
> Confirm the live surface anytime with `plugsmith --help` (or `pnpm dev -- --help`).

## Configuration

plugsmith reads YAML configuration from `~/.plugsmith/config.yaml`. If the file is absent, built-in defaults apply; a partial file merges over the defaults.

| Key | Purpose |
|-----|---------|
| `defaultProvider` | `anthropic` or `local` — which model provider the recommender uses by default. |
| `anthropic` | `{ model, apiKeyEnv }` — Anthropic model id and the env var holding the API key. |
| `local` | `{ baseUrl, model }` — local (OpenAI-compatible) endpoint and model id. |
| `marketplaces` | List of trusted index sources (name, gitUrl, kind, trustDefault, enabled). The local CLI catalog cache is primary; the canonical extended catalog supplements it. |
| `prefilterBreadth` | `narrow` \| `balanced` \| `generous` — how wide the deterministic pre-filter casts before the model sees candidates. |

The SQLite store lives alongside it at `~/.plugsmith/plugsmith.db` (index + cached inventory snapshot).

## How It Works

plugsmith inspects the plugins and skills available to Claude Code — their commands, skills, MCP server manifests, and hooks — and indexes them with their always-on context-token footprint. For a task it runs a deterministic pre-filter to a small candidate set, asks the configured model for a grounded enable/install/disable proposal, then validates that proposal against the index: anything that doesn't resolve to a real catalog entry is dropped, and conflict/context-cost checks run as hard facts the model cannot override. The read-only dashboard renders the same core output the CLI produces — no business logic of its own.

## Roadmap

The following are tracked in the PRD backlog (§11), not shipped today:

- **Per-task profiles** — define and activate named plugin sets ("review", "infra", "writing") instead of re-running `recommend`.
- **Token-cost report** — a standalone `cost` view ranking every installed plugin by its context-token footprint.
- **Usage audit** — analyze recent sessions to flag plugins that are loaded but rarely or never invoked.

## Development

Built with TypeScript and managed with [pnpm](https://pnpm.io/) (Node.js 20+).

```bash
pnpm install        # Install dependencies
pnpm dev -- <cmd>   # Run the CLI from source (e.g. pnpm dev -- status)
pnpm build          # Build the project
pnpm test           # Run all tests
pnpm typecheck      # Type-check without emitting
```

## License

[MIT](LICENSE)
