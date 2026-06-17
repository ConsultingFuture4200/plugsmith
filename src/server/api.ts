import { existsSync, readFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlugsmithConfig } from "../core/config.js";
import { getAllComponents } from "../core/db/components.js";
import type { DB } from "../core/db/store.js";
import { reconcile, scanInventory } from "../core/inventory/scanner.js";
import { selectProvider } from "../core/recommender/factory.js";
import { CostAbortedError, recommend } from "../core/recommender/index.js";
import { ProviderError } from "../core/recommender/provider.js";
import { search } from "../core/registry/sync.js";
import type { Component, InventoryItem, Recommendation } from "../core/types.js";

/**
 * Read-only dashboard HTTP layer (PRD §4.6, Milestone E).
 *
 * A thin localhost server over `@plugsmith/core`. It exposes ONLY read and
 * recommend endpoints — there is structurally no enable/install/disable/write
 * route, so the dashboard cannot change machine state (PRD §4.6 read-only
 * boundary). The recommend path goes through the SAME core `recommend()` — same
 * cache + cost guard (PRD §4.8) — so the UI cannot silently accrue spend.
 *
 * Dependency-free (`node:http` only): the dashboard is local and modest; a web
 * framework would be weight the read-only boundary doesn't need.
 */

/** A registered route: method + exact path + handler. */
interface Route {
  method: "GET" | "POST";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse, ctx: ApiContext) => Promise<void> | void;
}

/** Everything a handler needs, injected so the server stays testable. */
export interface ApiContext {
  db: DB;
  config: PlugsmithConfig;
  /** Project root whose `.claude/` is the project scope (default `process.cwd()`). */
  projectPath: string;
  /** Static web asset root; when present, non-API GETs serve the built SPA. */
  webRoot?: string;
}

/** Shape of a POST /api/recommend body (PRD §4.6 Recommendation view). */
interface RecommendBody {
  task?: unknown;
  scope?: unknown;
  tight?: unknown;
  integrations?: unknown;
  provider?: unknown;
}

/**
 * The complete route table (PRD §4.6). EXHAUSTIVE and read-only by construction:
 * exported so a test can assert no mutating method/path is ever registered. Any
 * future mutating route added here would be caught by that test.
 */
export const ROUTES: ReadonlyArray<Pick<Route, "method" | "path">> = [
  { method: "GET", path: "/api/index" },
  { method: "GET", path: "/api/status" },
  { method: "POST", path: "/api/recommend" },
];

/** Words that would betray a state change; no route may contain them (PRD §4.6). */
const MUTATING_TOKENS = ["enable", "disable", "install", "write", "delete", "update", "sync"];

/**
 * Assert the route table is read-only (PRD §4.6 architectural rule). Throws if a
 * mutating verb or a non-GET/recommend method ever slips in. Called at server
 * construction so a misconfiguration fails loudly at boot, and re-usable from a
 * test as the structural guarantee.
 */
export function assertReadOnly(routes: ReadonlyArray<Pick<Route, "method" | "path">>): void {
  for (const r of routes) {
    if (r.method !== "GET" && !(r.method === "POST" && r.path === "/api/recommend")) {
      throw new Error(`read-only boundary violated: ${r.method} ${r.path}`);
    }
    const lower = r.path.toLowerCase();
    for (const token of MUTATING_TOKENS) {
      if (lower.includes(token)) {
        throw new Error(`read-only boundary violated: route path contains "${token}" (${r.path})`);
      }
    }
  }
}

/** Serialize a Component for the wire (PRD §4.1 index model fields the UI shows). */
function componentDto(c: Component): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    trustTier: c.trustTier,
    description: c.description ?? "",
    categoryTags: c.categoryTags,
    contextCostFlag: c.contextCostFlag,
    mcpServers: c.bundles.mcpServers.length,
    hooks: c.bundles.hooks.length,
    singletonCategories: c.singletonCategories,
  };
}

/** Write a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/** Read and JSON-parse a request body (bounded — the dashboard is local). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** GET /api/index — component list + filter facets (PRD §4.6 Index view). */
function handleIndex(req: IncomingMessage, res: ServerResponse, ctx: ApiContext): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query = url.searchParams.get("q") ?? "";
  const category = url.searchParams.get("category") ?? undefined;
  const components =
    query.trim().length > 0 || category != null
      ? search(ctx.db, query, category != null ? { category } : {})
      : getAllComponents(ctx.db);
  sendJson(res, 200, { components: components.map(componentDto) });
}

/** GET /api/status — reconciled inventory snapshot (PRD §4.6 Status view). */
function handleStatus(_req: IncomingMessage, res: ServerResponse, ctx: ApiContext): void {
  const report = scanInventory({ projectPath: ctx.projectPath });
  const items: InventoryItem[] = reconcile(ctx.db, report);
  sendJson(res, 200, { items, unreadable: report.unreadable });
}

