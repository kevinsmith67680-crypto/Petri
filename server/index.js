// ---------------------------------------------------------------------------
// Authoritative server.
//
// Owns the only real copy of the world. Clients send an aim vector and
// discrete actions; the server decides what actually happens and broadcasts
// culled snapshots at a fixed tick.
//
// Threat model, briefly. Because the client cannot move itself, speed hacks,
// teleporting and mass editing are impossible by construction rather than by
// validation. What a modified client CAN still do:
//
//   * aim perfectly (aimbot)          — detection problem, not preventable
//   * flood messages                  — token buckets below
//   * open many connections           — per-IP cap below
//   * disconnect to escape a fight    — linger-on-disconnect below
//   * read everything you send it     — area-of-interest culling in protocol.js
//
// The last one is why culling matters for fairness, not just bandwidth: a
// player can never see further than the server chooses to tell them.
//
// Config via environment:
//   PORT              default 8080
//   BOTS              default 14
//   ALLOWED_ORIGINS   comma-separated; unset means allow any (dev only)
//   MAX_CONN_PER_IP   default 3
//   TRUST_PROXY       set to 1 behind Render / Fly / a reverse proxy
// ---------------------------------------------------------------------------

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import {
  createWorld, addPlayer, removePlayer, fillBots,
  setAim, queueAction, stepWorld, TICK_HZ, DEFAULT_BOTS
} from "../shared/sim.js";
import {
  encodeSnapshot, decodeClientMessage, createClientState, MSG
} from "../shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PORT = Number(process.env.PORT) || 8080;
const BOTS = Number(process.env.BOTS) || DEFAULT_BOTS;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 3;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Message budgets. A well-behaved client sends aim at 20Hz plus the occasional
// action, so these are generous; they exist to stop floods, not to police play.
const LIMITS = {
  message: 80,   // per second, any type
  action: 12     // per second, split / eject / respawn
};

// Binary gameplay frames are 5 bytes; the only text frame is the join, which
// carries a 16-character name. 128 is generous and rejects floods earlier.
const MAX_PAYLOAD = 128;
const LINGER_SEC = 6;         // how long your cells stay after you vanish

// ── static files ────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, players: clients.size, tick: world.tick }));
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";

  const file = path.normalize(path.join(ROOT, rel));
  // Refuse anything that escapes the project directory, and never serve the
  // server source or node_modules.
  if (!file.startsWith(ROOT) || /(^|[\\/])(server|node_modules|\.git)([\\/]|$)/.test(rel)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  });
});

// ── room ────────────────────────────────────────────────────────────────────

const world = createWorld(Date.now() & 0xffffffff);
fillBots(world, BOTS);

const clients = new Map();        // ws -> meta
const connectionsByIp = new Map(); // ip -> count
const lingering = [];              // { id, until } for players who dropped
let nextClientId = 1;

