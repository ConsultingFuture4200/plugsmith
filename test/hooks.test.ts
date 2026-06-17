import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hooksByComponentId, readHookRegistrations } from "../src/core/inventory/hooks.js";
import { annotateStack } from "../src/core/recommender/conflicts.js";
import type { Component } from "../src/core/types.js";

/**
 * Hermetic hook-matcher tests (PRD §4.4, Hook-matchers phase, §8). A temp-dir
 * tree stands in for the real `~/.claude`; nothing here reads the operator's
 * machine. Proves the reader pulls (event, matcher) from BOTH a settings hooks
 * block and an installed-plugin hook file, and that the collision check
 * distinguishes same-event-same-matcher (warn) from same-event-different-matcher
 * (no warn).
 */

/** Mirror the real on-disk shape: settings hooks block + installed plugin file. */
function buildTree(root: string): { claudeHome: string } {
  const claudeHome = join(root, "claude-home");
  mkdirSync(claudeHome, { recursive: true });

  // System settings.json with a hooks block: one matcher-bearing PostToolUse and
  // one matcher-free SessionStart (collapses to event-level).
  writeFileSync(
    join(claudeHome, "settings.json"),
    JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "x" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "y" }] }],
      },
    }),
  );

  // installed_plugins.json → installPath → <installPath>/hooks/hooks.json, mirroring
  // the real layout the CLI maintains.
  const installPath = join(claudeHome, "plugins", "cache", "official", "sec", "1.0.0");
  mkdirSync(join(installPath, "hooks"), { recursive: true });
  writeFileSync(
    join(claudeHome, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "sec-guidance@official": [{ scope: "user", installPath, version: "1.0.0" }],
      },
    }),
  );
  writeFileSync(
    join(installPath, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "z" }] },
          { matcher: "", hooks: [{ type: "command", command: "blank" }] },
        ],
      },
    }),
  );

  return { claudeHome };
}

describe("readHookRegistrations (PRD §4.4, §8)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plugsmith-hooks-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("extracts (event, matcher) from a settings block and an installed-plugin file", () => {
    const { claudeHome } = buildTree(root);
    const regs = readHookRegistrations({ claudeHome });

    // Settings: matcher-bearing entry carries its matcher...
    expect(regs).toContainEqual({
      source: "settings:system",
      event: "PostToolUse",
      matcher: "Write|Edit",
    });
    // ...and a matcher-free entry collapses to event-level (no matcher key).
    expect(regs).toContainEqual({ source: "settings:system", event: "SessionStart" });

    // Installed plugin: source id is the `<plugin>@<marketplace>` ref (== component id).
    expect(regs).toContainEqual({
      source: "sec-guidance@official",
      event: "PostToolUse",
      matcher: "Bash",
    });
    // An empty-string matcher is treated as event-level, not a literal "".
    expect(regs).toContainEqual({ source: "sec-guidance@official", event: "PostToolUse" });
  });

  it("is best-effort: a missing tree yields no entries, no throw", () => {
    expect(readHookRegistrations({ claudeHome: join(root, "nope") })).toEqual([]);
  });

  it("indexes only plugin (`@`-bearing) sources by component id", () => {
    const { claudeHome } = buildTree(root);
    const byId = hooksByComponentId(readHookRegistrations({ claudeHome }));

    // Settings registrations (no `@`) are excluded.
    expect(byId.has("settings:system")).toBe(false);
    // Plugin ref maps to its real {event, matcher?} list.
    const sec = byId.get("sec-guidance@official");
    expect(sec).toContainEqual({ event: "PostToolUse", matcher: "Bash" });
    expect(sec).toContainEqual({ event: "PostToolUse" });
  });
});

describe("annotateStack matcher distinction (PRD §4.4)", () => {
  function comp(id: string, hooks: Array<{ event: string; matcher?: string }>): Component {
    return {
      id,
      name: id,
      marketplaceId: "m",
      trustTier: "community",
      categoryTags: [],
      bundles: { skills: [], commands: [], hooks, mcpServers: [] },
      contextCostFlag: false,
      singletonCategories: [],
      compatibility: [],
    };
  }

  it("warns on same-event same-matcher across two components", () => {
    const stack = [
      comp("a", [{ event: "PostToolUse", matcher: "Bash" }]),
      comp("b", [{ event: "PostToolUse", matcher: "Bash" }]),
    ];
    const hook = annotateStack(stack).annotations.find((x) => x.kind === "hook");
    expect(hook?.severity).toBe("warn");
    expect(hook?.componentRefs.sort()).toEqual(["a", "b"]);
  });

  it("does NOT warn on same-event different-matcher (benign co-registration)", () => {
    const stack = [
      comp("a", [{ event: "PostToolUse", matcher: "Bash" }]),
      comp("b", [{ event: "PostToolUse", matcher: "Write|Edit" }]),
    ];
    expect(annotateStack(stack).annotations.some((x) => x.kind === "hook")).toBe(false);
  });
});
