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
  PHASE_LIVE, PHASE_INTERMISSION, PHASE_LOBBY, PROTOCOL_VERSION
} from "../shared/protocol.js";
import { isValidStake, PRACTICE, MICRO_PER_MASS, formatUsdc, valueOfMass, UNIT }
  from "../shared/wager.js";
import { MODES } from "../shared/modes.js";
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
// Bots per room in test mode. Unset, each room fills to its own lobby size —
// 100 for Standard, 50 for High stakes — so a solo test sees the board the
// mode is actually designed around. Set BOTS to override both.
const BOTS_OVERRIDE = process.env.BOTS !== undefined ? Number(process.env.BOTS) : null;

// Server tick rate. 20Hz is the safe default; 30Hz roughly halves the
// world-update latency at 1.5x the CPU and bandwidth. Worth raising once
// /health shows the tick has headroom.
const HZ = Math.max(10, Math.min(60, envInt("TICK_HZ", TICK_HZ)));

// Rounds. Ten minutes of play, then a short intermission showing standings.
const INTERMISSION_SECONDS = envInt("INTERMISSION_SECONDS", TEST_MODE ? 8 : 15);

// Lobby. A round starts only once this many players have marked themselves
// ready, and the server refuses connections past the maximum.
//
// READ THIS BEFORE DEPLOYING: with LOBBY_MIN at 100, nothing starts until a
// hundred real people are in the lobby at the same moment. On a new game that
// is never, so set LOBBY_MIN=2 while testing or you will stare at a lobby
// forever. It is an environment variable for exactly that reason.
// Per-mode defaults live in shared/modes.js. These override every room, which
// is what makes a full round reachable while testing.
const LOBBY_MIN_OVERRIDE = process.env.LOBBY_MIN !== undefined
  ? Number(process.env.LOBBY_MIN) : null;
const ROUND_SECONDS_OVERRIDE = process.env.ROUND_SECONDS !== undefined
  ? Number(process.env.ROUND_SECONDS) : null;

// Only the top finishers are paid. There is no voluntary cash-out, so the
// only way to realise a pot is to still be alive AND placed when the whistle
// goes. Everyone else loses what they staked.
const PAID_OVERRIDE = process.env.PAID_POSITIONS !== undefined
  ? Number(process.env.PAID_POSITIONS) : null;
// Connections per IP. Three was too tight for ordinary use: a page refresh
// leaves the old socket registered until the server notices it has gone, so
// the reload was rejected at the handshake and the client retried its way
// through the whole backoff before getting in. Households and offices also
// share one address behind NAT.
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 8;
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

// Google OAuth client id. Not a secret — it is public in every page that uses
// one. Unset simply hides the button.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

// Message budgets. A well-behaved client sends aim at 20Hz plus the occasional
// action, so these are generous; they exist to stop floods, not to police play.
const LIMITS = {
  message: 80,   // per second, any type
  action: 12     // per second, split / eject / respawn
};

// Binary gameplay frames are 5 bytes; the only text frame is the join, which
// carries a 16-character name. 128 is generous and rejects floods earlier.
// Largest client frame we will accept. Gameplay messages are tiny — aim is 5
// bytes, an action is 2 — but the join frame carries a 64-character session
// token plus a display name of up to 16, and at 128 it did not fit: a join
// measured 138 bytes and the server closed the socket the moment a player
// tried to enter. Anyone with a long display name could never connect at all.
//
// 512 is still small enough to be useless to an attacker and leaves room for
// the join frame to grow without silently breaking connections again.
const MAX_PAYLOAD = 512;
// How long your cells stay in the arena after you vanish, motionless and
// edible. Also the window in which a reconnect gets them back.
const LINGER_SEC = envInt("LINGER_SEC", 6);

