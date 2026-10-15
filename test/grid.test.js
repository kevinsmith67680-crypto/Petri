// ---------------------------------------------------------------------------
// The pellet index must answer with where pellets ARE. Run with:
//   node test/grid.test.js
//
// The grid is rebuilt at the end of a tick, but pellets in flight move at the
// start of the next one, before anyone eats. Until stepWorld re-filed them as
// they moved, a thrown blob was looked up where it had been a tick earlier —
// up to 57 units off at 20Hz, three times the eat query's padding — so a cell
// could have mass it was touching pass straight through it. That shipped
// because every test here looked at the grid after a tick, when it is right.
// These look at what a tick ate, and compare it with a brute-force scan.
//
// bench/spatial/ has the full audit (shadow scans of every query, lockstep
// against a reference simulation); these are the checks cheap enough to run
// on every change.
// ---------------------------------------------------------------------------

import {
  createWorld, addPlayer, stepWorld, queueAction, resetArena, buildPelletGrid,
  forEachPelletNear, advancePellet, radiusOf, pelletRadius, centroid,
  PELLET_MASS, EJECT_SPEED, EJECT_KEEP, DECAY_ABOVE, TICK_HZ
} from "../shared/sim.js";
import { createClientState, encodeSnapshot, decodeSnapshot } from "../shared/protocol.js";

let failures = 0;

function check(label, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const DT = 1 / TICK_HZ;

// ── fixtures ────────────────────────────────────────────────────────────────

function bare(seed, opts = {}) {
  return createWorld(seed, { pellets: 0, viruses: 0, ...opts });
}

// A human with no aim and no split speed stays exactly where it is put.
function still(w, id, x, y, mass) {
  const p = addPlayer(w, { id, name: id });
  Object.assign(p.cells[0], { x, y, mass });
  return p;
}

function orb(w, x, y, extra = {}) {
  const p = { id: w.nextId++, x, y, mass: PELLET_MASS, vx: 0, vy: 0, ci: 0, ...extra };
  w.pellets.push(p);
  return p;
}

const rng = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// What every query sees, independent of how the grid stores it: the whole
// arena must turn up each live pellet exactly once and nothing else, and a
// zero-radius query at a pellet's own position must find it.
function audit(w) {
  const seen = new Map();
  forEachPelletNear(w, w.size / 2, w.size / 2, w.size, p => seen.set(p, (seen.get(p) || 0) + 1));
  const live = new Set(w.pellets);
  let missing = 0, extra = 0, twice = 0, misfiled = 0;
  for (const p of live) if (!seen.has(p)) missing++;
  for (const [p, n] of seen) { if (!live.has(p)) extra++; if (n > 1) twice++; }
  for (const p of live) {
    let found = false;
    forEachPelletNear(w, p.x, p.y, 0, q => { if (q === p) found = true; });
    if (!found) misfiled++;
  }
  return { missing, extra, twice, misfiled };
}
const clean = a => !a.missing && !a.extra && !a.twice && !a.misfiled;

// The eat rule, by brute force (eatPellets in shared/sim.js). Cells here are
// still and below DECAY_ABOVE, so neither position nor reach changes during
// the tick; pellets are taken where advancePellet will put them.
function predictEats(w) {
  const next = new Map();
  for (const p of w.pellets) {
    const q = { x: p.x, y: p.y, vx: p.vx, vy: p.vy };
    advancePellet(q, DT, w.size);
    next.set(p, q);
  }
  const taken = new Map();       // pellet -> player id
  for (const ent of w.players.values()) {
    for (const c of ent.cells) {
      const r = radiusOf(c.mass);
      for (const [p, q] of next) {
        if (taken.has(p)) continue;
        if (p.owner === ent.id && w.time + DT < p.ownerFree) continue;
        if ((q.vx || q.vy) && (q.x - c.x) * q.vx + (q.y - c.y) * q.vy > 0) continue;
        const reach = r + pelletRadius(p) * 0.6;
        if ((q.x - c.x) ** 2 + (q.y - c.y) ** 2 < reach * reach) taken.set(p, ent.id);
      }
    }
  }
  return taken;
}

// ── a blob that crosses a bucket line into reach ────────────────────────────
//
// A still cell, and a blob thrown at it from far enough back that it changes
// bucket on the tick it arrives. Swept across a few buckets and in five
// directions, so some arrivals cross a line just outside the cell's query box
// — exactly the case the old index missed — whatever the bucket size is.

console.log("\n-- a thrown blob is eaten on the tick it reaches a cell --");
{
  const probe = { x: 1000, y: 1000, vx: EJECT_SPEED, vy: 0 };
  advancePellet(probe, DT, 8800);
  const travel = probe.x - 1000;              // first-tick flight, ~57 units

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [Math.SQRT1_2, Math.SQRT1_2]];
  let cases = 0, missed = 0;
  const misses = [];
  for (const [ux, uy] of dirs) {
    for (let k = 0; k < 64; k++) {
      const cx = 3000 + k * 11, cy = 3000 + k * 7;
      const w = bare(100 + k);
      const me = still(w, "me", cx, cy, 20);
      // Lands 15 units short of the centre, still approaching.
      const back = 15 + travel;
      const blob = orb(w, cx - ux * back, cy - uy * back,
        { mass: EJECT_KEEP, vx: ux * EJECT_SPEED, vy: uy * EJECT_SPEED, owner: "rival", ownerFree: 0 });
      buildPelletGrid(w);
      stepWorld(w, DT);
      cases++;
      if (!blob.dead || me.orbs !== 1) {
        missed++;
        if (misses.length < 3) misses.push(`${ux.toFixed(1)},${uy.toFixed(1)} @${cx},${cy}`);
      }
    }
  }
  check(`every arrival eaten that tick (${cases} throws, 5 directions)`, missed === 0,
    missed ? `${missed} passed through, e.g. ${misses.join("; ")}` : "");
}

