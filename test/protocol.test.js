// ---------------------------------------------------------------------------
// Protocol tests. Run with:  node test/protocol.test.js
//
// Three things are being checked here:
//   1. The codec refuses malformed input instead of allocating from it.
//   2. Deltas plus keyframes reconstruct the same state a full send would.
//   3. The scoping rules actually hold — a client cannot accumulate a map,
//      and cannot detect events outside its own view.
//
// (3) is the reason the delta protocol needed care at all, so it gets the
// most attention.
// ---------------------------------------------------------------------------

import { Reader, Writer } from "../shared/codec.js";
import {
  encodeSnapshot, decodeSnapshot, encodeAim, encodeAction,
  decodeClientMessage, createClientState, viewRadius, KEYFRAME_TICKS
} from "../shared/protocol.js";
import {
  createWorld, addPlayer, fillBots, stepWorld, TICK_HZ, centroid
} from "../shared/sim.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}
function throws(label, fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(label, threw);
}

console.log("\n-- codec --");

const w = new Writer(8);
w.u8(200).u16(60000).u32(4000000000).i16(-1234).f32(1.5).str("hello");
const r = new Reader(w.bytes());
check("round-trips scalars",
  r.u8() === 200 && r.u16() === 60000 && r.u32() === 4000000000 &&
  r.i16() === -1234 && Math.abs(r.f32() - 1.5) < 1e-6 && r.str() === "hello");
check("consumes exactly", r.remaining === 0);

throws("reading past the end throws", () => new Reader(new Uint8Array(2)).u32());
throws("truncated string throws", () => {
  const t = new Writer(4); t.u8(200);          // claims 200 bytes, supplies none
  new Reader(t.bytes()).str();
});
throws("trailing bytes rejected", () => {
  const t = new Writer(4); t.u8(1).u8(9);
  const rr = new Reader(t.bytes()); rr.u8(); rr.end();
});

// The allocation-DoS guard: a huge count must be rejected against the bytes
// actually present, before any array is built.
throws("absurd count rejected before allocating", () => {
  const t = new Writer(8); t.u16(65535);       // claims 65535 records
  const rr = new Reader(t.bytes());
  rr.expect(rr.u16(), 13);
});
check("honest count accepted", (() => {
  const t = new Writer(16); t.u16(2).u32(1).u32(2);
  const rr = new Reader(t.bytes());
  try { return rr.expect(rr.u16(), 4) === 2; } catch { return false; }
})());

console.log("\n-- client -> server --");

const aim = decodeClientMessage(encodeAim(-3000, 2500));
check("aim round-trips", aim.x === -3000 && aim.y === 2500);
check("aim frame is 5 bytes", encodeAim(1, 1).length === 5, `${encodeAim(1,1).length}`);
check("action round-trips", decodeClientMessage(encodeAction("split")).action === "split");
check("unknown action not encodable", encodeAction("nuke") === null);
throws("unknown action index rejected", () => decodeClientMessage(new Uint8Array([3, 99])));
throws("unknown message type rejected", () => decodeClientMessage(new Uint8Array([77, 0])));
throws("truncated aim rejected", () => decodeClientMessage(new Uint8Array([2, 0])));
throws("empty frame rejected", () => decodeClientMessage(new Uint8Array([])));

// Fuzz: random bytes must always throw, never hang or return junk.
let survived = 0;
for (let i = 0; i < 4000; i++) {
  const len = 1 + Math.floor(Math.random() * 24);
  const buf = new Uint8Array(len);
  for (let j = 0; j < len; j++) buf[j] = Math.floor(Math.random() * 256);
  try { decodeClientMessage(buf); survived++; } catch { /* expected */ }
}
check("random frames never yield junk commands", survived < 4000 * 0.02,
  `${survived}/4000 parsed (all must be structurally valid aims/actions)`);

console.log("\n-- snapshot deltas --");

const world = createWorld(77);
const me = addPlayer(world, { id: "me", name: "Tester" });
fillBots(world, 12);
for (let i = 0; i < TICK_HZ * 10; i++) stepWorld(world, 1 / TICK_HZ);

const cs = createClientState(0);
const cache = new Map();
let sawKeyframe = false;

function applyTo(map, snap) {
  if (snap.keyframe) map.clear();
  for (const p of snap.added) map.set(p.id, p);
  for (const id of snap.removed) map.delete(id);
}

for (let i = 0; i < TICK_HZ * 30; i++) {
  stepWorld(world, 1 / TICK_HZ);
  const snap = decodeSnapshot(encodeSnapshot(world, me, cs));
  if (snap.keyframe) sawKeyframe = true;
  applyTo(cache, snap);
}

check("keyframes are emitted", sawKeyframe);

// The cache the client built must equal exactly what is in view right now.
const c = centroid(me);
const R = viewRadius(me);
const truth = new Set(
  world.pellets.filter(p => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 < R * R).map(p => p.id)
);
const cached = new Set(cache.keys());
const missing = [...truth].filter(id => !cached.has(id));
const extra = [...cached].filter(id => !truth.has(id));
check("delta cache matches the true in-view set",
  missing.length === 0 && extra.length === 0,
  `${missing.length} missing, ${extra.length} extra`);

console.log("\n-- scoping rules --");

// RULE 1: moving around must not accumulate a map. After a long tour of the
// arena, the client's knowledge must still be bounded by its view radius.
const tourWorld = createWorld(5);
const tourist = addPlayer(tourWorld, { id: "me", name: "Tourist" });
fillBots(tourWorld, 8);
const tourCs = createClientState(0);
const tourCache = new Map();