// ── static files ────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  // Without these the logo and favicon are served as octet-stream, which
  // browsers will usually render in an <img> but will not accept as an icon.
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, {
      accounts, backend, ramp, url, ip: ipOf(req), googleClientId: GOOGLE_CLIENT_ID
    });
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      players: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0),
      // startsAt and test are here so a deployment can be diagnosed from a
      // browser: "nothing happens when I press ready" is almost always a
      // lobby minimum of 100 on a server nobody set TEST_MODE on.
      test: TEST_MODE,
      rooms: [...rooms.values()].map(r => ({
        mode: r.mode.id,
        players: r.clients.size,
        ready: readyCount(r),
        startsAt: r.lobbyMin,
        phase: ["", "live", "intermission", "lobby"][r.round.phase] || r.round.phase,
        round: r.round.number,
        arena: r.world.size,
        botTarget: r.bots,
        // Everything in the world: humans plus however many bots are
        // currently standing in for the rest of the lobby.
        inWorld: r.world.players.size,
        // Bodies whose owner dropped, still standing and still edible. A
        // number that does not come back down is a reconnect that failed to
        // reclaim its own run.
        lingering: r.lingering.length
      })),
      demo: !ramp.isReal,
      storage: DATABASE_URL ? "postgres" : "memory",
      tick: {
        hz: HZ,
        budgetMs: +(1000 / HZ).toFixed(1),
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

  // Cache headers matter more here than they look. The client and server share
  // a binary wire format, so a browser holding yesterday's protocol.js while
  // the server runs today's decodes every snapshot out of alignment: cells at
  // garbage positions, orbs that never appear. With no headers at all browsers
  // cache heuristically, which is exactly how that happens.
  //
  // Code revalidates on every load; a 304 is a few hundred bytes. Images and
  // fonts, which are not part of any contract, can be held for a day.
  fs.stat(file, (statErr, st) => {
    if (statErr) { res.writeHead(404).end("Not found"); return; }
    const ext = path.extname(file);
    const etag = `W/"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
    const immutableish = ext === ".png" || ext === ".webp" || ext === ".ico" || ext === ".woff2";

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag }).end();
      return;
    }

    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": immutableish ? "public, max-age=86400" : "no-cache",
        ETag: etag
      });
      res.end(body);
    });
  });
});

// ── room ────────────────────────────────────────────────────────────────────

// ── storage, money and identity ─────────────────────────────────────────────
//
// Shared by every room: a player's balance and account follow them between
// modes, while worlds, lobbies and rounds do not.

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

async function pushAccount(ws, meta) {
  if (ws.readyState !== ws.OPEN || !meta.accountId) return;
  const snap = await backend.snapshot(meta.accountId);
  if (ws.readyState !== ws.OPEN) return;
  // `pot` is the escrow, which grows when this player takes someone else's.
  // `stake` is only ever what they put in themselves — that is what the HUD
  // shows, so the figure never moves during a round.
  ws.send(JSON.stringify({
    type: "account", demo: !ramp.isReal, stake: meta.stake, ...snap
  }));
}

const connectionsByIp = new Map();

// ── rooms ───────────────────────────────────────────────────────────────────
//
// One room per game mode, each fully independent: its own world, arena size,
// lobby, round clock, bots and connected clients. Nothing is shared but the
// ledger and the account store, because a player's balance follows them
// between rooms while nothing else should.
//
// Everything below that used to be module-level state now lives on a room,
// which is what makes two concurrent games possible at all.

function createRoom(mode) {
  const world = createWorld(Date.now() & 0xffffffff, mode.world);
  const room = {
    mode,
    world,
    clients: new Map(),          // ws -> meta
    lastEater: new Map(),        // victim id -> killer id, for settlement
    lingering: [],               // players whose socket dropped
    round: { number: 0, phase: PHASE_LOBBY, endsAt: Infinity },
    // Test mode fills the room to the size the mode is built for, so a solo
    // test is representative rather than an empty field.
    bots: TEST_MODE ? Math.min(BOTS_OVERRIDE ?? mode.lobbyMin, mode.lobbyMax - 1) : 0,
    lobbyMin: TEST_MODE ? 1 : (LOBBY_MIN_OVERRIDE ?? mode.lobbyMin),
    lobbyMax: mode.lobbyMax,
    roundSeconds: ROUND_SECONDS_OVERRIDE ?? (TEST_MODE ? 120 : mode.roundSeconds),
    paidPositions: PAID_OVERRIDE ?? mode.paidPositions
  };
  // Deliberately NOT populated here. An empty room costs a tick either way;
  // simulating a hundred bots in a room nobody is in is pure waste, and with
  // two rooms it doubled the server's load for no one's benefit.
  return room;
}

const rooms = new Map(MODES.map(m => [m.id, createRoom(m)]));
const roomForStake = stake => [...rooms.values()].find(r => r.mode.stake === stake) || null;

// One live connection per account. Without this a second join escrowed
// another stake on top of the first, so the "at risk" figure climbed 1.00 ->
// 2.00 -> 3.00 while the player believed they had staked once. Reconnecting
// after a dropped socket, or pressing Start again, was enough to trigger it.
//
// The newer connection wins: a player who refreshes must not be locked out of
// their own game.
function evictExistingConnection(accountId) {
  for (const room of rooms.values()) {
    for (const [ws, meta] of room.clients) {
      if (meta.accountId !== accountId) continue;
      // The close handler must not treat this as a player walking away: that
      // would linger the cell and later refund an escrow we are about to
      // reconcile ourselves.
      meta.replaced = true;
      meta.stake = PRACTICE;
      room.clients.delete(ws);
      removePlayer(room.world, meta.id);
      room.lastEater.delete(meta.id);
      try { ws.close(4001, "Replaced by a newer connection"); } catch { /* already gone */ }
      pushLobby(room);
      return true;
    }
  }
  return false;
}

// Picking your own body back up after a dropped socket.
//
// A reconnect used to cost the run even when it took 200ms: the old player was
// deleted and a new one spawned at starting mass, while the body you had spent
// the round growing sat lingering in the arena for somebody else to eat. The
// escrow went round the houses too — refunded, then locked again — for a stake
// that had never stopped being at risk.
//
// So if the account that just joined is one of this room's lingering players,
// and its cells are still standing, hand them back. The player object is the
// same object: mass, cells, score and nid all continue. Only the connection id
// changes, because ids are per-socket.
//
// This is not an escape hatch. The body was motionless and edible for the
// whole outage, so anyone who caught it kept the kill; all this changes is
// what happens when nobody did.

// Step one: take this account off the lingering list, wherever it is, and say
// what was left behind. Claiming MUST happen on every rejoin, resumed or not.
//
// The sweep below refunds a lingering entry when its timer runs out, and it
// refunds whatever is in escrow AT THAT MOMENT — which, after a rejoin, is the
// stake for the run now being played. So a player who reconnected within the
// linger window had their live stake handed back a few seconds later and
// carried on with nothing at risk. Rejoining on a different tier did it too,
// because the stale entry sat in the room they left.
function claimLingering(accountId) {
  if (!accountId) return null;
  for (const room of rooms.values()) {
    const i = room.lingering.findIndex(l => l.accountId === accountId);
    if (i === -1) continue;
    const { id: oldId } = room.lingering[i];
    room.lingering.splice(i, 1);
    return { room, oldId, player: room.world.players.get(oldId) || null };
  }
  return null;
}

// Step two: move a claimed body onto the new connection, or clear it away if
// it cannot be resumed. Returns the player to carry on as, or null to join
// from scratch.
function resumeLingering(claim, room, newId) {
  if (!claim) return null;

  const { room: oldRoom, oldId, player } = claim;
  const usable =
    oldRoom === room &&                     // same tier; a switch is a new run
    room.round.phase === PHASE_LIVE &&      // nothing to come back to otherwise
    player && player.alive && player.cells.length;

  if (!usable) {
    // Eaten while away, a tier change, or the round moved on. Clear the old
    // body out now rather than leaving it for a sweep that no longer owns it.
    if (player) {
      removePlayer(oldRoom.world, oldId);
      oldRoom.lastEater.delete(oldId);
      syncBots(oldRoom);
    }
    return null;
  }

  room.world.players.delete(oldId);
  player.id = newId;
  room.world.players.set(newId, player);

  // lastEater holds player ids on both sides: whoever bit us, and whoever we
  // bit. Leaving the old id behind would misdirect a settlement.
  const biter = room.lastEater.get(oldId);
  if (biter !== undefined) {
    room.lastEater.delete(oldId);
    room.lastEater.set(newId, biter);
  }
  for (const [victim, killer] of room.lastEater) {
    if (killer === oldId) room.lastEater.set(victim, newId);
  }

  // Anyone spectating this body is still watching the same player, so follow
  // it to its new id rather than bumping their camera on to the next cell.
  for (const other of room.clients.values()) {
    if (other.spectateId === oldId) other.spectateId = newId;
  }
  return player;
}

const readyCount = room => {
  let n = 0;
  for (const meta of room.clients.values()) if (meta.ready) n++;
  return n;
};

function lobbyState(room) {
  return {
    type: "lobby",
    mode: room.mode.id,
    ready: readyCount(room),
    connected: room.clients.size,
    min: room.lobbyMin,
    max: room.lobbyMax,
    phase: room.round.phase,
    test: TEST_MODE
  };
}

function broadcast(room, payload) {
  const text = JSON.stringify(payload);
  for (const [ws] of room.clients) {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

const pushLobby = room => broadcast(room, lobbyState(room));

const roundView = room => ({
  phase: room.round.phase,
  remaining: room.round.endsAt === Infinity
    ? 0
    : Math.max(0, room.round.endsAt - room.world.time),
  number: room.round.number
});

// Bots exist for the benefit of players in the room. No players, no bots.
const botTarget = room => (TEST_MODE && room.clients.size > 0 ? room.bots : 0);

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
  // Snapshots are ~500 bytes of already-compact binary. Negotiating
  // permessage-deflate would spend CPU and add framing latency on every one
  // of them for almost no saving.
  perMessageDeflate: false,
  // WebSockets are not covered by the browser's same-origin policy, so if you
  // care where connections come from you have to check it yourself.
  verifyClient(info, done) {
    if (!originAllowed(info.req)) return done(false, 403, "Forbidden origin");
    const ip = ipOf(info.req);
    if ((connectionsByIp.get(ip) || 0) >= MAX_CONN_PER_IP) {
      console.warn(`refused ${ip}: ${connectionsByIp.get(ip)} connections already`);
      return done(false, 429, "Too many connections");
    }
    done(true);
  }
});

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

const accountOfPlayer = (room, id) => {
  for (const meta of room.clients.values()) if (meta.id === id) return meta;
  return null;
};

// Money moves only in response to simulation events, never in response to
// anything a client asserts.
async function settle(room, events) {
  for (const e of events) {
    if (e.t === "eat") room.lastEater.set(e.victim, e.id);
  }

  for (const e of events) {
    if (e.t !== "death") continue;
    const victim = accountOfPlayer(room, e.id);
    const killerId = room.lastEater.get(e.id);
    room.lastEater.delete(e.id);

    if (!victim || !victim.accountId) continue;

    const killer = killerId ? accountOfPlayer(room, killerId) : null;
    const killerStaked = killer && killer.accountId && killer.stake !== PRACTICE;
    const wasStaked = victim.stake !== PRACTICE;

    // Clear the stake before awaiting, so a second death event for the same
    // player cannot settle the same pot twice while the first is in flight.
    const stake = victim.stake;
    victim.stake = PRACTICE;

    recordRun(victim, e, {
      outcome: killer ? "eaten" : "bot",
      killerId: killer?.accountId || null,
      stake: wasStaked ? stake : 0,
      payout: 0
    });

    if (!wasStaked) continue;

    try {
      if (killerStaked) {
        await backend.claim(killer.accountId, victim.accountId);
      } else {
        // Killed by a bot, or by someone with nothing at risk. Nobody won it.
        await backend.forfeit(victim.accountId);
      }
      for (const [ws, meta] of room.clients) {
        if (meta === killer || meta === victim) await pushAccount(ws, meta);
      }
    } catch (err) {
      console.error("settlement failed:", err.message);
    }
  }
}

// ── spectating ──────────────────────────────────────────────────────────────

const aliveTargets = room =>
  [...room.world.players.values()].filter(p => p.alive && p.cells.length);

// Cycle to the next living player, sorted by mass so the order is stable.
function cycleSpectate(room, meta, dir) {
  const targets = aliveTargets(room).sort((a, b) => totalMass(b) - totalMass(a));
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

// The player being watched can be eaten at any moment, and a spectator
// staring at a corpse sees nothing.
function refreshSpectate(room, meta) {
  if (!meta.spectateId) return;
  const target = room.world.players.get(meta.spectateId);
  if (!target || !target.alive || !target.cells.length) cycleSpectate(room, meta, "next");
}

// ── rounds ──────────────────────────────────────────────────────────────────

// Time is up. Survivors are ranked by mass; the top paidPositions realise
// their pot and everyone else forfeits. Surviving is necessary but not
// sufficient — you have to place.
async function endRound(room) {
  const { world, round, mode } = room;
  round.phase = PHASE_INTERMISSION;
  round.endsAt = world.time + INTERMISSION_SECONDS;

  const survivors = aliveTargets(room).sort((a, b) => totalMass(b) - totalMass(a));

  broadcast(room, {
    type: "round_end",
    mode: mode.id,
    number: round.number,
    standings: survivors.map((p, i) => ({
      name: p.name,
      mass: Math.round(totalMass(p)),
      position: i + 1,
      paid: i + 1 <= room.paidPositions
    })),
    paidPositions: room.paidPositions,
    nextIn: INTERMISSION_SECONDS
  });

  for (const [ws, meta] of room.clients) {
    const player = world.players.get(meta.id);
    if (!player || !player.alive) continue;

    const position = survivors.indexOf(player) + 1;
    const stake = meta.stake;
    meta.stake = PRACTICE;

    const placed = position > 0 && position <= room.paidPositions;
    let payout = 0;
    try {
      if (stake > PRACTICE && meta.accountId) {
        if (placed) {
          ({ paid: payout } = await backend.cashOut(meta.accountId, RAKE_BPS));
        } else {
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
function toLobby(room) {
  room.round.phase = PHASE_LOBBY;
  room.round.endsAt = Infinity;
  // Readiness is NOT cleared. Anyone who opted in while the standings were up
  // stays in, so a full lobby rolls straight into the next round.
  for (const p of room.world.players.values()) {
    p.alive = false;
    p.cells = [];
  }
  pushLobby(room);
}

function maybeStartRound(room) {
  if (room.round.phase !== PHASE_LOBBY) return;
  if (readyCount(room) < room.lobbyMin) return;
  if (room.starting) return;           // re-staking is async; do not race it
  room.starting = true;
  startRound(room)
    .catch(err => console.error("startRound:", err.message))
    .finally(() => { room.starting = false; });
}

async function startRound(room) {
  const { world, round } = room;

  // Re-escrow before anyone is spawned. The previous round's stake was settled
  // at its end, so without this a player carried on into round two with
  // nothing at risk — playing a paid room for free.
  for (const [ws, meta] of room.clients) {
    if (!meta.ready || !meta.accountId) continue;
    if (meta.stake > PRACTICE || !meta.tier || meta.tier === PRACTICE) continue;
    try {
      await backend.lockStake(meta.accountId, meta.tier);
      meta.stake = meta.tier;
    } catch (err) {
      // Out of funds: sit this one out rather than playing for free.
      meta.ready = false;
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: "account_error", code: "funds",
          reason: "Not enough balance for another round at that stake."
        }));
      }
      if (!(err instanceof InsufficientFunds) && err.code !== "23514") {
        console.error("re-stake:", err.message);
      }
    }
    await pushAccount(ws, meta);
  }

  // Everyone who could not pay has been un-readied, so check again.
  if (readyCount(room) < room.lobbyMin && round.phase !== PHASE_INTERMISSION) {
    pushLobby(room);
    return;
  }

  round.number++;
  round.phase = PHASE_LIVE;
  round.endsAt = world.time + room.roundSeconds;
  resetArena(world);

  // Only players who marked themselves ready take the field.
  for (const meta of room.clients.values()) {
    meta.spectateId = null;
    const player = world.players.get(meta.id);
    if (!player) continue;
    if (meta.ready) spawnPlayer(world, player);
    else { player.alive = false; player.cells = []; }
  }

  syncBots(room);
  room.lastEater.clear();
  broadcast(room, {
    type: "round_start", mode: room.mode.id,
    number: round.number, seconds: room.roundSeconds
  });
  console.log(`[${room.mode.id}] round ${round.number} started with ${readyCount(room)} player(s)`);
}

// Bring the bot population to whatever this room should currently have,
// in either direction. Called when someone joins or leaves.
function syncBots(room) {
  const target = botTarget(room);
  const bots = [...room.world.players.values()].filter(p => p.bot);
  if (bots.length > target) {
    for (let i = 0; i < bots.length - target; i++) removePlayer(room.world, bots[i].id);
  } else if (bots.length < target) {
    fillBots(room.world, target);
  }
}

// ── connections ─────────────────────────────────────────────────────────────

wss.on("connection", (ws, req) => {
  // Nagle's algorithm buffers small writes waiting for more data, which is
  // exactly wrong for a stream of tiny time-critical frames. Node leaves it on.
  try { req.socket.setNoDelay(true); } catch { /* not a TCP socket */ }

  const ip = ipOf(req);
  connectionsByIp.set(ip, (connectionsByIp.get(ip) || 0) + 1);

  const id = `p:${nextClientId++}`;
  const meta = {
    id, ip, joined: false, state: null,
    room: null,        // set on join; a client belongs to exactly one room
    accountId: null,   // uuid once signed in
    joining: false,
    ready: false,
    spectateId: null,
    stake: PRACTICE,
    msgBucket: makeBucket(LIMITS.message),
    actBucket: makeBucket(LIMITS.action),
    alive: true
  };

  ws.on("pong", () => { meta.alive = true; });

  ws.on("message", async (raw, isBinary) => {
    if (!allow(meta.msgBucket)) { ws.close(1008, "Rate limit"); return; }

    // Text frames are control messages: join once, then money and lobby verbs.
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg) return;

      if (meta.joined) {
        const room = meta.room;
        if (msg.type === "ping") {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              type: "pong", t: msg.t, srvMs: +tickCost.avgMs.toFixed(2), hz: HZ
            }));
          }
        } else if (msg.type === "spectate") {
          const self = room.world.players.get(id);
          // Only the dead spectate; watching while alive is a second camera.
          if (self && self.alive) return;
          if (msg.dir === "off") meta.spectateId = null;
          else cycleSpectate(room, meta, msg.dir === "prev" ? "prev" : "next");
        } else if (msg.type === "ready") {
          // Also accepted during the intermission: deciding while the
          // standings are still on screen means the next round can start the
          // moment the clock runs out, instead of everyone being dropped into
          // a lobby and asked again.
          if (room.round.phase === PHASE_LIVE) return;
          meta.ready = msg.ready !== false;
          pushLobby(room);
          maybeStartRound(room);
        } else if (msg.type === "rename") {
          if (!meta.accountId) return;
          const fresh = await backend.getAccount(meta.accountId);
          const player = room.world.players.get(id);
          if (fresh && player) player.name = fresh.displayName;
        } else if (msg.type === "ramp") {
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

      // A stale client cannot be allowed to connect: it shares a binary wire
      // format with us, and a mismatch corrupts every frame silently. Tell it
      // to reload rather than letting it play a garbled game.
      if (msg.protocol !== PROTOCOL_VERSION) {
        meta.joining = false;
        ws.send(JSON.stringify({
          type: "account_error", code: "stale",
          reason: "This page is out of date. Reload to get the latest version."
        }));
        ws.close(1008, "Protocol mismatch");
        return;
      }

      const stake = Number(msg.stake) || PRACTICE;
      if (!isValidStake(stake) || stake === PRACTICE) {
        meta.joining = false;
        ws.close(1008, "Bad stake");
        return;
      }

      // The stake chooses the room. There is exactly one room per stake, so a
      // client cannot ask for a 2 USDC seat and pay 1.
      const room = roomForStake(stake);
      if (!room) { meta.joining = false; ws.close(1008, "No such mode"); return; }

      // Identity comes from the session token, never from anything else the
      // client says. Guests play locally against bots and never reach here.
      //
      // "No such session" and "the lookup failed" are different answers and
      // must not be collapsed. Swallowing the second into the first told a
      // signed-in player to sign in whenever the database hiccuped — and
      // because that refusal is final, the client did not even retry.
      let authed = null;
      try {
        authed = await accounts.resolveSession(msg.token);
      } catch (err) {
        console.error("session lookup failed:", err.message);
        meta.joining = false;
        ws.send(JSON.stringify({
          type: "account_error", code: "retry",
          reason: "The server could not check your session. Retrying."
        }));
        // 1011 is a server fault, which the client treats as retryable.
        ws.close(1011, "Session lookup failed");
        return;
      }
      if (!authed) {
        meta.joining = false;
        ws.send(JSON.stringify({
          type: "account_error", code: "auth",
          reason: "Sign in to play against other people. Guests play against bots."
        }));
        ws.close(1008, "Sign in required");
        return;
      }

      if (room.clients.size >= room.lobbyMax) {
        meta.joining = false;
        ws.send(JSON.stringify({
          type: "account_error",
          code: "full",
          reason: `${room.mode.label} is full (${room.lobbyMax} players). Try the other mode.`
        }));
        ws.close(1013, "Room full");
        return;
      }

      meta.accountId = authed.id;
      const displayName = authed.displayName;
      if (!ramp.isReal) await ramp.grant(meta.accountId);

      // Drop any earlier connection for this account, then return whatever it
      // left in escrow. Only after that is the new stake locked, so the pot is
      // always exactly the stake the player chose — never a sum of attempts.
      evictExistingConnection(meta.accountId);

      // A resumed run is already paid for. Its stake never left escrow, so
      // refunding and re-locking it would be two database round trips spent
      // to arrive back where we started — and two round trips is most of how
      // long a reconnect takes.
      const claim = claimLingering(meta.accountId);
      const resumed = resumeLingering(claim, room, id);

      if (!resumed) {
        try {
          const before = await backend.snapshot(meta.accountId);
          if (before.pot > 0) await backend.refund(meta.accountId);
        } catch (err) {
          console.error("clearing stale escrow:", err.message);
        }
      }

      try {
        if (!resumed) await backend.lockStake(meta.accountId, stake);
      } catch (err) {
        meta.joining = false;
        // Postgres raises a check-constraint violation (23514) when the
        // balance would go negative; the memory backend throws its own type.
        if (err instanceof InsufficientFunds || err.code === "23514") {
          ws.send(JSON.stringify({
            type: "account_error", code: "funds",
            reason: "Not enough balance for that stake."
          }));
          ws.close(1008, "Insufficient funds");
          return;
        }
        throw err;
      }

      meta.joined = true;
      meta.joining = false;
      meta.room = room;
      meta.stake = stake;
      // The tier they chose, kept for the life of the connection. meta.stake
      // is only the CURRENT round's escrow and is cleared at settlement, so
      // without this a player carried on into round two staking nothing.
      meta.tier = stake;

      const player = resumed || addPlayer(room.world, { id, name: displayName });
      // A rename can land while the socket is down.
      if (resumed) player.name = displayName;
      meta.state = createClientState(nextClientId);   // staggers keyframes
      // The run never stopped, so the player is already in it rather than
      // waiting to be let in.
      meta.ready = !!resumed;
      room.clients.set(ws, meta);
      syncBots(room);
      pushLobby(room);

      // Arrivals wait in the lobby rather than dropping into a live round.
      if (!resumed && room.round.phase !== PHASE_LIVE) {
        player.alive = false;
        player.cells = [];
      }

      ws.send(JSON.stringify({
        type: MSG.WELCOME, id, nid: player.nid, tickHz: HZ,
        mode: room.mode.id,
        modeLabel: room.mode.label,
        round: room.round.number,
        roundSeconds: room.roundSeconds,
        lobbyMin: room.lobbyMin,
        lobbyMax: room.lobbyMax,
        test: TEST_MODE,
        demo: !ramp.isReal,
        stake,
        signedIn: true,
        displayName,
        ...(await backend.snapshot(meta.accountId))
      }));
      return;
    }

    if (!meta.joined) return;

    // Binary gameplay. decodeClientMessage bounds-checks every field and
    // throws on anything malformed.
    let msg;
    try {
      msg = decodeClientMessage(raw);
    } catch {
      ws.close(1002, "Protocol error");
      return;
    }

    if (msg.type === MSG.AIM) {
      setAim(meta.room.world, id, msg.x, msg.y);
    } else if (msg.type === MSG.ACTION) {
      if (!allow(meta.actBucket)) return;
      if (msg.action === "respawn") meta.spectateId = null;
      queueAction(meta.room.world, id, msg.action);
    }
  });

  const cleanup = () => {
    const room = meta.room;
    if (room) room.clients.delete(ws);
    const n = (connectionsByIp.get(ip) || 1) - 1;
    if (n <= 0) connectionsByIp.delete(ip); else connectionsByIp.set(ip, n);

    // A replaced connection has already been reconciled by the join that
    // replaced it; lingering here would refund a stake that is now live.
    if (meta.joined && room && !meta.replaced) {
      pushLobby(room);
      syncBots(room);
      // Do not delete the player immediately. Vanishing on demand is a free
      // escape from any losing fight, so cells linger, motionless and edible.
      setAim(room.world, id, 0, 0);
      room.lingering.push({
        id, until: room.world.time + LINGER_SEC,
        accountId: meta.stake === PRACTICE ? null : meta.accountId
      });
    }
  };

  ws.on("close", cleanup);
  ws.on("error", () => { try { ws.close(); } catch {} });
});

// Ping every 30s; anything that misses two rounds is gone.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const [ws, meta] of room.clients) {
      if (!meta.alive) { ws.terminate(); continue; }
      meta.alive = false;
      try { ws.ping(); } catch {}
    }
  }
}, 30000);

// ── tick ────────────────────────────────────────────────────────────────────

let lastTick = process.hrtime.bigint();

// Rolling tick cost across all rooms, exposed on /health. A server that cannot
// hold its tick feels exactly like bad netcode from the player's side.
const tickCost = { avgMs: 0, worstMs: 0, behind: 0 };

function tickRoom(room, dt) {
  const { world, round } = room;
  const events = stepWorld(world, dt);

  if (round.phase === PHASE_LIVE && world.time >= round.endsAt) {
    // Not awaited: settlement talks to the database and the tick must not
    // block on it. The phase flips synchronously, so this cannot run twice.
    endRound(room).catch(err => console.error("endRound:", err.message));
  } else if (round.phase === PHASE_INTERMISSION && world.time >= round.endsAt) {
    toLobby(room);
    // Anyone who opted in while the standings were up is already ready, so
    // the next round can begin immediately rather than waiting to be asked.
    maybeStartRound(room);
  }

  if (events.length) {
    settle(room, events.slice()).catch(err => console.error("settle:", err.message));
  }

  for (let i = room.lingering.length - 1; i >= 0; i--) {
    if (world.time >= room.lingering[i].until) {
      const { id: goneId, accountId } = room.lingering[i];
      // Survived the linger window unclaimed, so the run is void rather than
      // lost. Refunding is the only defensible outcome: nobody beat them.
      if (accountId) {
        backend.refund(accountId).catch(err => console.error("refund:", err.message));
      }
      removePlayer(world, goneId);
      room.lastEater.delete(goneId);
      room.lingering.splice(i, 1);
      syncBots(room);
    }
  }

  const view = roundView(room);
  for (const [ws, meta] of room.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const player = world.players.get(meta.id);
    if (!player) continue;

    refreshSpectate(room, meta);
    const eye = meta.spectateId ? world.players.get(meta.spectateId) : null;
    ws.send(encodeSnapshot(world, player, meta.state, view, eye));
  }
}

function tick() {
  const tickStart = process.hrtime.bigint();
  // Measured elapsed time, not the nominal interval, so a busy event loop
  // slows the tick rather than silently changing game speed.
  const dt = Math.min(Number(tickStart - lastTick) / 1e9, 0.25);
  lastTick = tickStart;

  for (const room of rooms.values()) tickRoom(room, dt);

  const cost = Number(process.hrtime.bigint() - tickStart) / 1e6;
  tickCost.avgMs = tickCost.avgMs * 0.95 + cost * 0.05;
  tickCost.worstMs = Math.max(tickCost.worstMs * 0.999, cost);
  if (cost > 1000 / HZ) tickCost.behind++;
}

// setInterval drifts. A tick that overruns pushes the next one late, the error
// accumulates, and the effective rate quietly drops below HZ — which players
// feel as lag even though nothing in the netcode changed.
const TICK_MS = 1000 / HZ;
let nextTickAt = Date.now();

function scheduleTick() {
  nextTickAt += TICK_MS;
  const drift = Date.now() - nextTickAt;
  if (drift > 500) nextTickAt = Date.now();
  setTimeout(() => { tick(); scheduleTick();

// A tick that consistently overruns is the difference between a game that
// feels right and one that does not, and it is invisible from the outside —
// it shows up as players blaming their connection. Say so in the log.
let lastOverruns = 0;
setInterval(() => {
  const since = tickCost.behind - lastOverruns;
  lastOverruns = tickCost.behind;
  const budget = 1000 / HZ;
  if (since > HZ * 2) {           // more than ~3% of the last minute's ticks
    console.warn(
      `  SLOW    : ${since} of ~${HZ * 60} ticks overran their ${budget.toFixed(1)}ms budget ` +
      `in the last minute (avg ${tickCost.avgMs.toFixed(1)}ms). ` +
      `Lower TICK_HZ, lower BOTS, or move to a larger instance.`
    );
  }
}, 60_000).unref?.(); }, Math.max(0, nextTickAt - Date.now()));
}

scheduleTick();

// A tick that consistently overruns is the difference between a game that
// feels right and one that does not, and it is invisible from the outside —
// it shows up as players blaming their connection. Say so in the log.
let lastOverruns = 0;
setInterval(() => {
  const since = tickCost.behind - lastOverruns;
  lastOverruns = tickCost.behind;
  const budget = 1000 / HZ;
  if (since > HZ * 2) {           // more than ~3% of the last minute's ticks
    console.warn(
      `  SLOW    : ${since} of ~${HZ * 60} ticks overran their ${budget.toFixed(1)}ms budget ` +
      `in the last minute (avg ${tickCost.avgMs.toFixed(1)}ms). ` +
      `Lower TICK_HZ, lower BOTS, or move to a larger instance.`
    );
  }
}, 60_000).unref?.();

// The mass readout is display-only, but if it is ever mistaken for a payout
// rate the exposure is enormous. Say so loudly at startup.
if (MICRO_PER_MASS > 0) {
  const spawnValue = valueOfMass(20);
  console.log(
    `  mass    : displayed at ${formatUsdc(MICRO_PER_MASS, 4)} USDC/point ` +
    `(spawn shows ${formatUsdc(spawnValue)}, display only)`
  );
  if (REAL_MONEY) {
    console.warn("  WARNING : the mass readout is indicative; never settle against it.");
  }
}

server.listen(PORT, () => {
  console.log(`Petri server on port ${PORT}`);
  console.log(`  online  : http://localhost:${PORT}/?mode=online   <- accounts + live play`);
  console.log(`  offline : http://localhost:${PORT}/                 guest, bots, no accounts`);
  console.log(`  origins : ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "any (set ALLOWED_ORIGINS in production)"}`);
  console.log(`  tick    : ${HZ}Hz`);
  for (const r of rooms.values()) {
    console.log(
      `  room    : ${r.mode.label.padEnd(12)} stake ${(r.mode.stake / 1e6).toFixed(2)}  ` +
      `starts at ${String(r.lobbyMin).padStart(3)}  cap ${r.lobbyMax}  ` +
      `arena ${r.world.size}  ${r.roundSeconds}s  ${r.bots} bots on demand`
    );
  }
  if (TEST_MODE && BOTS_OVERRIDE !== null) {
    console.warn(
      `  NOTE    : BOTS=${BOTS_OVERRIDE} is overriding the per-mode bot counts ` +
      `(Standard would be ${MODES[0].lobbyMin}, High stakes ${MODES[1].lobbyMin}). ` +
      `Unset BOTS to fill each room to its own size.`
    );
  }
  console.log(`  google  : ${GOOGLE_CLIENT_ID ? "enabled" : "off (set GOOGLE_CLIENT_ID)"}`);
  if (TEST_MODE) {
    console.log("  TEST MODE: demo credits only, solo start, bot-filled arena");
  }
});
