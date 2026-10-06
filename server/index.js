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
//   BOT_DIFFICULTY    easy | normal | hard, default normal (test mode only)
//   ALLOWED_ORIGINS   comma-separated; unset means allow any (dev only)
//   MAX_CONN_PER_IP   default 3
//   TRUST_PROXY       set to 1 behind Render / Fly / a reverse proxy
//   MAX_ROOMS         default 4; rooms open as others fill, up to this many
// ---------------------------------------------------------------------------

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import {
  createWorld, addPlayer, removePlayer, fillBots, resetArena, spawnRing,
  setAim, queueAction, stepWorld, totalMass, TICK_HZ, STAIN_COUNT,
  isBotLevel, BOT_LEVEL_IDS, DEFAULT_BOT_LEVEL
} from "../shared/sim.js";
import {
  encodeSnapshot, decodeClientMessage, createClientState, MSG,
  PHASE_LIVE, PHASE_INTERMISSION, PHASE_LOBBY, PHASE_COUNTDOWN, PROTOCOL_VERSION
} from "../shared/protocol.js";
import { PRACTICE, MICRO_PER_MASS, formatUsdc, valueOfMass, UNIT }
  from "../shared/wager.js";
import { MODES } from "../shared/modes.js";
import { START_RATING, fitsSkill } from "../shared/progress.js";
import { scoreRound } from "./awards.js";
import { createRamp, InsufficientFunds } from "./ledger.js";
import { createStore } from "./store.js";
import { MemoryRepo } from "./db/memory.js";
import { emptyProgress } from "./db/pg.js";
import { Accounts } from "./accounts.js";
import { handleApi } from "./api.js";
import { verifyTicket, verifyRequest, TicketError, assertSecret } from "./ticket.js";
import { createMatchmaker } from "./matchmaker/core.js";
import { answerMatch, createRateLimit } from "./matchmaker/http.js";

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

// How hard those bots play: whether they split to engulf and shoot viruses.
// See BOT_LEVELS in shared/sim.js. This is the level of the rooms the server
// opens at startup, and of any room opened for a player who names none.
// Players who do name one are seated only with others who named the same,
// in a room opened at that level if need be (see seatFor), so nobody's pick
// is imposed on anyone else.
//
// A typo falls back to the default rather than refusing to start. It is a
// test-mode knob, and taking a server down over one is the wrong trade.
const BOT_LEVEL = (() => {
  const want = process.env.BOT_DIFFICULTY;
  if (want === undefined || want === "") return DEFAULT_BOT_LEVEL;
  if (isBotLevel(want)) return want;
  console.warn(
    `BOT_DIFFICULTY=${want} is not one of ${BOT_LEVEL_IDS.join(", ")}; ` +
    `using ${DEFAULT_BOT_LEVEL}.`
  );
  return DEFAULT_BOT_LEVEL;
})();

// Server tick rate. 20Hz is the safe default; 30Hz roughly halves the
// world-update latency at 1.5x the CPU and bandwidth. Worth raising once
// /health shows the tick has headroom.
const HZ = Math.max(10, Math.min(60, envInt("TICK_HZ", TICK_HZ)));

// The gap between the lobby filling and the whistle. Players who have just
// pressed a button are not looking at the arena; dropping them straight into
// it costs them the opening seconds of a round they have paid for.
const COUNTDOWN_SECONDS = envInt("COUNTDOWN_SECONDS", 5);

// How long the finishing positions stay on screen at the whistle before
// everyone is taken to the lobby.
const STANDINGS_SECONDS = envInt("STANDINGS_SECONDS", 5);

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
const LOBBY_MAX_OVERRIDE = process.env.LOBBY_MAX !== undefined
  ? Number(process.env.LOBBY_MAX) : null;
const ROUND_SECONDS_OVERRIDE = process.env.ROUND_SECONDS !== undefined
  ? Number(process.env.ROUND_SECONDS) : null;

// Rooms this process may run at once, across every mode. Each mode always
// keeps one, so this can never be fewer than there are modes; the rest are
// opened when every room of a mode is full and closed again once empty.
//
// One process is one thread, so every room here shares a single core. A full
// 100-player room costs roughly 10ms a tick, so at 30Hz three of them are the
// whole budget. The headroom check in seatFor() is what actually protects the
// tick; this is the ceiling above it.
const MAX_ROOMS = Math.max(MODES.length, envInt("MAX_ROOMS", 4));

// No further room is opened once the tick is already spending this share of
// its budget. Another world would slow every round in the process, including
// the ones people are already playing, so the arrival is turned away instead.
const OPEN_ROOM_BELOW = 0.6;

// Skill matchmaking. A room with people in it accepts ratings within
// SKILL_WINDOW of their mean, and the window grows by SKILL_WIDEN for every
// second its lobby has waited — so a busy server keeps rooms tight, and a
// quiet one, whose lobbies wait a long time to fill, soon takes anybody. A
// live round's window does not grow: nobody joining mid-round plays in it.
// See fitsSkill in shared/progress.js and seatFor below.
const SKILL_WINDOW = Math.max(0, envInt("SKILL_WINDOW", 200));
const SKILL_WIDEN = Math.max(0, envInt("SKILL_WIDEN", 10));

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
// The join now carries a match ticket in place of the session token, and a
// ticket is about 350 bytes. 1024 keeps the same headroom the 512 limit was
// chosen for, and is still far too small to be any use to an attacker.
const MAX_PAYLOAD = 1024;
// How long your cells stay in the arena after you vanish, motionless and
// edible. Also the window in which a reconnect gets them back.
const LINGER_SEC = envInt("LINGER_SEC", 6);

// ── matchmaking ─────────────────────────────────────────────────────────────
//
// Players do not pick a room, or even a server. They ask the matchmaker, which
// reserves a seat on a game server and hands back a signed ticket naming the
// server, room, account and stake; the join presents that ticket and nothing
// else is believed. See server/matchmaker/.
//
// MATCHMAKER=embedded (the default) runs the matchmaker inside this process
// at /api/match, with this server as its only server. That is the one-box
// deployment, and it needs no configuration. MATCHMAKER=external leaves
// matchmaking to the separate service, which this server answers on
// /internal/*; then SERVER_ID and MATCH_SECRET must be set, and must match
// the matchmaker's GAME_SERVERS list and its own secret.
const MATCHMAKER = process.env.MATCHMAKER === "external" ? "external" : "embedded";
if (MATCHMAKER === "external" && !process.env.SERVER_ID) {
  throw new Error("MATCHMAKER=external needs SERVER_ID: the matchmaker's tickets name the server they are for.");
}
const SERVER_ID = process.env.SERVER_ID || "local";
if (SERVER_ID.includes("#")) {
  throw new Error(`SERVER_ID may not contain "#": seat holders are written "<server>#<boot>".`);
}
const REGION = process.env.REGION || "local";
// Where players connect to reach this server, as the matchmaker should tell
// them. Unset means "wherever the page came from", which is right for one box.
const PUBLIC_URL = process.env.PUBLIC_URL || null;
// Shared with the matchmaker in external mode. Embedded, the signer and the
// checker are this one process, so a fresh random secret per boot is enough.
const MATCH_SECRET = (process.env.MATCH_SECRET || MATCHMAKER === "external")
  ? assertSecret(process.env.MATCH_SECRET)
  : crypto.randomBytes(32).toString("hex");
