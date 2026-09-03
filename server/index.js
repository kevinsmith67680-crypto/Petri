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
  createWorld, addPlayer, removePlayer, fillBots, resetArena, spawnPlayer,
  setAim, queueAction, stepWorld, totalMass, TICK_HZ
} from "../shared/sim.js";
import {
  encodeSnapshot, decodeClientMessage, createClientState, MSG,
  PHASE_LIVE, PHASE_INTERMISSION, PHASE_LOBBY
} from "../shared/protocol.js";
import { isValidStake, PRACTICE, MICRO_PER_MASS, formatUsdc, valueOfMass, UNIT }
  from "../shared/wager.js";
import { createRamp, InsufficientFunds } from "./ledger.js";
import { createStore } from "./store.js";
import { MemoryRepo } from "./db/memory.js";
import { Accounts } from "./accounts.js";
import { handleApi } from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const envInt = (name, fallback) =>
  process.env[name] !== undefined ? Number(process.env[name]) : fallback;

// Real money is off unless explicitly demanded, and createRamp() refuses to
// start if it is demanded without a real implementation behind it.
const REAL_MONEY = process.env.REAL_MONEY === "1";

// ── test mode ───────────────────────────────────────────────────────────────
//
// One switch that makes the live PvP mode playable alone: rounds start with a
// single ready player, the arena is filled with bots, and rounds are short so
// you can watch a whole cycle without waiting ten minutes.
//
// Money still moves, but only demo credits — MockRamp grants 5.00 on signup
// and there is no ramp behind it. That is deliberate: staking, claiming,
// forfeiting and paying the places are exactly the paths worth exercising,
// and they are worthless to test if money never moves at all.
const TEST_MODE = process.env.TEST_MODE === "1";

// Hard interlock. Test mode exists to make things easy, and easy plus real
// funds is how money goes missing.
if (TEST_MODE && REAL_MONEY) {
  throw new Error(
    "TEST_MODE=1 and REAL_MONEY=1 are mutually exclusive. Test mode lowers the " +
    "lobby to a single player and fills the arena with bots; it must never run " +
    "against real funds."
  );
}

const PORT = Number(process.env.PORT) || 8080;
// The live arena is player versus player, so no bots by default. Bots still
// fill the guest experience, which runs locally in the browser. Set BOTS to a
// number if you want to pad an empty server while testing.
const BOTS = envInt("BOTS", TEST_MODE ? 60 : 0) || 0;

// Rounds. Ten minutes of play, then a short intermission showing standings.
const ROUND_SECONDS = envInt("ROUND_SECONDS", TEST_MODE ? 120 : 600);
const INTERMISSION_SECONDS = envInt("INTERMISSION_SECONDS", TEST_MODE ? 8 : 15);

// Lobby. A round starts only once this many players have marked themselves
// ready, and the server refuses connections past the maximum.
//
// READ THIS BEFORE DEPLOYING: with LOBBY_MIN at 100, nothing starts until a
// hundred real people are in the lobby at the same moment. On a new game that
// is never, so set LOBBY_MIN=2 while testing or you will stare at a lobby
// forever. It is an environment variable for exactly that reason.
const LOBBY_MIN = envInt("LOBBY_MIN", TEST_MODE ? 1 : 100);
const LOBBY_MAX = envInt("LOBBY_MAX", 150);

// Only the top finishers are paid. There is no voluntary cash-out, so the
// only way to realise a pot is to still be alive AND placed when the whistle
// goes. Everyone else loses what they staked.
const PAID_POSITIONS = Number(process.env.PAID_POSITIONS) || 5;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 3;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);


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
      worldTick: world.tick,
      demo: !ramp.isReal,
      storage: DATABASE_URL ? "postgres" : "memory",
      tick: {
        hz: TICK_HZ,
        budgetMs: +(1000 / TICK_HZ).toFixed(1),
        avgMs: +tickCost.avgMs.toFixed(2),
        worstMs: +tickCost.worstMs.toFixed(2),
        overruns: tickCost.behind
      }
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
if (BOTS > 0) fillBots(world, BOTS);

