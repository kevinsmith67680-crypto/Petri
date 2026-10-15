// ---------------------------------------------------------------------------
// Spatial-index correctness checks, seeded and deterministic.
//
//   node bench/spatial/correctness.mjs [--quick] [--json out.json]
//
// Every check states what CORRECT behaviour is. A FAIL on the `current` build
// is a reproduced bug in shared/sim.js; the same check is then run on the
// `fresh` variant (see build.mjs) to show the proposed fix closes it. The
// game code itself is never modified.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import { loadVariant, VARIANTS } from "./build.mjs";
import { setupScenario, hashWorld, mulberry32 } from "./scenarios.mjs";

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const results = [];
function check(id, label, build, ok, detail = {}) {
  results.push({ id, label, build, ok: !!ok, detail });
  const d = Object.keys(detail).length ? "  " + JSON.stringify(detail) : "";
  console.log(`${ok ? "  PASS" : "  FAIL"}  [${build}] ${id} ${label}${d}`);
}

const B = {};
for (const [k, v] of Object.entries(VARIANTS)) {
  B[k] = await loadVariant(v);
  B[k + "C"] = await loadVariant({ ...v, counted: true });
}
// Second, independent instances for lockstep pairs.
B.freshC2 = await loadVariant({ ...VARIANTS.fresh, counted: true, tag: "twin" });
B.currentC2 = await loadVariant({ ...VARIANTS.current, counted: true, tag: "twin" });

const DT = 1 / 20;

// A bare world for hand-built fixtures: no orbs, no viruses, no top-ups.
function bare(sim, seed = 1, size = 8800) {
  sim.__S.spawnBox = null;
  return sim.createWorld(seed, { size, pellets: 0, viruses: 0 });
}
function human(sim, w, id, x, y, mass) {
  const p = sim.addPlayer(w, { id, name: id });
  const c = p.cells[0];
  c.x = x; c.y = y; c.mass = mass;
  return p;
}
function pellet(w, x, y, extra = {}) {
  const p = { id: w.nextId++, x, y, mass: 3.375, vx: 0, vy: 0, ci: 0, ...extra };
  w.pellets.push(p);
  return p;
}

// ── C1: grid query returns a superset of the query box ──────────────────────

function c1(build) {
  const { sim } = B[build];
  let missing = 0, dup = 0, queries = 0, foreign = 0;
  for (const seed of [1, 2, 3]) {
    sim.__S.spawnBox = null;
    const w = sim.createWorld(seed, { pellets: 4100, viruses: 0 });
    // Worst cases on purpose: orbs exactly on bucket lines and in corners.
    for (let k = 0; k <= 40; k++) {
      pellet(w, k * 220, 3000); pellet(w, 3000, k * 220);
      pellet(w, Math.min(8794, Math.max(6, k * 220)), 6);
    }
    pellet(w, 6, 6); pellet(w, 8794, 8794); pellet(w, 6, 8794); pellet(w, 8794, 6);
    sim.buildPelletGrid(w);
    const live = new Set(w.pellets);
    const r = mulberry32(seed * 7919);
    const n = QUICK ? 800 : 3000;
    for (let q = 0; q < n; q++) {
      const x = q % 5 === 0 ? Math.round(r() * 40) * 220 : -800 + r() * (w.size + 1600);
      const y = q % 7 === 0 ? Math.round(r() * 40) * 220 : -800 + r() * (w.size + 1600);
      const rad = q % 10 === 0 ? r() * 3000 : r() * 450;
      const seen = new Map();
      sim.forEachPelletNear(w, x, y, rad, p => seen.set(p, (seen.get(p) || 0) + 1));
      for (const [p, v] of seen) { if (v > 1) dup++; if (!live.has(p)) foreign++; }
      for (const p of w.pellets) {
        if (Math.abs(p.x - x) <= rad && Math.abs(p.y - y) <= rad && !seen.has(p)) missing++;
      }
      queries++;
    }
  }
  check("C1", "grid query covers every pellet in the query box, once", build,
    missing === 0 && dup === 0 && foreign === 0, { queries, missing, duplicates: dup, foreign });
}

