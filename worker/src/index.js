/**
 * L.A.M.F.I. — Link All MotherFuckers In
 * Global "Total Connections Made" counter.
 *
 * Architecture:
 *   POST /count -> GlobalCounter Durable Object does an atomic +1 (exact, serialized).
 *                  The new total is mirrored into ARCADE_STATS KV, throttled, via waitUntil.
 *   GET  /count -> served from ARCADE_STATS KV (cheap cached edge read).
 *                  Falls back to the Durable Object on a cache miss.
 *
 * Why not increment KV directly: KV has no atomic increment, allows only
 * 1 write/sec to the same key (free AND paid), and concurrent writes clobber
 * each other last-write-wins. The DO is the source of truth; KV is only a cache.
 */

import { DurableObject } from "cloudflare:workers";

/**
 * Origins allowed to talk to this Worker.
 *
 * NOTE: this is a speed bump, not security. The Origin header is trivially
 * forged by any non-browser client (curl, scripts). It stops casual
 * fetch()-from-the-console spam from other websites, nothing more. For real
 * protection add a WAF Rate Limiting rule in the Cloudflare dashboard.
 *
 * If you ever move the fetch into the extension's background service worker,
 * its requests arrive with Origin: chrome-extension://<id> (or none at all),
 * so you would need to add that here.
 */
const ALLOWED_ORIGINS = new Set(["https://www.linkedin.com"]);

const KV_KEY = "global:connections";

/**
 * How often the DO is allowed to refresh the KV mirror.
 * KV permits 1 write/sec/key and the free plan allows only 1,000 writes/day,
 * so 60s caps us at ~1,440 writes/day worst case. Lower this on a paid plan
 * if you want a fresher global number.
 */
const MIRROR_INTERVAL_MS = 60_000;

/** Edge cache TTL for GET reads. 30s is the minimum KV allows. */
const READ_CACHE_TTL = 60;

/** Single global counter instance, addressed by a fixed name. */
const COUNTER_NAME = "global";

export class GlobalCounter extends DurableObject {
  /**
   * Atomic increment. Durable Object input gating serializes concurrent
   * callers, so this read-modify-write cannot interleave or lose a count.
   *
   * @returns {Promise<{ total: number, shouldMirror: boolean }>}
   */
  async increment() {
    const total = ((await this.ctx.storage.get("total")) ?? 0) + 1;
    await this.ctx.storage.put("total", total);

    // Decide here rather than in the Worker: the DO is the one serialized
    // point, so the throttle can't be raced by parallel Worker invocations.
    const lastMirror = (await this.ctx.storage.get("lastMirror")) ?? 0;
    const now = Date.now();
    const shouldMirror = now - lastMirror >= MIRROR_INTERVAL_MS;
    if (shouldMirror) {
      await this.ctx.storage.put("lastMirror", now);
    }

    return { total, shouldMirror };
  }

  /** @returns {Promise<number>} */
  async getTotal() {
    return (await this.ctx.storage.get("total")) ?? 0;
  }
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, { status = 200, origin } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      // Deliberately omitted when origin is undefined, so a disallowed
      // caller is blocked by the browser as well as by our 403.
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}

function counterStub(env) {
  return env.GLOBAL_COUNTER.get(env.GLOBAL_COUNTER.idFromName(COUNTER_NAME));
}

/** Best-effort KV mirror. The DO remains authoritative, so failure is harmless. */
async function mirrorToKV(env, total) {
  try {
    await env.ARCADE_STATS.put(KV_KEY, String(total));
  } catch (err) {
    // Most likely a 429 from the 1-write/sec/key limit. Swallow it: the next
    // GET just falls through to the Durable Object.
    console.warn("KV mirror failed:", err?.message ?? err);
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const allowed = origin !== null && ALLOWED_ORIGINS.has(origin);

    if (request.method === "OPTIONS") {
      return allowed
        ? new Response(null, { status: 204, headers: corsHeaders(origin) })
        : new Response("Forbidden origin", { status: 403 });
    }

    if (!allowed) {
      return json({ error: "forbidden_origin" }, { status: 403 });
    }

    const { pathname } = new URL(request.url);
    if (pathname !== "/" && pathname !== "/count") {
      return json({ error: "not_found" }, { status: 404, origin });
    }

    if (request.method === "GET") {
      const cached = await env.ARCADE_STATS.get(KV_KEY, {
        cacheTtl: READ_CACHE_TTL,
      });
      if (cached !== null) {
        return json({ total: Number(cached), source: "cache" }, { origin });
      }

      // Cold cache: read through to the source of truth and warm KV.
      const total = await counterStub(env).getTotal();
      ctx.waitUntil(mirrorToKV(env, total));
      return json({ total, source: "origin" }, { origin });
    }

    if (request.method === "POST") {
      // Always exactly +1 per request. Keeping this non-parameterised means a
      // spammer gains nothing per call beyond a single increment.
      const { total, shouldMirror } = await counterStub(env).increment();
      if (shouldMirror) {
        ctx.waitUntil(mirrorToKV(env, total));
      }
      return json({ total }, { origin });
    }

    return json({ error: "method_not_allowed" }, { status: 405, origin });
  },
};
