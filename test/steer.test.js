// ---------------------------------------------------------------------------
// Distance-based steering. Run with:  node test/steer.test.js
//
// The cursor's distance from your cell sets how much of your top speed you
// steer at: none on the cell, all of it at the full-speed distance, never
// more. These checks hold that curve to its promises, and hold everything
// around it — the top speed itself, bots, split impulses, eating, scoring —
// to exactly what it was before.
//
// "Exactly" is checked against a copy of the old movement rule kept in this
// file, not imported, so it cannot drift along with the code it guards.
// ---------------------------------------------------------------------------

// One simulated clock for client and server, so the client's aim rate and
// its age compensation run on the same time line as the simulation.
let nowMs = 0;
globalThis.performance = { now: () => nowMs };

const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 1; this.h = {}; this.sent = []; sockets.push(this); }
  addEventListener(t, fn) { (this.h[t] ||= []).push(fn); }
  send(d) { this.sent.push(d); }
  close(code, reason) { this.readyState = 3; this.closeCode = code; this.closeReason = reason; }
  fire(t, ev) { for (const fn of this.h[t] || []) fn(ev); }
};

// Enough of a browser for the real renderer: a window to measure, and
// canvases that accept any drawing call and ignore it.
globalThis.window = { innerWidth: 1458, innerHeight: 820, devicePixelRatio: 1 };
const ignore = () => {};
const ctx = new Proxy({}, { get: () => ignore, set: () => true });
const canvas = () => ({
  width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: 132 })
});

const {
  createWorld, addPlayer, fillBots, stepWorld, setAim, queueAction, spawnPlayer, advanceCell,
  steerThrottle, topSpeedOf, clampReach, radiusOf, centroid, totalMass,
  BASE_SPEED, TICK_HZ, EJECT_SPEED
} = await import("../shared/sim.js");
const {
  MSG, encodeAim, encodeAction, decodeClientMessage, encodeSnapshot, createClientState
} = await import("../shared/protocol.js");
const {
  createRenderer, fullSpeedPixels, MOUSE_FULL_SPEED_DISTANCE
} = await import("../client/render.js");
const { createSocketConnection } = await import("../client/net.js");

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}
const close = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));
const pct = v => `${(v * 100).toFixed(2)}%`;

// ── the old rule, verbatim ──────────────────────────────────────────────────

const OLD_STEER_RATE = 12;
const OLD_CELL_DECAY = Math.pow(0.935, 60);
const OLD_CELL_LN = Math.log(OLD_CELL_DECAY);
const oldClamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function oldAdvanceCell(c, tx, ty, dt, size) {
  const dx = tx - c.x, dy = ty - c.y;
  const d = Math.hypot(dx, dy);
  const r = radiusOf(c.mass);
  let wantX = 0, wantY = 0, wantSpeed = 0;
  if (d > 1) {
    wantX = dx / d;
    wantY = dy / d;
    const throttle = oldClamp(d / (r * 0.9), 0, 1);
    wantSpeed = BASE_SPEED * Math.pow(c.mass, -0.24) * 60 * throttle;
  }
  const k = 1 - Math.exp(-OLD_STEER_RATE * dt);
  if (c.hx === undefined) { c.hx = wantX; c.hy = wantY; c.sp = wantSpeed; }
  else {
    c.hx += (wantX - c.hx) * k;
    c.hy += (wantY - c.hy) * k;
    c.sp += (wantSpeed - c.sp) * k;
  }
  c.x += c.hx * c.sp * dt;
  c.y += c.hy * c.sp * dt;
  if (c.vx || c.vy) {
    const f = Math.pow(OLD_CELL_DECAY, dt);
    const travel = (f - 1) / OLD_CELL_LN;
    c.x += c.vx * travel;
    c.y += c.vy * travel;
    c.vx *= f;
    c.vy *= f;
    if (Math.abs(c.vx) < 1 && Math.abs(c.vy) < 1) { c.vx = 0; c.vy = 0; }
  }
  c.x = oldClamp(c.x, r, size - r);
  c.y = oldClamp(c.y, r, size - r);
}

// A seeded generator, so a failure here reproduces.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

// The real renderer on the camera's reference screen, 820px tall.
const renderer = createRenderer(canvas(), canvas());
// The zoom the camera settles on for a cell of this mass.
function zoomFor(mass) {
  const camera = { x: 0, y: 0, scale: renderer.initialScale() };
  renderer.follow(camera, { me: { x: 0, y: 0, mass } }, 100);
  return camera.scale;
}
// The reach the client sends for a cell of this mass, the camera settled.
const reachFor = mass => renderer.fullSpeedReach({ scale: zoomFor(mass) });
const REACH = reachFor(20);           // a starting cell on the reference screen