// ── C2: resetArena leaves the index pointing at the previous round ──────────

function c2(build) {
  const { sim, protocol } = B[build];
  const w = bare(sim, 11);
  w.pelletCount = 400;
  for (let i = 0; i < 400; i++) pellet(w, 200 + (i % 20) * 400, 200 + Math.floor(i / 20) * 400);
  const me = human(sim, w, "me", 4400, 4400, 20);
  sim.stepWorld(w, DT);                     // grid built at the end of the tick
  const old = new Set(w.pellets);

  sim.resetArena(w);                        // what startRound does
  const live = new Set(w.pellets);
  const seen = new Set();
  sim.forEachPelletNear(w, w.size / 2, w.size / 2, w.size, p => seen.add(p));
  let ghosts = 0, absent = 0;
  for (const p of seen) if (!live.has(p)) ghosts++;
  for (const p of live) if (!seen.has(p)) absent++;
  check("C2a", "after resetArena the index holds exactly the new round's pellets", build,
    ghosts === 0 && absent === 0, { indexedFromOldRound: ghosts, newPelletsNotIndexed: absent });

  // The snapshot a client gets if startRound runs inside the tick (no
  // re-stake to await), before the next stepWorld rebuilds the index.
  const cs = protocol.createClientState(0);
  const snap = protocol.decodeSnapshot(protocol.encodeSnapshot(w, me, cs));
  const liveIds = new Set(w.pellets.map(p => p.id));
  const sentGhosts = snap.added.filter(p => !liveIds.has(p.id)).length;
  const c = sim.centroid(me), R = protocol.viewRadius(me);
  const shouldSee = w.pellets.filter(p => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 < R * R).length;
  const sentLive = snap.added.length - sentGhosts;
  check("C2b", "first snapshot after resetArena shows the new pellets, not the old", build,
    sentGhosts === 0 && sentLive === shouldSee, { ghostPelletsSent: sentGhosts, livePelletsSent: sentLive, shouldSee });

  // Gameplay: stand on an old-round orb that no longer exists.
  const target = [...old].find(p => !w.pellets.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 60));
  const cell = me.cells[0];
  cell.x = target.x; cell.y = target.y; cell.mass = 20;
  me.input.x = 0; me.input.y = 0;
  const before = me.orbs;
  sim.stepWorld(w, DT);
  check("C2c", "a player cannot eat an orb from the previous round", build,
    me.orbs === before, { ghostOrbsEaten: me.orbs - before });
}

// ── C3: a moving pellet indexed where it was last tick ──────────────────────

function c3(build) {
  const { sim } = B[build];
  const w = bare(sim, 3);
  const me = human(sim, w, "me", 480, 1000, 20);   // bucket gx = 2 (440-660)
  // A thrown blob from someone else, in bucket gx = 1 at the end of the last
  // tick, travelling toward the cell. This tick it moves ~35 units to x≈465:
  // inside the cell's reach and still approaching, so it must be eaten.
  const blob = pellet(w, 430, 1000, { mass: 13, vx: 800, vy: 0, owner: "rival", ownerFree: 0 });
  sim.buildPelletGrid(w);
  sim.stepWorld(w, DT);
  const atTick1 = { x: +blob.x.toFixed(1), dist: +Math.abs(blob.x - me.cells[0].x).toFixed(1),
    reach: +(sim.radiusOf(20) + sim.pelletRadius(blob) * 0.6).toFixed(1) };
  const eatenTick1 = !!blob.dead;
  let eatenLater = false;
  for (let i = 0; i < 60 && !blob.dead; i++) sim.stepWorld(w, DT);
  eatenLater = !eatenTick1 && !!blob.dead;
  check("C3", "a thrown blob that enters a cell's reach is eaten on that tick", build,
    eatenTick1, { ...atTick1, eatenTick1, eatenLater, endX: +blob.x.toFixed(1) });
}

