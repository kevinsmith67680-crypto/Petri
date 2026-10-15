// ---------------------------------------------------------------------------
// Builds instrumented and alternative copies of the shared simulation.
//
// Nothing in shared/ is modified. Each build is a copy of shared/sim.js,
// shared/protocol.js and shared/codec.js written to a temporary directory,
// with text patches applied. Every patch is anchored on an exact snippet of
// the current source and the build throws if an anchor is missing or appears
// more than once, so a change to sim.js can never silently make a benchmark
// measure the wrong thing.
//
// Patch groups:
//
//   knobs     always applied. Exposes `__S` (stats/flags) from the module, a
//             spawn hook for clustered scenarios, and light phase timers
//             (bot AI, eatPellets, cellCombat, grid rebuilds). Costs two
//             performance.now() calls per timed region: ~20-40 us a tick.
//   counted   broad/narrow-phase counters, the brute-force shadow check in
//             eatPellets, and the brute-force reference mode used by the
//             lockstep tests. Too slow for headline timings.
//
// Variants (each optional, combinable):
//
//   fresh     rebuild the pellet grid after pellets move, before anyone eats,
//             and after resetArena. Fixes the two stale-index bugs.
//   csr       pellet grid as a flat counting-sort (CSR) array instead of a
//             Map of arrays. Same bucket visit order, same results.
//   gcombat   cellCombat with a uniform-grid broad phase over cells, written
//             to reproduce the original iteration order exactly.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../..");
const SHARED = path.join(ROOT, "shared");

// The revision the audit measured. The patches below are anchored on its
// source, so by default the shared/ files are read from git at this commit,
// not from the working tree: the branch has moved on since (sowOrbs, the
// closing zone) and the anchors no longer match it. SPATIAL_REV=working reads
// the working tree instead; any other value is a git revision.
export const AUDITED_REV = "d93f567";
export const REV = process.env.SPATIAL_REV || AUDITED_REV;

function source(file) {
  if (REV === "working") return fs.readFileSync(path.join(SHARED, file), "utf8");
  return execFileSync("git", ["-C", ROOT, "show", `${REV}:shared/${file}`], { encoding: "utf8", maxBuffer: 1 << 26 });
}

function once(src, anchor, replacement, label) {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`patch "${label}": anchor not found`);
  if (src.indexOf(anchor, at + 1) >= 0) throw new Error(`patch "${label}": anchor not unique`);
  return src.slice(0, at) + replacement + src.slice(at + anchor.length);
}

// The same patch for different revisions of the source: the first
// [anchor, replacement] pair whose anchor is present is applied, exactly once.
function oneOf(src, label, pairs) {
  for (const [anchor, replacement] of pairs) {
    if (src.includes(anchor)) return once(src, anchor, replacement, label);
  }
  throw new Error(`patch "${label}": no known anchor in this revision`);
}

// Replace everything from `start` (inclusive) up to `end` (exclusive).
function between(src, start, end, replacement, label, mustContain) {
  const a = src.indexOf(start);
  if (a < 0 || src.indexOf(start, a + 1) >= 0) throw new Error(`patch "${label}": start anchor`);
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error(`patch "${label}": end anchor`);
  const old = src.slice(a, b);
  for (const s of mustContain || []) {
    if (!old.includes(s)) throw new Error(`patch "${label}": replaced region lacks ${s}`);
  }
  return src.slice(0, a) + replacement + src.slice(b);
}

// `/*C:name*/` markers become counter increments in counted builds and
// vanish otherwise, so one source text serves both.
const counters = (text, on) => text.replace(/\/\*C:(\w+)(?:\+=([^*]+))?\*\//g,
  (_, name, add) => (on ? (add ? `__S.c.${name} += ${add};` : `__S.c.${name}++;`) : ""));

