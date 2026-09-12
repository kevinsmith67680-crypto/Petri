// ---------------------------------------------------------------------------
// Reconnecting mid-round. Run with:  node test/resume.test.js
//
// Boots the real server against a stubbed `ws` and drives an actual drop and
// rejoin through the connection handler.
//
// Two things are being pinned, and they are different failures wearing the
// same coat.
//
//   * The run used to end with the socket. The old player was deleted and a
//     fresh one spawned at starting mass, so a two-second blip on a train was
//     indistinguishable from being eaten, and the body you had spent the round
//     growing was left standing for somebody else to take.
//
//   * The stake used to be handed back. A dropped player's escrow is refunded
//     when the linger timer expires, and the refund takes whatever is in
//     escrow AT THAT MOMENT. Rejoining inside the window re-locked a stake and
//     then watched the stale timer refund it a few seconds later — so the
//     player carried on playing a paid room with nothing at risk.
//
// This needs a round that does not end underneath it, which is why it boots
// its own server rather than joining the one in rooms.test.js.
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

const PORT = 8900 + (process.pid % 200);
process.env.PORT = String(PORT);
process.env.TEST_MODE = "1";
// A long round, so nothing here races a settlement, and no bots, so the count
// of bodies in the arena means what it says.
process.env.ROUND_SECONDS = "60";
process.env.INTERMISSION_SECONDS = "1";
process.env.BOTS = "0";
// Short enough to watch the window close within the test.
process.env.LINGER_SEC = "3";

await import("../server/index.js");
await new Promise(r => setTimeout(r, 400));

const { PROTOCOL_VERSION } = await import("../shared/protocol.js");

const req = { headers: {}, socket: { remoteAddress: "10.0.0.2", setNoDelay() {} } };

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

const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));
const room = async id =>
  (await (await fetch(`http://localhost:${PORT}/health`)).json()).rooms.find(r => r.mode === id);

const tok = await (await fetch(`http://localhost:${PORT}/api/signup`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "dropper", password: "password123",
    displayName: "Dropper", dateOfBirth: "1990-01-01"
  })
})).json().then(d => d.token);

const money = async () => (await (await fetch(`http://localhost:${PORT}/api/me`, {
  headers: { Authorization: `Bearer ${tok}` }
})).json());

const STAKE = 1_000_000;
const enter = async () => {
  const ws = new FakeWS();
  globalThis.__wss.emit("connection", ws, req);
  await ws.deliver({ type: "join", name: "Dropper", stake: STAKE, token: tok, protocol: PROTOCOL_VERSION });
  await settle();
  return ws;
};
const texts = ws => ws.out.filter(m => m !== "<binary>").map(JSON.parse);
const welcome = ws => texts(ws).find(m => m.type === "welcome");

console.log("\n-- getting into a live round --");

const first = await enter();
check("the join was accepted", !first.closed, JSON.stringify(first.closed || {}));
check("and escrowed the stake", (await money()).pot === STAKE, `${(await money()).pot}`);

await first.deliver({ type: "ready", ready: true });
await settle(400);
const std = await room("standard");
check("the round is live", std.phase === "live", std.phase);
check("one body in the arena", std.inWorld === 1, `${std.inWorld}`);

const before = welcome(first);

console.log("\n-- the socket drops --");

await first.drop();
await settle(100);
let now = await room("standard");
check("the body is left standing, motionless and edible",
  now.lingering === 1, `${now.lingering} lingering`);
check("and is still in the arena", now.inWorld === 1, `${now.inWorld}`);
check("the escrow is untouched while away", (await money()).pot === STAKE);

console.log("\n-- and comes straight back --");

const second = await enter();
const after = welcome(second);
check("the same body is handed back, not a new one",
  after && before && after.nid === before.nid,
  `nid ${before?.nid} -> ${after?.nid}`);

now = await room("standard");
check("no second body was spawned", now.inWorld === 1, `${now.inWorld}`);
check("the lingering entry was claimed", now.lingering === 0, `${now.lingering} left`);
check("the player is in the round, not waiting in the lobby",
  now.phase === "live" && now.ready === 1, `${now.phase}, ready ${now.ready}`);
check("the escrow was never refunded and re-locked",
  (await money()).pot === STAKE, `${(await money()).pot}`);

console.log("\n-- the stale timer cannot un-stake the new run --");

await settle(3600);   // past LINGER_SEC
const held = (await money()).pot;
check("the stake is still at risk after the linger window",
  held === STAKE, `${held}`);
check("and the player is still playing", (await room("standard")).inWorld === 1);

console.log("\n-- a body that is gone is not resumed --");

// Nothing to come back to is the normal case, and it must still leave the
// books straight: one stake in escrow, no stale entry behind it.
{
  const third = await enter();          // evicts the second, escrow reused
  await third.drop();
  await settle(3600);                   // let the linger window expire fully
  check("the arena is empty again", (await room("standard")).inWorld === 0,
    `${(await room("standard")).inWorld}`);
  check("and the expired stake was returned", (await money()).pot === 0,
    `${(await money()).pot}`);

  const fourth = await enter();
  check("a fresh join escrows once", (await money()).pot === STAKE, `${(await money()).pot}`);
  check("and gets a new body", welcome(fourth).nid !== before.nid,
    `nid ${welcome(fourth).nid} vs ${before.nid}`);
  await fourth.drop();
}

if (createdStub) {
  fs.rmSync(stubDir, { recursive: true, force: true });
  const parent = path.dirname(stubDir);
  try { fs.rmdirSync(parent); } catch { /* other packages live there */ }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