// Hold the aim point a fixed offset from the cell, as a cursor held still on
// screen does once the camera has caught up, and read the speed it settles at.
// Starts from rest with a heading already set, so the speed has to climb.
function settle(mass, ox, oy, reach, frames = 180, dt = 1 / 60) {
  const c = { x: 30000, y: 30000, mass, vx: 0, vy: 0, hx: 1, hy: 0, sp: 0 };
  let speed = 0, peak = 0;
  for (let f = 0; f < frames; f++) {
    const x0 = c.x, y0 = c.y;
    advanceCell(c, c.x + ox, c.y + oy, dt, 65535, reach);
    speed = Math.hypot(c.x - x0, c.y - y0) / dt;
    peak = Math.max(peak, speed, c.sp);
  }
  return { speed, peak, c };
}

console.log(`\n(reference screen 1458x820: full-speed distance ${fullSpeedPixels(1458, 820).toFixed(0)}px, ` +
  `starting reach ${REACH.toFixed(1)} world units)`);

// ── 1. the speed limit is the one it always was ─────────────────────────────

console.log("\n-- the mass-based top speed is unchanged --");

{
  let same = true;
  for (let m = 1; m < 50000; m *= 1.07) {
    if (topSpeedOf(m) !== BASE_SPEED * Math.pow(m, -0.24) * 60) same = false;
  }
  check("topSpeedOf is the old formula, bit for bit, from mass 1 to 50,000", same);

  const small = settle(20, 5000, 0, REACH).speed;
  const large = settle(2000, 5000, 0, reachFor(2000)).speed;
  check("a mass-20 cell at full reach steers at its old top speed",
    close(small, topSpeedOf(20)), `${small.toFixed(3)} vs ${topSpeedOf(20).toFixed(3)}`);
  check("so does a mass-2000 cell", close(large, topSpeedOf(2000)),
    `${large.toFixed(3)} vs ${topSpeedOf(2000).toFixed(3)}`);
  check("and small to large keep their old ratio, (m1/m2)^-0.24",
    close(small / large, Math.pow(20 / 2000, -0.24)), (small / large).toFixed(6));
}

// ── 2. the curve ────────────────────────────────────────────────────────────

console.log("\n-- the speed curve: zero at the centre, linear, capped --");

{
  // The table from the brief, at an illustrative 200-unit reach.
  const rows = [[0, 0], [50, 0.25], [100, 0.5], [150, 0.75], [200, 1], [250, 1], [10000, 1]];
  check("0/50/100/150/200/250+ of a 200 reach give 0/25/50/75/100/100%",
    rows.every(([d, want]) => close(steerThrottle(d, 10, 200), want)),
    rows.map(([d]) => pct(steerThrottle(d, 10, 200))).join(" "));

  for (const mass of [20, 100, 500, 2000]) {
    const reach = reachFor(mass);
    const top = topSpeedOf(mass);
    const at = k => settle(mass, reach * k, 0, reach);
    const centre = settle(mass, 0, 0, reach);
    check(`mass ${mass}: cursor on the cell, no steering at all`,
      centre.speed === 0 && centre.c.sp < 1e-9, `${centre.speed} u/s`);
    check(`mass ${mass}: half the full-speed distance, half the top speed`,
      close(at(0.5).speed, top * 0.5), pct(at(0.5).speed / top));
    check(`mass ${mass}: at the full-speed distance, exactly the top speed`,
      close(at(1).speed, top), pct(at(1).speed / top));
    const beyond = [1.5, 4, 40, 8800 / reach].map(k => at(k));
    check(`mass ${mass}: beyond it, never more than the top speed`,
      beyond.every(b => close(b.speed, top) && b.peak <= top * (1 + 1e-12)),
      beyond.map(b => pct(b.peak / top)).join(" "));
  }

  // Precision: a cursor a couple of pixels off the cell creeps, it does not
  // lurch. Two pixels at the starting zoom of 1.5 is 1.33 world units.
  const creep = settle(20, 2 / 1.5, 0, REACH);
  check("two pixels off centre steers at under 1% of top speed",
    creep.speed > 0 && creep.speed < topSpeedOf(20) * 0.01,
    `${creep.speed.toFixed(2)} u/s, ${pct(creep.speed / topSpeedOf(20))}`);
}

// ── 3. direction ────────────────────────────────────────────────────────────

console.log("\n-- direction is followed, and diagonals are no faster --");

{
  for (const k of [0.25, 0.5, 1, 3]) {
    const speeds = [], errs = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const s = settle(20, Math.cos(a) * REACH * k, Math.sin(a) * REACH * k, REACH);
      speeds.push(s.speed);
      errs.push(Math.abs(Math.atan2(s.c.hy, s.c.hx) - Math.atan2(Math.sin(a), Math.cos(a))) % (2 * Math.PI));
    }
    const spread = (Math.max(...speeds) - Math.min(...speeds)) / Math.max(...speeds);
    check(`every heading at ${k}x the reach steers at the same speed`, spread < 1e-9,
      `spread ${spread.toExponential(1)}`);
    check(`and heads exactly at the cursor`, Math.max(...errs.map(e => Math.min(e, 2 * Math.PI - e))) < 1e-9);
  }
  const straight = settle(20, REACH, 0, REACH).speed;
  const diagonal = settle(20, REACH / Math.SQRT2, REACH / Math.SQRT2, REACH).speed;
  const corner = settle(20, REACH, REACH, REACH).speed;
  check("a diagonal aim the same length as a straight one is the same speed",
    close(diagonal, straight), `${diagonal.toFixed(3)} vs ${straight.toFixed(3)}`);
  check("the full reach on both axes at once is still only the top speed",
    close(corner, topSpeedOf(20)), pct(corner / topSpeedOf(20)));
}

