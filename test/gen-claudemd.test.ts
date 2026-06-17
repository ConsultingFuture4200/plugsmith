import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderBlock, writeBlockToFile } from "../src/core/claudemd/block.js";
import {
  type InstallRunner,
  InstallUnavailableError,
  bumpPatch,
  installComponents,
  nextBlockVersion,
  parseBlockVersion,
  stackFromRecommendation,
} from "../src/core/claudemd/gen.js";
import { openStore } from "../src/core/db/store.js";
import type { Recommendation } from "../src/core/types.js";

/**
 * End-to-end-ish coverage for the gen-claudemd write path (PRD §4.5, §8,
 * Milestone D). Complements the pure block tests: this drives a real temp
 * CLAUDE.md with hand content above AND below an existing block, runs the
 * write path, and asserts the hand content survives byte-for-byte, the embedded
 * version bumped, and a `.bak` was made.
 */
describe("gen-claudemd write path on a temp CLAUDE.md", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plugsmith-gen-"));
    file = join(dir, "CLAUDE.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves hand content byte-for-byte, bumps the version, writes a .bak", () => {
    const above = "# My CLAUDE.md\n\nHand-tuned rules I care about.\n\n";
    const below = "\n\n## My footer\n\nMore content the operator owns.\n";
    const original = `${above}${renderBlock("0.7.0", ["old-plugin@market"])}${below}`;
    writeFileSync(file, original, "utf8");

    // The version the CLI would render at: bump of the existing embedded version.
    const version = nextBlockVersion(file, "0.7.0");
    expect(version).toBe("0.7.1");

    const block = renderBlock(version, ["test-engineer", "git-check"]);
    const result = writeBlockToFile(file, block);

    expect(result.mode).toBe("replaced");

    const written = readFileSync(file, "utf8");
    // Hand content above and below survives byte-for-byte.
    expect(written.startsWith(above)).toBe(true);
    expect(written.endsWith(below)).toBe(true);
    // Version bumped; old stack gone.
    expect(parseBlockVersion(written)).toBe("0.7.1");
    expect(written).not.toContain("old-plugin@market");
    expect(written).toContain("test-engineer");

    // A backup of the pre-write content exists, equal to the original.
    expect(existsSync(`${file}.bak`)).toBe(true);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(original);
  });

  it("creates a new file containing just the block when none exists", () => {
    expect(existsSync(file)).toBe(false);
    const version = nextBlockVersion(file, "0.7.0");
    expect(version).toBe("0.7.0"); // no existing block ⇒ seed version
    const result = writeBlockToFile(file, renderBlock(version, ["solo"]));
    expect(result.mode).toBe("created");
    expect(existsSync(`${file}.bak`)).toBe(false); // nothing to back up
    expect(readFileSync(file, "utf8")).toContain("plugsmith:start v0.7.0");
  });
});

describe("stackFromRecommendation", () => {
  function rec(lines: Recommendation["lines"]): Recommendation {
    return {
      task: "t",
      lines,
      annotations: [],
      contextCostSummary: { costlyCount: 0, tightRequested: false },
      provider: "fake",
      cached: false,
      indexVersion: "1",
    };
  }

  it("collects enable + install refs into the enabled list, install tracked separately", () => {
    const chosen = stackFromRecommendation(
      rec([
        { action: "enable", componentRef: "a", reason: "" },
        { action: "install", componentRef: "b", reason: "" },
        { action: "disable", componentRef: "c", reason: "" },
      ]),
    );
    expect(chosen.enabled).toEqual(["a", "b"]);
    expect(chosen.install).toEqual(["b"]);
  });

  it("dedupes enabled refs", () => {
    const chosen = stackFromRecommendation(
      rec([
        { action: "enable", componentRef: "a", reason: "" },
        { action: "install", componentRef: "a", reason: "" },
      ]),
    );
    expect(chosen.enabled).toEqual(["a"]);
    expect(chosen.install).toEqual(["a"]);
  });
});

describe("bumpPatch", () => {
  it("bumps the patch component of a dotted version", () => {
    expect(bumpPatch("0.7.0")).toBe("0.7.1");
    expect(bumpPatch("1.2.9")).toBe("1.2.10");
  });

  it("appends .1 for non-semver input", () => {
    expect(bumpPatch("nightly")).toBe("nightly.1");
  });
});

describe("installComponents (UMB-140)", () => {
  it("throws InstallUnavailableError when `claude` is not on PATH", () => {
    const db = openStore(":memory:");
    const runner: InstallRunner = {
      resolve: () => undefined,
      run: () => {
        throw new Error("must not run when claude is absent");
      },
    };
    expect(() => installComponents(db, ["x@m"], { runner })).toThrow(InstallUnavailableError);
    db.close();
  });

  it("reports per-ref install status and re-inventories with an injected runner", () => {
    const db = openStore(":memory:");
    const calls: string[] = [];
    const runner: InstallRunner = {
      resolve: () => "/usr/local/bin/claude",
      run: (ref) => {
        calls.push(ref);
        return ref === "bad@m" ? { code: 1, stderr: "boom" } : { code: 0, stderr: "" };
      },
    };
    const results = installComponents(db, ["good@m", "bad@m"], { runner });
    expect(calls).toEqual(["good@m", "bad@m"]);
    expect(results[0]).toEqual({ componentRef: "good@m", status: "installed" });
    expect(results[1]?.status).toBe("failed");
    expect(results[1]?.detail).toContain("exit 1");
    db.close();
  });
});