const TICKET_MS = envInt("TICKET_SECONDS", 30) * 1000;

// The seat lease: while this server is responsible for an account — it is
// connected, or its body lingers — the database says so, and no other server
// may touch that account's money. Renewed well inside its lifetime; a server
// that stops renewing loses its players' seats within SEAT_TTL.
//
// The holder carries a per-boot id as well as the server id. Two processes
// with the same SERVER_ID overlap during a deploy, and the new one must not
// take over players the old one is still settling.
const SEAT_TTL_MS = envInt("SEAT_TTL_SECONDS", 30) * 1000;
const SEAT_RENEW_MS = Math.max(250, Math.floor(SEAT_TTL_MS / 3));
const SEAT_HOLDER = `${SERVER_ID}#${crypto.randomBytes(4).toString("hex")}`;

// Set once SIGTERM arrives: no more ticks, reservations or joins. See shutdown().
let shuttingDown = false;

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

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

// The matchmaker's side door: what rooms this server has, and holding a seat
// in one. Both hand out places in paid rooms, so nothing is answered without
// a request signed with MATCH_SECRET.
async function handleInternal(req, res, pathname) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024) return sendJson(res, 413, { error: "Request too large." });
  }
  if (!verifyRequest(req.headers["x-match-signature"], pathname, raw, MATCH_SECRET)) {
    return sendJson(res, 401, { error: "Bad signature." });
  }
  if (pathname === "/internal/status" && req.method === "GET") {
    return sendJson(res, 200, localStatus());
  }
  if (pathname === "/internal/reserve" && req.method === "POST") {
    let body;
    try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "Malformed JSON." }); }
    return sendJson(res, 200, reserveSeat(body || {}));
  }
  sendJson(res, 404, { error: "No such endpoint." });
}

