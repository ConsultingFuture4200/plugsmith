import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * CLAUDE.md managed-block writer (PRD §4.5, Milestone D).
 *
 * Hard guarantee: ccharness writes ONLY between its delimiters and never reads
 * for meaning or modifies a byte outside the block. Everything else in this
 * module exists to make that guarantee testable.
 */

const START_RE = /<!--\s*ccharness:start\s+v[\w.\-]+\s*-->/;
const END = "<!-- ccharness:end -->";

export function startDelimiter(version: string): string {
  return `<!-- ccharness:start v${version} -->`;
}

/** Render the managed block body from a chosen stack. Pure. */
export function renderBlock(
  version: string,
  enabled: string[],
  notes: string[] = [],
): string {
  const lines = [
    startDelimiter(version),
    "<!-- Managed by ccharness. Do not edit inside this block; it is regenerated. -->",
    "",
    "## Enabled stack (ccharness)",
    "",
    ...(enabled.length ? enabled.map((e) => `- ${e}`) : ["- (none selected)"]),
    ...(notes.length ? ["", "### Notes", ...notes.map((n) => `- ${n}`)] : []),
    "",
    END,
  ];
  return lines.join("\n");
}

export interface UpsertResult {
  /** The full file content after the upsert. */
  content: string;
  /** "appended" when no block existed, "replaced" when one did. */
  mode: "appended" | "replaced" | "created";
}

/**
 * Insert or replace the managed block in `original` content. Pure string op —
 * no filesystem. This is the function that must be unit-tested against files
 * with content above and below the block, no block, and empty input.
 */
export function upsertBlock(original: string | null, block: string): UpsertResult {
  if (original === null) {
    return { content: `${block}\n`, mode: "created" };
  }

  const startMatch = original.match(START_RE);
  const endIdx = original.indexOf(END);

  // A well-formed existing block: replace ONLY its span, preserve the rest.
  // The end MUST come after the start — an inverted/orphaned END before a START
  // falls through to the safe append path rather than corrupting the file.
  if (startMatch && startMatch.index !== undefined && endIdx > startMatch.index) {
    const start = startMatch.index;
    const after = endIdx + END.length;
    const before = original.slice(0, start);
    const tail = original.slice(after);
    return { content: `${before}${block}${tail}`, mode: "replaced" };
  }

  // No block (or malformed/partial — we never try to repair foreign content):
  // append, preserving the original byte-for-byte.
  const sep = original.endsWith("\n") ? "\n" : "\n\n";
  return { content: `${original}${sep}${block}\n`, mode: "appended" };
}

/**
 * Write the managed block to a CLAUDE.md file on disk (PRD §4.5, §8).
 * Backs up to `<path>.bak` before any in-place write. Review-first lives in the
 * CLI; this is the `--write` path.
 */
export function writeBlockToFile(path: string, block: string): UpsertResult {
  const exists = existsSync(path);
  const original = exists ? readFileSync(path, "utf8") : null;
  const result = upsertBlock(original, block);
  if (exists) {
    copyFileSync(path, `${path}.bak`);
  }
  writeFileSync(path, result.content, "utf8");
  return result;
}