/**
 * POST /api/recommend — task → recommend() (PRD §4.6 Recommendation view).
 *
 * Routes through the SAME core `recommend()` (cache + cost guard, PRD §4.8). The
 * cost guard auto-DECLINES paid providers here: a read-only dashboard must not
 * silently accrue spend, and there is no interactive confirm in a browser. Paid
 * recommendations stay a deliberate CLI step (with `--yes`); the UI is for
 * viewing, and the free/local provider runs unguarded.
 */
async function handleRecommend(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<void> {
  let body: RecommendBody;
  try {
    body = (await readJsonBody(req)) as RecommendBody;
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid JSON body" });
    return;
  }

  const task = typeof body.task === "string" ? body.task.trim() : "";
  if (task.length === 0) {
    sendJson(res, 400, { error: "task is required" });
    return;
  }

  const scope = body.scope === "project" ? "project" : "system";
  const integrations =
    typeof body.integrations === "string"
      ? body.integrations
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : Array.isArray(body.integrations)
        ? body.integrations.filter((s): s is string => typeof s === "string")
        : undefined;
  const providerName =
    body.provider === "anthropic" || body.provider === "local" ? body.provider : undefined;

  try {
    const provider = selectProvider(ctx.config, providerName);
    const rec: Recommendation = await recommend(ctx.db, ctx.config, task, {
      scope,
      ...(body.tight === true ? { tight: true } : {}),
      ...(integrations && integrations.length > 0 ? { integrations } : {}),
      provider,
      // Read-only boundary (PRD §4.6/§4.8): paid providers are declined here so
      // the dashboard cannot accrue spend. Local/free providers never reach this.
      confirmCost: () => false,
    });
    sendJson(res, 200, { recommendation: rec });
  } catch (err) {
    if (err instanceof CostAbortedError) {
      sendJson(res, 402, {
        error:
          "paid provider declined: the read-only dashboard cannot run paid recommendations. Use `plugsmith recommend --provider anthropic --yes` from the CLI, or configure a local provider.",
      });
      return;
    }
    if (err instanceof ProviderError) {
      sendJson(res, 502, { error: err.message });
      return;
    }
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

const ROUTE_HANDLERS: Route[] = [
  { method: "GET", path: "/api/index", handler: handleIndex },
  { method: "GET", path: "/api/status", handler: handleStatus },
  { method: "POST", path: "/api/recommend", handler: handleRecommend },
];

/** Minimal content-type map for the static SPA assets. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve a built static asset from `webRoot`, falling back to `index.html` for
 * client-side routes (SPA). Path-traversal is blocked: the resolved file must
 * stay inside `webRoot`. Strictly read-only — only reads files under the asset
 * root, never the operator's machine state.
 */
function serveStatic(res: ServerResponse, webRoot: string, urlPath: string): void {
  const rootAbs = resolve(webRoot);
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  let fileAbs = resolve(join(rootAbs, rel === "/" || rel === "" ? "index.html" : rel));
  if (fileAbs !== rootAbs && !fileAbs.startsWith(rootAbs + sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(fileAbs) || !extname(fileAbs)) {
    // SPA fallback: unknown route → index.html so client routing takes over.
    fileAbs = join(rootAbs, "index.html");
  }
  if (!existsSync(fileAbs)) {
    res.writeHead(404).end("not found");
    return;
  }
  const type = MIME[extname(fileAbs).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(fileAbs));
}

/**
 * Build the read-only HTTP server (PRD §4.6). Asserts the read-only boundary at
 * construction, then dispatches API routes; non-API GETs serve the static SPA
 * when `webRoot` is set, else a small JSON hint. The returned server is NOT yet
 * listening — the caller binds it to localhost.
 */
export function createApiServer(ctx: ApiContext): Server {
  assertReadOnly(ROUTES);

  return createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? "GET";
        const url = new URL(req.url ?? "/", "http://localhost");
        const route = ROUTE_HANDLERS.find((r) => r.method === method && r.path === url.pathname);
        if (route) {
          await route.handler(req, res, ctx);
          return;
        }
        // No mutating fallthrough: any non-listed API path is 404, never acted on.
        if (url.pathname.startsWith("/api/")) {
          sendJson(res, 404, { error: `no route: ${method} ${url.pathname}` });
          return;
        }
        if (method === "GET" && ctx.webRoot) {
          serveStatic(res, ctx.webRoot, url.pathname);
          return;
        }
        sendJson(res, 404, {
          error: "not found",
          hint: "read-only API: GET /api/index, GET /api/status, POST /api/recommend",
        });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

/** Resolve the bundled web assets dir relative to this module (dist or src). */
export function defaultWebRoot(): string | undefined {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // dist/server/api.js → ../../web/dist ; src/server/api.ts → ../../web/dist
  const candidate = resolve(here, "..", "..", "web", "dist");
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Start the read-only dashboard server bound to localhost ONLY (PRD §4.6:
 * "binds localhost"). Resolves once listening. Never binds 0.0.0.0 — the host is
 * hard-coded to the loopback address.
 */
export function serve(
  ctx: ApiContext,
  port: number,
): Promise<{ server: Server; port: number; url: string }> {
  const server = createApiServer(ctx);
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      server.removeListener("error", reject);
      resolvePromise({
        server,
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}`,
      });
    });
  });
}