// MATCH_RATE matches a second per address, in bursts of MATCH_BURST.
const matchAllowed = createRateLimit({
  rate: Number(process.env.MATCH_RATE) || 2,
  burst: Number(process.env.MATCH_BURST) || 10
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/match" && req.method === "POST") {
    if (!matchmaker) {
      sendJson(res, 404, {
        error: "Matchmaking for this server is a separate service.", code: "external"
      });
      return;
    }
    await answerMatch(req, (status, payload) => sendJson(res, status, payload), matchmaker, {
      allowed: matchAllowed, ip: ipOf(req)
    });
    return;
  }

  if (url.pathname.startsWith("/internal/")) {
    await handleInternal(req, res, url.pathname);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, {
      accounts, backend, ramp, url, ip: ipOf(req), googleClientId: GOOGLE_CLIENT_ID,
      liveBots: TEST_MODE
    });
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      // Readable from anywhere on purpose. It carries no secrets, and the one
      // case where a client most needs it — a page served from one host
      // talking to a game server on another, where the origin allowlist is
      // most likely to be what is refusing the socket — is exactly the case
      // where the request is cross-origin and would otherwise be blocked.
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify({
      ok: true,
      players: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0),
      // startsAt and test are here so a deployment can be diagnosed from a
      // browser: "nothing happens when I press ready" is almost always a
      // lobby minimum of 100 on a server nobody set TEST_MODE on.
      test: TEST_MODE,
      server: SERVER_ID,
      region: REGION,
      matchmaker: MATCHMAKER,
      maxRooms: MAX_ROOMS,
      rooms: [...rooms.values()].map(r => ({
        id: r.id,
        mode: r.mode.id,
        players: r.clients.size,
        ready: readyCount(r),
        startsAt: r.lobbyMin,
        cap: r.lobbyMax,
        // Seats promised to tickets that have not joined yet.
        reserved: r.reserved.size,
        phase: ["", "live", "intermission", "lobby", "countdown"][r.round.phase] || r.round.phase,
        round: r.round.number,
        arena: r.world.size,
        botTarget: r.bots,
        botLevel: r.world.botLevel,
        // The mean rating of the people in the room and how far from it the
        // room will seat someone right now. Both null in an empty room.
        skill: (({ rating, window }) => ({
          rating: rating == null ? null : Math.round(rating),
          window: window == null ? null : Math.round(window)
        }))(roomSkill(r)),
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
      // Whether a WebSocket handshake FROM THIS CALLER would be accepted, and
      // if not, which guard would turn it away.
      //
      // A rejected upgrade reaches the browser as a bare close with no code
      // and no reason, so a client cannot tell a server it cannot reach from
      // one that is refusing it — and neither can you, from the outside. Both
      // look like "could not reach the server after several attempts". This is
      // the same two checks verifyClient runs, answered over plain HTTP where
      // the answer can actually be read.
      socket: (() => {
        const ip = ipOf(req);
        const held = connectionsByIp.get(ip) || 0;
        // A browser sends NO Origin header on a same-origin fetch, so this
        // request cannot be used to work out the page's origin. Judging it
        // would answer "refused, no origin" for every healthy same-host
        // deployment that has an allowlist set — a confident wrong answer,
        // which is worse than none. The page names its own origin instead.
        // Safe, because this is a report and never an access decision: the
        // real check runs in verifyClient against headers the browser sets.
        const origin = url.searchParams.get("origin") || req.headers.origin || null;
        return {
          origin,
          originAsked: !!url.searchParams.get("origin"),
          wouldAccept: originIsAllowed(origin, req.headers.host),
          matchesHost: originMatchesHost(origin, req.headers.host),
          originsConfigured: ALLOWED_ORIGINS.length > 0,
          ip,
          trustProxy: TRUST_PROXY,
          connections: held,
          maxPerIp: MAX_CONN_PER_IP,
          atCap: held >= MAX_CONN_PER_IP
        };
      })(),
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

// Embedded, this server is the matchmaker's only server, and the two talk by
// function call instead of signed HTTP. The tickets are the same tickets and
// the join checks them the same way, so one box and a fleet run one path.
const matchmaker = MATCHMAKER === "embedded" ? createMatchmaker({
  servers: [{
    id: SERVER_ID, region: REGION, url: PUBLIC_URL,
    status: async () => localStatus(),
    reserve: async req => reserveSeat(req)
  }],
  secret: MATCH_SECRET,
  resolveSession: token => accounts.resolveSession(token),
  findSeat: accountId => backend.findSeat(accountId),
  findSkill: async accountId => (await backend.getProgress(accountId)).rating,
  ticketTtlMs: TICKET_MS
}) : null;

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
// Rooms are made on demand, each fully independent: its own world, arena size,
// lobby, round clock, bots and connected clients. Nothing is shared but the
// ledger and the account store, because a player's balance follows them
// between rooms while nothing else should.
//
// Every mode keeps at least one room open. When all of a mode's rooms are
// full, the next arrival opens another, up to MAX_ROOMS in this process, and
// an empty room closes as long as its mode has another open. The stake
// still chooses the mode; which room of that mode is the server's decision,
// so a client cannot pick its table.
//
// In test mode, where rooms have bots, the bot level is part of the choice
// too: a player is only seated in a room at the level they asked for. It
// picks which room, never what a room already is, so a level cannot be
// changed under anyone. Without bots the level means nothing, and ignoring it
// keeps real players from being split across lobbies over a setting that
// changes nothing.

let roomSerial = 0;
const roomsOpened = new Map();   // mode id -> rooms ever opened, for naming

function createRoom(mode, botLevel = BOT_LEVEL) {
  const n = (roomsOpened.get(mode.id) || 0) + 1;
  roomsOpened.set(mode.id, n);
  // Two rooms opened in the same millisecond must not share an orb layout.
  const world = createWorld((Date.now() + ++roomSerial) & 0xffffffff,
    { ...mode.world, botLevel });
  const lobbyMax = LOBBY_MAX_OVERRIDE ?? mode.lobbyMax;
  const room = {
    // Numbers are never reused, so a log line naming standard-2 cannot mean
    // two different rooms.
    id: `${mode.id}-${n}`,
    mode,
    world,
    clients: new Map(),          // ws -> meta
    arriving: 0,                 // joins that have a seat but are still awaiting the database
    reserved: new Map(),         // reservation id -> { account, until }, one per match ticket
    lastEater: new Map(),        // victim id -> killer id, for settlement
    lingering: [],               // players whose socket dropped
    round: { number: 0, phase: PHASE_LOBBY, endsAt: Infinity },
    // When this room last began taking players for a round, for its skill
    // window: at opening, and again every time a round ends.
    waitingSince: Date.now(),
    entrants: null,              // body -> result, for the round being played
    // Test mode fills the room to the size the mode is built for, so a solo
    // test is representative rather than an empty field.
    bots: TEST_MODE ? Math.min(BOTS_OVERRIDE ?? mode.lobbyMin, lobbyMax - 1) : 0,
    lobbyMin: TEST_MODE ? 1 : (LOBBY_MIN_OVERRIDE ?? mode.lobbyMin),
    lobbyMax,
    roundSeconds: ROUND_SECONDS_OVERRIDE ?? (TEST_MODE ? 120 : mode.roundSeconds),
    paidPositions: PAID_OVERRIDE ?? mode.paidPositions
  };
  // Deliberately NOT populated here. An empty room costs a tick either way;
  // simulating a hundred bots in a room nobody is in is pure waste, and with
  // two rooms it doubled the server's load for no one's benefit.
  return room;
}

const rooms = new Map();

function openRoom(mode, botLevel) {
  const room = createRoom(mode, botLevel);
  rooms.set(room.id, room);
  return room;
}

for (const mode of MODES) openRoom(mode);

const modeForStake = stake => MODES.find(m => m.stake === stake) || null;

// Seats promised count as taken: reservations waiting for their ticket to be
// presented, and joins in flight between presenting it and entering. Without
// both, a burst of arrivals could all be handed the same last seat.
const seatsTaken = room => room.clients.size + room.arriving + room.reserved.size;
const hasSeat = room => seatsTaken(room) < room.lobbyMax;

// A room between rounds beats one in the middle of a round: someone seated in
// a live room only watches the lobby card until the whistle. After that the
// fuller room, so one lobby reaches its minimum rather than several getting
// halfway there and none starting.
const betweenRounds = room => room.round.phase !== PHASE_LIVE;
const betterSeat = (a, b) =>
  betweenRounds(a) !== betweenRounds(b) ? betweenRounds(a) : seatsTaken(a) > seatsTaken(b);

// tickCost covers every room in the process, so it is the right measure of
// whether one more world fits.
const hasHeadroom = () => tickCost.avgMs < (1000 / HZ) * OPEN_ROOM_BELOW;

// A rating from a reservation request, or null for none. Signed by the
// matchmaker, but a number is still checked to be one.
const skillOf = rating => (Number.isFinite(rating) ? rating : null);

// The level a player asked for, where it decides anything: only in test mode,
// the one time a live room has bots. null is no preference.
const askedLevel = bots => (TEST_MODE && isBotLevel(bots) ? bots : null);
const levelFits = (room, level) => !level || room.world.botLevel === level;

// How a room describes itself to skill matchmaking: the mean rating of the
// people in it, counting seats promised to reservations, and how far from
// that mean it will take someone. A room with nobody in it has no rating and
// takes anyone.
function roomSkill(room, now = Date.now()) {
  let sum = 0, n = 0;
  for (const meta of room.clients.values()) {
    if (meta.progress) { sum += meta.progress.rating; n++; }
  }
  for (const held of room.reserved.values()) {
    if (held.rating != null) { sum += held.rating; n++; }
  }
  if (!n) return { rating: null, window: null };
  const waited = room.round.phase === PHASE_LIVE ? 0 : Math.max(0, now - room.waitingSince) / 1000;
  return { rating: sum / n, window: SKILL_WINDOW + SKILL_WIDEN * waited };
}

// Where a new arrival for this mode sits:
//
//   1. the best room whose skill window they fit (betterSeat: between rounds,
//      then fuller — filling rooms before opening more keeps a quiet server
//      from splitting players across lobbies that never reach their minimum);
//   2. otherwise a new room, which takes its rating from them;
//   3. otherwise, with no room to open, the room nearest their rating. Skill
//      decides where someone sits, never whether they get a seat.
//
// A player with no rating fits everywhere, which is plain fill-first seating.
function seatFor(mode, level = null, rating = null) {
  let best = null, nearest = null, nearestGap = Infinity;
  for (const room of rooms.values()) {
    if (room.mode !== mode || !hasSeat(room) || !levelFits(room, level)) continue;
    const skill = roomSkill(room);
    if (fitsSkill(skill, rating)) {
      if (!best || betterSeat(room, best)) best = room;
    } else if (Math.abs(rating - skill.rating) < nearestGap) {
      nearest = room;
      nearestGap = Math.abs(rating - skill.rating);
    }
  }
  if (best) return best;
  if (rooms.size >= MAX_ROOMS || !hasHeadroom()) return nearest;
  const room = openRoom(mode, level ?? BOT_LEVEL);
  console.log(`[${room.id}] opened, ${rooms.size} of ${MAX_ROOMS} room(s) in use`);
  return room;
}

// Close any room with nothing left in it, as long as its mode keeps another.
// A lingering body still holds escrow the sweep has yet to refund, a start in
// flight is still re-staking, and a reservation is a player on their way, so
// any of them keeps the room open.
//
// The room a mode keeps is one at the server's own bot level. A room opened
// at somebody's requested level is the first to go, so the standing room does
// not quietly become whatever level was last asked for.
function retireIdleRooms() {
  for (const room of rooms.values()) {
    if (room.clients.size || room.arriving || room.reserved.size ||
        room.lingering.length || room.starting) continue;
    const standing = room.world.botLevel === BOT_LEVEL;
    const sibling = [...rooms.values()].some(r => r !== room && r.mode === room.mode &&
      (!standing || r.world.botLevel === BOT_LEVEL));
    if (!sibling) continue;
    rooms.delete(room.id);
    console.log(`[${room.id}] closed, ${rooms.size} of ${MAX_ROOMS} room(s) in use`);
  }
}

// A ticket nobody presented stops holding its seat. The grace covers a join
// that started just inside the ticket's life and is still in flight.
const RESERVATION_GRACE_MS = 5000;

function sweepReservations(now = Date.now()) {
  for (const room of rooms.values()) {
    for (const [rsv, held] of room.reserved) if (held.until <= now) room.reserved.delete(rsv);
  }
}

// One outstanding reservation per account on this server. Asking again
// replaces the last, so an account cannot hold seats it is not going to use.
function dropReservations(account) {
  for (const room of rooms.values()) {
    for (const [rsv, held] of room.reserved) if (held.account === account) room.reserved.delete(rsv);
  }
}

// What the matchmaker asks for: hold a seat for this account at this stake,
// in the room it suggests if that still has one, else wherever this server
// would seat them. A player whose body is still standing mid-round goes back
// to that room whatever was suggested, and past a full cap: it is their own
// seat they are returning to, not a new one — and at its own bot level,
// whatever they ask for now.
function reserveSeat({ account, stake, room: hint, bots, rating }) {
  if (shuttingDown) return { ok: false, code: "closing" };
  const mode = modeForStake(Number(stake));
  if (!mode || typeof account !== "string") return { ok: false, code: "bad" };
  dropReservations(account);
  const level = askedLevel(bots);

  let room = resumableRoom(account, mode);
  if (!room) {
    const suggested = typeof hint === "string" ? rooms.get(hint) : null;
    room = suggested && suggested.mode === mode && hasSeat(suggested) && levelFits(suggested, level)
      ? suggested
      : seatFor(mode, level, skillOf(rating));
  }
  if (!room) return { ok: false, code: "full" };

  const now = Date.now();
  const rsv = crypto.randomBytes(9).toString("base64url");
  // The rating travels with the reservation, so the room's mean counts a
  // player on their way in, not only the ones already seated.
  room.reserved.set(rsv, {
    account, until: now + TICKET_MS + RESERVATION_GRACE_MS, rating: skillOf(rating)
  });
  return { ok: true, room: room.id, rsv, expiresAt: now + TICKET_MS };
}

// What the matchmaker ranks servers by.
function localStatus() {
  return {
    id: SERVER_ID,
    region: REGION,
    canOpen: !shuttingDown && rooms.size < MAX_ROOMS && hasHeadroom(),
    rooms: shuttingDown ? [] : [...rooms.values()].map(r => ({
      id: r.id, mode: r.mode.id, taken: seatsTaken(r), cap: r.lobbyMax, between: betweenRounds(r),
      // A level only where there are bots for it to describe.
      bots: TEST_MODE ? r.world.botLevel : null,
      skill: roomSkill(r)
    }))
  };
}

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
      dropConnection(room, ws, meta, "Replaced by a newer connection");
      return true;
    }
  }
  return false;
}

// Take a connection out of play without the close handler treating it as a
// player walking away: that would linger the cell and later refund an escrow
// that someone else is now responsible for.
function dropConnection(room, ws, meta, reason) {
  meta.replaced = true;
  meta.stake = PRACTICE;
  room.clients.delete(ws);
  markOut(room, meta.id);
  removePlayer(room.world, meta.id);
  room.lastEater.delete(meta.id);
  try { ws.close(4001, reason); } catch { /* already gone */ }
  pushLobby(room);
}

// ── seat leases ─────────────────────────────────────────────────────────────
//
// This server holds an account's seat from the moment a join claims it until
// the account has neither a connection nor a lingering body here. Released
// only once any refund owed has landed: releasing first would let another
// server reconcile the escrow while our refund was still in flight.

const seatsInFlight = new Map();   // account -> joins that claimed it and have not entered yet
const seatClaimedAt = new Map();   // account -> when this process last claimed it

function holdsHere(accountId) {
  if (seatsInFlight.get(accountId) > 0) return true;
  for (const room of rooms.values()) {
    for (const meta of room.clients.values()) if (meta.accountId === accountId) return true;
    if (room.lingering.some(l => l.accountId === accountId)) return true;
  }
  return false;
}

function releaseSeatIfIdle(accountId) {
  if (!accountId || holdsHere(accountId)) return;
  seatClaimedAt.delete(accountId);
  backend.releaseSeat(accountId, SEAT_HOLDER)
    .catch(err => console.error("release seat:", err.message));
}

// Our lease ran out and another server took the account: a stalled process,
// or a database we could not reach for longer than SEAT_TTL. That server has
// already reconciled the escrow, so nothing here may move this account's
// money again. The connection goes, and a lingering body stays standing
// without the refund it would have had.
function loseSeat(accountId) {
  console.warn(`seat for ${accountId} was taken by another server; dropping it here`);
  seatClaimedAt.delete(accountId);
  for (const room of rooms.values()) {
    for (const [ws, meta] of room.clients) {
      if (meta.accountId === accountId) dropConnection(room, ws, meta, "Playing on another server");
    }
    for (const l of room.lingering) if (l.accountId === accountId) l.accountId = null;
  }
}

function accountsHeldHere() {
  const held = new Set(seatsInFlight.keys());
  for (const room of rooms.values()) {
    for (const meta of room.clients.values()) if (meta.accountId) held.add(meta.accountId);
    for (const l of room.lingering) if (l.accountId) held.add(l.accountId);
  }
  return held;
}

async function renewSeats() {
  const held = accountsHeldHere();
  if (!held.size) return;
  const started = Date.now();
  let kept;
  try {
    kept = new Set(await backend.renewSeats(SEAT_HOLDER, [...held], SEAT_TTL_MS));
  } catch (err) {
    // Nothing is lost yet: the leases have SEAT_TTL to run. Another server
    // cannot take them while the database is unreachable to it too.
    console.error("seat renewal:", err.message);
    return;
  }
  for (const accountId of held) {
    if (kept.has(accountId) || !holdsHere(accountId)) continue;
    // Claimed again while this renewal was in flight: that claim is newer
    // than the answer, and the answer says nothing about it.
    if ((seatClaimedAt.get(accountId) ?? 0) >= started) continue;
    loseSeat(accountId);
  }
}

setInterval(() => { renewSeats(); }, SEAT_RENEW_MS).unref?.();

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
function findLingering(accountId) {
  if (!accountId) return null;
  for (const room of rooms.values()) {
    const index = room.lingering.findIndex(l => l.accountId === accountId);
    if (index === -1) continue;
    const oldId = room.lingering[index].id;
    return { room, index, oldId, player: room.world.players.get(oldId) || null };
  }
  return null;
}

function claimLingering(accountId) {
  const found = findLingering(accountId);
  if (found) found.room.lingering.splice(found.index, 1);
  return found;
}

// Is there still a run to come back to? A round that has moved on, or a body
// that was eaten while its owner was away, leaves nothing to resume.
const canResume = ({ room, player }) =>
  room.round.phase === PHASE_LIVE && !!player && player.alive && player.cells.length > 0;

// The room holding this account's body, if the player can step back into it.
// A mode has several rooms now, so "the room for this stake" is no longer
// where the body is; a reconnect seated anywhere else would start from
// scratch while its old self stood in another arena waiting to be eaten.
function resumableRoom(accountId, mode) {
  const found = findLingering(accountId);
  return found && found.room.mode === mode && canResume(found) ? found.room : null;
}

// Step two: move a claimed body onto the new connection, or clear it away if
// it cannot be resumed. Returns the player to carry on as, or null to join
// from scratch.
function resumeLingering(claim, room, newId) {
  if (!claim) return null;

  const { room: oldRoom, oldId, player } = claim;
  // Same room: a tier switch is a new run, and so is being seated elsewhere.
  const usable = oldRoom === room && canResume(claim);

  if (!usable) {
    // Eaten while away, a tier change, or the round moved on. Clear the old
    // body out now rather than leaving it for a sweep that no longer owns it.
    if (player) {
      markOut(oldRoom, oldId);
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

// Seconds left on the pre-round count. Ceilinged because it is read as a
// number on a card, not as a clock: "1" then covers the whole last second
// instead of half of it, and the count never shows a zero it sits on.
const countdownLeft = room =>
  Math.max(0, Math.ceil(room.round.endsAt - room.world.time));

function lobbyState(room) {
  const counting = room.round.phase === PHASE_COUNTDOWN;
  return {
    type: "lobby",
    mode: room.mode.id,
    ready: readyCount(room),
    connected: room.clients.size,
    min: room.lobbyMin,
    max: room.lobbyMax,
    phase: room.round.phase,
    // The count travels with the message that opens the card. Without it the
    // card shows whatever the last count ended on until the next snapshot
    // lands — a stale "1" flashing where a "5" belongs — and a player who
    // joins mid-count has nothing to show at all.
    starts: counting ? countdownLeft(room) : null,
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
    : room.round.phase === PHASE_COUNTDOWN
      ? countdownLeft(room)
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

// Is this request coming from a page this very server handed out? A browser
// sets Host from the URL being opened and Origin from the page doing the
// opening, so the two agree only for a same-origin request. Ports count:
// localhost:8080 and localhost:9000 are different origins.
function originMatchesHost(origin, host) {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;                             // not a URL, so not ours
  }
}

function originIsAllowed(origin, host) {
  if (!ALLOWED_ORIGINS.length) return true;   // unset = dev, allow anything
  // No Origin header means a non-browser client. Once you have set an
  // allowlist, that is exactly what you are trying to keep out.
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // A page this server served can always talk back to it. The allowlist is
  // here to stop SOMEBODY ELSE'S page pointing a client at us, and a
  // same-origin request is by definition not that — evil.com opening a socket
  // to us sends Host: our-host with Origin: https://evil.com, which does not
  // match. Nothing is given away: a non-browser client that can forge Host
  // could forge Origin too, so this was never the defence against one.
  //
  // Without it the allowlist can lock the game out of a host the server
  // itself serves — a Render URL, a preview deploy, the apex when only www is
  // listed, a machine on the LAN — and the failure is invisible from the
  // outside: the page loads, the socket is refused during the handshake, and
  // the browser is told only that it closed. Every cause looks like a flaky
  // network from there.
  return originMatchesHost(origin, host);
}

const originAllowed = req => originIsAllowed(req.headers.origin, req.headers.host);

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

// A palette slot, or null for "no preference", which addPlayer reads as pick
// one at random. The palette itself lives client-side; only the index travels.
function cleanColour(raw) {
  return Number.isInteger(raw) && raw >= 0 && raw < STAIN_COUNT ? raw : null;
}

// Names and colours are sent once, when a player first comes into view, and
// then remembered by each client until its next keyframe. After a change,
// forget that anyone was told, so the new one goes out on the next snapshot
// rather than up to five seconds later.
function reannounce(room, player) {
  for (const meta of room.clients.values()) meta.state?.knownNames.delete(player.nid);
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
    if (!originAllowed(info.req)) {
      console.warn(
        `refused origin ${info.req.headers.origin || "(none sent)"} for host ` +
        `${info.req.headers.host || "(none)"}: not in ALLOWED_ORIGINS ` +
        `(${ALLOWED_ORIGINS.join(", ")}) and not same-origin`
      );
      return done(false, 403, "Forbidden origin");
    }
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
  // Both before anything is awaited: the body a death names may be gone from
  // the world by the time a later await returns.
  for (const e of events) {
    if (e.t === "eat") room.lastEater.set(e.victim, e.id);
    else if (e.t === "death") markOut(room, e.id);
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
// sufficient — you have to place. Then the standings, then the lobby.
async function endRound(room) {
  const { world, round, mode } = room;
  // Taken now, before anything is awaited, so the round being scored is this
  // one whatever happens during settlement.
  const entrants = room.entrants;
  room.entrants = null;
  room.waitingSince = Date.now();

  const survivors = aliveTargets(room).sort((a, b) => totalMass(b) - totalMass(a));

  // Who is settled, fixed before anything is awaited: going back to the lobby
  // below despawns every body, and settlement must not depend on a body that
  // is no longer there. The stake is taken off the connection here for the
  // same reason, so nothing can read it as still riding on this round.
  const settling = [];
  for (const [ws, meta] of room.clients) {
    const player = world.players.get(meta.id);
    if (!player || !player.alive) continue;
    settling.push({ ws, meta, player, position: survivors.indexOf(player) + 1, stake: meta.stake });
    meta.stake = PRACTICE;
  }

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
    nextIn: STANDINGS_SECONDS
  });

  // The round is over for everyone at once: bodies off the board, nobody
  // ready, and the standings up until the lobby opens. Synchronous, so the
  // phase has left LIVE before the tick could ask again.
  closeRound(room);

  // No count can start until every survivor is paid: startRound re-stakes
  // from the connection, and a round must not open on a payout in flight.
  room.settling = true;
  try {
    // One at a time, and each on its own: a fault settling one survivor
    // must not leave the ones after them unpaid.
    for (const s of settling) {
      await settleSurvivor(room, s, survivors.length)
        .catch(err => console.error("round settlement:", err.message));
    }
    await awardProgress(room, survivors, entrants);
  } finally {
    room.settling = false;
    maybeStartRound(room);
  }
}

async function settleSurvivor(room, { ws, meta, player, position, stake }, field) {
  const placed = position > 0 && position <= room.paidPositions;
  let payout = 0;
  let settled = !(stake > PRACTICE && meta.accountId);
  try {
    if (!settled) {
      if (placed) {
        ({ paid: payout } = await backend.cashOut(meta.accountId, RAKE_BPS));
      } else {
        await backend.forfeit(meta.accountId);
      }
      settled = true;
    }
  } catch (err) {
    console.error("round settlement:", err.message);
  }

  recordRun(meta, {
    duration: room.world.time - (player.spawnedAt || room.world.time),
    rank: position || null,
    of: field,
    orbs: player.orbs,
    eaten: player.eaten,
    peak: Math.round(player.peak)
  }, { outcome: "survived", killerId: null, stake, payout });

  // The balance first, so the result below lands on a client that already
  // holds the balance the payout produced.
  await pushAccount(ws, meta);

  // Each survivor's own result. A paid place is shown as a congratulations
  // card built from these figures, so they are the ledger's, not a guess
  // from the standings: what was staked, and what was actually paid.
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({
      type: "result", round: room.round.number, place: position, placed,
      stake, paid: payout, settled, peak: Math.round(player.peak), eaten: player.eaten
    }));
  }
}

// ── progress: XP and rating ─────────────────────────────────────────────────
//
// The rules are in shared/progress.js. Who takes part is decided here: the
// humans dealt in at the whistle, with the life they were dealt in with.
// Nobody joins or respawns during a round, so that life is the only one.
//
// Entrants are keyed by the body rather than its id, because a reconnect
// moves the same body to a new id (resumeLingering).

function dealEntrants(room) {
  room.entrants = new Map();
  room.eliminated = 0;
  for (const meta of room.clients.values()) {
    const body = meta.ready && meta.accountId ? room.world.players.get(meta.id) : null;
    if (!body || !body.alive) continue;
    room.entrants.set(body, {
      accountId: meta.accountId,
      rating: meta.progress?.rating ?? START_RATING,
      games: meta.progress?.ratedGames ?? 0,
      out: 0              // order of elimination; 0 while still in the round
    });
  }
}

// An entrant is out of the round: eaten, or their body gone because they left.
// The first time only.
function markOut(room, playerId) {
  const body = room.world.players.get(playerId);
  const entry = body && room.entrants?.get(body);
  if (entry && !entry.out) entry.out = ++room.eliminated;
}

async function awardProgress(room, survivors, entrants) {
  if (!entrants?.size) return;
  const { results, field } = scoreRound(entrants, survivors, room.paidPositions);
  if (!results.length) return;

  let saved;
  try {
    saved = await backend.recordProgress(results);
  } catch (err) {
    console.error("progress:", err.message);
    return;
  }

  // Tell whoever is still here. Anyone who left is updated all the same; they
  // see it next time they sign in.
  for (const [ws, meta] of room.clients) {
    const r = results.find(x => x.accountId === meta.accountId);
    const now = r && saved.get(meta.accountId);
    if (!now) continue;
    meta.progress = now;
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(JSON.stringify({
      type: "progress",
      round: room.round.number,
      gained: r.xp,
      ratingChange: r.ratingChange,
      rated: r.rated,
      place: r.place,
      of: field,
      ...now
    }));
  }
}

// The whistle. Everyone is despawned and un-readied, so the next round needs
// a fresh show of hands: nobody is staked into a round they did not choose to
// play. The exception is a player who sat this round out and readied during
// it, which was that choice, made for the next one. The finishing positions
// stay on screen for STANDINGS_SECONDS, then toLobby opens the lobby.
function closeRound(room) {
  room.round.phase = PHASE_INTERMISSION;
  room.round.endsAt = room.world.time + STANDINGS_SECONDS;
  for (const meta of room.clients.values()) {
    meta.ready = !!meta.readyForNext;
    meta.readyForNext = false;
  }
  for (const p of room.world.players.values()) {
    p.alive = false;
    p.cells = [];
  }
}

// The standings have been up long enough: everyone to the lobby.
function toLobby(room) {
  room.round.phase = PHASE_LOBBY;
  room.round.endsAt = Infinity;
  pushLobby(room);
}

// The order players are dealt onto the starting ring. Neighbours on the ring
// are neighbours in this list, so the humans are spread through it at even
// intervals rather than left in a block: nobody opens wedged between two bots
// while somebody else has the far side of the arena to themselves.
export function startingOrder(humans, bots) {
  if (!bots.length) return humans;
  if (!humans.length) return bots;

  const slots = humans.length + bots.length;
  const step = slots / humans.length;          // >= 1, so no two humans collide
  const order = new Array(slots).fill(null);
  humans.forEach((p, i) => { order[Math.round(i * step)] = p; });

  let b = 0;
  for (let i = 0; i < slots; i++) if (!order[i]) order[i] = bots[b++];
  return order;
}

// Enough hands are up. The round does not begin here: the lobby holds for a
// visible count first, so nobody is dropped into the arena mid-sentence.
function maybeStartRound(room) {
  if (room.round.phase !== PHASE_LOBBY) return;
  if (room.settling) return;           // the last round is still paying out
  if (readyCount(room) < room.lobbyMin) return;
  if (room.starting) return;           // a start is already in flight
  room.round.phase = PHASE_COUNTDOWN;
  room.round.endsAt = room.world.time + COUNTDOWN_SECONDS;
  pushLobby(room);
}

// Back to waiting. Reached when someone un-readies or drops during the count,
// and when the re-stake at the top of startRound cannot fund the round.
function cancelCountdown(room) {
  room.round.phase = PHASE_LOBBY;
  room.round.endsAt = Infinity;
  pushLobby(room);
}

// The count has run out. Kept separate from the countdown so the async
// re-staking inside startRound cannot be entered twice.
function beginRound(room) {
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

  // Everyone who could not pay has been un-readied, so check again. Nothing
  // has been spawned yet, so the room simply goes back to waiting.
  if (readyCount(room) < room.lobbyMin) {
    cancelCountdown(room);
    return;
  }

  round.number++;
  round.phase = PHASE_LIVE;
  round.endsAt = world.time + room.roundSeconds;
  resetArena(world);

  // Bots first: the roster has to be final before anyone is placed, or the
  // ring is spaced for a field that is about to change size.
  syncBots(room);

  // Only players who marked themselves ready take the field.
  const humans = [];
  for (const meta of room.clients.values()) {
    meta.spectateId = null;
    const player = world.players.get(meta.id);
    if (!player) continue;
    if (meta.ready) humans.push(player);
    else { player.alive = false; player.cells = []; }
  }
  const bots = [...world.players.values()].filter(p => p.bot);
  spawnRing(world, startingOrder(humans, bots));
  dealEntrants(room);

  room.lastEater.clear();
  broadcast(room, {
    type: "round_start", mode: room.mode.id,
    number: round.number, seconds: room.roundSeconds
  });
  console.log(`[${room.id}] round ${round.number} started with ${readyCount(room)} player(s)`);
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
          // During a live round, only from someone without a body in it: a
          // player waiting for the next round opts in from the lobby card.
          if (room.round.phase === PHASE_LIVE && room.world.players.get(id)?.alive) return;
          meta.ready = msg.ready !== false;
          // Chosen during a round by someone sitting it out, which makes it a
          // choice about the next one: the whistle keeps it (toLobby).
          meta.readyForNext = meta.ready && room.round.phase === PHASE_LIVE;
          pushLobby(room);
          maybeStartRound(room);
        } else if (msg.type === "rename") {
          if (!meta.accountId) return;
          const fresh = await backend.getAccount(meta.accountId);
          const player = room.world.players.get(id);
          if (fresh && player) {
            player.name = fresh.displayName;
            reannounce(room, player);
          }
        } else if (msg.type === "colour") {
          const player = room.world.players.get(id);
          const ci = cleanColour(msg.ci);
          // Chosen between rounds, never mid-fight: a live body keeps the
          // colour it was born with, so nobody can change their look to
          // shake off a chaser or pass for someone else.
          if (!player || player.alive || ci === null) return;
          player.ci = ci;
          reannounce(room, player);
        } else if (msg.type === "leave") {
          // Back to the menu from the lobby. Nobody can be eaten there, so a
          // linger protects nothing: the stake comes back now rather than six
          // seconds after the socket closes, and the account push lands
          // before the close, so the menu shows the balance the player has.
          // A live body is not let off that way — it closes, and lingers,
          // like any other exit.
          const player = room.world.players.get(id);
          if (player?.alive) { ws.close(1000, "Left"); return; }
          meta.left = true;
          meta.ready = false;
          // Out of the room before anything is awaited, so a count that
          // finishes meanwhile cannot deal them into the round.
          room.clients.delete(ws);
          markOut(room, id);
          if (player) removePlayer(room.world, id);
          syncBots(room);
          pushLobby(room);
          // Only a stake still held for this round is refunded — the one
          // locked on joining. After a round it has already been settled.
          if (meta.stake !== PRACTICE && meta.accountId) {
            try {
              await backend.refund(meta.accountId);
            } catch (err) {
              console.error("refund on leave:", err.message);
            }
          }
          meta.stake = PRACTICE;
          // Only now, with the refund landed: released any earlier, another
          // server could reconcile this escrow while ours was in flight.
          releaseSeatIfIdle(meta.accountId);
          await pushAccount(ws, meta);
          ws.close(1000, "Left");
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
      // Claiming the seat is a database round trip, so a second JOIN could
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

      const refuse = (code, reason, closeCode, closeWhy) => {
        meta.joining = false;
        ws.send(JSON.stringify({ type: "account_error", code, reason }));
        ws.close(closeCode, closeWhy);
      };

      if (shuttingDown) {
        refuse("retry", "This server is restarting. Finding you another seat.", 1012, "Server restarting");
        return;
      }

      // The ticket is the matchmaker's word on who this is, what they are
      // staking and where they sit. Nothing else the client says about itself
      // is believed, and checking it costs no database round trip. Guests
      // play locally against bots and never get one.
      let ticket;
      try {
        ticket = verifyTicket(msg.ticket, MATCH_SECRET);
        if (ticket.srv !== SERVER_ID) throw new TicketError("server");
      } catch (err) {
        if (!(err instanceof TicketError)) throw err;
        // Not final: the client goes back to the matchmaker for a new one.
        refuse("ticket", "Finding you a seat again.", 4003, `Ticket ${err.reason}`);
        return;
      }

      // The seat it names must still be held, for this account. A reservation
      // is spent by the first join that presents it, so one ticket cannot be
      // replayed into a second seat.
      const mode = modeForStake(Number(ticket.stake));
      const room = rooms.get(ticket.room);
      const held = room?.reserved.get(ticket.rsv);
      if (!mode || !room || room.mode !== mode || !held || held.account !== ticket.acct) {
        refuse("ticket", "Finding you a seat again.", 4003, "Ticket not reserved");
        return;
      }
      room.reserved.delete(ticket.rsv);

      // Counted as taken across the database round trips below. It also keeps
      // a room opened for this join from being closed as empty before the
      // player is in it.
      room.arriving++;
      const accountId = ticket.acct;
      seatsInFlight.set(accountId, (seatsInFlight.get(accountId) || 0) + 1);
      try {
        // Before anything touches this account's money, make sure no other
        // server is. If one holds the seat, the matchmaker sends them there.
        let mine;
        try {
          mine = await backend.claimSeat(accountId, SEAT_HOLDER, SEAT_TTL_MS);
        } catch (err) {
          console.error("seat claim failed:", err.message);
          // 1011 is a server fault, which the client treats as retryable.
          refuse("retry", "The server could not take your seat. Retrying.", 1011, "Seat claim failed");
          return;
        }
        if (!mine) {
          refuse("elsewhere", "You are still in a game on another server. Taking you back to it.",
            4004, "Seat held elsewhere");
          return;
        }
        seatClaimedAt.set(accountId, Date.now());

        meta.accountId = accountId;
        const displayName = cleanName(ticket.name);
        const stake = mode.stake;
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

        // XP and rating: what the welcome shows, what matchmaking and the
        // round-end award start from. A failed read does not turn the player
        // away. They play at the starting figures, and anything they earn is
        // still added to what they really have, since progress only ever
        // moves by increment.
        meta.progress = await backend.getProgress(meta.accountId).catch(err => {
          console.error("progress lookup:", err.message);
          return emptyProgress();
        });

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

        const player = resumed ||
          addPlayer(room.world, { id, name: displayName, ci: cleanColour(msg.ci) });
        // A rename can land while the socket is down.
        if (resumed) player.name = displayName;
        meta.state = createClientState(nextClientId);   // staggers keyframes
        // The run never stopped, so the player is already in it rather than
        // waiting to be let in.
        meta.ready = !!resumed;
        room.clients.set(ws, meta);
        syncBots(room);
        pushLobby(room);

        // Arrivals wait in the lobby rather than dropping into a live round:
        // a body is only ever dealt at the whistle (startRound). One arriving
        // while a round is being played, or wound up, is told it is waiting,
        // and watches the lobby card until the next one.
        if (!resumed) {
          player.alive = false;
          player.cells = [];
        }
        const waiting = !resumed &&
          room.round.phase !== PHASE_LOBBY && room.round.phase !== PHASE_COUNTDOWN;

        ws.send(JSON.stringify({
          type: MSG.WELCOME, id, nid: player.nid, tickHz: HZ,
          // Readiness belongs to the connection, so a fresh one starts unready
          // unless it picked a live run back up. Said, so the button agrees.
          ready: meta.ready,
          // Held out of a round already under way, until the next one.
          waiting,
          // The colour actually in use, which is the server's choice when the
          // client did not make one, so the lobby can show it as selected.
          ci: player.ci,
          mode: room.mode.id,
          room: room.id,
          server: SERVER_ID,
          region: REGION,
          modeLabel: room.mode.label,
          round: room.round.number,
          roundSeconds: room.roundSeconds,
          lobbyMin: room.lobbyMin,
          lobbyMax: room.lobbyMax,
          test: TEST_MODE,
          // Only meaningful in test mode, the one time a live room has bots:
          // the level this room was opened at, which the player asked for.
          botLevel: room.world.botLevel,
          progress: meta.progress,
          demo: !ramp.isReal,
          stake,
          signedIn: true,
          displayName,
          ...(await backend.snapshot(meta.accountId))
        }));
        // The lobby state broadcast on arrival went out before the welcome,
        // while the client still took the room for one it was playing in.
        // Sent again now that it knows it is waiting, so the card opens.
        if (waiting) ws.send(JSON.stringify(lobbyState(room)));
        return;
      } finally {
        room.arriving--;
        const inFlight = seatsInFlight.get(accountId) - 1;
        if (inFlight > 0) seatsInFlight.set(accountId, inFlight);
        else seatsInFlight.delete(accountId);
        // A join that did not get in leaves nothing here to hold the seat for.
        if (!meta.joined) releaseSeatIfIdle(accountId);
      }
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
      // Nobody joins a round under way, and a respawn would be a way in: a
      // body is dealt at the whistle and nowhere else. Someone eaten, or
      // waiting, plays again in the next round.
      if (msg.action === "respawn") return;
      queueAction(meta.room.world, id, msg.action);
    }
  });

  const cleanup = () => {
    const room = meta.room;
    if (room) room.clients.delete(ws);
    const n = (connectionsByIp.get(ip) || 1) - 1;
    if (n <= 0) connectionsByIp.delete(ip); else connectionsByIp.set(ip, n);

    // A replaced connection has already been reconciled by the join that
    // replaced it; lingering here would refund a stake that is now live. One
    // that left for the menu has already been refunded and removed.
    if (meta.joined && room && !meta.replaced && !meta.left) {
      pushLobby(room);
      syncBots(room);
      // Do not delete the player immediately. Vanishing on demand is a free
      // escape from any losing fight, so cells linger, motionless and edible.
      setAim(room.world, id, 0, 0);
      room.lingering.push({
        id, until: room.world.time + LINGER_SEC,
        accountId: meta.stake === PRACTICE ? null : meta.accountId
      });
      // A lingering stake keeps the seat until the sweep has refunded it.
      // With nothing at stake there is nothing left here to hold it for.
      releaseSeatIfIdle(meta.accountId);
    }
  };

  ws.on("close", cleanup);
  ws.on("error", () => { try { ws.close(); } catch {} });
});