// ── 4. the old rule, where it still applies ─────────────────────────────────

console.log("\n-- bots, old clients and full-reach aims move exactly as before --");

{
  const r = rng(42);
  let mismatchNone = 0, mismatchFar = 0, steps = 0;
  for (let trial = 0; trial < 400; trial++) {
    const mass = 10 + r() * 20000;
    const mk = () => ({
      x: 500 + r() * 7800, y: 500 + r() * 7800, mass,
      vx: r() < 0.3 ? (r() - 0.5) * 3000 : 0, vy: r() < 0.3 ? (r() - 0.5) * 3000 : 0
    });
    const seed = mk();
    const a = { ...seed }, b = { ...seed }, c = { ...seed }, d = { ...seed };
    for (let i = 0; i < 40; i++) {
      const tx = r() * 8800, ty = r() * 8800, dt = 0.004 + r() * 0.06;
      oldAdvanceCell(a, tx, ty, dt, 8800);
      advanceCell(b, tx, ty, dt, 8800);                 // no reach: a bot
      if (["x", "y", "hx", "hy", "sp", "vx", "vy"].some(k => a[k] !== b[k])) mismatchNone++;
      // Any reach no wider than the aim's distance is all the way out.
      const dist = Math.min(Math.hypot(tx - c.x, ty - c.y), Math.hypot(tx - d.x, ty - d.y));
      oldAdvanceCell(d, tx, ty, dt, 8800);
      advanceCell(c, tx, ty, dt, 8800, dist * r());
      if (["x", "y", "hx", "hy", "sp", "vx", "vy"].some(k => c[k] !== d[k])) mismatchFar++;
      steps++;
    }
  }
  check(`with no reach, every step matches the old rule bit for bit (${steps} steps)`, mismatchNone === 0,
    `${mismatchNone} differ`);
  check("with the aim beyond the reach, every step matches it too", mismatchFar === 0,
    `${mismatchFar} differ`);
}

// A whole arena: bots, orbs, viruses, a split, eating and the standings. The
// same seed with the player's aim always beyond the full-speed distance must
// play out identically to the old rule — the same bites, orbs, deaths and
// ranks, to the last bit.
function playArena(reach) {
  const w = createWorld(77, { size: 4200, pellets: 700, viruses: 12 });
  fillBots(w, 12);
  addPlayer(w, { id: "me", name: "Me" });
  const log = [];
  for (let i = 0; i < 900; i++) {
    const a = i / 45;
    setAim(w, "me", Math.cos(a) * 700, Math.sin(a) * 700, reach);
    if (i === 300 || i === 301) queueAction(w, "me", "split");
    if (i === 500) queueAction(w, "me", "eject");
    for (const e of stepWorld(w, 1 / TICK_HZ)) log.push(JSON.stringify(e));
  }
  const players = [...w.players.values()].map(p => ({
    id: p.id, alive: p.alive, orbs: p.orbs, eaten: p.eaten, rank: p.rank, peak: p.peak,
    cells: p.cells.map(c => [c.x, c.y, c.mass, c.vx, c.vy])
  }));
  const pellets = w.pellets.map(p => [p.x, p.y, p.mass]);
  const viruses = w.viruses.map(v => [v.x, v.y, v.fed]);
  return { state: JSON.stringify({ players, pellets, viruses }), log };
}
{
  const before = playArena(0);
  const after = playArena(240);
  const kinds = new Set(before.log.map(e => JSON.parse(e).t));
  check("the arena run exercises eating, orbs and deaths",
    kinds.has("orb") && kinds.has("eat") && kinds.has("death"), [...kinds].join(", "));
  check("the same events in the same order", before.log.join() === after.log.join(),
    `${before.log.length} vs ${after.log.length} events`);
  check("and the same arena at the end, every cell, orb and virus", before.state === after.state);
}

// ── 5. camera zoom, window size, pixel density ─────────────────────────────

console.log("\n-- zoom, resizing and pixel density leave the curve where it is --");