// ── C4: shadow brute force during real play ─────────────────────────────────

function c4(build, key, ticks, dt = DT) {
  const { sim } = B[build];
  sim.__reset();
  const { world, driver } = setupScenario(sim, key, 5);
  sim.__S.shadow = true;
  for (let t = 0; t < ticks; t++) { driver.step(world); sim.stepWorld(world, dt); }
  sim.__S.shadow = false;
  const c = sim.__S.c;
  const d = {
    ticks, dt, eligible: c.shadowEligible, eaten: c.pelletEats,
    missedStaleMoving: c.missStaleMoving, missedOther: c.missOther,
    missedCreatedThisTick: c.missSameTick, ghostEats: c.ghostEats
  };
  check(`C4.${key}${dt !== DT ? "@" + dt : ""}`,
    "no pellet satisfying the eat rule is skipped by the grid (vs full scan)", build,
    c.missStaleMoving === 0 && c.missOther === 0 && c.ghostEats === 0, d);
  return d;
}

// ── C5: lockstep against a brute-force reference simulation ─────────────────

function lockstep(aKey, bKey, key, ticks, { refB = false, seed = 9, dt = DT } = {}) {
  const A = B[aKey].sim, Bs = B[bKey].sim;
  A.__S.ref = false; Bs.__S.ref = refB;
  const a = setupScenario(A, key, seed), b = setupScenario(Bs, key, seed);
  let diverged = -1;
  for (let t = 0; t < ticks; t++) {
    a.driver.step(a.world); b.driver.step(b.world);
    A.stepWorld(a.world, dt); Bs.stepWorld(b.world, dt);
    if (hashWorld(a.world) !== hashWorld(b.world)) { diverged = t + 1; break; }
  }
  Bs.__S.ref = false;
  return diverged;
}

// ── C6: duplicate consumption ───────────────────────────────────────────────

function c6(build) {
  const { sim } = B[build];
  // Three players stacked: A can eat B and C, B can eat C. C's mass must be
  // taken exactly once.
  {
    const w = bare(sim, 21);
    const A = human(sim, w, "A", 3000, 3000, 1000);
    const Bp = human(sim, w, "B", 3000, 3000, 300);
    const C = human(sim, w, "C", 3000, 3000, 50);
    const ev = sim.stepWorld(w, DT).slice();
    const eats = ev.filter(e => e.t === "eat");
    const byVictim = id => eats.filter(e => e.victim === id).length;
    const ids = [...w.players.values()].flatMap(p => p.cells.map(c => c.id));
    check("C6a", "a stacked chain of eats consumes each victim exactly once", build,
      byVictim("B") === 1 && byVictim("C") === 1 && eats.length === 2 &&
      !Bp.cells.length && !C.cells.length && new Set(ids).size === ids.length,
      { eats: eats.length, A: Math.round(sim.totalMass(A)) });
  }
  // One orb under two equal rivals: eaten once.
  {
    const w = bare(sim, 22);
    const P = human(sim, w, "P", 2000, 2000, 100);
    const Q = human(sim, w, "Q", 2010, 2000, 100);
    pellet(w, 2005, 2000);
    sim.buildPelletGrid(w);
    const before = sim.totalMass(P) + sim.totalMass(Q);
    sim.stepWorld(w, DT);
    const gained = sim.totalMass(P) + sim.totalMass(Q) - before;
    check("C6b", "an orb under two cells at once is eaten once", build,
      P.orbs + Q.orbs === 1 && Math.abs(gained - 3.375) < 1e-9, { orbs: P.orbs + Q.orbs, gained });
  }
}