export const COUNTER_NAMES = [
  "buckets", "pelletCandAll",
  "eatCand", "eatNarrow", "pelletEats",
  "snapCand", "snapNarrow", "snapCellTests",
  "combatPairs", "combatIter", "combatMassPass", "combatNarrow", "combatEats",
  "combatQueries", "combatGridVisits",
  "virusTests", "feedTests", "ownTests", "botScan",
  // gridMove (the B1 fix): pellets checked after moving, and re-filed
  "gridMoves", "gridRefiles",
  // shadow check
  "shadowEligible", "missSameTick", "missStaleMoving", "missOther",
  "ghostVisits", "ghostEats"
];

const HEADER = `
// ── benchmark instrumentation (bench/spatial/build.mjs) ──
export const __S = {
  c: Object.create(null),
  t: Object.create(null),
  shadow: false,       // brute-force check every eatPellets query (observe only)
  ref: false,          // eatPellets via a full scan instead of the grid
  spawnBox: null,      // { pellet: box, player: box } for clustered scenarios
  tickStartId: 0,
  live: null,
  now: () => performance.now()
};
export function __reset() {
  for (const k of ${JSON.stringify(COUNTER_NAMES)}) __S.c[k] = 0;
  for (const k of ["bot", "eat", "combat", "grid", "gridFresh"]) __S.t[k] = 0;
}
__reset();
function __spawn(world, kind) {
  const b = __S.spawnBox && __S.spawnBox[kind];
  if (b) return { x: b.x0 + world.rng() * (b.x1 - b.x0), y: b.y0 + world.rng() * (b.y1 - b.y0) };
  return spawnPoint(world);
}
`;

// ── knobs ───────────────────────────────────────────────────────────────────

function knobs(src) {
  src = HEADER + src;
  src = oneOf(src, "spawn pellet", [
    // d93f567: makePellet picks its own point.
    ["function makePellet(world, x, y, mass, vx, vy, ci) {\n  const p = x === undefined ? spawnPoint(world) : { x, y };",
     "function makePellet(world, x, y, mass, vx, vy, ci) {\n  const p = x === undefined ? __spawn(world, \"pellet\") : { x, y };"],
    // From adb6295: sowOrbs throws darts at spawnPoint.
    ["      const p = spawnPoint(world);\n      const room = underCell(",
     "      const p = __spawn(world, \"pellet\");\n      const room = underCell("]
  ]);
  src = once(src,
    "export function spawnPlayer(world, player, mass = START_MASS) {\n  const p = spawnPoint(world);",
    "export function spawnPlayer(world, player, mass = START_MASS) {\n  const p = __spawn(world, \"player\");",
    "spawn player");
  src = once(src,
    "      const t = driveBot(world, ent, dt);",
    "      const __tb = __S.now(); const t = driveBot(world, ent, dt); __S.t.bot += __S.now() - __tb;",
    "time bot");
  src = once(src,
    "    eatPellets(world, ent);",
    "    { const __te = __S.now(); eatPellets(world, ent); __S.t.eat += __S.now() - __te; }",
    "time eat");
  src = oneOf(src, "time combat", [
    ["  if (!held) cellCombat(world);",
     "  if (!held) { const __tc = __S.now(); cellCombat(world); __S.t.combat += __S.now() - __tc; }"],
    ["  cellCombat(world);",
     "  { const __tc = __S.now(); cellCombat(world); __S.t.combat += __S.now() - __tc; }"]
  ]);
  src = oneOf(src, "time grid", [
    ["  buildPelletGrid(world);\n\n  return world.events;",
     "  { const __tg = __S.now(); buildPelletGrid(world); __S.t.grid += __S.now() - __tg; }\n\n  return world.events;"],
    ["  buildPelletGrid(world);\n\n  // Then the arena is topped back up",
     "  { const __tg = __S.now(); buildPelletGrid(world); __S.t.grid += __S.now() - __tg; }\n\n  // Then the arena is topped back up"]
  ]);
  // Before anything moves. Pellets with an id at or past tickStartId were
  // created during this tick.
  src = once(src,
    "  world.time += dt;\n  world.events.length = 0;\n",
    "  world.time += dt;\n  world.events.length = 0;\n" +
    "  __S.tickStartId = world.nextId;\n" +
    "  if (__S.shadow) __S.live = new Set(world.pellets);\n",
    "tick start");
  return src;
}