{
  // The pointer is placed on screen and read back through screenToWorld, the
  // same path main.js takes. Only the zoom changes between rows.
  const share = [];
  for (const scale of [0.3, 0.62, 1, 1.5, 2.4]) {
    const camera = { x: 4000, y: 4000, scale };
    const F = fullSpeedPixels(window.innerWidth, window.innerHeight);
    const reach = renderer.fullSpeedReach(camera);
    const at = px => {
      const t = renderer.screenToWorld(camera, window.innerWidth / 2 + px, window.innerHeight / 2);
      return steerThrottle(Math.hypot(t.x - camera.x, t.y - camera.y), 1, reach);
    };
    share.push([at(F / 4), at(F / 2), at(F), at(F * 2)]);
  }
  check("at every zoom, F/4, F/2, F and 2F on screen give 25/50/100/100%",
    share.every(([q, h, f, b]) => close(q, 0.25) && close(h, 0.5) && close(f, 1) && close(b, 1)),
    share.map(s => s.map(pct).join("/")).join("  "));

  const sizes = [[1458, 820], [1920, 955], [2560, 1290], [390, 664], [844, 340], [1024, 600]];
  const ok = sizes.every(([w, h]) => {
    window.innerWidth = w; window.innerHeight = h;
    renderer.resize();
    return close(fullSpeedPixels(w, h) / (Math.min(w, h) / 2), MOUSE_FULL_SPEED_DISTANCE) &&
      close(renderer.fullSpeedReach({ scale: 1 }), MOUSE_FULL_SPEED_DISTANCE * Math.min(w, h) / 2);
  });
  check("a resized window keeps full speed the same share of the way to the edge", ok,
    sizes.map(([w, h]) => `${w}x${h}:${fullSpeedPixels(w, h).toFixed(0)}px`).join(" "));

  window.innerWidth = 1458; window.innerHeight = 820;
  renderer.resize();
  const plain = renderer.fullSpeedReach({ scale: 1.5 });
  window.devicePixelRatio = 2;
  renderer.setSharp(true);
  const sharp = renderer.fullSpeedReach({ scale: 1.5 });
  renderer.setSharp(false);
  window.devicePixelRatio = 1;
  check("a 2x display at full resolution sends the same reach", plain === sharp,
    `${plain.toFixed(2)} vs ${sharp.toFixed(2)}`);
}

// The whole client loop, as main.js runs it: the real camera chasing the cell,
// the pointer held still on screen, the aim read through screenToWorld and
// the reach at the camera's live zoom. The camera trails the cell, so a
// pointer measured from the screen centre is that much nearer the cell than
// it looks; the model below is that lag and nothing else, and it must account
// for every bit of the difference from p / F.
//
// The lag at 60fps: the camera closes K = 1 - e^(-24 dt) of the gap a frame,
// so a cell moving v dt a frame leads it by v dt (1 - K) / K — v / 29.5,
// about 34ms. (CAMERA_FOLLOW is 24 in client/render.js.)
function cameraLoop(mass, px, seconds = 4) {
  const w = createWorld(3, { size: 60000, pellets: 0, viruses: 0 });
  const p = addPlayer(w, { id: "me", name: "Me" });
  p.cells[0].mass = mass; p.cells[0].x = 30000; p.cells[0].y = 30000;
  const camera = { x: 30000, y: 30000, scale: renderer.initialScale() };
  const view = () => ({ me: { ...centroid(p), mass: totalMass(p) } });
  renderer.follow(camera, view(), 100);                  // zoom settled for this mass
  const dt = 1 / 60;
  let speed = 0, top = 0;
  for (let f = 0; f < seconds * 60; f++) {
    const me = view().me;
    const t = renderer.screenToWorld(camera, window.innerWidth / 2 + px, window.innerHeight / 2);
    setAim(w, "me", t.x - me.x, t.y - me.y, renderer.fullSpeedReach(camera));
    // Read before the step: cells over DECAY_ABOVE shed a little mass after
    // they move, and the move is made at the speed of the mass before it.
    top = topSpeedOf(totalMass(p));
    stepWorld(w, dt);
    speed = (centroid(p).x - me.x) / dt;
    renderer.follow(camera, view(), dt);
  }
  const reach = renderer.fullSpeedReach(camera);
  const F = fullSpeedPixels(window.innerWidth, window.innerHeight);
  const K = 1 - Math.exp(-24 * dt);
  const lag = dt * (1 - K) / K;                          // seconds of travel
  const model = Math.min(1, (px / F) / (1 + (top * lag) / reach));
  return { frac: speed / top, model };
}
{
  for (const mass of [20, 400, 3000]) {
    const zero = cameraLoop(mass, 0);
    const half = cameraLoop(mass, fullSpeedPixels(1458, 820) / 2);
    const out = cameraLoop(mass, fullSpeedPixels(1458, 820) * 1.3);
    check(`mass ${mass}, zoom ${zoomFor(mass).toFixed(2)}: pointer on the screen centre comes to rest`,
      Math.abs(zero.frac) < 1e-6, pct(zero.frac));
    check(`  half way out: ${pct(half.frac)} of top, all of the shortfall from 50% is camera lag`,
      Math.abs(half.frac - half.model) < 1e-4, `model ${pct(half.model)}`);
    // A cell over DECAY_ABOVE sheds mass, so its top speed creeps up and the
    // steering inertia trails it from below by a few parts in 100,000.
    check(`  1.3x out: the top speed, and never over it`,
      out.frac <= 1 + 1e-12 && out.frac > 1 - 1e-4, `${(out.frac - 1).toExponential(2)} from top`);
  }
}

// ── 6. split pieces, impulses, ejected mass, walls, respawn ────────────────

console.log("\n-- split pieces, impulses, ejected mass, walls and respawning --");

