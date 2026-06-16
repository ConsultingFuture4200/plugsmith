import { describe, expect, it } from "vitest";
import { type ProposalInput, ProviderError } from "../src/core/recommender/provider.js";
import { anthropicProvider } from "../src/core/recommender/providers/anthropic.js";
import { localProvider } from "../src/core/recommender/providers/local.js";
import type { Component } from "../src/core/types.js";

/**
 * Provider adapter unit tests (PRD §4.7).
 *
 * Exercises the strict-JSON + single-repair-retry + loud-failure discipline of
 * the real adapters by INJECTING a fake fetch — no network is ever touched.
 * Asserts: valid JSON parses; one-bad-then-good triggers the repair path (and
 * only once); persistently-bad throws ProviderError.
 */

const CAND: Component = {
  id: "mem-a",
  name: "MemoryEngineA",
  marketplaceId: "seed",
  trustTier: "partner",
  description: "persistent memory",
  categoryTags: ["memory"],
  bundles: { skills: [], commands: [], hooks: [], mcpServers: [] },
  contextCostFlag: false,
  singletonCategories: ["memory"],
  compatibility: [],
};

const INPUT: ProposalInput = {
  task: "set up memory",
  candidates: [CAND],
  inventory: [],
  flags: { scope: "system" },
};

const GOOD_BODY = JSON.stringify({
  lines: [{ action: "install", componentRef: "mem-a", reason: "covers memory" }],
});
const BAD_BODY = "Sure! Here are my picks: not json at all.";

