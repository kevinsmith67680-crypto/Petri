// ---------------------------------------------------------------------------
// Rooms on demand. Run with:  node test/factory.test.js
//
// Boots the real server against a stubbed `ws` and drives joins through the
// actual connection handler. Rooms are shrunk to two seats and the process to
// three rooms, so every edge of the factory is reachable with a few players.
//
// What is being pinned:
//
//   * A mode opens a second room only once its first is full, and the
//     process stops opening them at MAX_ROOMS.
//   * A newcomer is seated in a room between rounds before one mid-round.
//   * A reconnect goes back to the room its body is standing in, even when a
//     fresh arrival would have been seated elsewhere.
//   * An empty extra room closes, but not while a lingering body in it still
//     holds escrow, and a mode's last room never closes.
//   * A burst of simultaneous arrivals cannot overfill the last seat, now
//     that seats are reserved by the matchmaker and filled by the join.
//
// It boots its own server because it needs room sizes and a room cap that the
// other suites must not see.
// ---------------------------------------------------------------------------

import path from "node:path";
import fs from "node:fs";

// Stub `ws` on disk, because the server imports it by name. Written beside the
// project rather than into it, and removed afterwards.
const root = path.dirname(new URL(import.meta.url).pathname);
const stubDir = path.join(root, "..", "node_modules", "ws");
let createdStub = false;
if (!fs.existsSync(stubDir)) {
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "package.json"),
    JSON.stringify({ name: "ws", version: "0.0.0-test", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(stubDir, "index.js"),
    'import { EventEmitter } from "node:events";\n' +
    'export class WebSocketServer extends EventEmitter {\n' +
    '  constructor(o) { super(); this.options = o; globalThis.__wss = this; }\n' +
    '}\nexport default { WebSocketServer };\n');
  createdStub = true;
}

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const PORT = 9100 + (process.pid % 200);
process.env.PORT = String(PORT);
process.env.TEST_MODE = "1";
process.env.MATCH_BURST = "1000";
process.env.BOTS = "0";
process.env.LOBBY_MAX = "2";
process.env.MAX_ROOMS = "3";
// A long round, so nothing here races a settlement.
process.env.ROUND_SECONDS = "60";
process.env.COUNTDOWN_SECONDS = "1";
// Short enough to watch a room wait out its lingering bodies.
process.env.LINGER_SEC = "2";

await import("../server/index.js");
await new Promise(r => setTimeout(r, 400));

const { PROTOCOL_VERSION } = await import("../shared/protocol.js");

const req = { headers: {}, socket: { remoteAddress: "10.0.0.3", setNoDelay() {} } };

class FakeWS {
  static OPEN = 1;
  constructor() { this.OPEN = 1; this.readyState = 1; this.h = {}; this.out = []; }
  on(t, fn) { (this.h[t] ||= []).push(fn); }
  send(d) { this.out.push(typeof d === "string" ? d : "<binary>"); }
  close(code, why) { this.closed = { code, why }; this.readyState = 3; }
  ping() {} terminate() {}
  async deliver(o) { for (const fn of this.h.message || []) await fn(JSON.stringify(o), false); }
  async drop() { for (const fn of this.h.close || []) await fn(); }
}

const STANDARD = 1_000_000;
const HIGH = 2_000_000;

const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));
const health = async () => (await (await fetch(`http://localhost:${PORT}/health`)).json());
const roomIds = async () => (await health()).rooms.map(r => r.id);
const roomById = async id => (await health()).rooms.find(r => r.id === id);
const texts = ws => ws.out.filter(m => m !== "<binary>").map(JSON.parse);
const welcome = ws => texts(ws).find(m => m.type === "welcome");
const seatOf = ws => welcome(ws)?.room ?? null;

async function signup(username) {
  return (await fetch(`http://localhost:${PORT}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123", displayName: username, dateOfBirth: "1990-01-01" })
  })).json().then(d => d.token);
}

const money = async token => (await (await fetch(`http://localhost:${PORT}/api/me`, {
  headers: { Authorization: `Bearer ${token}` }
})).json());

