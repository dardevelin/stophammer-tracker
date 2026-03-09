/**
 * stophammer-tracker — Cloudflare Workers node registry
 *
 * Routes:
 *   POST /nodes/register  — upsert { pubkey, address }, set last_seen = now
 *   GET  /nodes/find      — return nodes seen within the last 10 minutes
 *   GET  /health          — liveness check
 *
 * All routing goes through a single NodeRegistry Durable Object instance
 * identified by the fixed ID "global". The DO owns its own storage; no
 * external KV or D1 is used.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Cloudflare Workers environment bindings. */
export interface Env {
  NODE_REGISTRY: DurableObjectNamespace;
}

/** A single node entry stored in Durable Object storage. */
interface NodeRecord {
  pubkey:    string;
  address:   string;
  last_seen: number; // Unix seconds
}

/** Request body for POST /nodes/register. */
interface RegisterBody {
  pubkey:  string;
  address: string;
}

// ── CORS helpers ─────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function corsResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ── Worker entry-point ────────────────────────────────────────────────────────

export default {
  /**
   * Worker entry-point: routes all requests into the single "global"
   * NodeRegistry Durable Object instance after handling CORS preflight.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") return optionsResponse();

    // All routes funnel into the single "global" Durable Object instance.
    const id   = env.NODE_REGISTRY.idFromName("global");
    const stub = env.NODE_REGISTRY.get(id);

    return stub.fetch(request);
  },
};

// ── NodeRegistry Durable Object ───────────────────────────────────────────────

/**
 * Durable Object that owns the node registry.
 *
 * A single instance (keyed "global") holds all node records in its private
 * storage.  No external KV or D1 is required.
 */
export class NodeRegistry {
  private readonly ctx:     DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
  }

  /**
   * Dispatches an inbound request to the appropriate handler.
   * CORS preflight is handled before any routing logic.
   */
  async fetch(request: Request): Promise<Response> {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight (re-checked here in case the Worker stub forwards it)
    if (method === "OPTIONS") return optionsResponse();

    // ── GET /health ─────────────────────────────────────────────────────────
    if (method === "GET" && url.pathname === "/health") {
      return corsResponse({ ok: true, ts: nowSecs() });
    }

    // ── POST /nodes/register ─────────────────────────────────────────────────
    if (method === "POST" && url.pathname === "/nodes/register") {
      return this.handleRegister(request);
    }

    // ── GET /nodes/find ──────────────────────────────────────────────────────
    if (method === "GET" && url.pathname === "/nodes/find") {
      return this.handleFind();
    }

    return corsResponse({ error: "not found" }, 404);
  }

  // ── Handlers ───────────────────────────────────────────────────────────────

  /**
   * Upserts a node record and evicts stale entries.
   *
   * Validates that `pubkey` is a non-empty string and `address` is a valid URL,
   * then writes the record keyed by pubkey.  After writing, nodes not seen in
   * the last hour are deleted to keep storage bounded.
   */
  private async handleRegister(request: Request): Promise<Response> {
    let body: RegisterBody;
    try {
      body = await request.json<RegisterBody>();
    } catch {
      return corsResponse({ error: "invalid JSON body" }, 400);
    }

    if (typeof body.pubkey !== "string" || body.pubkey.trim() === "") {
      return corsResponse({ error: "pubkey is required" }, 400);
    }
    if (typeof body.address !== "string" || body.address.trim() === "") {
      return corsResponse({ error: "address is required" }, 400);
    }

    // Validate that address is a well-formed URL, not arbitrary garbage.
    try {
      new URL(body.address.trim());
    } catch {
      return corsResponse({ error: "address must be a valid URL" }, 400);
    }

    const record: NodeRecord = {
      pubkey:    body.pubkey.trim(),
      address:   body.address.trim(),
      last_seen: nowSecs(),
    };

    // Storage key is the pubkey so each node has exactly one record.
    await this.ctx.storage.put<NodeRecord>(`node:${record.pubkey}`, record);

    // Evict nodes not seen in the last hour to keep storage bounded.
    const evictBefore = nowSecs() - 3600;
    const all = await this.ctx.storage.list<NodeRecord>({ prefix: "node:" });
    const staleKeys: string[] = [];
    for (const [key, r] of all.entries()) {
      if (r.last_seen < evictBefore) {
        staleKeys.push(key);
      }
    }
    if (staleKeys.length > 0) {
      await this.ctx.storage.delete(staleKeys);
    }

    return corsResponse({ ok: true });
  }

  /**
   * Returns all nodes seen within the last 10 minutes.
   *
   * Uses a linear scan over all stored node records.  This is acceptable up to
   * ~10,000 nodes; beyond that, consider a secondary index or a time-bucketed
   * storage scheme.
   */
  private async handleFind(): Promise<Response> {
    const cutoff = nowSecs() - 600; // 10 minutes

    // list() returns an ordered Map of all keys in this DO's storage.
    const all = await this.ctx.storage.list<NodeRecord>({ prefix: "node:" });

    const nodes: NodeRecord[] = [];
    for (const record of all.values()) {
      if (record.last_seen >= cutoff) {
        nodes.push(record);
      }
    }

    return corsResponse({ nodes });
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// Pure helper — returns the current wall-clock time as Unix seconds.
function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}