// ── counters ────────────────────────────────────────────────────────────────

const EAT_PELLETS_COUNTED = `function __eligible(world, ent, c, r, p) {
  if (p.dead) return false;
  if (p.owner === ent.id && world.time < p.ownerFree) return false;
  if (p.vx || p.vy) {
    const away = (p.x - c.x) * p.vx + (p.y - c.y) * p.vy;
    if (away > 0) return false;
  }
  const dx = p.x - c.x, dy = p.y - c.y;
  const reach = r + pelletRadius(p) * 0.6;
  return dx * dx + dy * dy < reach * reach;
}

function __eatOne(world, ent, c, p) {
  c.mass += p.mass;
  p.dead = true;
  world.pelletsDirty = true;
  ent.orbs++;
  world.events.push({ t: "orb", id: ent.id });
  __S.c.pelletEats++;
  if (__S.eatLog) __S.eatLog.push(p.id);
}

function eatPellets(world, ent) {
  for (const c of ent.cells) {
    const r = radiusOf(c.mass);

    if (__S.ref) {
      // Brute-force reference. WHAT is eaten comes from a scan of every
      // pellet in the world under the same rule (pellets created this tick
      // are exempt, as they are in every grid variant). The grid is consulted
      // only for the ORDER, so the float additions match production exactly
      // whenever the grid is complete; anything it failed to return is eaten
      // after the rest, and the two worlds diverge.
      const hit = new Set();
      for (const p of world.pellets) {
        if (p.id >= __S.tickStartId) continue;
        __S.c.eatNarrow++;
        if (__eligible(world, ent, c, r, p)) hit.add(p);
      }
      const order = [];
      forEachPelletNear(world, c.x, c.y, r + ORB_RADIUS * 3, p => { if (hit.delete(p)) order.push(p); });
      for (const p of hit) order.push(p);
      for (const p of order) __eatOne(world, ent, c, p);
      continue;
    }

    let want = null;
    if (__S.shadow) {
      want = [];
      for (const p of world.pellets) if (__eligible(world, ent, c, r, p)) want.push(p);
      __S.c.shadowEligible += want.length;
    }

    forEachPelletNear(world, c.x, c.y, r + ORB_RADIUS * 3, p => {
      __S.c.eatCand++;
      const ghost = __S.shadow && !__S.live.has(p) && p.id < __S.tickStartId;
      if (ghost) __S.c.ghostVisits++;
      if (p.dead) return;
      if (p.owner === ent.id && world.time < p.ownerFree) return;
      if (p.vx || p.vy) {
        const away = (p.x - c.x) * p.vx + (p.y - c.y) * p.vy;
        if (away > 0) return;
      }
      const dx = p.x - c.x, dy = p.y - c.y;
      const reach = r + pelletRadius(p) * 0.6;
      __S.c.eatNarrow++;
      if (dx * dx + dy * dy < reach * reach) {
        if (ghost) __S.c.ghostEats++;
        __eatOne(world, ent, c, p);
      }
    });

    if (want) {
      for (const p of want) {
        if (p.dead) continue;
        if (p.id >= __S.tickStartId) __S.c.missSameTick++;
        else if (p.vx || p.vy || p.__moved) __S.c.missStaleMoving++;
        else __S.c.missOther++;
      }
    }
  }
}

`;

