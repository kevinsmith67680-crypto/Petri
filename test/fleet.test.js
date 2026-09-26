// ---------------------------------------------------------------------------
// A real fleet.   DATABASE_URL=postgres://... node test/fleet.test.js
//
// Starts the matchmaker and two game servers — "eu-1" and "us-1" — as three
// separate processes sharing one Postgres, and plays through them over real
// WebSockets. Everything the unit tests fake is real here: signed internal
// calls, tickets crossing processes, seat leases in the database, and a
// server dying with a player's stake in escrow.
//
// Needs the real `ws` package (npm install) and a scratch database with
// schema.sql applied. Part of `npm run test:db`; skipped without DATABASE_URL.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.log("  skipped  set DATABASE_URL to run a matchmaker and two game servers against it");
  process.exit(0);
}

const wsPkg = await import("ws");
const WebSocket = wsPkg.WebSocket || wsPkg.default?.WebSocket;
if (!WebSocket) {
  console.error("This test needs the real ws package. Run npm install; see HANDOVER.md on the ws stub.");
  process.exit(1);
}

const { PROTOCOL_VERSION } = await import("../shared/protocol.js");
const { signTicket, signRequest } = await import("../server/ticket.js");

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = crypto.randomBytes(32).toString("hex");
const port0 = 9400 + (process.pid % 150) * 3;
const EU = port0, US = port0 + 1, MM = port0 + 2;
const STAKE = 1_000_000;
const SEAT_TTL = 3;               // seconds, so a dead server's seats lapse within the test

const children = new Map();
process.on("exit", () => { for (const c of children.values()) c.kill("SIGKILL"); });

function start(name, script, env, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"]
    });
    children.set(name, child);
    let log = "";
    const timer = setTimeout(() => reject(new Error(`${name} did not start:\n${log}`)), 15000);
    const read = chunk => {
      log += chunk;
      if (log.includes(ready)) { clearTimeout(timer); resolve(child); }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", code => {
      if (!log.includes(ready)) { clearTimeout(timer); reject(new Error(`${name} exited ${code}:\n${log}`)); }
    });
  });
}

const game = (id, region, port) => start(id, "server/index.js", {
  PORT: String(port), MATCHMAKER: "external", SERVER_ID: id, REGION: region,
  PUBLIC_URL: `ws://localhost:${port}`, MATCH_SECRET: SECRET, DATABASE_URL: DB,
  TEST_MODE: "1", BOTS: "0", ROUND_SECONDS: "60", COUNTDOWN_SECONDS: "1",
  LINGER_SEC: "2", SEAT_TTL_SECONDS: String(SEAT_TTL), ALLOWED_ORIGINS: ""
}, "Petri server on port");

await Promise.all([game("eu-1", "eu", EU), game("us-1", "us", US)]);
await start("matchmaker", "server/matchmaker/index.js", {
  PORT: String(MM), MATCH_SECRET: SECRET, DATABASE_URL: DB, DEFAULT_REGION: "eu",
  MATCH_BURST: "1000",
  GAME_SERVERS: JSON.stringify([
    { id: "eu-1", region: "eu", url: `ws://localhost:${EU}`, internal: `http://localhost:${EU}` },
    { id: "us-1", region: "us", url: `ws://localhost:${US}`, internal: `http://localhost:${US}` }
  ])
}, "Matchmaker on port");

// ── helpers ─────────────────────────────────────────────────────────────────

const uniq = () => crypto.randomBytes(3).toString("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function signup(name) {
  const res = await fetch(`http://localhost:${EU}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: name.toLowerCase(), password: "password123", displayName: name, dateOfBirth: "1990-01-01" })
  });
  return (await res.json()).token;
}

// Accounts live in the shared database, so any server can answer for them.
const money = async (token, port = US) =>
  (await (await fetch(`http://localhost:${port}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).json());

async function match(token, stake = STAKE, region) {
  const res = await fetch(`http://localhost:${MM}/match`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://page.example" },
    body: JSON.stringify(region ? { stake, region } : { stake })
  });
  return { status: res.status, cors: res.headers.get("access-control-allow-origin"), ...(await res.json()) };
}

// Opens a real socket, presents the ticket, and settles on the welcome or on
// being turned away.
function join(url, ticket) {
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    const said = [];
    const done = extra => resolve({ ws, said, ...extra });
    ws.on("open", () => ws.send(JSON.stringify({ type: "join", ticket, protocol: PROTOCOL_VERSION })));
    ws.on("message", (data, binary) => {
      if (binary) return;
      const m = JSON.parse(data);
      said.push(m);
      if (m.type === "welcome") done({ welcome: m });
    });
    ws.on("close", (code, why) => done({ closed: { code, why: String(why) } }));
    ws.on("error", () => {});
  });
}

