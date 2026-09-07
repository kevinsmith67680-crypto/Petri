// ---------------------------------------------------------------------------
// Rooms and bots. Run with:  node test/rooms.test.js
//
// Boots the real server against a stubbed `ws` and drives joins and departures
// through the actual connection handler, so the room logic is exercised rather
// than described.
//
// The thing being pinned: in test mode each room fills to the size its MODE is
// built for — 100 for Standard, 50 for High stakes — and only while somebody
// is in it. Populating empty rooms doubled the server's work for nobody's
// benefit, which mattered once there were two of them.
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

// Stub `ws` on disk, because the server imports it by name. Written beside the
// project rather than into it, and removed afterwards.
const require = createRequire(import.meta.url);
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

const PORT = 8700 + (process.pid % 200);
process.env.PORT = String(PORT);
process.env.TEST_MODE = "1";
delete process.env.BOTS;

await import("../server/index.js");
await new Promise(r => setTimeout(r, 400));

const req = { headers: {}, socket: { remoteAddress: "10.0.0.1", setNoDelay() {} } };

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

const health = async () => (await (await fetch(`http://localhost:${PORT}/health`)).json());
const room = async id => (await health()).rooms.find(r => r.mode === id);
const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));

async function join(username, stake) {
  const token = await (await fetch(`http://localhost:${PORT}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123", displayName: username })
  })).json().then(d => d.token);
  const ws = new FakeWS();
  globalThis.__wss.emit("connection", ws, req);
  await ws.deliver({ type: "join", name: username, stake, token });
  await settle();
  return ws;
}

console.log("\n-- each room is sized for its own mode --");

const std = await room("standard");
const high = await room("highstakes");
check("Standard targets 100 bots", std.botTarget === 100, String(std.botTarget));
check("High stakes targets 50 bots", high.botTarget === 50, String(high.botTarget));
check("Standard starts at 1 ready in test mode", std.startsAt === 1);

console.log("\n-- empty rooms stay empty --");

check("nothing is simulated in Standard", std.inWorld === 0, String(std.inWorld));
check("nothing is simulated in High stakes", high.inWorld === 0, String(high.inWorld));

console.log("\n-- bots arrive with the first player --");

const ada = await join("ada", 1_000_000);
check("the 1.00 join was accepted", !ada.closed, JSON.stringify(ada.closed || {}));

let s = await room("standard");
let h = await room("highstakes");
check("Standard fills to 100 bots plus the player", s.inWorld === 101, String(s.inWorld));
check("High stakes is untouched", h.inWorld === 0, String(h.inWorld));

const bob = await join("bob", 2_000_000);
h = await room("highstakes");
check("the 2.00 room fills to 50 plus the player", h.inWorld === 51, String(h.inWorld));
check("and Standard is unchanged", (await room("standard")).inWorld === 101);

console.log("\n-- and leave with the last one --");

await ada.drop();
await settle(300);
s = await room("standard");
// The departing player lingers briefly, motionless and edible, so the world
// is not quite empty for a few seconds.
check("Standard sheds its bots", s.inWorld <= 1, `${s.inWorld} left`);
check("High stakes keeps its own", (await room("highstakes")).inWorld === 51);

console.log("\n-- the ready flow still starts a round --");

const before = bob.out.length;
await bob.deliver({ type: "ready", ready: true });
await settle(300);
const msgs = bob.out.slice(before).filter(m => m !== "<binary>");
check("readying one player starts the round",
  msgs.some(m => m.includes("round_start")), msgs.join(" ").slice(0, 120) || "nothing");
check("the room reports itself live", (await room("highstakes")).phase === "live");

if (createdStub) fs.rmSync(stubDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