function c6long(build, key, ticks) {
  const { sim } = B[build];
  const { world, driver } = setupScenario(sim, key, 13);
  const everEaten = new Set();
  let dupEat = 0, stillPresent = 0, dupCell = 0, orbMismatch = 0;
  for (let t = 0; t < ticks; t++) {
    driver.step(world);
    sim.__S.eatLog = [];
    const ev = sim.stepWorld(world, DT);
    const log = sim.__S.eatLog;
    for (const id of log) { if (everEaten.has(id)) dupEat++; everEaten.add(id); }
    const ids = new Set(world.pellets.map(p => p.id));
    for (const id of log) if (ids.has(id)) stillPresent++;
    const cells = [...world.players.values()].flatMap(p => p.cells.map(c => c.id));
    if (new Set(cells).size !== cells.length) dupCell++;
    if (ev.filter(e => e.t === "orb").length !== log.length) orbMismatch++;
  }
  sim.__S.eatLog = null;
  check(`C6c.${key}`, "no pellet eaten twice, none left behind, no duplicated cell", build,
    !dupEat && !stillPresent && !dupCell && !orbMismatch,
    { ticks, pelletsEaten: everEaten.size, dupEat, stillPresent, dupCell, orbMismatch });
}

// ── C7: very large cells across many buckets ────────────────────────────────

function c7(build) {
  const { sim } = B[build];
  const w = bare(sim, 31);
  const G = human(sim, w, "giant", 4000, 4000, 40000);
  const m1 = 40000 - 40000 * 0.0022 * DT;          // after this tick's decay
  const reach = sim.radiusOf(m1) + 6 * 0.6;
  const inside = [], outside = [];
  for (let k = 0; k < 360; k++) {
    const a = (k / 360) * Math.PI * 2;
    inside.push(pellet(w, 4000 + Math.cos(a) * (reach - 0.3), 4000 + Math.sin(a) * (reach - 0.3)));
    outside.push(pellet(w, 4000 + Math.cos(a) * (reach + 0.3), 4000 + Math.sin(a) * (reach + 0.3)));
  }
  sim.buildPelletGrid(w);
  sim.stepWorld(w, DT);
  const inEaten = inside.filter(p => p.dead).length, outEaten = outside.filter(p => p.dead).length;
  check("C7a", "a radius-800 cell eats every orb just inside its reach, none just outside", build,
    inEaten === 360 && outEaten === 0, { inside: `${inEaten}/360`, outside: `${outEaten}/360` });

  // Prey cells strewn across the giant's whole body. The outer ring sits
  // 15 units past the eat radius: every inner kill grows the giant by ~0.24
  // units of radius within the same tick (2/sqrt(m) per unit of mass), and
  // eating all 24 inner prey moves the line by under 6.
  const w2 = bare(sim, 32);
  const g2 = human(sim, w2, "giant", 4000, 4000, 40000);
  const ra = sim.radiusOf(m1), rb = sim.radiusOf(20);
  const inner = [], outer = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    inner.push(human(sim, w2, `in${k}`, 4000 + Math.cos(a) * (ra - rb * 0.55 - 2), 4000 + Math.sin(a) * (ra - rb * 0.55 - 2), 20));
    outer.push(human(sim, w2, `out${k}`, 4000 + Math.cos(a + 0.1) * (ra - rb * 0.55 + 15), 4000 + Math.sin(a + 0.1) * (ra - rb * 0.55 + 15), 20));
  }
  sim.stepWorld(w2, DT);
  const innerEaten = inner.filter(p => !p.cells.length).length;
  const outerEaten = outer.filter(p => !p.cells.length).length;
  check("C7b", "a radius-800 cell eats prey anywhere inside its eat radius, none outside", build,
    innerEaten === 24 && outerEaten === 0, { inner: `${innerEaten}/24`, outer: `${outerEaten}/24` });
}

// ── C8: walls, corners, bucket edges ────────────────────────────────────────