// Ping every 10s; anything that misses two rounds is gone.
//
// This was 30s, which meant a hard-killed connection — a closed laptop, a
// dropped link, a browser that navigated away without a clean close — held
// its slot for up to a minute. That slot counts against MAX_CONN_PER_IP, so a
// player who reloaded a few times in a row could be refused at the handshake
// by their own abandoned sockets, and a refused handshake tells the browser
// nothing at all. Ten seconds costs one frame per client per ten seconds.
setInterval(() => {
  for (const room of rooms.values()) {
    for (const [ws, meta] of room.clients) {
      if (!meta.alive) { ws.terminate(); continue; }
      meta.alive = false;
      try { ws.ping(); } catch {}
    }
  }
}, 10000);

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
    // Only someone who sat the round out, or arrived during the standings,
    // can be ready already; with enough of them the count starts now. Held
    // while the round is still paying out, and asked again when it is done.
    maybeStartRound(room);
  } else if (round.phase === PHASE_COUNTDOWN && !room.starting) {
    // Checked every tick rather than only where readiness changes, so a player
    // dropping their connection mid-count aborts it the same as un-readying.
    // Skipped once a start is in flight: the phase stays COUNTDOWN across the
    // awaits inside startRound, which does its own final check.
    if (readyCount(room) < room.lobbyMin) cancelCountdown(room);
    else if (world.time >= round.endsAt) beginRound(room);
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
        // The seat is released once the refund has landed, not before. If the
        // refund fails the seat is not renewed either, so it lapses and the
        // next server to claim it clears the stale escrow itself.
        backend.refund(accountId)
          .then(() => releaseSeatIfIdle(accountId))
          .catch(err => console.error("refund:", err.message));
      }
      // Walking away does not escape a rating loss: they are out of the
      // round at the moment their body left it.
      markOut(room, goneId);
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
  sweepReservations();
  retireIdleRooms();

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
  if (shuttingDown) return;
  nextTickAt += TICK_MS;
  const drift = Date.now() - nextTickAt;
  if (drift > 500) nextTickAt = Date.now();
  setTimeout(() => { tick(); scheduleTick(); }, Math.max(0, nextTickAt - Date.now()));
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