function splitRun(reach, aimX, ticks = 30) {
  const w = createWorld(9, { size: 8800, pellets: 0, viruses: 0 });
  const p = addPlayer(w, { id: "me", name: "Me" });
  p.cells[0].mass = 400; p.cells[0].x = 4400; p.cells[0].y = 4400;
  setAim(w, "me", aimX, 0, reach);
  queueAction(w, "me", "split");
  const impulses = [];
  for (let i = 0; i < ticks; i++) {
    setAim(w, "me", aimX, 0, reach);
    stepWorld(w, 1 / TICK_HZ);
    impulses.push(p.cells.map(c => [c.vx, c.vy]));
  }
  return { w, p, impulses: JSON.stringify(impulses) };
}
{
  const reach = reachFor(400);
  const old = splitRun(0, 2000);
  const near = splitRun(reach, 6);
  const half = splitRun(reach, reach / 2);
  const far = splitRun(reach, 2000);
  check("a split launches and coasts identically however far the cursor is",
    near.impulses === old.impulses && half.impulses === old.impulses && far.impulses === old.impulses);
  const firstV = JSON.parse(near.impulses)[0][1];
  check("the piece is launched at its normal speed with the cursor on the cell",
    Math.hypot(firstV[0], firstV[1]) > 500, `${Math.hypot(firstV[0], firstV[1]).toFixed(0)} u/s after one tick`);

  // Each piece runs at its own top speed once the launch has died away.
  const steady = splitRun(reach, 3000, 60).p.cells;
  check("each split piece steers at the top speed of its own mass",
    steady.length === 2 && steady.every(c => close(c.sp, topSpeedOf(c.mass), 1e-6)),
    steady.map(c => `${c.sp.toFixed(1)}/${topSpeedOf(c.mass).toFixed(1)}`).join(" "));

  // Pieces still come back together with the cursor between them.
  const mergeTime = reachArg => {
    const w = createWorld(9, { size: 8800, pellets: 0, viruses: 0 });
    const p = addPlayer(w, { id: "me", name: "Me" });
    p.cells[0].mass = 400; p.cells[0].x = 4400; p.cells[0].y = 4400;
    setAim(w, "me", 500, 0, reachArg);
    queueAction(w, "me", "split");
    stepWorld(w, 1 / TICK_HZ);
    const due = Math.max(...p.cells.map(c => c.mergeAt));
    for (let i = 0; i < 60 * TICK_HZ && p.cells.length > 1; i++) {
      setAim(w, "me", 0, 0, reachArg);              // cursor on the centroid
      stepWorld(w, 1 / TICK_HZ);
    }
    return { left: p.cells.length, after: w.time - due, mass: totalMass(p) };
  };
  const m0 = mergeTime(0), m1 = mergeTime(reach);
  check("with the cursor between the pieces, they merge once the cooldown ends",
    m1.left === 1 && m1.after < 1.5, `${m1.after.toFixed(2)}s after the cooldown (old rule ${m0.after.toFixed(2)}s)`);
  check("and merging stays mass-neutral", close(m1.mass, 400, 1e-9) && close(m0.mass, 400, 1e-9));

  // Ejected mass leaves at EJECT_SPEED whatever the cursor distance. Thrown
  // after this tick's orbs have moved, so it has not slowed yet.
  const ejectSpeed = aimX => {
    const w = createWorld(9, { size: 8800, pellets: 0, viruses: 0 });
    const p = addPlayer(w, { id: "me", name: "Me" });
    p.cells[0].mass = 200; p.cells[0].x = 4400; p.cells[0].y = 4400;
    setAim(w, "me", aimX, 0, reach);
    queueAction(w, "me", "eject");
    stepWorld(w, 1 / TICK_HZ);
    const b = w.pellets.find(q => q.owner === "me");
    return b ? Math.hypot(b.vx, b.vy) : -1;
  };
  const e1 = ejectSpeed(4), e2 = ejectSpeed(reach * 3);
  check("ejected mass flies the same with the cursor near or far",
    e1 === EJECT_SPEED && e2 === EJECT_SPEED, `${e1.toFixed(1)} vs ${e2.toFixed(1)} u/s`);

  // Walls: aiming past one pins the cell to it, sliding along at no more than
  // the top speed, and nothing goes NaN.
  {
    const w = createWorld(9, { size: 3000, pellets: 0, viruses: 0 });
    const p = addPlayer(w, { id: "me", name: "Me" });
    const c = p.cells[0];
    c.mass = 50; c.x = radiusOf(50) + 1; c.y = 1500;
    let worst = 0, inside = true;
    for (let i = 0; i < 120; i++) {
      const x0 = c.x, y0 = c.y;
      setAim(w, "me", -500, i < 60 ? 0 : 150, reach);
      stepWorld(w, 1 / 60);
      worst = Math.max(worst, Math.hypot(c.x - x0, c.y - y0) * 60 / topSpeedOf(c.mass));
      if (!(c.x >= radiusOf(c.mass) - 1e-9 && c.x <= 3000 && Number.isFinite(c.y))) inside = false;
    }
    check("a cell steered into a wall stays inside it, finite", inside, `x ${c.x.toFixed(2)}`);
    check("and slides along it no faster than its top speed", worst <= 1 + 1e-9, pct(worst));
  }

  // A respawned cell waits for the cursor: it carries no speed from before.
  {
    const w = createWorld(9, { size: 8800, pellets: 0, viruses: 0 });
    const p = addPlayer(w, { id: "me", name: "Me" });
    setAim(w, "me", 800, 0, reach);
    for (let i = 0; i < 20; i++) stepWorld(w, 1 / TICK_HZ);
    spawnPlayer(w, p);
    const at = { x: p.cells[0].x, y: p.cells[0].y };
    for (let i = 0; i < 20; i++) stepWorld(w, 1 / TICK_HZ);
    check("a respawned cell stays put until the player aims", p.cells[0].x === at.x && p.cells[0].y === at.y);
  }
}

