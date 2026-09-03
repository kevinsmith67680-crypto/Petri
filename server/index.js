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
import { isValidStake, PRACTICE } from "../shared/wager.js";
import { createRamp, InsufficientFunds } from "./ledger.js";
import { createStore } from "./store.js";
import { MemoryRepo } from "./db/memory.js";
import { Accounts } from "./accounts.js";
import { handleApi } from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PORT = Number(process.env.PORT) || 8080;
const BOTS = Number(process.env.BOTS) || DEFAULT_BOTS;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 3;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Real money is off unless explicitly demanded, and createRamp() refuses to
// start if it is demanded without a real implementation behind it.
const REAL_MONEY = process.env.REAL_MONEY === "1";

// Unset keeps accounts in memory (lost on restart). Set a path to persist.
// On Render the filesystem is ephemeral, so this survives restarts of the
// process but NOT deploys — see README before relying on it.
const DATA_FILE = process.env.DATA_FILE || "";

// Set to a Supabase / Postgres connection string to persist accounts and
// balances. Unset falls back to the in-memory backend.
const DATABASE_URL = process.env.DATABASE_URL || "";

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, { accounts, backend, ramp, url, ip: ipOf(req) });
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      players: clients.size,
      tick: world.tick,
      demo: !ramp.isReal,
      storage: DATABASE_URL ? "postgres" : "memory"
    }));
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

// Backend selection. Both implementations expose the same surface, so nothing
// below this line knows or cares which one is in use.
let backend;
if (DATABASE_URL) {
  const { createPool, PgRepo } = await import("./db/pg.js");
  backend = new PgRepo(await createPool(DATABASE_URL));
  console.log("storage: postgres");
} else {
  backend = new MemoryRepo(createStore(DATA_FILE));
  console.log(`storage: memory${DATA_FILE ? ` (mirrored to ${DATA_FILE})` : ""}`);
}

const ramp = createRamp({ backend, real: REAL_MONEY });
const accounts = new Accounts(backend);

setInterval(() => {
  accounts.sweepSessions().catch(err => console.error("session sweep:", err.message));
}, 3600_000).unref?.();

// Who last ate whom, so a death can be settled to the right winner. Keyed by
// victim player id, cleared as soon as it is consumed.
const lastEater = new Map();