// ── shutdown ────────────────────────────────────────────────────────────────
//
// A deploy starts the new process before stopping this one. The new one has
// a different boot id, so it cannot take the seats this one leases until they
// lapse — up to SEAT_TTL, which is longer than a client keeps retrying — and
// every player mid-game would be told the server was unreachable.
//
// So on SIGTERM: stop the tick, which ends all settlement; close every
// connection; give writes already in flight a moment to land; then hand the
// seats back. Any stake left in escrow is refunded when its player joins the
// new process, exactly as after any restart.

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  for (const room of rooms.values()) {
    for (const [ws] of room.clients) {
      // 1012 "service restart": the client reconnects, through the matchmaker.
      try { ws.close(1012, "Server restarting"); } catch { /* already gone */ }
    }
  }
  await new Promise(r => setTimeout(r, 1000));
  const held = [...accountsHeldHere()];
  await Promise.allSettled(held.map(id => backend.releaseSeat(id, SEAT_HOLDER)));
  console.log(`${signal}: stopped, ${held.length} seat(s) handed back`);
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM"); });
process.on("SIGINT", () => { shutdown("SIGINT"); });

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
  console.log(
    `  server  : ${SERVER_ID} in region ${REGION}, matchmaker ${MATCHMAKER}` +
    (MATCHMAKER === "embedded" ? " at /api/match" : " (answering /internal/*)")
  );
  console.log(
    `  rooms   : ${rooms.size} open, up to ${MAX_ROOMS} as they fill ` +
    `(none past ${Math.round(OPEN_ROOM_BELOW * 100)}% of the tick budget)`
  );
  if (TEST_MODE && BOTS_OVERRIDE !== null) {
    console.warn(
      `  NOTE    : BOTS=${BOTS_OVERRIDE} is overriding the per-mode bot counts ` +
      `(Standard would be ${MODES[0].lobbyMin}, High stakes ${MODES[1].lobbyMin}). ` +
      `Unset BOTS to fill each room to its own size.`
    );
  }
  console.log(`  google  : ${GOOGLE_CLIENT_ID ? "enabled" : "off (set GOOGLE_CLIENT_ID)"}`);
  if (TEST_MODE) {
    console.log(`  TEST MODE: demo credits only, solo start, bot-filled arena (${BOT_LEVEL} bots)`);
  }
});
