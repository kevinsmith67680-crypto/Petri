// ---------------------------------------------------------------------------
// A client that stops reading is not sent snapshots it cannot take. Run with:
//   node test/backlog.test.js
//
// Boots the real server against a stubbed `ws`, as rooms.test.js does. A
// socket whose send buffer is past SEND_BACKLOG gets no snapshot that tick,
// and none is encoded for it either, so its delta state still matches what
// it was last sent: when it drains, the stream picks up where it left off,
// with no pellet added twice and none removed that it never had. Everyone
// else is unaffected.
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

const PORT = 9100 + (process.pid % 200);
process.env.PORT = String(PORT);
process.env.TEST_MODE = "1";
process.env.MATCH_BURST = "1000";
process.env.BOTS = "20";
process.env.ROUND_SECONDS = "30";
process.env.COUNTDOWN_SECONDS = "1";
process.env.HOLD_SECONDS = "1";
process.env.ALLOWED_ORIGINS = "";

await import("../server/index.js");
await new Promise(r => setTimeout(r, 400));
const { PROTOCOL_VERSION, PHASE_LIVE, decodeSnapshot } = await import("../shared/protocol.js");

const req = { headers: {}, socket: { remoteAddress: "10.0.0.2", setNoDelay() {} } };

// A socket that can be told it has a backlog, and that folds every snapshot
// into the pellet set a client keeps.
class FakeWS {
  constructor() { this.OPEN = 1; this.readyState = 1; this.h = {}; this.bufferedAmount = 0; this.snaps = []; this.pellets = new Set(); this.errors = []; }
  on(t, fn) { (this.h[t] ||= []).push(fn); }
  send(d) {
    if (typeof d === "string") return;
    const s = decodeSnapshot(d);
    this.snaps.push(s);
    if (s.keyframe) this.pellets.clear();
    for (const p of s.added) { if (this.pellets.has(p.id)) this.errors.push(`tick ${s.tick}: ${p.id} added twice`); this.pellets.add(p.id); }
    for (const id of s.removed) { if (!this.pellets.delete(id)) this.errors.push(`tick ${s.tick}: ${id} removed, never added`); }
  }
  close() { this.readyState = 3; }
  ping() {} terminate() {}
  async deliver(o) { for (const fn of this.h.message || []) await fn(JSON.stringify(o), false); }
}

const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));
const health = async () => (await (await fetch(`http://localhost:${PORT}/health`)).json());

async function join(username) {
  const token = await (await fetch(`http://localhost:${PORT}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123", displayName: username, dateOfBirth: "1990-01-01" })
  })).json().then(d => d.token);
  const got = await (await fetch(`http://localhost:${PORT}/api/match`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ stake: 1_000_000 })
  })).json();
  const ws = new FakeWS();
  globalThis.__wss.emit("connection", ws, req);
  await ws.deliver({ type: "join", ticket: got.ticket, protocol: PROTOCOL_VERSION });
  return ws;
}

const slow = await join("slowpoke");
const fast = await join("quick");
await slow.deliver({ type: "ready", ready: true });
await fast.deliver({ type: "ready", ready: true });
for (let i = 0; i < 60 && !slow.snaps.some(s => s.round.phase === PHASE_LIVE); i++) await settle(100);
await settle(500);

// The health request first: a tick can run while it is in flight, and one run
// after the counts were taken would send an ordinary snapshot that then looks
// like one sent while backed up. Nothing awaits between the counts and the
// backlog.
const heldBefore = (await health()).tick.snapshotsHeld;
const before = { slow: slow.snaps.length, fast: fast.snaps.length, held: heldBefore };
slow.bufferedAmount = 10 * 1024 * 1024;     // ten megabytes queued: well past the limit
await settle(1000);
const during = { slow: slow.snaps.length, fast: fast.snaps.length, held: (await health()).tick.snapshotsHeld };
slow.bufferedAmount = 0;
await settle(1000);
const after = { slow: slow.snaps.length, fast: fast.snaps.length };

check("a backed-up socket is sent nothing", during.slow === before.slow, `${during.slow - before.slow} sent while backed up`);
check("and the server counts what it held back", during.held - before.held >= 15, `${during.held - before.held} held`);
check("everyone else carries on", during.fast - before.fast >= 15, `${during.fast - before.fast} sent to the other client`);
check("once drained, snapshots resume", after.slow - during.slow >= 15, `${after.slow - during.slow} sent after`);
const gap = slow.snaps[during.slow].tick - slow.snaps[during.slow - 1].tick;
check("skipping the ticks in between", gap >= 15, `tick ${slow.snaps[during.slow - 1].tick} then ${slow.snaps[during.slow].tick}`);
check("with the pellet stream still consistent across the gap", !slow.errors.length && !fast.errors.length,
  [...slow.errors, ...fast.errors].slice(0, 3).join("; "));

if (createdStub) {
  fs.rmSync(stubDir, { recursive: true, force: true });
  const nm = path.dirname(stubDir);
  try { if (fs.readdirSync(nm).length === 0) fs.rmdirSync(nm); } catch { /* fine */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
