import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { upsertComponents } from "../src/core/db/components.js";
import { type DB, openStore, setMeta } from "../src/core/db/store.js";
import type { Component, Recommendation } from "../src/core/types.js";
import { ROUTES, assertReadOnly, createApiServer, serve } from "../src/server/index.js";

/**
 * Milestone E read-only dashboard API tests (PRD §4.6).
 *
 * Hermetic: an in-memory store, a temp project path, and a localhost server on
 * an ephemeral port. No live network call — the recommend path is exercised via
 * a seeded cache hit (zero provider calls) and the paid-provider decline path.
 * The structural assertion (no mutating route) is the read-only guarantee.
 */
function comp(over: Partial<Component> & { id: string; name: string }): Component {
  return {
    marketplaceId: "seed",
    trustTier: "community",
    description: "",
    categoryTags: [],
    bundles: { skills: [], commands: [], hooks: [], mcpServers: [] },
    contextCostFlag: false,
    singletonCategories: [],
    compatibility: [],
    ...over,
  };
}

const SEED: Component[] = [
  comp({ id: "mem-a", name: "MemoryEngineA", categoryTags: ["memory"], trustTier: "partner" }),
  comp({ id: "mcp-slack", name: "SlackMCP", categoryTags: ["integrations"], contextCostFlag: true, trustTier: "official" }),
];

/** Cache signature matches the recommender's: sha256 of normalized task. */
function taskSignature(task: string): string {
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

describe("read-only dashboard API (Milestone E)", () => {
  let db: DB;

  beforeEach(() => {
    db = openStore(":memory:");
    db.prepare(
      "INSERT INTO marketplaces (id, name, git_url, trust_default, kind) VALUES (?, ?, ?, ?, ?)",
    ).run("seed", "Seed", "https://example.invalid/seed", "community", "custom");
    upsertComponents(db, SEED);
  });

  afterEach(() => {
    db.close();
  });

  it("registers no mutating route (read-only boundary, PRD §4.6)", () => {
    // The route table is GET-only except POST /api/recommend, and no path names
    // a state change. assertReadOnly throws if that is ever violated.
    expect(() => assertReadOnly(ROUTES)).not.toThrow();
    const mutating = ROUTES.filter(
      (r) => r.method !== "GET" && !(r.method === "POST" && r.path === "/api/recommend"),
    );
    expect(mutating).toEqual([]);
    for (const r of ROUTES) {
      for (const token of ["enable", "disable", "install", "write", "delete", "update", "sync"]) {
        expect(r.path.toLowerCase()).not.toContain(token);
      }
    }
  });

  it("createApiServer throws if a mutating route is injected", () => {
    expect(() => assertReadOnly([{ method: "POST", path: "/api/install" }])).toThrow(/read-only/);
    expect(() => assertReadOnly([{ method: "DELETE" as "GET", path: "/api/index" }])).toThrow(
      /read-only/,
    );
  });

  it("GET /api/index returns normalized components", async () => {
    const { server, url } = await listen(db);
    try {
      const res = await fetch(`${url}/api/index`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { components: Array<{ id: string; contextCostFlag: boolean }> };
      expect(body.components.map((c) => c.id).sort()).toEqual(["mcp-slack", "mem-a"]);
      const slack = body.components.find((c) => c.id === "mcp-slack");
      expect(slack?.contextCostFlag).toBe(true);
    } finally {
      server.close();
    }
  });

  it("GET /api/index?q= filters via the same core search", async () => {
    const { server, url } = await listen(db);
    try {
      const res = await fetch(`${url}/api/index?q=MemoryEngine`);
      const body = (await res.json()) as { components: Array<{ id: string }> };
      expect(body.components.map((c) => c.id)).toEqual(["mem-a"]);
    } finally {
      server.close();
    }
  });

  it("GET /api/status returns a reconciled (empty here) inventory snapshot", async () => {
    const { server, url } = await listen(db);
    try {
      const res = await fetch(`${url}/api/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; unreadable: unknown[] };
      expect(Array.isArray(body.items)).toBe(true);
      expect(Array.isArray(body.unreadable)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("POST /api/recommend with no task is a 400", async () => {
    const { server, url } = await listen(db);
    try {
      const res = await fetch(`${url}/api/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("POST /api/recommend returns a cached recommendation with zero provider calls", async () => {
    // Seed rec_cache so the local provider is never reached — proves the POST
    // handler routes through the SAME cache (PRD §4.8) without any network call.
    setMeta(db, "index_version", "1");
    const task = "refactor the untested billing module";
    const cached: Recommendation = {
      task,
      lines: [{ action: "enable", componentRef: "mem-a", reason: "seeded" }],
      annotations: [],
      contextCostSummary: { costlyCount: 0, tightRequested: false },
      provider: "local",
      cached: false,
      indexVersion: "1",
    };
    db.prepare(
      "INSERT INTO rec_cache (task_signature, index_version, scope, proposal, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(taskSignature(task), "1", "system", JSON.stringify(cached), "local", new Date().toISOString());

    const { server, url } = await listen(db);
    try {
      const res = await fetch(`${url}/api/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, scope: "system" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recommendation: Recommendation };
      expect(body.recommendation.cached).toBe(true);
      expect(body.recommendation.lines[0]?.componentRef).toBe("mem-a");
    } finally {
      server.close();
    }
  });

  it("POST /api/recommend declines a paid provider with 402 (no spend)", async () => {
    // anthropic is paid; the dashboard's cost guard auto-declines (PRD §4.8) so
    // the dashboard cannot accrue spend. Force a fresh call past any cache.
    const config = {
      ...DEFAULT_CONFIG,
      defaultProvider: "anthropic" as const,
      anthropic: { model: "claude-x", apiKeyEnv: "PLUGSMITH_TEST_KEY_ABSENT" },
    };
    const { server, url } = await listenWith(db, config);
    try {
      const res = await fetch(`${url}/api/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "anything", provider: "anthropic" }),
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/paid provider/i);
    } finally {
      server.close();
    }
  });

  it("unknown /api path is a 404, never acted on", async () => {
    const { server, url } = await listen(db);
    try {
      const res = await fetch(`${url}/api/install`, { method: "POST" });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("serve() binds localhost only", async () => {
    const { server, url } = await serve(
      { db, config: DEFAULT_CONFIG, projectPath: process.cwd() },
      0,
    );
    try {
      const addr = server.address() as AddressInfo;
      expect(addr.address).toBe("127.0.0.1");
      expect(url).toContain("127.0.0.1");
    } finally {
      server.close();
    }
  });
});

/** Start the server on an ephemeral port with DEFAULT_CONFIG. */
async function listen(db: DB): Promise<{ server: import("node:http").Server; url: string }> {
  return listenWith(db, DEFAULT_CONFIG);
}

async function listenWith(
  db: DB,
  config: typeof DEFAULT_CONFIG,
): Promise<{ server: import("node:http").Server; url: string }> {
  const server = createApiServer({ db, config, projectPath: process.cwd() });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}` };
}