// ── 7. hostile input ────────────────────────────────────────────────────────

console.log("\n-- invalid input cannot get past the limit --");

{
  const w = createWorld(9, { size: 8800, pellets: 0, viruses: 0 });
  const p = addPlayer(w, { id: "me", name: "Me" });
  const bad = [NaN, Infinity, -Infinity, 1e308, -1e308, -5, 0, 1e-300];
  let finite = true, worst = 0;
  for (const dx of bad) for (const reach of bad) {
    p.cells[0].x = 4400; p.cells[0].y = 4400; p.cells[0].mass = 100;
    setAim(w, "me", dx, 300, reach);
    if (!Number.isFinite(p.input.x) || !Number.isFinite(p.input.y) || !Number.isFinite(p.input.reach) ||
        p.input.reach < 0 || p.input.reach > w.size) finite = false;
    for (let i = 0; i < 5; i++) {
      const x0 = p.cells[0].x, y0 = p.cells[0].y;
      stepWorld(w, 1 / TICK_HZ);
      const c = p.cells[0];
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.sp)) finite = false;
      worst = Math.max(worst, Math.hypot(c.x - x0, c.y - y0) * TICK_HZ / topSpeedOf(c.mass));
    }
  }
  check("NaN, Infinity, huge and negative aims and reaches leave the state finite", finite);
  check("and none of them moves a cell faster than its top speed", worst <= 1 + 1e-9, pct(worst));
  check("reach is bounded to the arena", clampReach(65535, 8800) === 8800 && clampReach(-1, 8800) === 0 &&
    clampReach(NaN, 8800) === 0 && clampReach(Infinity, 8800) === 0);

  // The wire, both forms of each and the malformed lengths around them.
  const oldAim = decodeClientMessage(encodeAim(-120, 45, 3));
  const newAim = decodeClientMessage(encodeAim(-120, 45, 3, 164));
  check("an older 7-byte aim decodes with no reach", encodeAim(-120, 45, 3).length === 7 &&
    oldAim.x === -120 && oldAim.y === 45 && oldAim.seq === 3 && oldAim.reach === 0);
  check("a 9-byte aim carries its reach", encodeAim(-120, 45, 3, 164).length === 9 &&
    newAim.x === -120 && newAim.y === 45 && newAim.seq === 3 && newAim.reach === 164);
  const oldAct = decodeClientMessage(encodeAction("split", -120, 45, 4));
  const newAct = decodeClientMessage(encodeAction("split", -120, 45, 4, 164));
  check("an older 8-byte action decodes with no reach",
    encodeAction("split", -120, 45, 4).length === 8 && oldAct.action === "split" && oldAct.reach === 0);
  check("a 10-byte action carries the reach with its aim",
    encodeAction("split", -120, 45, 4, 164).length === 10 && newAct.action === "split" &&
    newAct.x === -120 && newAct.seq === 4 && newAct.reach === 164);
  const malformed = [
    [MSG.AIM, 1, 0, 1, 0, 3, 0, 9],                       // 8: one stray byte
    [MSG.AIM, 1, 0, 1, 0, 3, 0, 9, 0, 9],                 // 10: a reach and a byte
    [MSG.ACTION, 0, 1, 0, 1, 0, 4, 0, 9],                 // 9
    [MSG.ACTION, 0, 1, 0, 1, 0, 4, 0, 9, 0, 9]            // 11
  ].filter(bytes => { try { decodeClientMessage(new Uint8Array(bytes)); return false; } catch { return true; } });
  check("a stray byte either side of the reach is rejected as malformed", malformed.length === 4,
    `${malformed.length} of 4 rejected`);

  // A modified client's whole range of frames, through the real decode path.
  const r = rng(7);
  const fw = createWorld(10, { size: 8800, pellets: 0, viruses: 0 });
  const fp = addPlayer(fw, { id: "me", name: "Me" });
  fp.cells[0].mass = 150;
  let fastest = 0, broken = 0;
  for (let i = 0; i < 4000; i++) {
    const bytes = new Uint8Array(9);
    bytes[0] = MSG.AIM;
    for (let j = 1; j < 9; j++) bytes[j] = (r() * 256) | 0;
    const msg = decodeClientMessage(bytes);
    setAim(fw, "me", msg.x, msg.y, msg.reach);
    const c = fp.cells[0], x0 = c.x, y0 = c.y;
    stepWorld(fw, 1 / TICK_HZ);
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) broken++;
    fastest = Math.max(fastest, Math.hypot(c.x - x0, c.y - y0) * TICK_HZ / topSpeedOf(c.mass));
  }
  check("4,000 random aim frames: never NaN, never past the top speed",
    broken === 0 && fastest <= 1 + 1e-9, `fastest ${pct(fastest)} of top`);

  // The smallest reach a client can send buys exactly the old rule: full
  // speed outside its own membrane, which a cursor at the edge of the screen
  // gets anyway. No more.
  const tiny = settle(20, 30, 0, 1), legacy = settle(20, 30, 0, 0), honest = settle(20, 5000, 0, REACH);
  check("a reach of 1 is the old rule, and no faster than an honest cursor at the edge",
    close(tiny.speed, legacy.speed) && tiny.peak <= honest.peak * (1 + 1e-12),
    `${tiny.speed.toFixed(2)} vs ${legacy.speed.toFixed(2)} vs ${honest.speed.toFixed(2)} u/s`);
}

