import { describe, expect, it } from "vitest";
import { renderBlock, upsertBlock } from "../src/core/claudemd/block.js";

/**
 * The trust-defining test (PRD §4.5, Milestone D exit gate): hand-edited
 * content above and below the managed block must survive byte-for-byte.
 */
describe("upsertBlock", () => {
  const block = renderBlock("0.7.0", ["test-engineer", "git-check"]);

  it("creates a file containing only the block when original is null", () => {
    const { content, mode } = upsertBlock(null, block);
    expect(mode).toBe("created");
    expect(content).toContain("ccharness:start v0.7.0");
    expect(content.trimEnd().endsWith("ccharness:end -->")).toBe(true);
  });

  it("appends when no block exists, preserving original byte-for-byte", () => {
    const original = "# My CLAUDE.md\n\nHand-tuned rules I care about.\n";
    const { content, mode } = upsertBlock(original, block);
    expect(mode).toBe("appended");
    expect(content.startsWith(original)).toBe(true);
  });

  it("replaces ONLY the block span, preserving content above and below", () => {
    const above = "# Top\n\nMy own rules.\n\n";
    const below = "\n\n## Below\n\nMore of my own content.\n";
    const original = `${above}${renderBlock("0.6.0", ["old-plugin"])}${below}`;
    const { content, mode } = upsertBlock(original, block);
    expect(mode).toBe("replaced");
    expect(content.startsWith(above)).toBe(true);
    expect(content.endsWith(below)).toBe(true);
    expect(content).toContain("ccharness:start v0.7.0");
    expect(content).not.toContain("old-plugin");
    expect(content).not.toContain("v0.6.0");
  });

  it("handles an empty original by appending", () => {
    const { content } = upsertBlock("", block);
    expect(content).toContain("ccharness:start");
  });

  it("does NOT replace when an end delimiter precedes a start (inverted/orphaned)", () => {
    // A corrupted file with END before START must fall through to safe append,
    // never the replace branch (which would splice between them and corrupt it).
    const original = `<!-- ccharness:end -->\nrogue\n<!-- ccharness:start v0.1.0 -->\n`;
    const { content, mode } = upsertBlock(original, block);
    expect(mode).toBe("appended");
    expect(content.startsWith(original)).toBe(true);
  });
});
