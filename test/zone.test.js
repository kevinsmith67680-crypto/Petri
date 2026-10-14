// ---------------------------------------------------------------------------
// The closing zone, through the real server. Run with:  node test/zone.test.js
//
// shared/sim.js owns the rule and test/sim.test.js pins it. This file pins the
// parts only the server does: planning a zone when a round opens, sending it
// on the snapshot clock, taking it away at the whistle, and settling a player
// the zone drains as nobody's kill — a stake forfeited, a match recorded as
// 'zone', and nothing paid to whoever bit them earlier.
//
// Boots the real server against a stubbed `ws`, as test/rooms.test.js does.
// ---------------------------------------------------------------------------

import path from "node:path";
import fs from "node:fs";

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

const PORT = 9500 + (process.pid % 200);
process.env.PORT = String(PORT);
process.env.TEST_MODE = "1";
process.env.MATCH_BURST = "1000";
// Shorter than the zone's 1:40, so it is announced as the round opens and
// closes from ten seconds in to the whistle: the short-round path, which a
// short ROUND_SECONDS takes. Long enough after that for a cell that has eaten
// its way to a corner to be drained away with seconds to spare.
process.env.ROUND_SECONDS = "28";
process.env.COUNTDOWN_SECONDS = "1";
process.env.STANDINGS_SECONDS = "1";
// Nobody to be eaten by: the only way this player dies is the zone. What bots
// do about the zone is test/sim.test.js's business.
process.env.BOTS = "0";

await import("../server/index.js");
await new Promise(r => setTimeout(r, 400));

const {
  PROTOCOL_VERSION, PHASE_LIVE, ZONE_WARNING, ZONE_CLOSING, decodeSnapshot, encodeAim
} = await import("../shared/protocol.js");
const { STAKE_2_USDC } = await import("../shared/wager.js");

const req = { headers: {}, socket: { remoteAddress: "10.0.0.9", setNoDelay() {} } };

class FakeWS {
  static OPEN = 1;
  constructor() { this.OPEN = 1; this.readyState = 1; this.h = {}; this.out = []; this.bin = []; }
  on(t, fn) { (this.h[t] ||= []).push(fn); }
  send(d) {
    if (typeof d === "string") this.out.push(JSON.parse(d));
    else this.bin.push(decodeSnapshot(d));
  }
  close(code, why) { this.closed = { code, why }; this.readyState = 3; }
  ping() {} terminate() {}
  async deliver(o) { for (const fn of this.h.message || []) await fn(JSON.stringify(o), false); }
  async binary(b) { for (const fn of this.h.message || []) await fn(Buffer.from(b), true); }
}

const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));
const until = async (cond, ms = 15000) => {
  for (let t = 0; t < ms && !(await cond()); t += 50) await settle(50);
  return cond();
};
const api = (route, token, body) => fetch(`http://localhost:${PORT}/api/${route}`, {
  method: body ? "POST" : "GET",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined
}).then(r => r.json());

const token = (await api("signup", null, {
  username: "stray", password: "password123", displayName: "Stray", dateOfBirth: "1990-01-01"
})).token;
const { ticket } = await api("match", token, { stake: STAKE_2_USDC });
const ws = new FakeWS();
globalThis.__wss.emit("connection", ws, req);
await ws.deliver({ type: "join", ticket, protocol: PROTOCOL_VERSION });
await settle();
await ws.deliver({ type: "ready", ready: true });

console.log("\n-- the zone rides on the round --");

const started = await until(() => ws.out.some(m => m.type === "round_start"));
check("a round starts", started);
const live = () => ws.bin.filter(s => s.round.phase === PHASE_LIVE && s.me.alive);
await until(() => live().length > 0);
const first = live()[0];
check("a round shorter than 1:30 announces the zone as it opens",
  first?.zone?.state === ZONE_WARNING && first.zone.secs === 10,
  JSON.stringify(first?.zone && { state: first.zone.state, secs: first.zone.secs }));
const to = first?.zone?.to;
const size = first?.world;
check("naming a square 60% of the arena, inside it",
  to && to.x1 - to.x0 === Math.round(size * 0.6) && to.x0 >= 0 && to.x1 <= size,
  JSON.stringify(to));

// Away from the square, as far as the arena goes: into the corner on whichever
// side of it has more room. The aim is an offset from the cell, so a long one
// just keeps it pressed against the walls.
const away = { x: to.x0 > size - to.x1 ? -3000 : 3000, y: to.y0 > size - to.y1 ? -3000 : 3000 };
await ws.binary(encodeAim(away.x, away.y));

const closing = await until(() => ws.bin.some(s => s.zone?.state === ZONE_CLOSING));
check("ten seconds later its edges start to move", closing);

console.log("\n-- a player caught outside --");

const died = await until(() => ws.bin.some(s => s.round.phase === PHASE_LIVE && s.zone && !s.me.alive), 16000);
check("is drained away before the whistle", died);
const forfeited = await until(() => ws.out.some(m => m.type === "account" && m.pot === 0 && !m.staked));
check("and their stake goes, as it would to a bot", forfeited);

const ended = await until(() => ws.out.some(m => m.type === "round_end"));
check("the round ends", ended);
const after = ws.bin.length;
await settle(400);
check("and the zone goes with it", ws.bin.slice(after).every(s => !s.zone),
  `${ws.bin.slice(after).filter(s => s.zone).length} snapshots still carry it`);

const stats = await api("stats", token);
const match = stats.matches?.[0];
check("the run is recorded as a zone death", match?.outcome === "zone", match?.outcome);
check("with no killer, and nothing paid", match && !match.killerId && !match.payout,
  JSON.stringify({ killer: match?.killerId, payout: match?.payout }));

if (createdStub) {
  fs.rmSync(stubDir, { recursive: true, force: true });
  const nm = path.dirname(stubDir);
  try { if (fs.readdirSync(nm).length === 0) fs.rmdirSync(nm); } catch { /* fine */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