function counted(src) {
  src = between(src, "function eatPellets(world, ent) {", "// Ejected mass fed into a virus.",
    EAT_PELLETS_COUNTED, "eatPellets", ["forEachPelletNear"]);
  // Moving pellets that came to rest this tick are still "moved" for the
  // shadow classification.
  src = once(src,
    "  if (Math.abs(p.vx) < 1 && Math.abs(p.vy) < 1) { p.vx = 0; p.vy = 0; }\n}",
    "  p.__moved = true;\n  if (Math.abs(p.vx) < 1 && Math.abs(p.vy) < 1) { p.vx = 0; p.vy = 0; }\n}",
    "pellet moved flag");
  src = once(src,
    "  __S.tickStartId = world.nextId;\n",
    "  __S.tickStartId = world.nextId;\n  for (const p of world.pellets) p.__moved = false;\n",
    "clear moved flag");
  // Original cellCombat, counted. Skipped automatically if gcombat replaced it.
  if (src.includes("      const A = ents[i], B = ents[j];")) {
    src = once(src, "      const A = ents[i], B = ents[j];",
      "      const A = ents[i], B = ents[j]; __S.c.combatPairs++;", "combat pairs");
    src = once(src, "          const b = B.cells[k];\n          if (a.mass < b.mass * EAT_RATIO) continue;",
      "          const b = B.cells[k]; __S.c.combatIter++;\n          if (a.mass < b.mass * EAT_RATIO) continue; __S.c.combatMassPass++;",
      "combat iter");
    src = once(src, "          const rb = radiusOf(b.mass);\n          if (Math.hypot(dx, dy) < ra - rb * 0.55) {",
      "          const rb = radiusOf(b.mass); __S.c.combatNarrow++;\n          if (Math.hypot(dx, dy) < ra - rb * 0.55) { __S.c.combatEats++;",
      "combat narrow");
  }
  src = once(src, "      const v = world.viruses[i];\n      if (Math.hypot(",
    "      const v = world.viruses[i]; __S.c.virusTests++;\n      if (Math.hypot(", "virus tests");
  src = once(src, "    for (const v of world.viruses) {\n      const dx = p.x - v.x, dy = p.y - v.y;",
    "    for (const v of world.viruses) { __S.c.feedTests++;\n      const dx = p.x - v.x, dy = p.y - v.y;", "feed tests");
  // Every own-cell pair loop (one at d93f567; merge and separation later).
  if (!src.includes("      const a = cells[i], b = cells[j];")) throw new Error('patch "own tests": anchor not found');
  src = src.split("      const a = cells[i], b = cells[j];").join("      const a = cells[i], b = cells[j]; __S.c.ownTests++;");
  src = once(src, "    for (const c of o.cells) {\n      // Cheap rejects first",
    "    for (const c of o.cells) { __S.c.botScan++;\n      // Cheap rejects first", "bot scan");
  if (src.includes("function gridMove(")) {
    src = once(src, "  if (keyOf(p) === was) return;\n", "  __S.c.gridMoves++;\n  if (keyOf(p) === was) return;\n  __S.c.gridRefiles++;\n", "grid moves");
  }
  if (src.includes("      const bucket = world.grid.get(key(gx, gy));")) {
    src = once(src, "      const bucket = world.grid.get(key(gx, gy));",
      "      const bucket = world.grid.get(key(gx, gy)); __S.c.buckets++;", "buckets");
    src = once(src, "      for (let i = 0; i < bucket.length; i++) fn(bucket[i]);",
      "      __S.c.pelletCandAll += bucket.length;\n      for (let i = 0; i < bucket.length; i++) fn(bucket[i]);", "cand all");
  }
  return src;
}

function countedProtocol(src) {
  src = once(src, "  radiusOf, totalMass, centroid, leaderboard, rankOf, MAX_WORLD, forEachPelletNear,",
    "  __S, radiusOf, totalMass, centroid, leaderboard, rankOf, MAX_WORLD, forEachPelletNear,", "import __S");
  src = once(src, "    if (p.dead || !near(p.x, p.y)) return;",
    "    __S.c.snapCand++;\n    if (p.dead || !near(p.x, p.y)) return;\n    __S.c.snapNarrow++;", "snap pellets");
  src = once(src, "      if (!near(c.x, c.y, radiusOf(c.mass))) continue;",
    "      __S.c.snapCellTests++;\n      if (!near(c.x, c.y, radiusOf(c.mass))) continue;", "snap cells");
  return src;
}

