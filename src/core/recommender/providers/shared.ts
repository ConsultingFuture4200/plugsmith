import type { Component, InventoryItem, ProviderProposal, RecLine } from "../../types.js";
import { PROPOSAL_SCHEMA, type ProposalInput, ProviderError } from "../provider.js";

/**
 * Shared adapter machinery for the real model providers (PRD §4.7).
 *
 * Both the Anthropic and the local (OpenAI-compatible) adapters obey the SAME
 * discipline: build a small, bounded prompt from the pre-filtered candidate set,
 * call the model constrained to strict JSON matching PROPOSAL_SCHEMA, and parse
 * the result with a SINGLE repair retry. If the model still returns text that is
 * not schema-valid JSON, that is a LOUD failure (`ProviderError`) — never a
 * silent degraded recommendation (PRD §4.7, §4.8).
 *
 * The fetch transport is injected so the parse/repair logic can be unit-tested
 * without touching the network (test/providers.test.ts).
 */

/** Injectable transport: the global `fetch` in prod, a fake in tests. */
export type FetchLike = typeof fetch;

/** System prompt: the model proposes judgment WITHIN the candidate set only. */
export const SYSTEM_PROMPT =
  "You are a Claude Code stack adviser. Given a task, a fixed candidate set of " +
  "plugins/skills, and the operator's current inventory, propose which to " +
  "enable, install, or disable, each with a one-sentence reason. " +
  "You MUST only reference components present in the candidate set — never " +
  "invent a component. Respond with ONLY valid JSON matching the provided schema.";

/** A single repair reminder, appended on the second attempt only. */
export const REPAIR_REMINDER = `Your previous response was not valid JSON matching the required schema. Return ONLY a single JSON object matching this schema, with no prose, no markdown fences, and no commentary:\n${JSON.stringify(PROPOSAL_SCHEMA)}`;

/** Compact a candidate for the prompt — only what the model needs to choose. */
function renderCandidate(c: Component): string {
  const tags = c.categoryTags.length > 0 ? c.categoryTags.join("/") : "uncategorized";
  const cost = c.contextCostFlag ? ", context-costly" : "";
  const desc = c.description ? ` — ${c.description}` : "";
  return `- id=${c.id} name="${c.name}" [${c.trustTier}] ${tags}${cost}${desc}`;
}

/** One installed item, so the model can reason about the live stack (disables). */
function renderInventory(i: InventoryItem): string {
  return `- ${i.componentRef} (${i.enabled ? "enabled" : "disabled"}, ${i.scope})`;
}

/**
 * Build the user prompt from the bounded inputs. Small by construction (PRD §4.8):
 * the model only ever sees the pre-filtered candidate set, never the whole index.
 */
export function buildUserPrompt(input: ProposalInput): string {
  const flags: string[] = [];
  if (input.flags.scope) flags.push(`scope=${input.flags.scope}`);
  if (input.flags.tight) flags.push("tight-context-budget");
  if (input.flags.integrations && input.flags.integrations.length > 0) {
    flags.push(`required-integrations=${input.flags.integrations.join(",")}`);
  }

  const candidates =
    input.candidates.length > 0 ? input.candidates.map(renderCandidate).join("\n") : "(none)";
  const inventory =
    input.inventory.length > 0 ? input.inventory.map(renderInventory).join("\n") : "(empty)";

  return [
    `Task: ${input.task}`,
    flags.length > 0 ? `Flags: ${flags.join(" ")}` : "Flags: (none)",
    "",
    "Candidate components (you may ONLY reference these by their id):",
    candidates,
    "",
    "Current inventory:",
    inventory,
    "",
    'Respond with JSON of the form {"lines":[{"action","componentRef","reason"}]}.',
    'action is one of "enable" | "install" | "disable"; componentRef is a candidate id.',
  ].join("\n");
}

/**
 * Rough input-token estimate for the cost guard (PRD §4.8). Deliberately a cheap
 * heuristic (~4 chars/token over system + user prompt) — the guard needs an
 * order-of-magnitude number to show the operator, not an exact count.
 */
export function estimateInputTokens(input: ProposalInput): number {
  const chars = SYSTEM_PROMPT.length + buildUserPrompt(input).length;
  return Math.ceil(chars / 4);
}

/**
 * Strip reasoning/markdown wrappers a model may emit around its JSON. Handles,
 * in order: `<think>…</think>` reasoning blocks (qwen3 and similar leak these
 * intermittently — the validation run showed qwen3:4b emitting them even under
 * a json_object hint), a surrounding ```json fence, and finally a fall-back to
 * the outermost `{…}` object substring. The repair-retry discipline still backs
 * this up; this just keeps a well-formed proposal wrapped in reasoning from
 * being treated as a failure.
 */
function stripFence(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // A dangling, unclosed <think> (truncated reasoning) — drop everything up to
  // the first opening brace.
  t = t.replace(/<\/?think>/gi, "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(t);
  if (fence?.[1]) return fence[1].trim();
  // Last resort: the outermost JSON object, ignoring any prose around it.
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last > first) return t.slice(first, last + 1).trim();
  return t;
}

/**
 * Parse model text into a schema-valid ProviderProposal, or `undefined` if it
 * does not conform. Tolerant of a single markdown fence; strict on shape. Never
 * throws — the caller decides whether a miss triggers a repair or a loud fail.
 */
export function parseProposal(text: string): ProviderProposal | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const linesRaw = (parsed as { lines?: unknown }).lines;
  if (!Array.isArray(linesRaw)) return undefined;

  const lines: RecLine[] = [];
  for (const item of linesRaw) {
    if (typeof item !== "object" || item === null) return undefined;
    const { action, componentRef, reason } = item as Record<string, unknown>;
    if (action !== "enable" && action !== "install" && action !== "disable") return undefined;
    if (typeof componentRef !== "string" || typeof reason !== "string") return undefined;
    lines.push({ action, componentRef, reason });
  }
  return { lines };
}

/**
 * The shared propose() body: attempt → parse → (repair attempt → parse) → throw.
 *
 * `callModel(promptMessages)` performs ONE round-trip and returns the model's raw
 * text. The first attempt uses the base prompt; if the text is not schema-valid,
 * a SINGLE repair attempt is made with the reminder appended. A persistent miss
 * is a ProviderError (PRD §4.7 loud-failure discipline).
 */
export async function proposeWithRepair(
  providerName: string,
  callModel: (userPrompt: string, repair: boolean) => Promise<string>,
  input: ProposalInput,
): Promise<ProviderProposal> {
  const basePrompt = buildUserPrompt(input);

  const first = await callModel(basePrompt, false);
  const parsedFirst = parseProposal(first);
  if (parsedFirst) return parsedFirst;

  // Single repair retry — append the reminder, do not loop further.
  const repairPrompt = `${basePrompt}\n\n${REPAIR_REMINDER}`;
  const second = await callModel(repairPrompt, true);
  const parsedSecond = parseProposal(second);
  if (parsedSecond) return parsedSecond;

  throw new ProviderError(
    `${providerName}: model returned non-schema-valid JSON after one repair retry`,
  );
}