/** Wrap a body string as an Anthropic Messages API response. */
function anthropicResponse(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Wrap a body string as an OpenAI chat/completions response. */
function localResponse(text: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that returns the queued responses in order; records call count. */
function queuedFetch(responses: Response[]): { fetch: typeof fetch; calls: () => number } {
  let i = 0;
  const fn = (async () => {
    const res = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return res as Response;
  }) as unknown as typeof fetch;
  return { fetch: fn, calls: () => i };
}

describe("anthropicProvider (PRD §4.7)", () => {
  const apiKeyEnv = "TEST_ANTHROPIC_KEY";
  process.env[apiKeyEnv] = "sk-test";

  it("parses valid JSON on the first attempt (no repair)", async () => {
    const q = queuedFetch([anthropicResponse(GOOD_BODY)]);
    const provider = anthropicProvider({ model: "claude-opus-4-8", apiKeyEnv, fetchImpl: q.fetch });
    const proposal = await provider.propose(INPUT);
    expect(proposal.lines).toEqual([
      { action: "install", componentRef: "mem-a", reason: "covers memory" },
    ]);
    expect(q.calls()).toBe(1);
  });

  it("tolerates a markdown-fenced JSON body", async () => {
    const fenced = `\`\`\`json\n${GOOD_BODY}\n\`\`\``;
    const q = queuedFetch([anthropicResponse(fenced)]);
    const provider = anthropicProvider({ model: "claude-opus-4-8", apiKeyEnv, fetchImpl: q.fetch });
    const proposal = await provider.propose(INPUT);
    expect(proposal.lines[0]?.componentRef).toBe("mem-a");
  });

  it("strips a <think> reasoning block on the first attempt (no repair)", async () => {
    // qwen3 and similar leak <think>…</think> intermittently even under a JSON
    // hint — a well-formed proposal wrapped in reasoning must not count as a miss.
    const thinky = `<think>The task needs memory, so install mem-a.</think>\n${GOOD_BODY}`;
    const q = queuedFetch([localResponse(thinky)]);
    const provider = localProvider({ baseUrl: "http://localhost:11434/v1", model: "qwen3:4b", fetchImpl: q.fetch });
    const proposal = await provider.propose(INPUT);
    expect(proposal.lines[0]?.componentRef).toBe("mem-a");
    expect(q.calls()).toBe(1);
  });

  it("repairs once when the first response is not schema-valid", async () => {
    const q = queuedFetch([anthropicResponse(BAD_BODY), anthropicResponse(GOOD_BODY)]);
    const provider = anthropicProvider({ model: "claude-opus-4-8", apiKeyEnv, fetchImpl: q.fetch });
    const proposal = await provider.propose(INPUT);
    expect(proposal.lines[0]?.componentRef).toBe("mem-a");
    expect(q.calls()).toBe(2); // first + one repair
  });

  it("throws ProviderError when both attempts are non-schema-valid", async () => {
    const q = queuedFetch([anthropicResponse(BAD_BODY), anthropicResponse(BAD_BODY)]);
    const provider = anthropicProvider({ model: "claude-opus-4-8", apiKeyEnv, fetchImpl: q.fetch });
    await expect(provider.propose(INPUT)).rejects.toBeInstanceOf(ProviderError);
    expect(q.calls()).toBe(2); // exactly one repair, no further loop
  });

  it("throws ProviderError when the API key env var is unset", async () => {
    const q = queuedFetch([anthropicResponse(GOOD_BODY)]);
    const provider = anthropicProvider({
      model: "claude-opus-4-8",
      apiKeyEnv: "DEFINITELY_UNSET_KEY_VAR",
      fetchImpl: q.fetch,
    });
    await expect(provider.propose(INPUT)).rejects.toBeInstanceOf(ProviderError);
    expect(q.calls()).toBe(0); // never reached the network
  });

  it("throws ProviderError on a non-2xx HTTP response", async () => {
    const errRes = new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
    const q = queuedFetch([errRes]);
    const provider = anthropicProvider({ model: "claude-opus-4-8", apiKeyEnv, fetchImpl: q.fetch });
    await expect(provider.propose(INPUT)).rejects.toBeInstanceOf(ProviderError);
  });

  it("is marked paid:true", () => {
    const provider = anthropicProvider({ model: "claude-opus-4-8", apiKeyEnv });
    expect(provider.paid).toBe(true);
    expect(provider.name).toBe("anthropic");
  });
});

describe("localProvider (PRD §4.7)", () => {
  it("parses valid JSON on the first attempt", async () => {
    const q = queuedFetch([localResponse(GOOD_BODY)]);
    const provider = localProvider({
      baseUrl: "http://localhost:8000/v1",
      model: "local",
      fetchImpl: q.fetch,
    });
    const proposal = await provider.propose(INPUT);
    expect(proposal.lines[0]?.componentRef).toBe("mem-a");
    expect(q.calls()).toBe(1);
  });

  it("repairs once on a bad-then-good sequence", async () => {
    const q = queuedFetch([localResponse(BAD_BODY), localResponse(GOOD_BODY)]);
    const provider = localProvider({
      baseUrl: "http://localhost:8000/v1",
      model: "local",
      fetchImpl: q.fetch,
    });
    const proposal = await provider.propose(INPUT);
    expect(proposal.lines[0]?.action).toBe("install");
    expect(q.calls()).toBe(2);
  });

  it("throws ProviderError when persistently non-schema-valid", async () => {
    const q = queuedFetch([localResponse(BAD_BODY), localResponse(BAD_BODY)]);
    const provider = localProvider({
      baseUrl: "http://localhost:8000/v1",
      model: "local",
      fetchImpl: q.fetch,
    });
    await expect(provider.propose(INPUT)).rejects.toBeInstanceOf(ProviderError);
    expect(q.calls()).toBe(2);
  });

  it("rejects a structurally-wrong JSON object (wrong action enum)", async () => {
    const wrong = JSON.stringify({
      lines: [{ action: "frobnicate", componentRef: "mem-a", reason: "x" }],
    });
    const q = queuedFetch([localResponse(wrong), localResponse(wrong)]);
    const provider = localProvider({
      baseUrl: "http://localhost:8000/v1",
      model: "local",
      fetchImpl: q.fetch,
    });
    await expect(provider.propose(INPUT)).rejects.toBeInstanceOf(ProviderError);
  });

  it("is marked paid:false (no cost guard)", () => {
    const provider = localProvider({ baseUrl: "http://localhost:8000/v1", model: "local" });
    expect(provider.paid).toBe(false);
    expect(provider.name).toBe("local");
  });
});