// ── variant: fresh grid ─────────────────────────────────────────────────────

function fresh(src) {
  src = once(src, "  feedViruses(world);",
    "  // [fresh] Index pellets where they are NOW, before anyone eats.\n" +
    "  { const __tg = __S.now(); buildPelletGrid(world); __S.t.gridFresh += __S.now() - __tg; }\n" +
    "  feedViruses(world);", "fresh: rebuild after advance");
  src = once(src, "  // Evenly spaced rather than scattered: a fresh round should not hand anyone",
    "  buildPelletGrid(world);   // [fresh] the old round's orbs must leave the index\n" +
    "  // Evenly spaced rather than scattered: a fresh round should not hand anyone",
    "fresh: rebuild in resetArena");
  return src;
}

// ── variant: CSR pellet grid ────────────────────────────────────────────────

const CSR_GRID = `export function buildPelletGrid(world) {
  // [csr] One flat array of pellets ordered by bucket, plus an offset table.
  // A stable counting sort, so pellets within a bucket keep world.pellets
  // order, exactly as the Map-of-arrays did.
  const cols = Math.ceil(world.size / GRID) + 1;
  const nb = cols * cols;
  let g = world.grid;
  if (!g || g.cols !== cols) {
    g = world.grid = { cols, start: new Int32Array(nb + 1), cursor: new Int32Array(nb), keys: new Int32Array(0), items: [] };
  }
  const ps = world.pellets, n = ps.length;
  if (g.keys.length < n) g.keys = new Int32Array(Math.max(n * 2, 1024));
  const start = g.start, keys = g.keys, max = cols - 1;
  start.fill(0);
  for (let i = 0; i < n; i++) {
    const p = ps[i];
    let gx = (p.x / GRID) | 0, gy = (p.y / GRID) | 0;
    gx = gx < 0 ? 0 : gx > max ? max : gx;
    gy = gy < 0 ? 0 : gy > max ? max : gy;
    const k = gx * cols + gy;
    keys[i] = k;
    start[k + 1]++;
  }
  for (let b = 0; b < nb; b++) start[b + 1] += start[b];
  const cursor = g.cursor;
  cursor.set(start.subarray(0, nb));
  const items = g.items;
  items.length = n;
  for (let i = 0; i < n; i++) items[cursor[keys[i]]++] = ps[i];
}

export function forEachPelletNear(world, x, y, r, fn) {
  if (!world.grid) buildPelletGrid(world);
  const g = world.grid, cols = g.cols, max = cols - 1, start = g.start, items = g.items;
  const x0 = Math.max(0, ((x - r) / GRID) | 0);
  const x1 = Math.min(max, ((x + r) / GRID) | 0);
  const y0 = Math.max(0, ((y - r) / GRID) | 0);
  const y1 = Math.min(max, ((y + r) / GRID) | 0);
  for (let gx = x0; gx <= x1; gx++) {
    const row = gx * cols;
    for (let gy = y0; gy <= y1; gy++) {
      const k = row + gy;
      const a = start[k], b = start[k + 1];
      /*C:buckets*/
      /*C:pelletCandAll+=b - a*/
      for (let i = a; i < b; i++) fn(items[i]);
    }
  }
}
`;

function csr(src, on) {
  // sowOrbs (adb6295 onward) inserts into the grid one orb at a time, which a
  // counting-sort layout cannot do between rebuilds.
  if (src.includes("function gridInsert(")) throw new Error("variant csr: this revision indexes orbs incrementally (gridInsert); csr predates it");
  return between(src, "export function buildPelletGrid(world) {", "const clamp = (v, a, b) =>",
    counters(CSR_GRID, on), "csr grid", ["forEachPelletNear", "world.grid"]);
}

// ── variant: grid broad phase for cellCombat ────────────────────────────────