function ipOf(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function originAllowed(req) {
  if (!ALLOWED_ORIGINS.length) return true;   // unset = dev, allow anything
  const origin = req.headers.origin;
  // No Origin header means a non-browser client. Once you have set an
  // allowlist, that is exactly what you are trying to keep out.
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

// Names are rendered into the leaderboard and onto cells. ui.js escapes HTML,
// but strip control characters here too so nothing weird reaches other players.
function cleanName(raw) {
  const name = String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
  return name || "Player";
}

function makeBucket(rate) { return { tokens: rate, at: Date.now(), rate }; }

function allow(bucket) {
  const now = Date.now();
  bucket.tokens = Math.min(bucket.rate, bucket.tokens + ((now - bucket.at) / 1000) * bucket.rate);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD,
  // WebSockets are not covered by the browser's same-origin policy, so if you
  // care where connections come from you have to check it yourself.
  verifyClient(info, done) {
    if (!originAllowed(info.req)) return done(false, 403, "Forbidden origin");
    const ip = ipOf(info.req);
    if ((connectionsByIp.get(ip) || 0) >= MAX_CONN_PER_IP) {
      return done(false, 429, "Too many connections");
    }
    done(true);
  }
});

wss.on("connection", (ws, req) => {
  const ip = ipOf(req);
  connectionsByIp.set(ip, (connectionsByIp.get(ip) || 0) + 1);

  const id = `p:${nextClientId++}`;
  const meta = {
    id, ip, joined: false, state: null,
    msgBucket: makeBucket(LIMITS.message),
    actBucket: makeBucket(LIMITS.action),
    alive: true
  };

  // Drop sockets that stop responding, so ghosts do not hold a slot.
  ws.on("pong", () => { meta.alive = true; });

  ws.on("message", (raw, isBinary) => {
    if (!allow(meta.msgBucket)) { ws.close(1008, "Rate limit"); return; }

    // Text frames are control messages. Only "join" is accepted, once.
    if (!isBinary) {
      if (meta.joined) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || msg.type !== MSG.JOIN) return;

      meta.joined = true;
      const player = addPlayer(world, { id, name: cleanName(msg.name) });
      meta.state = createClientState(nextClientId);   // staggers keyframes
      clients.set(ws, meta);
      trimBots();
      ws.send(JSON.stringify({
        type: MSG.WELCOME, id, nid: player.nid, tickHz: TICK_HZ
      }));
      return;
    }

    if (!meta.joined) return;

    // Binary gameplay. decodeClientMessage bounds-checks every field and
    // throws on anything malformed; a client that cannot speak the protocol
    // has nothing useful to say, so the socket goes.
    let msg;
    try {
      msg = decodeClientMessage(raw);
    } catch {
      ws.close(1002, "Protocol error");
      return;
    }

    if (msg.type === MSG.AIM) {
      // i16 decoding already guarantees finite, bounded values; setAim caps
      // the magnitude again on the simulation side.
      setAim(world, id, msg.x, msg.y);
    } else if (msg.type === MSG.ACTION) {
      if (!allow(meta.actBucket)) return;
      queueAction(world, id, msg.action);
    }
  });

  const cleanup = () => {
    clients.delete(ws);
    const n = (connectionsByIp.get(ip) || 1) - 1;
    if (n <= 0) connectionsByIp.delete(ip); else connectionsByIp.set(ip, n);

    if (meta.joined) {
      // Do not delete the player immediately. Vanishing on demand is a free
      // escape from any losing fight, so cells linger, motionless and edible.
      setAim(world, id, 0, 0);
      lingering.push({ id, until: world.time + LINGER_SEC });
    }
  };

  ws.on("close", cleanup);
  ws.on("error", () => { try { ws.close(); } catch {} });
});

function trimBots() {
  const humans = clients.size;
  const bots = [...world.players.values()].filter(p => p.bot);
  const excess = bots.length - Math.max(0, BOTS - humans);
  for (let i = 0; i < excess; i++) removePlayer(world, bots[i].id);
}

// Ping every 30s; anything that misses two rounds is gone.
setInterval(() => {
  for (const [ws, meta] of clients) {
    if (!meta.alive) { ws.terminate(); continue; }
    meta.alive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

// ── tick ────────────────────────────────────────────────────────────────────

let lastTick = process.hrtime.bigint();

setInterval(() => {
  const now = process.hrtime.bigint();
  // Measured elapsed time, not the nominal interval, so a busy event loop
  // slows the tick rather than silently changing game speed.
  const dt = Math.min(Number(now - lastTick) / 1e9, 0.25);
  lastTick = now;

  stepWorld(world, dt);

  for (let i = lingering.length - 1; i >= 0; i--) {
    if (world.time >= lingering[i].until) {
      removePlayer(world, lingering[i].id);
      lingering.splice(i, 1);
      fillBots(world, Math.max(0, BOTS - clients.size));
    }
  }

  for (const [ws, meta] of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const player = world.players.get(meta.id);
    if (!player) continue;

    // Deltas are computed against meta.state, which lives here on the server.
    // The client never tells us what it already knows, so it cannot lie about
    // it to widen its own view.
    ws.send(encodeSnapshot(world, player, meta.state));
  }
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`Petri server on port ${PORT}`);
  console.log(`  offline : http://localhost:${PORT}/`);
  console.log(`  online  : http://localhost:${PORT}/?mode=online`);
  console.log(`  origins : ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "any (set ALLOWED_ORIGINS in production)"}`);
});