function c8(build) {
  const { sim } = B[build];
  const w = bare(sim, 41);
  const S = w.size, r = sim.radiusOf(20);
  const corners = [[6, 6], [6, S - 6], [S - 6, 6], [S - 6, S - 6]];
  const ps = [], ents = [];
  corners.forEach(([x, y], i) => {
    ps.push(pellet(w, x, y));
    ents.push(human(sim, w, `k${i}`, x < S / 2 ? r : S - r, y < S / 2 ? r : S - r, 20));
  });
  // A cell sitting on a bucket corner with orbs in all four buckets.
  ents.push(human(sim, w, "edge", 2200, 2200, 20));
  for (const [dx, dy] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) ps.push(pellet(w, 2200 + dx, 2200 + dy));
  sim.buildPelletGrid(w);
  sim.stepWorld(w, DT);
  const eaten = ps.filter(p => p.dead).length;
  check("C8", "orbs in arena corners and across bucket corners are eaten", build,
    eaten === ps.length, { eaten: `${eaten}/${ps.length}` });
}

// ── C9: snapshot area-of-interest query vs brute force ──────────────────────

function c9(build, key, ticks) {
  const { sim, protocol } = B[build];
  const { world, driver } = setupScenario(sim, key, 17);
  const states = new Map();
  let missing = 0, extra = 0, checked = 0;
  for (let t = 0; t < ticks; t++) {
    driver.step(world);
    sim.stepWorld(world, DT);
    let i = 0;
    for (const p of world.players.values()) {
      let cs = states.get(p.id);
      if (!cs) states.set(p.id, (cs = protocol.createClientState(i)));
      i++;
      protocol.encodeSnapshot(world, p, cs);
      const c = sim.centroid(p), R = protocol.viewRadius(p);
      for (const q of world.pellets) {
        const dx = q.x - c.x, dy = q.y - c.y;
        const want = dx * dx + dy * dy < R * R;
        const got = cs.knownPellets.has(q.id);
        if (want && !got) missing++;
        if (!want && got) extra++;
      }
      checked++;
    }
  }
  check(`C9.${key}`, "each snapshot's pellets equal a brute-force view query", build,
    missing === 0 && extra === 0, { snapshots: checked, missing, extra });
}

// ── C10: discrete steps under a long tick ───────────────────────────────────
//
// The server steps with the measured interval, clamped at 0.25s
// (server/index.js tick()). A late tick moves everything up to 5x further.

function c10(build) {
  const { sim } = B[build];
  const out = {};
  for (const dt of [DT, 0.25]) {
    // Feed: a blob thrown straight at a virus 110 units ahead.
    const w = bare(sim, 51);
    const A = human(sim, w, "A", 2000, 2000, 120);
    A.input.x = 1000; A.input.y = 0;
    sim.queueAction(w, "A", "eject");
    sim.stepWorld(w, DT);
    const blob = w.pellets.find(p => p.owner === "A");
    w.viruses.push({ id: w.nextId++, vid: 1, x: blob.x + 110, y: blob.y, mass: 110, fed: 0, vx: 0, vy: 0 });
    sim.buildPelletGrid(w);
    for (let i = 0; i < 6; i++) sim.stepWorld(w, dt);
    out[`feed@${dt}`] = w.viruses[0].fed === 1;

    // Engulf: split onto a still prey 180 units ahead. Judged on the split
    // tick itself: after it the launched half is moving away, so a miss
    // there is final (the parent may still walk onto the prey later).
    const w2 = bare(sim, 52);
    const H = human(sim, w2, "H", 2000, 2000, 1000);
    const P = human(sim, w2, "P", 2180, 2000, 20);
    H.input.x = 1000; H.input.y = 0;
    sim.queueAction(w2, "H", "split");
    sim.stepWorld(w2, dt);
    out[`engulf@${dt}`] = !P.cells.length;
    const piece = H.cells.reduce((a, b) => (b.x > a.x ? b : a));
    out[`pieceAheadOfPrey@${dt}`] = Math.round(piece.x - 2180);
  }
  check("C10", "a feed and a split-engulf that land at 20Hz still land on a 250ms tick", build,
    out["feed@0.25"] && out["engulf@0.25"], out);
}

// ── C11: a small split piece at the normal tick ─────────────────────────────
//
// A split half launches at 780 + 40·sqrt(m) u/s. For a small half that is
// more travel per 50ms step than the width of its eat window on small prey,
// so it can step straight over prey it passes through.