// A victim can only be eaten if its centre lies inside the attacker:
// dist < ra - 0.55 rb < ra. So inserting every cell by its CENTRE and querying
// the attacker's box of half-size ra is complete, however large either cell
// is — a giant attacker simply spans more buckets in its query.
//
// The original loop is order-dependent (who eats first decides who can be
// eaten later), so this reproduces it exactly: attackers i in order, victims
// j in order, attacker cells in order, victim cells from the back; the
// radius used for the axis test is the one at the start of each (j, a) group
// and the mass test is live. When an attacker cell grows by eating, its
// candidate list is re-queried at the new radius before its next group.
const COMBAT_GRID = `const CGRID = 256;
function cellCombat(world) {
  // [gcombat]
  const ents = [];
  for (const p of world.players.values()) if (p.alive && p.cells.length) ents.push(p);
  const n = ents.length;
  if (n < 2) return;
  const cols = Math.ceil(world.size / CGRID) + 1, max = cols - 1, nb = cols * cols;
  const G = world.__cgrid && world.__cgrid.cols === cols ? world.__cgrid
    : (world.__cgrid = { cols, start: new Int32Array(nb + 1), cursor: new Int32Array(nb), keys: [], cells: [], owner: [] });
  let total = 0;
  for (let j = 0; j < n; j++) total += ents[j].cells.length;
  const start = G.start, keys = G.keys, cells = G.cells, owner = G.owner;
  start.fill(0);
  keys.length = total;
  let t = 0;
  for (let j = 0; j < n; j++) {
    for (const c of ents[j].cells) {
      let gx = (c.x / CGRID) | 0, gy = (c.y / CGRID) | 0;
      gx = gx < 0 ? 0 : gx > max ? max : gx;
      gy = gy < 0 ? 0 : gy > max ? max : gy;
      const k = gx * cols + gy;
      keys[t++] = k;
      start[k + 1]++;
    }
  }
  for (let b = 0; b < nb; b++) start[b + 1] += start[b];
  G.cursor.set(start.subarray(0, nb));
  cells.length = total; owner.length = total;
  t = 0;
  for (let j = 0; j < n; j++) {
    for (const c of ents[j].cells) {
      const at = G.cursor[keys[t++]]++;
      cells[at] = c; owner[at] = j;
    }
  }

  const eaten = new Set();
  // Candidate victims of attacker cell a: Map j -> Set of victim cells.
  const query = (i, a) => {
    /*C:combatQueries*/
    const ra = radiusOf(a.mass);
    let out = null;
    const x0 = Math.max(0, ((a.x - ra) / CGRID) | 0), x1 = Math.min(max, ((a.x + ra) / CGRID) | 0);
    const y0 = Math.max(0, ((a.y - ra) / CGRID) | 0), y1 = Math.min(max, ((a.y + ra) / CGRID) | 0);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const k = gx * cols + gy;
        for (let s = start[k], e = start[k + 1]; s < e; s++) {
          /*C:combatGridVisits*/
          const j = owner[s];
          if (j === i) continue;
          const b = cells[s];
          // Position only. A mass pre-filter here is NOT exact: the original
          // re-tests mass live inside a group, so a cell that has just grown
          // can eat a victim it was too small for when the group began.
          const dx = b.x - a.x; if (dx > ra || dx < -ra) continue;
          const dy = b.y - a.y; if (dy > ra || dy < -ra) continue;
          if (!out) out = new Map();
          let set = out.get(j);
          if (!set) out.set(j, (set = new Set()));
          set.add(b);
        }
      }
    }
    return out;
  };

  for (let i = 0; i < n; i++) {
    const A = ents[i];
    if (!A.cells.length) continue;
    const per = A.cells.map(a => query(i, a));
    // Victim players in order, but only those some attacker cell can reach.
    const js = new Set();
    for (const m of per) if (m) for (const j of m.keys()) js.add(j);
    if (!js.size) continue;
    let order = [...js].sort((x, y) => x - y);
    for (let oi = 0; oi < order.length; oi++) {
      const j = order[oi];
      const B = ents[j];
      if (!A.cells.length || !B.cells.length) continue;
      /*C:combatPairs*/
      let grew = false;
      for (let ai = 0; ai < A.cells.length; ai++) {
        const set = per[ai] && per[ai].get(j);
        if (!set) continue;
        const a = A.cells[ai];
        const ra = radiusOf(a.mass);
        let ate = false;
        for (let k = B.cells.length - 1; k >= 0; k--) {
          const b = B.cells[k];
          if (!set.has(b) || eaten.has(b)) continue;
          /*C:combatIter*/
          if (a.mass < b.mass * EAT_RATIO) continue;
          /*C:combatMassPass*/
          const dx = b.x - a.x; if (dx > ra || dx < -ra) continue;
          const dy = b.y - a.y; if (dy > ra || dy < -ra) continue;
          const rb = radiusOf(b.mass);
          /*C:combatNarrow*/
          if (Math.hypot(dx, dy) < ra - rb * 0.55) {
            /*C:combatEats*/
            a.mass += b.mass * EAT_BONUS;
            B.cells.splice(k, 1);
            eaten.add(b);
            A.eaten++;
            world.events.push({ t: "eat", id: A.id, victim: B.id });
            ate = true;
          }
        }
        if (ate) { per[ai] = query(i, a); grew = true; }
      }
      if (grew) {
        // A grown cell may now reach players it could not before. Keep the
        // order: only players after this one are still to come.
        const rest = new Set();
        for (const m of per) if (m) for (const jj of m.keys()) if (jj > j) rest.add(jj);
        order = order.slice(0, oi + 1).concat([...rest].sort((x, y) => x - y));
      }
    }
  }
}

`;