for (let i = 0; i < TICK_HZ * 60; i++) {
  // Drive a wide circle, which is exactly how you would try to farm a map.
  const ang = (i / (TICK_HZ * 60)) * Math.PI * 2;
  const cell = tourist.cells[0];
  if (cell) { cell.x = 1700 + Math.cos(ang) * 1200; cell.y = 1700 + Math.sin(ang) * 1200; }
  stepWorld(tourWorld, 1 / TICK_HZ);
  applyTo(tourCache, decodeSnapshot(encodeSnapshot(tourWorld, tourist, tourCs)));
}

const tc = centroid(tourist);
const tR = viewRadius(tourist);
const outsideView = [...tourCache.values()].filter(
  p => (p.x - tc.x) ** 2 + (p.y - tc.y) ** 2 > tR * tR * 1.05
);
check("a full tour of the arena reveals nothing outside the view radius",
  outsideView.length === 0,
  `${outsideView.length} stale pellets retained of ${tourCache.size}`);
check("known set stays bounded", tourCache.size < tourWorld.pellets.length,
  `${tourCache.size} of ${tourWorld.pellets.length} total`);

// RULE 2: pellets eaten outside the view must produce no traffic at all.
// Park the observer in a corner, force-feed a bot in the far corner, and
// confirm the observer hears nothing.
const quiet = createWorld(31);
const observer = addPlayer(quiet, { id: "obs", name: "Obs" });
const eater = addPlayer(quiet, { id: "eat", name: "Eater" });
observer.cells[0].x = 200; observer.cells[0].y = 200;
eater.cells[0].x = 3200; eater.cells[0].y = 3200;
eater.cells[0].mass = 400;

const qcs = createClientState(0);
encodeSnapshot(quiet, observer, qcs);          // establish a baseline

let removalsHeard = 0, addsHeard = 0;
for (let i = 0; i < 60; i++) {
  // Keep both parked; the eater sits on the far side hoovering up orbs.
  observer.cells[0].x = 200; observer.cells[0].y = 200;
  eater.cells[0].x = 3200; eater.cells[0].y = 3200;
  stepWorld(quiet, 1 / TICK_HZ);
  const snap = decodeSnapshot(encodeSnapshot(quiet, observer, qcs));
  if (!snap.keyframe) { removalsHeard += snap.removed.length; addsHeard += snap.added.length; }
}
check("a stationary observer hears nothing about the far corner",
  removalsHeard === 0 && addsHeard === 0,
  `${addsHeard} adds, ${removalsHeard} removals`);
check("the eater was actually eating meanwhile", eater.orbs > 0, `${eater.orbs} orbs`);

// The observer must not be told the far-corner player's name either.
const farSnap = decodeSnapshot(encodeSnapshot(quiet, observer, qcs));
const leakedName = farSnap.names.some(n => n.name === "Eater");
check("out-of-view player names are not sent", !leakedName);

console.log("\n-- spectating --");

// A dead player has no cells, so without an eye the area-of-interest query has
// nothing to centre on and the snapshot comes back empty. These assertions are
// the whole reason encodeSnapshot takes an eye.
const spec = createWorld(101);
const ghost = addPlayer(spec, { id: "ghost", name: "Ghost" });
const star = addPlayer(spec, { id: "star", name: "Star" });
fillBots(spec, 4);

star.cells[0].x = 6000; star.cells[0].y = 6000; star.cells[0].mass = 300;
ghost.cells[0].x = 500; ghost.cells[0].y = 500;
stepWorld(spec, 1 / TICK_HZ);

// Kill the ghost the way the simulation would.
ghost.cells = [];
ghost.alive = false;

const blind = decodeSnapshot(encodeSnapshot(spec, ghost, createClientState(0), null, null));
check("a dead player with no eye sees nothing", blind.cells.length === 0, `${blind.cells.length} cells`);
check("and is not marked as spectating", blind.spectating === false);

const watching = decodeSnapshot(encodeSnapshot(spec, ghost, createClientState(0), null, star));
check("with an eye they see the watched player", watching.cells.some(c => c.mine),
  `${watching.cells.length} cells`);
check("the snapshot is flagged as spectating", watching.spectating === true);
check("it names whose eyes are borrowed", watching.eyeNid === star.nid);
check("the view is centred on the target",
  Math.abs(watching.me.x - 6000) < 200 && Math.abs(watching.me.y - 6000) < 200,
  `${watching.me.x},${watching.me.y}`);
check("stats describe the target, not the corpse",
  watching.me.mass >= 300 && watching.me.alive === true, `mass ${watching.me.mass}`);

// Scoping still applies: a spectator inherits the target's view radius, not a
// free view of the whole arena.
const starR = viewRadius(star);
const outside = watching.cells.filter(c =>
  Math.hypot(c.x - 6000, c.y - 6000) > starR * 1.3);
check("a spectator sees no further than the target does", outside.length === 0,
  `${outside.length} cells beyond the radius`);
check("pellets are culled to the target too",
  watching.added.every(p => Math.hypot(p.x - 6000, p.y - 6000) <= starR * 1.1),
  `${watching.added.length} pellets`);

// Watching a dead target must fall back rather than showing an empty world.
const deadStar = addPlayer(spec, { id: "dead", name: "Dead" });
deadStar.cells = [];
deadStar.alive = false;
const fallback = decodeSnapshot(encodeSnapshot(spec, ghost, createClientState(0), null, deadStar));
check("watching a dead target falls back to self", fallback.spectating === false);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
