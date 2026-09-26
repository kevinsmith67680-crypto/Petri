// ---------------------------------------------------------------------------
// The /match request, shared by the standalone matchmaker and the one a
// single game server runs for itself, so the two cannot answer differently.
// ---------------------------------------------------------------------------

import { MatchError } from "./core.js";

const MAX_BODY = 1024;

// Per-address token bucket. Every match holds a seat for as long as its
// ticket lives, so this is what stops one address filling a room with
// reservations it never uses.
export function createRateLimit({ rate = 2, burst = 10 } = {}) {
  const buckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [key, b] of buckets) if (b.at < cutoff) buckets.delete(key);
  }, 60_000).unref?.();
  return key => {
    const t = Date.now();
    const b = buckets.get(key) || { tokens: burst, at: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * rate);
    b.at = t;
    buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// Answers POST /match. `send(status, payload)` writes the response, so each
// caller keeps its own headers (CORS on the standalone service, none on a
// same-origin game server).
export async function answerMatch(req, send, matchmaker, { allowed = () => true, ip = "" } = {}) {
  if (!allowed(ip)) return send(429, { error: "Too many requests.", code: "throttled" });

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return send(413, { error: "Request too large." });
  }
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { return send(400, { error: "Malformed JSON." }); }

  const header = req.headers.authorization || "";
  try {
    return send(200, await matchmaker.match({
      token: header.startsWith("Bearer ") ? header.slice(7) : null,
      stake: body?.stake,
      region: typeof body?.region === "string" ? body.region : null
    }));
  } catch (err) {
    if (err instanceof MatchError) {
      return send(err.status, { error: err.message, code: err.code, retryMs: err.retryMs });
    }
    console.error("match failed:", err);
    return send(500, { error: "Something went wrong." });
  }
}
