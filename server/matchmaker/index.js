// ---------------------------------------------------------------------------
// The matchmaker as its own service.   node server/matchmaker/index.js
//
//   POST /match     Authorization: Bearer <session>   { stake, region? }
//                   -> { ticket, url, server, region, room, mode, expiresAt }
//   GET  /regions   the regions it can place players in
//   GET  /health    whether each game server is answering
//
// It keeps nothing between requests. Sessions and seats come from the same
// Postgres the game servers use, rooms come from the game servers, so a
// restart loses nothing and several can run behind one load balancer.
//
// Environment:
//   PORT              default 8090
//   DATABASE_URL      required: sessions and seats are shared state
//   MATCH_SECRET      required: the same value on every game server
//   GAME_SERVERS      required, JSON:
//                       [{ "id": "eu-1", "region": "eu",
//                          "url": "wss://eu-1.engulfs.io",
//                          "internal": "https://eu-1.engulfs.io" }]
//                     url is what players connect to; internal is where this
//                     service reaches the server (defaults to url over https)
//   DEFAULT_REGION    region for a player who names none (default: first listed)
//   TICKET_SECONDS    ticket lifetime, default 30
//   ALLOWED_ORIGINS   pages allowed to call /match; unset allows any
//   TRUST_PROXY       set to 1 behind a proxy, for per-address rate limits
//   MATCH_RATE        matches per second per address, default 2 (MATCH_BURST 10)
// ---------------------------------------------------------------------------

import http from "node:http";
import { fileURLToPath } from "node:url";

import { createMatchmaker } from "./core.js";
import { answerMatch, createRateLimit } from "./http.js";
import { signRequest, assertSecret } from "../ticket.js";
import { Accounts } from "../accounts.js";

// Signed HTTP to one game server, in the shape createMatchmaker expects.
export function remoteServer({ id, region, url, internal }, secret) {
  if (!id || !region || !url) throw new Error(`GAME_SERVERS entry needs id, region and url: ${JSON.stringify({ id, region, url })}`);
  const base = String(internal || url.replace(/^ws/, "http")).replace(/\/+$/, "");
  const call = async (path, payload) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const res = await fetch(base + path, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Match-Signature": signRequest(path, body, secret)
      },
      body: payload === undefined ? undefined : body
    });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res.json();
  };
  return {
    id, region, url,
    status: () => call("/internal/status"),
    reserve: req => call("/internal/reserve", req)
  };
}

export async function startMatchmaker(env = process.env) {
  const secret = assertSecret(env.MATCH_SECRET);
  if (!env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required. The matchmaker reads sessions and seats from the " +
      "database the game servers write to; there is nothing to share in memory."
    );
  }
  let list;
  try { list = JSON.parse(env.GAME_SERVERS || ""); } catch { list = null; }
  if (!Array.isArray(list) || !list.length) {
    throw new Error('GAME_SERVERS must be a JSON array, e.g. [{"id":"eu-1","region":"eu","url":"wss://eu-1.example"}]');
  }
  const servers = list.map(s => remoteServer(s, secret));
  if (new Set(servers.map(s => s.id)).size !== servers.length) {
    throw new Error("GAME_SERVERS ids must be unique: a ticket is only valid on the server it names");
  }

  const { createPool, PgRepo } = await import("../db/pg.js");
  const backend = new PgRepo(await createPool(env.DATABASE_URL));
  const accounts = new Accounts(backend);

  const matchmaker = createMatchmaker({
    servers,
    secret,
    resolveSession: token => accounts.resolveSession(token),
    findSeat: accountId => backend.findSeat(accountId),
    ticketTtlMs: (Number(env.TICKET_SECONDS) || 30) * 1000,
    defaultRegion: env.DEFAULT_REGION || servers[0].region
  });

  const origins = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const trustProxy = env.TRUST_PROXY === "1";
  const ipOf = req => {
    const fwd = req.headers["x-forwarded-for"];
    if (trustProxy && typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
    return req.socket.remoteAddress || "unknown";
  };

  const allowed = createRateLimit({
    rate: Number(env.MATCH_RATE) || 2,
    burst: Number(env.MATCH_BURST) || 10
  });

  const server = http.createServer(async (req, res) => {
    // Bearer tokens travel in a header, never a cookie, so a cross-origin call
    // carries nothing the calling page did not already hold. The allowlist
    // is about who may use this service at all.
    const origin = req.headers.origin;
    const cors = {};
    if (origin && (!origins.length || origins.includes(origin))) {
      cors["Access-Control-Allow-Origin"] = origin;
      cors["Vary"] = "Origin";
      cors["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
      cors["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    }
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(body);
    };
    const path = new URL(req.url, "http://x").pathname;

    if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }

    if (path === "/health" && req.method === "GET") {
      const checks = await Promise.all(servers.map(async s => {
        try {
          const st = await Promise.race([
            s.status(), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 1500))
          ]);
          return { id: s.id, region: s.region, ok: true, rooms: st.rooms?.length ?? 0, canOpen: !!st.canOpen };
        } catch (err) {
          return { id: s.id, region: s.region, ok: false, error: err.message };
        }
      }));
      return send(200, { ok: true, servers: checks, regions: matchmaker.regions() });
    }

    if (path === "/regions" && req.method === "GET") {
      return send(200, { regions: matchmaker.regions() });
    }

    if (path === "/match" && req.method === "POST") {
      return answerMatch(req, send, matchmaker, { allowed, ip: ipOf(req) });
    }

    send(404, { error: "No such endpoint." });
  });

  const port = Number(env.PORT) || 8090;
  await new Promise(r => server.listen(port, r));
  console.log(`Matchmaker on port ${port}`);
  for (const s of servers) console.log(`  server  : ${s.id.padEnd(10)} ${s.region.padEnd(8)} ${s.url}`);
  console.log(`  default : ${matchmaker.regions().find(r => r.default)?.id}`);
  return { server, matchmaker, close: async () => { server.close(); await backend.close(); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startMatchmaker().catch(err => { console.error(err.message); process.exit(1); });
}