// ── the fleet is up ─────────────────────────────────────────────────────────

console.log("\n-- the fleet --");

{
  const h = await (await fetch(`http://localhost:${MM}/health`)).json();
  check("the matchmaker reaches both game servers",
    h.servers.length === 2 && h.servers.every(s => s.ok), JSON.stringify(h.servers));
  const r = await fetch(`http://localhost:${EU}/internal/status`);
  check("a game server's internal endpoints refuse unsigned requests", r.status === 401, String(r.status));
  const m = await fetch(`http://localhost:${EU}/api/match`, { method: "POST" });
  check("and a fleet server leaves matchmaking to the matchmaker", m.status === 404, String(m.status));
}

console.log("\n-- grouped by region --");

const ada = await signup(`Ada${uniq()}`);
const bob = await signup(`Bob${uniq()}`);

const adaTicket = await match(ada, STAKE, "eu");
check("an eu player gets an eu-1 ticket", adaTicket.status === 200 && adaTicket.server === "eu-1",
  `${adaTicket.status} ${adaTicket.server} ${adaTicket.error || ""}`);
check("and is told to connect there", adaTicket.url === `ws://localhost:${EU}`, adaTicket.url);
check("the answer is readable from the game's page", adaTicket.cors === "http://page.example",
  String(adaTicket.cors));

const bobTicket = await match(bob, STAKE, "us");
check("a us player gets a us-1 ticket", bobTicket.server === "us-1", bobTicket.server);

console.log("\n-- tickets across processes --");

const adaIn = await join(adaTicket.url, adaTicket.ticket);
check("eu-1 accepts a ticket the matchmaker issued",
  adaIn.welcome?.server === "eu-1" && adaIn.welcome?.room === adaTicket.room,
  JSON.stringify(adaIn.closed || adaIn.welcome?.server));
check("and escrows the stake the ticket names", (await money(ada)).pot === STAKE,
  `${(await money(ada)).pot}`);

const wrongDoor = await join(`ws://localhost:${EU}`, bobTicket.ticket);
check("a ticket for us-1 is refused at eu-1", wrongDoor.closed?.code === 4003,
  JSON.stringify(wrongDoor.closed));
const bobIn = await join(bobTicket.url, bobTicket.ticket);
check("and accepted where it belongs", bobIn.welcome?.server === "us-1");

console.log("\n-- one server per player --");

{
  const again = await match(ada, STAKE, "us");
  check("while ada plays on eu-1, asking for us still sends her to eu-1", again.server === "eu-1",
    `${again.server} ${again.error || ""}`);

  // The matchmaker will not issue it, so forge the one ticket that would let
  // a second server move ada's money: a real reservation on us-1, signed
  // with the real secret. The seat lease is what has to stop it.
  const claims = JSON.parse(Buffer.from(adaTicket.ticket.split(".")[0], "base64url"));
  const body = JSON.stringify({ account: claims.acct, stake: STAKE });
  const rsv = await (await fetch(`http://localhost:${US}/internal/reserve`, {
    method: "POST", headers: { "Content-Type": "application/json",
      "X-Match-Signature": signRequest("/internal/reserve", body, SECRET) }, body
  })).json();
  const forged = signTicket({ ...claims, srv: "us-1", room: rsv.room, rsv: rsv.rsv, exp: Date.now() + 20_000 }, SECRET);
  const second = await join(`ws://localhost:${US}`, forged);
  check("a second server cannot take a player another server holds",
    second.closed?.code === 4004, JSON.stringify(second.closed));
  check("and ada's stake is untouched", (await money(ada)).pot === STAKE, `${(await money(ada)).pot}`);
  check("and she is still playing on eu-1", adaIn.ws.readyState === WebSocket.OPEN);
}

console.log("\n-- a reconnect finds its own body --");