// Asks the matchmaker for a seat and joins with the ticket, as the client
// does, without waiting for either, so several can be in flight at once. A
// refusal from the matchmaker is kept as `refused`: no socket is opened.
function connect(token, stake) {
  const ws = new FakeWS();
  ws.joined = (async () => {
    const res = await fetch(`http://localhost:${PORT}/api/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ stake })
    });
    const got = await res.json();
    if (!res.ok) { ws.refused = { status: res.status, ...got }; return; }
    globalThis.__wss.emit("connection", ws, req);
    await ws.deliver({ type: "join", ticket: got.ticket, protocol: PROTOCOL_VERSION });
  })();
  return ws;
}

async function enter(token, stake = STANDARD) {
  const ws = connect(token, stake);
  await ws.joined;
  await settle();
  return ws;
}

const tokens = {};
for (const name of ["ada", "bob", "cyd", "dee", "eve", "hal", "ivy", "joy", "kit"]) {
  tokens[name] = await signup(name);
}

console.log("\n-- one room per mode to start with --");

{
  const h = await health();
  check("each mode has its first room open",
    JSON.stringify(h.rooms.map(r => r.id)) === JSON.stringify(["standard-1", "highstakes-1"]),
    JSON.stringify(h.rooms.map(r => r.id)));
  check("and the cap is reported", h.maxRooms === 3, String(h.maxRooms));
  check("rooms are sized by LOBBY_MAX", h.rooms.every(r => r.cap === 2),
    JSON.stringify(h.rooms.map(r => r.cap)));
}

console.log("\n-- a second room opens only once the first is full --");

const ada = await enter(tokens.ada);
const bob = await enter(tokens.bob);
check("the first two arrivals share the first room",
  seatOf(ada) === "standard-1" && seatOf(bob) === "standard-1",
  `${seatOf(ada)}, ${seatOf(bob)}`);
check("and no other room has opened", (await roomIds()).length === 2);

const cyd = await enter(tokens.cyd);
check("the third opens standard-2", seatOf(cyd) === "standard-2", String(seatOf(cyd)));
check("and it is reported", (await roomIds()).includes("standard-2"), JSON.stringify(await roomIds()));

const dee = await enter(tokens.dee);
check("the fourth fills it rather than opening another", seatOf(dee) === "standard-2",
  String(seatOf(dee)));

console.log("\n-- the process stops at MAX_ROOMS --");

{
  const eve = await enter(tokens.eve);
  check("a fifth Standard arrival is turned away by the matchmaker",
    eve.refused?.code === "full", JSON.stringify(eve.refused || {}));
  check("before any socket is opened", !welcome(eve) && eve.out.length === 0);
  check("and told why", /full/i.test(eve.refused?.error || ""), eve.refused?.error || "—");
  check("no fourth room was opened", (await roomIds()).length === 3,
    JSON.stringify(await roomIds()));
  check("nothing was escrowed for the refused join", (await money(tokens.eve)).pot === 0,
    `${(await money(tokens.eve)).pot}`);

  // The cap stops new rooms, not seats in rooms that already exist.
  const hal = await enter(tokens.hal, HIGH);
  check("High stakes still seats people in its own room", seatOf(hal) === "highstakes-1",
    String(seatOf(hal)));
}

console.log("\n-- a room between rounds is preferred to one mid-round --");

await ada.deliver({ type: "ready", ready: true });
await settle(1500);                       // the count, plus margin
check("standard-1 is live", (await roomById("standard-1"))?.phase === "live",
  (await roomById("standard-1"))?.phase);

await bob.drop();
await dee.drop();
await settle();
// standard-1: live, ada playing, one seat free.
// standard-2: in the lobby, cyd waiting, one seat free.

console.log("\n-- a reconnect goes back to its own body --");

{
  const before = welcome(ada);
  await ada.drop();
  await settle(100);
  check("ada's body is lingering in standard-1",
    (await roomById("standard-1"))?.lingering >= 1);

  // A fresh arrival would be seated in standard-2, which is between rounds.
  // Ada's body is standing in standard-1, and that is where she has to go.
  const back = await enter(tokens.ada);
  check("she is returned to standard-1, not seated in standard-2",
    seatOf(back) === "standard-1", String(seatOf(back)));
  check("as the same body, not a fresh spawn", welcome(back)?.nid === before?.nid,
    `${before?.nid} -> ${welcome(back)?.nid}`);

  const eve = await enter(tokens.eve);
  check("while a fresh arrival does go to the room between rounds",
    seatOf(eve) === "standard-2", String(seatOf(eve)));

  console.log("\n-- an empty extra room closes, once its escrow is settled --");

  const cydBefore = await money(tokens.cyd);
  await cyd.drop();
  await eve.drop();
  await settle(300);
  check("it stays open while its bodies linger",
    (await roomIds()).includes("standard-2"), JSON.stringify(await roomIds()));
  check("and cyd's stake is still in escrow", (await money(tokens.cyd)).pot === STANDARD,
    `${(await money(tokens.cyd)).pot}`);

  await settle(2500);                     // the linger window, plus margin
  check("then it closes", !(await roomIds()).includes("standard-2"),
    JSON.stringify(await roomIds()));
  const cydAfter = await money(tokens.cyd);
  check("and the lingering stake was refunded before it did",
    cydAfter.pot === 0 && cydAfter.balance === cydBefore.balance + STANDARD,
    `pot ${cydAfter.pot}, balance ${cydBefore.balance} -> ${cydAfter.balance}`);

  console.log("\n-- a mode's last room never closes --");

  await back.drop();
  await settle(2800);
  const s1 = await roomById("standard-1");
  check("standard-1 is empty", s1 && s1.players === 0 && s1.lingering === 0,
    s1 ? `${s1.players} players, ${s1.lingering} lingering` : "gone");
  check("and still open", !!s1);
}

console.log("\n-- a reopened room gets a fresh number --");

const again = [await enter(tokens.ada), await enter(tokens.bob), await enter(tokens.cyd)];
check("the first two fill standard-1",
  seatOf(again[0]) === "standard-1" && seatOf(again[1]) === "standard-1",
  `${seatOf(again[0])}, ${seatOf(again[1])}`);
check("and the overflow is standard-3, never a second standard-2",
  seatOf(again[2]) === "standard-3", String(seatOf(again[2])));

console.log("\n-- a burst of arrivals cannot overfill the last seat --");

{
  // standard-3 has one seat left and the process is at its cap, so of three
  // simultaneous arrivals exactly one may get in. The seat is reserved when
  // the ticket is issued and only filled when the ticket is presented, which
  // is the window a burst could otherwise fall through.
  const burst = [connect(tokens.dee, STANDARD), connect(tokens.ivy, STANDARD),
    connect(tokens.joy, STANDARD)];
  await Promise.all(burst.map(ws => ws.joined));
  await settle();

  const seated = burst.filter(ws => welcome(ws));
  const refused = burst.filter(ws => ws.refused?.code === "full");
  check("exactly one of three is seated", seated.length === 1, `${seated.length} seated`);
  check("and the other two are told the mode is full", refused.length === 2,
    `${refused.length} refused`);
  const s3 = await roomById("standard-3");
  check("standard-3 holds exactly its limit", s3 && s3.players === 2,
    s3 ? `${s3.players} players` : "gone");
  check("still three rooms", (await roomIds()).length === 3, JSON.stringify(await roomIds()));

  const kit = await enter(tokens.kit, HIGH);
  check("the other mode is unaffected", seatOf(kit) === "highstakes-1", String(seatOf(kit)));
}

if (createdStub) {
  fs.rmSync(stubDir, { recursive: true, force: true });
  const nm = path.dirname(stubDir);
  try { if (fs.readdirSync(nm).length === 0) fs.rmdirSync(nm); } catch { /* fine */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