// ── 8. client and server agree ──────────────────────────────────────────────

console.log("\n-- client and server agree, over a real latency --");

// client/net.js against a real simulation over a modelled link, on one
// virtual clock: half the round trip each way, delivery in order as over TCP,
// and the server handling each frame as server/index.js does — the aim and
// its reach into setAim, the sequence number stamped for the acknowledgement.
// `aimReach` says whether the welcome offers the reach; `actions` are times
// at which the player presses split.
//
// The client deliberately draws its cell where its input will put it, which
// is half a round trip ahead of where the server has it now. So the drawn
// cell at time t is compared with the server's cell at t + rtt / 2.
function netRun({ aimReach, rtt = 120, hz = 30, script, seconds = 12, actions = [] }) {
  nowMs = 0;
  sockets.length = 0;
  const world = createWorld(5, { size: 8800, pellets: 0, viruses: 0 });
  const me = addPlayer(world, { id: "me", name: "Me" });
  me.cells[0].x = 4400; me.cells[0].y = 4400;
  const cs = createClientState(0);
  const conn = createSocketConnection({ getTicket: () => ({ url: "ws://x", ticket: "t" }) });
  const sock = sockets[0];
  sock.fire("open");
  sock.fire("message", {
    data: JSON.stringify({ type: "welcome", nid: me.nid, tickHz: hz, ...(aimReach ? { aimReach: true } : {}) })
  });

  const up = [], down = [], track = [], drawn = [];
  const pressAt = [...actions];
  let read = 0, tickAt = 0, nextTick = 0, nextFrame = 0;
  const out = { sizes: new Set(), actionReach: new Set(), serverReach: new Set(), peak: 0, serverPath: 0 };
  while (nowMs < seconds * 1000) {
    nowMs = Math.min(nextTick, nextFrame, up.length ? up[0].at : Infinity, down.length ? down[0].at : Infinity);
    if (up.length && up[0].at === nowMs) {
      const msg = decodeClientMessage(up.shift().data);
      setAim(world, "me", msg.x, msg.y, msg.reach);
      me.inputSeq = msg.seq;
      me.inputAt = nowMs;
      if (msg.type === MSG.ACTION) { out.actionReach.add(msg.reach); queueAction(world, "me", msg.action); }
      out.serverReach.add(me.input.reach);
    } else if (down.length && down[0].at === nowMs) {
      sock.fire("message", { data: down.shift().data });
    } else if (nowMs === nextTick) {
      const s0 = centroid(me);
      const dt = tickAt ? (nowMs - tickAt) / 1000 : 1 / hz;
      stepWorld(world, dt);
      tickAt = nowMs;
      const s1 = centroid(me);
      const step = Math.hypot(s1.x - s0.x, s1.y - s0.y);
      out.serverPath += step;
      out.peak = Math.max(out.peak, step / dt);
      track.push({ t: nowMs, x: s1.x, y: s1.y });
      down.push({ at: nowMs + rtt / 2, data: encodeSnapshot(world, me, cs, null, null, nowMs).slice().buffer });
      nextTick += 1000 / hz;
    } else {
      const aim = script(nowMs / 1000);
      conn.sendAim(aim.x, aim.y, REACH);
      if (pressAt.length && pressAt[0] * 1000 <= nowMs) { pressAt.shift(); conn.sendAction("split"); }
      conn.update(1 / 60);
      for (; read < sock.sent.length; read++) {
        const d = sock.sent[read];
        if (typeof d === "string") continue;
        out.sizes.add(`${decodeClientMessage(d).type === MSG.AIM ? "aim" : "action"}:${d.length}`);
        up.push({ at: nowMs + rtt / 2, data: d });
      }
      const v = conn.getView();
      if (v) drawn.push({ t: nowMs, x: v.me.x, y: v.me.y });
      nextFrame += 1000 / 60;
    }
  }
  conn.close();

  // Where the server had the cell at time t, between its ticks.
  const serverAt = t => {
    let i = track.findIndex(p => p.t >= t);
    if (i <= 0) return i === 0 ? track[0] : null;
    const a = track[i - 1], b = track[i], k = (t - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  };
  const errs = [];
  let lurch = 0, path = 0, maxStep = 0;
  for (let i = 0; i < drawn.length; i++) {
    const s = serverAt(drawn[i].t + rtt / 2);
    if (s) errs.push(Math.hypot(drawn[i].x - s.x, drawn[i].y - s.y));
    if (i) {
      const step = Math.hypot(drawn[i].x - drawn[i - 1].x, drawn[i].y - drawn[i - 1].y);
      path += step;
      maxStep = Math.max(maxStep, step);
      lurch = Math.max(lurch, step * 60 / topSpeedOf(totalMass(me)));
    }
  }
  const last = drawn[drawn.length - 1], end = track[track.length - 1];
  return {
    ...out, lurch, path, maxStep,
    rms: Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length),
    max: Math.max(...errs),
    finalErr: Math.hypot(last.x - end.x, last.y - end.y),
    reach: me.input.reach
  };
}