// All round timing runs off world.time, the same clock the simulation uses, so
// a slow tick stretches the round rather than desynchronising it from play.
const round = {
  number: 0,
  phase: PHASE_LOBBY,
  endsAt: Infinity        // the lobby waits on people, not on the clock
};

const readyCount = () => {
  let n = 0;
  for (const meta of clients.values()) if (meta.ready) n++;
  return n;
};

function lobbyState() {
  return {
    type: "lobby",
    ready: readyCount(),
    connected: clients.size,
    min: LOBBY_MIN,
    max: LOBBY_MAX,
    phase: round.phase,
    test: TEST_MODE
  };
}

function pushLobby() { broadcast(lobbyState()); }

const roundView = () => ({
  phase: round.phase,
  remaining: round.endsAt === Infinity
    ? 0
    : Math.max(0, round.endsAt - world.time),
  number: round.number
});

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
    ready: false,
    spectateId: null,   // whose eyes this client is borrowing, if dead
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
        if (msg.type === "spectate") {
          const self = world.players.get(id);
          // Only the dead spectate. Watching while alive would be a free
          // second camera on the arena.
          if (self && self.alive) return;
          if (msg.dir === "off") {
            meta.spectateId = null;
          } else {
            cycleSpectate(meta, msg.dir === "prev" ? "prev" : "next");
          }
        } else if (msg.type === "ready") {
          // Only meaningful in the lobby; readying mid-round would let a
          // player spawn into a game already in progress.
          if (round.phase !== PHASE_LOBBY) return;
          meta.ready = msg.ready !== false;
          pushLobby();
          maybeStartRound();
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
      // client says.
      const authed = await accounts.resolveSession(msg.token).catch(() => null);

      // The shared arena is for signed-in players only. Guests play the same
      // simulation locally in their own tab, against bots.
      //
      // Enforced here rather than merely hidden in the UI: the client routes
      // guests to the local simulation, but a modified client would happily
      // open a socket anyway. Requiring a session is also what makes every
      // player in the arena attributable, which matters for stats, for bans,
      // and for anything involving a balance.
      if (!authed) {
        meta.joining = false;
        ws.send(JSON.stringify({
          type: "account_error",
          reason: "Sign in to play against other people. Guests play against bots."
        }));
        ws.close(1008, "Sign in required");
        return;
      }

      // Capacity is a hard limit: past LOBBY_MAX the arena stops being the
      // size it was tuned for, and the per-tick cost grows with every body.
      if (clients.size >= LOBBY_MAX) {
        meta.joining = false;
        ws.send(JSON.stringify({
          type: "account_error",
          reason: `Server full (${LOBBY_MAX} players). Try again shortly.`
        }));
        ws.close(1013, "Server full");
        return;
      }

      meta.accountId = authed.id;
      // The name on the cell is the account's, not whatever was sent, so a
      // client cannot impersonate another player by editing their join.
      const displayName = authed.displayName;
      if (!ramp.isReal) await ramp.grant(meta.accountId);

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
      pushLobby();
      // Arrivals wait in the lobby rather than dropping into a live round.
      const joinedPlayer = world.players.get(id);
      if (joinedPlayer && round.phase !== PHASE_LIVE) {
        joinedPlayer.alive = false;
        joinedPlayer.cells = [];
      }

      ws.send(JSON.stringify({
        type: MSG.WELCOME, id, nid: player.nid, tickHz: TICK_HZ,
        round: round.number,
        roundSeconds: ROUND_SECONDS,
        lobbyMin: LOBBY_MIN,
        lobbyMax: LOBBY_MAX,
        test: TEST_MODE,
        demo: !ramp.isReal,
        signedIn: true,
        displayName,
        ...(await backend.snapshot(meta.accountId))
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
      // Coming back into play ends spectating; otherwise the camera would
      // stay locked on someone else while you are alive.
      if (msg.action === "respawn") meta.spectateId = null;
      queueAction(world, id, msg.action);
    }
  });

  const cleanup = () => {
    clients.delete(ws);
    if (meta.joined) pushLobby();
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

// Outside test mode bots only fill seats humans have not taken. In test mode
// the count is fixed, because the whole point is a populated arena for one
// person.
const botTarget = () => (TEST_MODE ? BOTS : Math.max(0, BOTS - clients.size));

function trimBots() {
  const bots = [...world.players.values()].filter(p => p.bot);
  const excess = bots.length - botTarget();
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

// ── spectating ──────────────────────────────────────────────────────────────

const aliveTargets = () =>
  [...world.players.values()].filter(p => p.alive && p.cells.length);

// Cycle to the next living player. Sorted by mass so the order is stable and
// meaningful rather than whatever the Map happens to hold.
function cycleSpectate(meta, dir) {
  const targets = aliveTargets().sort((a, b) => totalMass(b) - totalMass(a));
  if (!targets.length) { meta.spectateId = null; return null; }
  const i = targets.findIndex(p => p.id === meta.spectateId);
  const next = i < 0
    ? targets[0]
    : dir === "prev"
      ? targets[(i - 1 + targets.length) % targets.length]
      : targets[(i + 1) % targets.length];
  meta.spectateId = next.id;
  return next;
}

// Called every tick before snapshots go out: the player being watched can be
// eaten at any moment, and a spectator staring at a corpse sees nothing.
function refreshSpectate(meta) {
  if (!meta.spectateId) return;
  const target = world.players.get(meta.spectateId);
  if (!target || !target.alive || !target.cells.length) cycleSpectate(meta, "next");
}

// ── rounds ──────────────────────────────────────────────────────────────────

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const [ws] of clients) {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

// Time is up. Survivors are ranked by mass; the top PAID_POSITIONS realise
// their pot and everyone else forfeits theirs. Surviving is necessary but no
// longer sufficient — you have to place.
async function endRound() {
  round.phase = PHASE_INTERMISSION;
  round.endsAt = world.time + INTERMISSION_SECONDS;

  const survivors = [...world.players.values()]
    .filter(p => p.alive && p.cells.length)
    .sort((a, b) => totalMass(b) - totalMass(a));

  const standings = survivors.map((p, i) => ({
    name: p.name,
    mass: Math.round(totalMass(p)),
    position: i + 1,
    paid: i + 1 <= PAID_POSITIONS
  }));

  broadcast({
    type: "round_end",
    number: round.number,
    standings,
    paidPositions: PAID_POSITIONS,
    nextIn: INTERMISSION_SECONDS
  });

  for (const [ws, meta] of clients) {
    const player = world.players.get(meta.id);
    if (!player || !player.alive) continue;

    const position = survivors.indexOf(player) + 1;
    const stake = meta.stake;
    meta.stake = PRACTICE;

    const placed = position > 0 && position <= PAID_POSITIONS;
    let payout = 0;
    try {
      if (stake > PRACTICE && meta.accountId) {
        if (placed) {
          ({ paid: payout } = await backend.cashOut(meta.accountId, RAKE_BPS));
        } else {
          // Survived but out of the places: the stake is gone.
          await backend.forfeit(meta.accountId);
        }
      }
    } catch (err) {
      console.error("round settlement:", err.message);
    }

    recordRun(meta, {
      duration: world.time - (player.spawnedAt || world.time),
      rank: position || null,
      of: survivors.length,
      orbs: player.orbs,
      eaten: player.eaten,
      peak: Math.round(player.peak)
    }, { outcome: "survived", killerId: null, stake, payout });

    await pushAccount(ws, meta);
  }
}

// Back to the lobby. Everyone is despawned and un-readied, so the next round
// needs a fresh show of hands rather than inheriting the last one.
function toLobby() {
  round.phase = PHASE_LOBBY;
  round.endsAt = Infinity;
  for (const meta of clients.values()) meta.ready = false;
  for (const p of world.players.values()) {
    p.alive = false;
    p.cells = [];
  }
  pushLobby();
}

function maybeStartRound() {
  if (round.phase !== PHASE_LOBBY) return;
  if (readyCount() < LOBBY_MIN) return;
  startRound();
}

function startRound() {
  round.number++;
  round.phase = PHASE_LIVE;
  round.endsAt = world.time + ROUND_SECONDS;
  resetArena(world);

  // Only players who marked themselves ready take the field. Anyone who
  // connected without readying waits for the next one.
  for (const meta of clients.values()) {
    meta.spectateId = null;
    const player = world.players.get(meta.id);
    if (!player) continue;
    if (meta.ready) spawnPlayer(world, player);
    else { player.alive = false; player.cells = []; }
  }

  if (botTarget() > 0) fillBots(world, botTarget());
  lastEater.clear();
  broadcast({ type: "round_start", number: round.number, seconds: ROUND_SECONDS });
  console.log(`round ${round.number} started with ${readyCount()} player(s)`);
}

// ── tick ────────────────────────────────────────────────────────────────────

let lastTick = process.hrtime.bigint();

// Rolling tick cost, exposed on /health. A server that cannot hold its tick
// feels exactly like bad netcode from the player's side, so it needs to be
// possible to tell the two apart without guessing.
const tickCost = { avgMs: 0, worstMs: 0, behind: 0 };

setInterval(() => {
  const tickStart = process.hrtime.bigint();
  const now = tickStart;
  // Measured elapsed time, not the nominal interval, so a busy event loop
  // slows the tick rather than silently changing game speed.
  const dt = Math.min(Number(now - lastTick) / 1e9, 0.25);
  lastTick = now;

  const events = stepWorld(world, dt);

  if (round.phase === PHASE_LIVE && world.time >= round.endsAt) {
    // Not awaited: settlement talks to the database and the tick must not
    // block on it. The phase flips synchronously, so this cannot run twice.
    endRound().catch(err => console.error("endRound:", err.message));
  } else if (round.phase === PHASE_INTERMISSION && world.time >= round.endsAt) {
    toLobby();
  }
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
      fillBots(world, botTarget());
    }
  }

  for (const [ws, meta] of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const player = world.players.get(meta.id);
    if (!player) continue;

    // Deltas are computed against meta.state, which lives here on the server.
    // The client never tells us what it already knows, so it cannot lie about
    // it to widen its own view.
    refreshSpectate(meta);
    const eye = meta.spectateId ? world.players.get(meta.spectateId) : null;
    ws.send(encodeSnapshot(world, player, meta.state, roundView(), eye));
  }

  const cost = Number(process.hrtime.bigint() - tickStart) / 1e6;
  tickCost.avgMs = tickCost.avgMs * 0.95 + cost * 0.05;
  tickCost.worstMs = Math.max(tickCost.worstMs * 0.999, cost);
  if (cost > 1000 / TICK_HZ) tickCost.behind++;
}, 1000 / TICK_HZ);

// The mass readout is display-only, but if it is ever mistaken for a payout
// rate the exposure is enormous. Say so loudly at startup rather than letting
// someone discover it from their balance sheet.
if (MICRO_PER_MASS > 0) {
  const spawnValue = valueOfMass(20);
  const roundNotional = valueOfMass(400) * LOBBY_MIN;
  const roundStaked = UNIT * LOBBY_MIN;
  console.log(
    // 4 decimals: at 0.005 the default 2dp display rounds to "0.00".
    `  mass    : displayed at ${formatUsdc(MICRO_PER_MASS, 4)} USDC/point ` +
    `(spawn shows ${formatUsdc(spawnValue)}, display only)`
  );
  if (REAL_MONEY && roundNotional > roundStaked) {
    console.warn(
      `  WARNING : a full round would show ~${formatUsdc(roundNotional)} USDC of mass ` +
      `against ${formatUsdc(roundStaked)} USDC staked. The readout is indicative; ` +
      `never settle against it.`
    );
  }
}

server.listen(PORT, () => {
  console.log(`Petri server on port ${PORT}`);
  console.log(`  online  : http://localhost:${PORT}/?mode=online   <- accounts + live play`);
  console.log(`  offline : http://localhost:${PORT}/                 guest, bots, no accounts`);
  console.log(`  origins : ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "any (set ALLOWED_ORIGINS in production)"}`);
  console.log(`  mode    : live PvP, ${ROUND_SECONDS}s rounds, ${BOTS} bots`);
  console.log(`  lobby   : starts at ${LOBBY_MIN} ready, capacity ${LOBBY_MAX}`);
  if (TEST_MODE) {
    console.log("  TEST MODE: demo credits only, solo start, bot-filled arena");
  }
});