async function pushAccount(ws, meta) {
  if (ws.readyState !== ws.OPEN || !meta.accountId) return;
  const snap = await backend.snapshot(meta.accountId);
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: "account", demo: !ramp.isReal, ...snap }));
}

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
    // Stand-in for a real account id. A production build attaches this to an
    // authenticated user, not to a socket — see README.
    // Set on join: a resolved session gives `acct:<uuid>`, a guest gets a
    // per-socket id that owns nothing and cannot wager.
    accountId: null,   // uuid once signed in; guests never hold money
    joining: false,
    stake: PRACTICE,
    msgBucket: makeBucket(LIMITS.message),
    actBucket: makeBucket(LIMITS.action),
    alive: true
  };

  // Drop sockets that stop responding, so ghosts do not hold a slot.
  ws.on("pong", () => { meta.alive = true; });

  ws.on("message", async (raw, isBinary) => {
    if (!allow(meta.msgBucket)) { ws.close(1008, "Rate limit"); return; }

    // Text frames are control messages: join once, then money actions.
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg) return;

      if (meta.joined) {
        if (msg.type === "cashout") {
          // You can only realise a pot while alive. Dying settles it to
          // whoever ate you, so there is nothing left to claim afterwards.
          const player = world.players.get(id);
          if (!player || !player.alive || !meta.accountId) return;
          if (await backend.potOf?.(meta.accountId) === 0) return;
          // Snapshot the run before ending it: the player object is reset on
          // respawn and these numbers would be gone.
          const run = {
            duration: world.time - (player.spawnedAt || world.time),
            rank: player.rank, of: player.of,
            orbs: player.orbs, eaten: player.eaten, peak: Math.round(player.peak)
          };
          const stake = meta.stake;

          // End the run first, then settle. If the order were reversed a
          // player could be eaten in the window between the two and have the
          // same pot paid out twice.
          player.alive = false;
          player.cells = [];
          meta.stake = PRACTICE;
          setAim(world, id, 0, 0);
          const { paid } = await backend.cashOut(meta.accountId, RAKE_BPS);
          recordRun(meta, run, {
            outcome: "cashed_out", killerId: null, stake, payout: paid
          });
          await pushAccount(ws, meta);
        } else if (msg.type === "rename") {
          // The HTTP API is the only thing that can actually change a name.
          // This just re-reads it, so a rename shows on the cell without
          // needing a reconnect.
          if (!meta.accountId) return;
          const fresh = await backend.getAccount(meta.accountId);
          const player = world.players.get(id);
          if (fresh && player) player.name = fresh.displayName;
        } else if (msg.type === "ramp") {
          // Placeholder endpoint. Always refuses while MockRamp is in place.
          const result = msg.action === "withdraw"
            ? ramp.requestWithdrawal(meta.accountId, 0, null)
            : ramp.openDeposit(meta.accountId);
          Promise.resolve(result).then(r => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "ramp_result", ...r }));
            }
          });
        }
        return;
      }

      if (msg.type !== MSG.JOIN || meta.joining) return;
      // Resolving a session is a database round trip, so a second JOIN could
      // arrive mid-await and create two players for one socket.
      meta.joining = true;

      const stake = Number(msg.stake) || PRACTICE;
      if (!isValidStake(stake)) { ws.close(1008, "Bad stake"); return; }

      // Identity comes from the session token, never from anything else the
      // client says. A guest may play, but only for free: a balance has to
      // belong to an account, or it belongs to whoever opens a new socket.
      const authed = await accounts.resolveSession(msg.token).catch(() => null);
      let displayName;
      if (authed) {
        meta.accountId = authed.id;
        // The name on the cell is the account's, not whatever was sent, so a
        // client cannot impersonate another player by editing its join.
        displayName = authed.displayName;
        if (!ramp.isReal) await ramp.grant(meta.accountId);
      } else {
        displayName = cleanName(msg.name || "Guest");
      }

      if (stake > PRACTICE && !authed) {
        meta.joining = false;
        ws.send(JSON.stringify({
          type: "account_error",
          reason: "Sign in to wager. Guest play is practice only."
        }));
        ws.close(1008, "Auth required to wager");
        return;
      }

      if (stake > PRACTICE) {
        try {
          await backend.lockStake(meta.accountId, stake);
        } catch (err) {
          meta.joining = false;
          // Postgres raises a check-constraint violation (23514) when the
          // balance would go negative; the memory backend throws its own type.
          if (err instanceof InsufficientFunds || err.code === "23514") {
            ws.send(JSON.stringify({ type: "account_error", reason: "Not enough balance for that stake." }));
            ws.close(1008, "Insufficient funds");
            return;
          }
          throw err;
        }
      }

      meta.joined = true;
      meta.joining = false;
      meta.stake = stake;
      const player = addPlayer(world, { id, name: displayName });
      meta.state = createClientState(nextClientId);   // staggers keyframes
      clients.set(ws, meta);
      trimBots();
      ws.send(JSON.stringify({
        type: MSG.WELCOME, id, nid: player.nid, tickHz: TICK_HZ,
        demo: !ramp.isReal,
        signedIn: !!authed,
        displayName,
        ...(meta.accountId ? await backend.snapshot(meta.accountId) : { balance: 0, pot: 0, staked: false })
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
      // The pot stays in escrow for that window and settles normally if
      // something eats the abandoned cells.
      setAim(world, id, 0, 0);
      lingering.push({
        id, until: world.time + LINGER_SEC,
        accountId: meta.stake === PRACTICE ? null : meta.accountId
      });
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

// ── match history ───────────────────────────────────────────────────────────

// Fire-and-forget: a failed write must not interrupt play, and a match record
// is not worth blocking the tick for.
function recordRun(meta, event, extra) {
  if (!meta.accountId) return;
  backend.recordMatch({
    accountId: meta.accountId,
    startedAt: Date.now() - Math.round((event.duration || 0) * 1000),
    duration: Number((event.duration || 0).toFixed(2)),
    finishPosition: event.rank || null,
    playersInArena: event.of || null,
    orbs: event.orbs || 0,
    playersEaten: event.eaten || 0,
    peakMass: event.peak || 0,
    ...extra
  }).catch(err => console.error("recordMatch:", err.message));
}

// ── settlement ──────────────────────────────────────────────────────────────

const RAKE_BPS = Number(process.env.RAKE_BPS) || 0;

const accountOfPlayer = id => {
  for (const meta of clients.values()) if (meta.id === id) return meta;
  return null;
};

// Money moves only in response to simulation events, never in response to
// anything a client asserts.
async function settle(events) {
  for (const e of events) {
    if (e.t === "eat") lastEater.set(e.victim, e.id);
  }

  for (const e of events) {
    if (e.t !== "death") continue;
    const victim = accountOfPlayer(e.id);
    const killerId = lastEater.get(e.id);
    lastEater.delete(e.id);

    if (!victim || !victim.accountId) continue;

    const killer = killerId ? accountOfPlayer(killerId) : null;
    const killerStaked = killer && killer.accountId && killer.stake !== PRACTICE;
    const wasStaked = victim.stake !== PRACTICE;

    // Clear the stake before awaiting, so a second death event for the same
    // player cannot settle the same pot twice while the first is in flight.
    const stake = victim.stake;
    victim.stake = PRACTICE;

    // Every run is recorded, wagered or not. `killer` being absent means an
    // NPC got them, which is a different outcome from losing to a person.
    recordRun(victim, e, {
      outcome: killer ? "eaten" : "bot",
      killerId: killer?.accountId || null,
      stake: wasStaked ? stake : 0,
      payout: 0
    });

    if (!wasStaked) continue;

    try {
      if (killerStaked) {
        // Staked player beat another staked player: the pot changes hands.
        await backend.claim(killer.accountId, victim.accountId);
      } else {
        // Killed by a bot, or by someone with nothing at risk. Nobody won it.
        // See the note on Ledger.forfeit: this is why wagered players should
        // never share a world with bots.
        await backend.forfeit(victim.accountId);
      }
      for (const [ws, meta] of clients) {
        if (meta === killer || meta === victim) await pushAccount(ws, meta);
      }
    } catch (err) {
      console.error("settlement failed:", err.message);
    }
  }
}

// ── tick ────────────────────────────────────────────────────────────────────

let lastTick = process.hrtime.bigint();

setInterval(() => {
  const now = process.hrtime.bigint();
  // Measured elapsed time, not the nominal interval, so a busy event loop
  // slows the tick rather than silently changing game speed.
  const dt = Math.min(Number(now - lastTick) / 1e9, 0.25);
  lastTick = now;

  const events = stepWorld(world, dt);
  // Deliberately not awaited: the tick must not wait on the database. Events
  // are copied because stepWorld reuses its array next tick.
  if (events.length) {
    settle(events.slice()).catch(err => console.error("settle:", err.message));
  }

  for (let i = lingering.length - 1; i >= 0; i--) {
    if (world.time >= lingering[i].until) {
      const { id: goneId, accountId } = lingering[i];
      // Survived the linger window unclaimed, so the run is void rather than
      // lost. Refunding is the only defensible outcome: nobody beat them.
      if (accountId) {
        backend.refund(accountId).catch(err => console.error("refund:", err.message));
      }
      removePlayer(world, goneId);
      lastEater.delete(goneId);
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