// ── thrown mass in play, against brute force ────────────────────────────────
//
// Fifty still cells in a field of orbs, with twenty blobs a tick thrown at
// them from every side, some fast enough to fly through. Every tick, what
// stepWorld ate must be exactly what the eat rule says, pellet for pellet and
// player for player.

console.log("\n-- a field of still cells under fire matches brute force --");
{
  const w = createWorld(7, { pellets: 1500, viruses: 0 });
  check("initial sowing is indexed", clean(audit(w)), JSON.stringify(audit(w)));

  const r = rng(99);
  const cells = [];
  for (let i = 0; i < 50; i++) {
    const x = 700 + (i % 10) * 820 + r() * 120, y = 900 + Math.floor(i / 10) * 1500 + r() * 120;
    cells.push(still(w, `c${i}`, x, y, 20 + r() * 180));
  }
  check("fixture cells are below the decay line", cells.every(p => p.cells[0].mass < DECAY_ABOVE));
  buildPelletGrid(w);

  let ticks = 0, wrong = 0, extra = 0, eaten = 0, eatenMoving = 0, badIndex = 0, firstBad = "";
  const everEaten = new Set();
  let twice = 0;
  for (let t = 0; t < 80; t++) {
    // Throw: aimed at a cell from 40-260 units out, at 30-100% of launch speed.
    for (let n = 0; n < 20; n++) {
      const c = cells[(r() * cells.length) | 0].cells[0];
      const a = r() * Math.PI * 2, d = 40 + r() * 220, s = EJECT_SPEED * (0.3 + 0.7 * r());
      orb(w, c.x + Math.cos(a) * d, c.y + Math.sin(a) * d,
        { mass: r() < 0.5 ? EJECT_KEEP : PELLET_MASS, vx: -Math.cos(a) * s, vy: -Math.sin(a) * s, owner: "rival", ownerFree: 0 });
    }
    // As if thrown last tick: mass joins the index when the tick that made it ends.
    buildPelletGrid(w);
    // Cells grow as they eat. Above DECAY_ABOVE they shrink before eating,
    // which the brute force does not model, so keep them under it.
    for (const p of cells) p.cells[0].mass = Math.min(p.cells[0].mass, DECAY_ABOVE - 20);

    const want = predictEats(w);
    const before = new Map(w.pellets.map(p => [p.id, p]));
    const flying = new Set(w.pellets.filter(p => p.vx || p.vy));
    const orbsBefore = new Map(cells.map(p => [p.id, p.orbs]));
    stepWorld(w, DT);
    const after = new Set(w.pellets.map(p => p.id));
    ticks++;

    const gone = [...before.values()].filter(p => !after.has(p.id));
    for (const p of gone) {
      eaten++;
      if (everEaten.has(p.id)) twice++;
      everEaten.add(p.id);
      if (!want.has(p)) extra++;
      else if (flying.has(p)) eatenMoving++;
    }
    for (const [p] of want) {
      if (after.has(p.id)) { wrong++; if (!firstBad) firstBad = `tick ${t + 1}: pellet ${p.id} skipped`; }
    }
    // Player by player: the right cell got each one.
    for (const p of cells) {
      const n = [...want.values()].filter(id => id === p.id).length;
      if (p.orbs - orbsBefore.get(p.id) !== n) { wrong++; if (!firstBad) firstBad = `tick ${t + 1}: ${p.id} ate the wrong count`; }
    }
    if (!clean(audit(w))) badIndex++;
  }
  check(`every eat the rule requires happened (${ticks} ticks, ${eaten} eaten)`, wrong === 0, firstBad);
  check("and nothing the rule forbids", extra === 0, `${extra} unexpected`);
  check("thrown mass was in play", eatenMoving > 50, `${eatenMoving} eaten in flight`);
  check("no pellet was eaten twice", twice === 0);
  check("index exact after every tick: moved, stopped, eaten and refilled", badIndex === 0, `${badIndex} bad ticks`);
}