{
  adaIn.ws.send(JSON.stringify({ type: "ready", ready: true }));
  await sleep(1600);                            // the count, plus margin
  const live = (await (await fetch(`http://localhost:${EU}/health`)).json())
    .rooms.find(r => r.id === adaTicket.room);
  check("ada's round is live on eu-1", live?.phase === "live", live?.phase);

  const nid = adaIn.welcome.nid;
  adaIn.ws.terminate();                         // no goodbye, as a dropped link
  await sleep(150);
  const back = await match(ada, STAKE, "us");
  check("the matchmaker sends her back to eu-1, not to the region she asked for",
    back.server === "eu-1", back.server);
  const again = await join(back.url, back.ticket);
  check("where she steps back into the same body",
    again.welcome?.nid === nid && again.welcome?.room === adaTicket.room,
    `${nid} -> ${again.welcome?.nid}`);
  check("still staked once", (await money(ada)).pot === STAKE, `${(await money(ada)).pot}`);
  adaIn.ws = again.ws;
}

console.log("\n-- leaving frees the seat --");

{
  bobIn.ws.send(JSON.stringify({ type: "leave" }));
  await sleep(500);
  check("bob's stake came back when he left", (await money(bob)).pot === 0, `${(await money(bob)).pot}`);
  const fresh = await match(bob, STAKE, "eu");
  check("and he is placed by region again, not held to us-1", fresh.server === "eu-1", fresh.server);
}

console.log("\n-- a deploy restarts a server --");

// A deploy stops the old process after starting the new one, whose boot id
// differs, so it could not take the old one's seats until they lapsed — longer
// than a client keeps retrying. On SIGTERM a server hands its seats back.
{
  const before = await money(ada);
  let closeCode = null;
  adaIn.ws.on("close", code => { closeCode = code; });
  const stopped = new Promise(r => children.get("eu-1").on("exit", code => r(code)));
  children.get("eu-1").kill("SIGTERM");
  const code = await Promise.race([stopped, sleep(5000).then(() => "still running")]);
  children.delete("eu-1");
  check("eu-1 stops cleanly on SIGTERM", code === 0, String(code));
  check("telling ada it is restarting, which her client retries", closeCode === 1012, String(closeCode));

  const got = await match(ada, STAKE, "us");
  check("her seat was handed back, so she is placed at once",
    got.status === 200 && got.server === "us-1", `${got.status} ${got.server || got.code}`);
  const moved = got.ticket && await join(got.url, got.ticket);
  check("and plays on", moved?.welcome?.server === "us-1");
  const after = await money(ada);
  check("with the interrupted round's stake returned and one stake held",
    after.pot === STAKE && after.balance + after.pot === before.balance + before.pot,
    `pot ${after.pot}, total ${before.balance + before.pot} -> ${after.balance + after.pot}`);
  adaIn.ws = moved?.ws;
}

// Back up under the same id, as the deploy's new process would be.
await game("eu-1", "eu", EU);

console.log("\n-- a server dies holding a stake --");

{
  const before = await money(ada);
  check("ada has her stake in escrow on us-1", before.pot === STAKE, `${before.pot}`);
  children.get("us-1").kill("SIGKILL");
  children.delete("us-1");
  await sleep(200);

  const early = await match(ada, STAKE, "eu");
  check("while her seat's lease runs, she is not given to another server",
    early.status === 503 && early.code === "unavailable", `${early.status} ${early.code}`);

  // The dead server stops renewing, so the lease lapses by itself.
  let placed = null;
  for (let t = 0; t < (SEAT_TTL + 5) * 1000 && !placed; t += 250) {
    const got = await match(ada, STAKE, "eu");
    if (got.status === 200) placed = got; else await sleep(250);
  }
  check("once it lapses she can play elsewhere", placed?.server === "eu-1", placed?.server);

  const rejoined = placed && await join(placed.url, placed.ticket);
  check("the restarted eu-1 takes her in", rejoined?.welcome?.server === "eu-1");
  const after = await money(ada, EU);
  check("the dead server's escrow was returned, and exactly one stake is held",
    after.pot === STAKE, `pot ${after.pot}`);
  check("no money appeared or vanished", after.balance + after.pot === before.balance + before.pot,
    `${before.balance + before.pot} -> ${after.balance + after.pot}`);
  rejoined?.ws.close();
}

for (const c of children.values()) c.kill("SIGKILL");
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