function c11(build) {
  const { sim } = B[build];
  const skipped = [];
  for (let ahead = 60; ahead <= 200; ahead += 5) {
    const w = bare(sim, 61);
    const H = human(sim, w, "H", 2000, 2000, 120);
    const P = human(sim, w, "P", 2000 + ahead, 2000, 20);
    H.input.x = 1000; H.input.y = 0;
    sim.queueAction(w, "H", "split");
    // Only the launched half: watch it until it has passed the prey.
    let passed = false;
    for (let t = 0; t < 6 && P.cells.length && !passed; t++) {
      sim.stepWorld(w, DT);
      const piece = H.cells.reduce((a, b) => (b.x > a.x ? b : a));
      if (piece.x - sim.radiusOf(piece.mass) > P.cells[0]?.x) passed = true;
    }
    if (P.cells.length) skipped.push(ahead);
  }
  check("C11", "a split half that passes over smaller prey at 20Hz eats it", build,
    skipped.length === 0, { preyDistancesSkipped: skipped.join(",") });
}

// ── run ─────────────────────────────────────────────────────────────────────

console.log("\nC1  grid query superset");
c1("current"); c1("csr");
console.log("\nC2  index after resetArena");
c2("current"); c2("fresh");
console.log("\nC3  moving pellet, stale bucket");
c3("current"); c3("fresh");
console.log("\nC4  shadow brute-force check during play");
const T = QUICK ? 150 : 400;
const shadow = {};
for (const key of ["eject", "splits", "full", "churn"]) {
  shadow[key] = { current: c4("currentC", key, T), fresh: c4("freshC", key, T) };
}
shadow["eject@0.25"] = { current: c4("currentC", "eject", T, 0.25), fresh: c4("freshC", "eject", T, 0.25) };

console.log("\nC5  lockstep against a brute-force reference (eatPellets by full scan)");
const LT = QUICK ? 300 : 1200;
for (const key of ["eject", "splits", "full", "churn"]) {
  // The reference scans every pellet for every cell, so keep the split-heavy
  // run shorter.
  const n = key === "splits" ? Math.min(LT, 400) : LT;
  const dCur = lockstep("currentC", "currentC2", key, n, { refB: true });
  check(`C5.${key}`, `current == brute-force reference for ${n} ticks`, "current",
    dCur < 0, { firstDivergentTick: dCur });
  const dFresh = lockstep("freshC", "freshC2", key, n, { refB: true });
  check(`C5.${key}`, `fresh == brute-force reference for ${n} ticks`, "fresh",
    dFresh < 0, { firstDivergentTick: dFresh });
}

console.log("\nC6  duplicate consumption");
c6("current");
c6long("currentC", "churn", QUICK ? 300 : 1200);
c6long("currentC", "splits", QUICK ? 300 : 1200);
c6long("currentC", "eject", QUICK ? 300 : 1200);

console.log("\nC7  very large cells");
c7("current"); c7("gcombat");
console.log("\nC8  walls and bucket corners");
c8("current"); c8("csr");
console.log("\nC9  snapshot area of interest");
c9("current", "full", QUICK ? 60 : 200);
c9("current", "splits", QUICK ? 60 : 200);

console.log("\nC10 discrete collision steps under a long tick");
c10("current");
console.log("\nC11 discrete collision steps at the normal tick");
c11("current");

console.log("\nE   alternatives produce bit-identical games (lockstep state hash)");
for (const key of ["full", "dense", "giants", "splits", "eject", "churn"]) {
  for (const [a, b] of [["current", "csr"], ["current", "gcombat"], ["fresh", "all"]]) {
    const d = lockstep(a, b, key, LT, { seed: 23 });
    check(`E.${key}`, `${b} plays identically to ${a} for ${LT} ticks`, b, d < 0, { firstDivergentTick: d });
  }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ quick: QUICK, results, shadow }, null, 2));
process.exitCode = failed.length ? 1 : 0;
