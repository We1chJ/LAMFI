/**
 * L.A.M.F.I. — personal cross-device counter.
 *
 * Single user, so there is no concurrency to arbitrate and no Durable Object
 * needed. Plain KV is enough.
 *
 * The extension keeps the authoritative count locally and pushes its ABSOLUTE
 * total here, debounced. The Worker stores max(incoming, stored), which makes
 * writes idempotent: a retry can't double-count, and a device that's behind
 * can't stomp a higher number. Deltas would get both of those wrong.
 *
 * Auth is a bearer token, not an Origin check — an Origin check can't work
 * from curl or a phone, which is the entire point of going cross-device.
 *
 * Routes (all require Authorization: Bearer <token>):
 *   GET    /count  -> { total, updatedAt }
 *   POST   /count  -> { total } body; stores the max; returns the new total
 *   DELETE /count  -> resets to 0
 */

const KV_KEY = "counter:total";

// The extension calls from a LinkedIn page, so that origin needs CORS headers.
// curl and other non-browser clients send no Origin and don't need them.
const ALLOWED_ORIGIN = "https://www.linkedin.com";

function corsHeaders(origin) {
  if (origin !== ALLOWED_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    // Authorization makes this a preflighted request, so it must be listed.
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Constant-time compare so the token can't be recovered by timing. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthed(request, env) {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7), env.SYNC_TOKEN ?? "");
}

function json(body, { status = 200, origin } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

async function readTotal(env) {
  const raw = await env.CONNECTION_STATS.get(KV_KEY);
  if (!raw) return { total: 0, updatedAt: null };
  try {
    const parsed = JSON.parse(raw);
    return { total: Number(parsed.total) || 0, updatedAt: parsed.updatedAt ?? null };
  } catch {
    // Tolerate a bare number left by an earlier version or a manual kv put.
    return { total: Number(raw) || 0, updatedAt: null };
  }
}

function writeTotal(env, total) {
  const record = { total, updatedAt: new Date().toISOString() };
  return env.CONNECTION_STATS.put(KV_KEY, JSON.stringify(record)).then(() => record);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!isAuthed(request, env)) {
      return json({ error: "unauthorized" }, { status: 401, origin });
    }

    const { pathname } = new URL(request.url);
    if (pathname !== "/" && pathname !== "/count") {
      return json({ error: "not_found" }, { status: 404, origin });
    }

    if (request.method === "GET") {
      return json(await readTotal(env), { origin });
    }

    if (request.method === "POST") {
      let incoming;
      try {
        const body = await request.json();
        incoming = Number(body?.total);
      } catch {
        return json({ error: "invalid_json" }, { status: 400, origin });
      }
      if (!Number.isFinite(incoming) || incoming < 0) {
        return json({ error: "invalid_total" }, { status: 400, origin });
      }

      const current = await readTotal(env);
      // Monotonic merge — see the note at the top of this file.
      if (incoming <= current.total) {
        return json({ ...current, merged: false }, { origin });
      }
      const record = await writeTotal(env, Math.floor(incoming));
      return json({ ...record, merged: true }, { origin });
    }

    if (request.method === "DELETE") {
      return json({ ...(await writeTotal(env, 0)), merged: true }, { origin });
    }

    return json({ error: "method_not_allowed" }, { status: 405, origin });
  },
};