// ── real ejected mass, at a neighbour ───────────────────────────────────────
//
// The whole path a player uses: queueAction eject, the blob leaving the
// membrane, coasting, slowing. A still cell sits on the line of the throw at
// a range of distances. A blob that ends a tick inside its reach and still
// approaching should already have been eaten.

console.log("\n-- ejected mass is never carried through a cell --");
{
  let throws = 0, carried = 0, landed = 0;
  for (let d = 30; d <= 260; d += 5) {
    const w = bare(500 + d);
    const T = still(w, "thrower", 2000, 3000, 400);
    T.input.x = 1000; T.input.y = 0;
    const S = still(w, "target", 2000 + 83 + d, 3000, 20);
    queueAction(w, "thrower", "eject");
    stepWorld(w, DT);
    T.input.x = 0;
    const blob = w.pellets.find(p => p.owner === "thrower");
    if (!blob) continue;
    throws++;
    for (let i = 0; i < 40 && !blob.dead; i++) {
      stepWorld(w, DT);
      if (blob.dead) break;
      const c = S.cells[0];
      const reach = radiusOf(c.mass) + pelletRadius(blob) * 0.6;
      const inReach = (blob.x - c.x) ** 2 + (blob.y - c.y) ** 2 < reach * reach;
      const closing = !(blob.vx || blob.vy) || (blob.x - c.x) * blob.vx + (blob.y - c.y) * blob.vy <= 0;
      if (inReach && closing) { carried++; break; }
    }
    if (blob.dead && S.orbs === 1) landed++;
  }
  check(`no blob sits in reach uneaten (${throws} throws)`, carried === 0, `${carried} carried`);
  check("and the throws do land", landed > throws / 2, `${landed}/${throws}`);
}

// ── stationary orbs stay where they are filed ───────────────────────────────

console.log("\n-- a still board is not disturbed --");
{
  const w = createWorld(11, { pellets: 800, viruses: 0 });
  const p = still(w, "me", 4400, 4400, 20);
  const where = new Map(w.pellets.map(q => [q.id, `${q.x},${q.y}`]));
  for (let i = 0; i < 40; i++) stepWorld(w, DT);
  const moved = w.pellets.filter(q => where.has(q.id) && where.get(q.id) !== `${q.x},${q.y}`).length;
  check("orbs at rest never move", moved === 0, `${moved} moved`);
  check("index exact with nothing in flight", clean(audit(w)), JSON.stringify(audit(w)));
  check("and the still cell is where it was put", centroid(p).x === 4400 && centroid(p).y === 4400);
}

// ── a new round ─────────────────────────────────────────────────────────────
//
// resetArena replaces every orb. Mass still in flight when the whistle goes
// is part of the old board and must leave the index with it.

console.log("\n-- the index after resetArena --");
{
  const w = createWorld(13, { pellets: 600, viruses: 0 });
  const me = still(w, "me", 4400, 4400, 20);
  for (let i = 0; i < 30; i++) orb(w, 500 + i * 250, 2000, { mass: EJECT_KEEP, vx: 900, vy: 300, owner: "x", ownerFree: 0 });
  buildPelletGrid(w);
  stepWorld(w, DT);
  const old = w.pellets.slice();
  resetArena(w);
  const a = audit(w);
  check("holds exactly the new board", clean(a), JSON.stringify(a));
  check("with none of the old one", !old.some(p => w.pellets.includes(p)));

  const snap = decodeSnapshot(encodeSnapshot(w, me, createClientState(0)));
  const ids = new Set(w.pellets.map(p => p.id));
  check("the first snapshot shows only new orbs", snap.added.every(p => ids.has(p.id)),
    `${snap.added.filter(p => !ids.has(p.id)).length} ghosts`);

  // Stand on an orb from the old board that has nothing new near it.
  const ghost = old.find(p => !w.pellets.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 60));
  Object.assign(me.cells[0], { x: Math.min(Math.max(ghost.x, 40), w.size - 40), y: Math.min(Math.max(ghost.y, 40), w.size - 40) });
  const before = me.orbs;
  stepWorld(w, DT);
  check("nobody eats an orb from the last round", me.orbs === before, `${me.orbs - before} eaten`);
  for (let i = 0; i < 10; i++) stepWorld(w, DT);
  check("and the index stays exact into the round", clean(audit(w)), JSON.stringify(audit(w)));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