{
  // Half speed, a sweep from nothing to twice the reach, a stop, a cursor
  // pumping in and out while it turns, a creep, and a final stop. Split is
  // pressed twice along the way: the cell is too small to split, but the
  // action still carries the aim, and the reach must ride with it.
  const busy = t => {
    let rad, ang;
    if (t < 2) { rad = REACH * 0.5; ang = 0; }
    else if (t < 4) { rad = REACH * (t - 2); ang = (t - 2) * 1.5; }
    else if (t < 5.5) { rad = 0; ang = 0; }
    else if (t < 9) { rad = REACH * (0.6 + 0.6 * Math.sin(3 * t)); ang = t * 1.7; }
    else if (t < 10.5) { return { x: 3, y: -2 }; }
    else { rad = 0; ang = 0; }
    return { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad };
  };
  const neu = netRun({ aimReach: true, script: busy, actions: [3, 7] });
  const old = netRun({ aimReach: false, script: busy, actions: [3, 7] });
  const sent = clampReach(Math.round(REACH), 8800);
  check("against a new server aims go out at 9 bytes and actions at 10",
    neu.sizes.size === 2 && neu.sizes.has("aim:9") && neu.sizes.has("action:10"), [...neu.sizes].join(" "));
  check("every action carries the reach, so the server never drops back to the old rule",
    neu.actionReach.size === 1 && neu.actionReach.has(sent) &&
    neu.serverReach.size === 1 && neu.serverReach.has(sent),
    `actions ${[...neu.actionReach]}, server ${[...neu.serverReach]}`);
  check("against an old server they go out at 7 and 8, with no reach",
    old.sizes.size === 2 && old.sizes.has("aim:7") && old.sizes.has("action:8") && old.reach === 0,
    [...old.sizes].join(" "));
  check("the drawn cell stays where the server is about to have it",
    neu.max < 25, `max ${neu.max.toFixed(1)}, rms ${neu.rms.toFixed(1)} units at 120ms RTT`);
  check("at least as closely as under the old rule", neu.rms <= old.rms + 0.5,
    `rms ${neu.rms.toFixed(1)} vs old ${old.rms.toFixed(1)}; max ${neu.max.toFixed(1)} vs ${old.max.toFixed(1)}`);
  check("corrections never show as a lurch past the top speed", neu.lurch < 1.1,
    `fastest frame ${pct(neu.lurch)} of top (old rule ${pct(old.lurch)})`);
  check("after the final stop both ends rest at the same spot", neu.finalErr < 2,
    `${neu.finalErr.toFixed(2)} units apart`);
  check("and the server never moved the cell past its top speed", neu.peak <= topSpeedOf(20) * (1 + 1e-9),
    pct(neu.peak / topSpeedOf(20)));
}

// ── 9. jitter ───────────────────────────────────────────────────────────────

console.log("\n-- a shaking hand near the centre does not shake the cell --");

{
  // Two pixels of tremor around the centre, every frame, at the starting
  // zoom of 1.5. The aim the client sends is whole world units.
  const r = rng(99);
  const shake = () => ({ x: (r() * 2 - 1) * 2 / 1.5, y: (r() * 2 - 1) * 2 / 1.5 });
  const run = netRun({ aimReach: true, script: shake, seconds: 4 });
  const top = topSpeedOf(20);
  check("the server cell barely moves: under 1% of top speed at its fastest", run.peak < top * 0.01,
    `${run.peak.toFixed(2)} u/s peak, ${(run.serverPath / 4).toFixed(2)} u/s average`);
  // Jitter is a cell that visibly jumps between frames. The live frame steers
  // by the exact pointer while the server gets whole units, so the drawn cell
  // does wander a little — the question is whether any one frame shows it.
  check("on screen no frame moves it as much as a quarter of a pixel", run.maxStep * 1.5 < 0.25,
    `largest step ${(run.maxStep * 1.5).toFixed(3)} px; ${(run.path / 4 * 1.5).toFixed(2)} px/s in all`);
  check("the client and server agree on it to within a unit", run.max < 1, `max ${run.max.toFixed(2)}`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