function gcombat(src, on) {
  return between(src, "function cellCombat(world) {", "const SCAN = 620",
    counters(COMBAT_GRID, on), "grid combat", ["EAT_BONUS", "B.cells.splice"]);
}

// ── build ───────────────────────────────────────────────────────────────────

export function buildVariant({ fresh: f = false, csr: c = false, gcombat: g = false, counted: k = false, tag = "", gridSize = null } = {}, outRoot) {
  let sim = source("sim.js");
  let protocol = source("protocol.js");
  const codec = source("codec.js");

  sim = knobs(sim);
  // Bucket size sweep. Only the constant changes.
  if (gridSize) sim = once(sim, "const GRID = 220;", `const GRID = ${gridSize};`, "grid size");
  if (c) sim = csr(sim, k);
  if (g) sim = gcombat(sim, k);
  if (f) sim = fresh(sim);
  if (k) { sim = counted(sim); protocol = countedProtocol(protocol); }

  // `tag` gives a second, independent module instance of the same build, for
  // lockstep runs that need two worlds with separate __S flags.
  const name = [k ? "counted" : "plain", f && "fresh", c && "csr", g && "gcombat", gridSize && `g${gridSize}`, tag].filter(Boolean).join("-");
  const root = path.join(outRoot || process.env.SPATIAL_BUILD_DIR || path.join(os.tmpdir(), "petri-spatial-builds"), REV);
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sim.js"), sim);
  fs.writeFileSync(path.join(dir, "protocol.js"), protocol);
  fs.writeFileSync(path.join(dir, "codec.js"), codec);
  // shared/ is an ES module tree; the copy must be too.
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  return { name, dir };
}

export async function loadVariant(opts) {
  const { name, dir } = buildVariant(opts);
  const sim = await import(pathToFileURL(path.join(dir, "sim.js")).href);
  const protocol = await import(pathToFileURL(path.join(dir, "protocol.js")).href);
  return { name, dir, sim, protocol };
}

export const VARIANTS = {
  current: {},
  fresh: { fresh: true },
  csr: { csr: true },
  gcombat: { gcombat: true },
  all: { fresh: true, csr: true, gcombat: true },
  // Bucket-size sweep on the recommended layout.
  "all-g110": { fresh: true, csr: true, gcombat: true, gridSize: 110 },
  "all-g440": { fresh: true, csr: true, gcombat: true, gridSize: 440 }
};
