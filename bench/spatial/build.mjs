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
//             to reproduce the original iteration order exactly. The
//             prototype for what shared/sim.js now ships.
//   pairs     the reverse, for revisions that ship the grid: cellCombat put
//             back to the all-pairs loop it replaced, verbatim from a44cad8.
//   mapgrid   the reverse of csr, for revisions that ship the flat pellet
//             grid: the Map of buckets put back, as it was at 7594a8b.
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
  "combatQueries", "combatGridVisits", "combatCand",
  "virusTests", "feedTests", "ownTests", "botScan",
  // gridMove (the B1 fix): pellets checked after moving, and re-filed
  "gridMoves", "gridRefiles",
  // swept collision: eats only the test along the way caught
  "sweptPelletEats", "sweptCellEats",
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

// The same instrumentation for revisions whose eatPellets also tests along
// each step (the swept collision tests). The predicate is production's, line
// for line, factored out so the grid pass, the full-scan shadow and the
// reference mode all apply exactly the same rule; the lockstep check "counted
// plays like plain" in correctness.mjs fails if it ever drifts.
const EAT_PELLETS_COUNTED_SWEPT = `function __eligible(world, ent, c, r, rs, moved, p) {
  if (p.dead) return false;
  if (p.owner === ent.id && world.time < p.ownerFree) return false;
  const dx = p.x - c.x, dy = p.y - c.y;
  const pr = pelletRadius(p) * 0.6;
  const reach = r + pr;
  const away = p.vx || p.vy ? dx * p.vx + dy * p.vy : 0;
  if (away <= 0 && dx * dx + dy * dy < reach * reach) return 1;
  const pm = p.movedAt === world.tick;
  if (!moved && !pm) return 0;
  const px0 = pm ? p.startX : p.x, py0 = pm ? p.startY : p.y;
  const ux = p.vx || p.vy ? p.vx : p.x - px0, uy = p.vx || p.vy ? p.vy : p.y - py0;
  // 2: caught along the way, missed by the end-of-tick test alone.
  return sweptWithin(px0 - c.startX, py0 - c.startY, dx, dy, rs + pr, ux, uy) ? 2 : 0;
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
  const pad = ORB_RADIUS * 3 + world.pelletStep;
  for (const c of ent.cells) {
    const r = radiusOf(c.mass);
    const rs = radiusOf(Math.min(c.startMass, c.mass));
    const moved = c.startX !== c.x || c.startY !== c.y;
    const q = r + pad;
    const box = [Math.min(c.x, c.startX) - q, Math.min(c.y, c.startY) - q,
      Math.max(c.x, c.startX) + q, Math.max(c.y, c.startY) + q];

    if (__S.ref) {
      // Brute-force reference: WHAT is eaten comes from every pellet in the
      // world; the grid only supplies the order, so a complete grid matches
      // production bit for bit and anything it misses is eaten after.
      const hit = new Set();
      for (const p of world.pellets) {
        if (p.id >= __S.tickStartId) continue;
        __S.c.eatNarrow++;
        if (__eligible(world, ent, c, r, rs, moved, p)) hit.add(p);
      }
      const order = [];
      forEachPelletIn(world, ...box, p => { if (hit.delete(p)) order.push(p); });
      for (const p of hit) order.push(p);
      for (const p of order) __eatOne(world, ent, c, p);
      continue;
    }

    let want = null;
    if (__S.shadow) {
      want = [];
      for (const p of world.pellets) {
        if (p.id >= __S.tickStartId && !(p.movedAt === world.tick)) {
          // Created this tick and not yet indexed: no grid variant sees it.
          if (__eligible(world, ent, c, r, rs, moved, p)) __S.c.missSameTick++;
          continue;
        }
        if (__eligible(world, ent, c, r, rs, moved, p)) want.push(p);
      }
      __S.c.shadowEligible += want.length;
    }

    forEachPelletIn(world, ...box, p => {
      __S.c.eatCand++;
      const ghost = __S.shadow && !__S.live.has(p) && p.id < __S.tickStartId;
      if (ghost) __S.c.ghostVisits++;
      if (p.dead || (p.owner === ent.id && world.time < p.ownerFree)) return;
      __S.c.eatNarrow++;
      const e = __eligible(world, ent, c, r, rs, moved, p);
      if (e) {
        if (ghost) __S.c.ghostEats++;
        if (e === 2) __S.c.sweptPelletEats++;
        __eatOne(world, ent, c, p);
      }
    });

    if (want) {
      for (const p of want) {
        if (p.dead) continue;
        if (p.vx || p.vy || p.__moved) __S.c.missStaleMoving++;
        else __S.c.missOther++;
      }
    }
  }
}

`;

function counted(src) {
  const swept = src.includes("function sweptWithin(");
  src = between(src, "function eatPellets(world, ent) {", "// Ejected mass fed into a virus.",
    swept ? EAT_PELLETS_COUNTED_SWEPT : EAT_PELLETS_COUNTED, "eatPellets",
    [swept ? "forEachPelletIn" : "forEachPelletNear"]);
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
  // cellCombat, counted: the all-pairs loop (up to a44cad8, and the pairs
  // variant) or the grid that replaced it. The gcombat prototype carries its
  // own counters.
  const pairsLoop = src.includes("      const A = ents[i], B = ents[j];");
  const gridLoop = src.includes("  fileCells(world, ents);\n");
  if (pairsLoop) {
    src = once(src, "      const A = ents[i], B = ents[j];",
      "      const A = ents[i], B = ents[j]; __S.c.combatPairs++;", "combat pairs");
    src = once(src, "          const b = B.cells[k];\n          if (a.mass < b.mass * EAT_RATIO) continue;",
      "          const b = B.cells[k]; __S.c.combatIter++;\n          if (a.mass < b.mass * EAT_RATIO) continue; __S.c.combatMassPass++;",
      "combat iter");
  }
  if (gridLoop) {
    src = once(src, "  const stamp = ++cg.stamp;\n", "  const stamp = ++cg.stamp; __S.c.combatQueries++;\n", "combat queries");
    src = once(src, "        const t = entries[s];\n", "        const t = entries[s]; __S.c.combatGridVisits++;\n", "combat grid visits");
    src = once(src, "        (out || (out = [])).push(t);\n", "        (out || (out = [])).push(t); __S.c.combatCand++;\n", "combat candidates");
    src = once(src, "      const B = ents[j];\n      if (!B.cells.length) continue;\n",
      "      const B = ents[j];\n      if (!B.cells.length) continue; __S.c.combatPairs++;\n", "combat pairs");
    src = once(src, "          const b = filed[t];\n          if (a.mass < b.mass * EAT_RATIO) continue;",
      "          const b = filed[t]; __S.c.combatIter++;\n          if (a.mass < b.mass * EAT_RATIO) continue; __S.c.combatMassPass++;",
      "combat iter");
  }
  if (pairsLoop || gridLoop) {
    src = oneOf(src, "combat narrow", [
      ["          const rb = radiusOf(b.mass);\n          if (Math.hypot(dx, dy) < ra - rb * 0.55) {",
       "          const rb = radiusOf(b.mass); __S.c.combatNarrow++;\n          if (Math.hypot(dx, dy) < ra - rb * 0.55) { __S.c.combatEats++;"],
      // Swept revisions decide first and act after.
      ["          const rb = radiusOf(b.mass);\n          let hit = ",
       "          const rb = radiusOf(b.mass); __S.c.combatNarrow++;\n          let hit = "]
    ]);
    if (src.includes("              closestApproach(sx, sy, dx, dy) < radiusOf(least) - radiusOf(most) * 0.55;\n")) {
      src = once(src, "              closestApproach(sx, sy, dx, dy) < radiusOf(least) - radiusOf(most) * 0.55;\n",
        "              closestApproach(sx, sy, dx, dy) < radiusOf(least) - radiusOf(most) * 0.55;\n            if (hit) __S.c.sweptCellEats++;\n",
        "swept cell eats");
    }
    if (src.includes("          if (hit) {\n            a.mass += b.mass * EAT_BONUS;")) {
      src = once(src, "          if (hit) {\n            a.mass += b.mass * EAT_BONUS;",
        "          if (hit) { __S.c.combatEats++;\n            a.mass += b.mass * EAT_BONUS;", "combat eats");
    }
  }
  src = oneOf(src, "virus tests", [
    ["      const v = world.viruses[i];\n      if (Math.hypot(",
     "      const v = world.viruses[i]; __S.c.virusTests++;\n      if (Math.hypot("],
    ["      const v = world.viruses[i];\n      const dx = v.x - c.x",
     "      const v = world.viruses[i]; __S.c.virusTests++;\n      const dx = v.x - c.x"]
  ]);
  src = oneOf(src, "feed tests", [
    ["    for (const v of world.viruses) {\n      const dx = p.x - v.x, dy = p.y - v.y;",
     "    for (const v of world.viruses) { __S.c.feedTests++;\n      const dx = p.x - v.x, dy = p.y - v.y;"],
    ["    for (const v of world.viruses) {\n      const reach = radiusOf(v.mass) + pr;",
     "    for (const v of world.viruses) { __S.c.feedTests++;\n      const reach = radiusOf(v.mass) + pr;"]
  ]);
  // Every own-cell pair loop (one at d93f567; merge and separation later).
  if (!src.includes("      const a = cells[i], b = cells[j];")) throw new Error('patch "own tests": anchor not found');
  src = src.split("      const a = cells[i], b = cells[j];").join("      const a = cells[i], b = cells[j]; __S.c.ownTests++;");
  src = once(src, "    for (const c of o.cells) {\n      // Cheap rejects first",
    "    for (const c of o.cells) { __S.c.botScan++;\n      // Cheap rejects first", "bot scan");
  if (src.includes("function gridMove(")) {
    src = oneOf(src, "grid moves", [
      ["  if (keyOf(p) === was) return;\n", "  __S.c.gridMoves++;\n  if (keyOf(p) === was) return;\n  __S.c.gridRefiles++;\n"],
      ["  if (bucketOf(g, p) === was) return;\n", "  __S.c.gridMoves++;\n  if (bucketOf(g, p) === was) return;\n  __S.c.gridRefiles++;\n"]
    ]);
  }
  if (src.includes("      const k = row + gy;\n      for (let i = start[k], end = start[k + 1]; i < end; i++) {")) {
    src = once(src, "      const k = row + gy;\n      for (let i = start[k], end = start[k + 1]; i < end; i++) {",
      "      const k = row + gy; __S.c.buckets++; __S.c.pelletCandAll += start[k + 1] - start[k] + (extra[k] === null ? 0 : extra[k].length);\n      for (let i = start[k], end = start[k + 1]; i < end; i++) {", "flat buckets");
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
  if (src.includes("// Laid out flat:")) throw new Error("variant csr: this revision ships its own flat pellet grid; compare it with mapgrid instead");
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
  // The prototype tests only where cells end the tick. Against a revision
  // that also tests along the way it would quietly undo that, so it refuses:
  // a swept version has to insert cells where they end and query each
  // attacker's whole step, widened by the furthest any cell moved.
  if (src.includes("function fileCells(")) throw new Error("variant gcombat: this revision ships its own grid broad phase in cellCombat; compare it with pairs instead");
  if (src.includes("function closestApproach(")) throw new Error("variant gcombat: this revision tests collisions along each step; the prototype predates it");
  return between(src, "function cellCombat(world) {", "const SCAN = 620",
    counters(COMBAT_GRID, on), "grid combat", ["EAT_BONUS", "B.cells.splice"]);
}

// ── variant: Map grid ───────────────────────────────────────────────────────

// The pellet grid as a Map of bucket arrays, as it was before the flat layout
// shipped (7594a8b), with the call signatures the rest of sim.js now uses.
// The same text as test/pelletgrid.test.js's reference.
const MAP_GRID = `const GRID = 220;
const key = (gx, gy) => gx * 100003 + gy;

export function buildPelletGrid(world) {
  const g = world.grid || (world.grid = new Map());
  for (const bucket of g.values()) bucket.length = 0;
  for (const p of world.pellets) mapInsert(g, p);
}

const keyOf = p => key((p.x / GRID) | 0, (p.y / GRID) | 0);
const bucketOf = (g, p) => keyOf(p);

function mapInsert(g, p) {
  const k = keyOf(p);
  const bucket = g.get(k);
  if (bucket) bucket.push(p);
  else g.set(k, [p]);
}
const gridInsert = (world, p) => mapInsert(world.grid, p);

function gridMove(world, p, was) {
  const g = world.grid;
  if (keyOf(p) === was) return;
  const from = g.get(was);
  const i = from ? from.indexOf(p) : -1;
  if (i >= 0) from.splice(i, 1);
  mapInsert(g, p);
}

export function forEachPelletNear(world, x, y, r, fn) {
  forEachPelletIn(world, x - r, y - r, x + r, y + r, fn);
}

function forEachPelletIn(world, minX, minY, maxX, maxY, fn) {
  if (!world.grid) buildPelletGrid(world);
  const x0 = Math.max(0, (minX / GRID) | 0);
  const x1 = (maxX / GRID) | 0;
  const y0 = Math.max(0, (minY / GRID) | 0);
  const y1 = (maxY / GRID) | 0;
  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const bucket = world.grid.get(key(gx, gy));
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
    }
  }
}
`;

function mapgrid(src) {
  if (!src.includes("// Laid out flat:")) throw new Error("variant mapgrid: this revision's pellet grid is already a Map");
  return between(src, "// Laid out flat:", "const clamp = (v, a, b) =>", MAP_GRID + "\n", "map grid", ["function gridMove(world, p, was)"]);
}

// ── variant: all pairs ──────────────────────────────────────────────────────

// cellCombat as it was before the grid broad phase shipped: every ordered
// pair of players, every cell against every cell. Verbatim from a44cad8, so
// lockstep runs show the grid plays exactly the game this did.
const ALL_PAIRS = `function cellCombat(world) {
  const ents = [...world.players.values()].filter(p => p.alive && p.cells.length);
  // No pair can have closed by more than both their steps on an axis, so a
  // pair further apart at the end than reach plus twice the longest step any
  // cell took is rejected on end positions alone, as cheaply as before. Zero
  // when nothing moved.
  let step = 0;
  for (const ent of ents) {
    for (const c of ent.cells) {
      const d = Math.max(Math.abs(c.x - c.startX), Math.abs(c.y - c.startY));
      if (d > step) step = d;
    }
  }
  const band = 2 * step;
  for (let i = 0; i < ents.length; i++) {
    for (let j = 0; j < ents.length; j++) {
      if (i === j) continue;
      const A = ents[i], B = ents[j];
      if (!A.cells.length || !B.cells.length) continue;
      for (const a of A.cells) {
        const ra = radiusOf(a.mass), rw = ra + band;
        // The smallest this cell was during the tick: all it can have eaten
        // on the way, whatever it has eaten since.
        const least = Math.min(a.startMass, a.mass);
        for (let k = B.cells.length - 1; k >= 0; k--) {
          const b = B.cells[k];
          if (a.mass < b.mass * EAT_RATIO) continue;
          // Axis reject before the sqrt: with a hundred players this pair
          // loop runs ten thousand times a tick. The first covers anything
          // the band rules out; the second, the way from where the pair
          // started to where it ended, so two cells that passed through each
          // other this tick are not thrown out on where they stopped. A pair
          // that did not move is rejected exactly as before.
          const dx = b.x - a.x; if (dx > rw || dx < -rw) continue;
          const dy = b.y - a.y; if (dy > rw || dy < -rw) continue;
          const sx = b.startX - a.startX, sy = b.startY - a.startY;
          if (sweptApart(sx, sy, dx, dy, ra)) continue;
          const rb = radiusOf(b.mass);
          let hit = Math.hypot(dx, dy) < ra - rb * 0.55;
          if (!hit && (sx !== dx || sy !== dy)) {
            // On the way: the eater at its smallest, the prey at its largest.
            const most = Math.max(b.startMass, b.mass);
            hit = least >= most * EAT_RATIO &&
              closestApproach(sx, sy, dx, dy) < radiusOf(least) - radiusOf(most) * 0.55;
          }
          if (hit) {
            a.mass += b.mass * EAT_BONUS;
            B.cells.splice(k, 1);
            A.eaten++;
            world.events.push({ t: "eat", id: A.id, victim: B.id });
          }
        }
      }
    }
  }
}

`;

function pairs(src) {
  if (!src.includes("  fileCells(world, ents);\n")) throw new Error("variant pairs: this revision's cellCombat already tests all pairs");
  return between(src, "function cellCombat(world) {", "const SCAN = 620", ALL_PAIRS, "all pairs", ["fileCells(world, ents)"]);
}

// ── build ───────────────────────────────────────────────────────────────────

export function buildVariant({ fresh: f = false, csr: c = false, gcombat: g = false, pairs: pr = false, mapgrid: mg = false, counted: k = false, tag = "", gridSize = null } = {}, outRoot) {
  let sim = source("sim.js");
  let protocol = source("protocol.js");
  const codec = source("codec.js");

  sim = knobs(sim);
  // Bucket size sweep. Only the constant changes.
  if (gridSize) sim = once(sim, "const GRID = 220;", `const GRID = ${gridSize};`, "grid size");
  if (c) sim = csr(sim, k);
  if (g) sim = gcombat(sim, k);
  if (pr) sim = pairs(sim);
  if (mg) sim = mapgrid(sim);
  if (f) sim = fresh(sim);
  if (k) { sim = counted(sim); protocol = countedProtocol(protocol); }

  // `tag` gives a second, independent module instance of the same build, for
  // lockstep runs that need two worlds with separate __S flags.
  const name = [k ? "counted" : "plain", f && "fresh", c && "csr", g && "gcombat", pr && "pairs", mg && "mapgrid", gridSize && `g${gridSize}`, tag].filter(Boolean).join("-");
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
  pairs: { pairs: true },
  mapgrid: { mapgrid: true },
  all: { fresh: true, csr: true, gcombat: true },
  // Bucket-size sweep on the recommended layout.
  "all-g110": { fresh: true, csr: true, gcombat: true, gridSize: 110 },
  "all-g440": { fresh: true, csr: true, gcombat: true, gridSize: 440 },
  // Bucket-size sweep on whatever the revision ships.
  g110: { gridSize: 110 },
  g165: { gridSize: 165 },
  g330: { gridSize: 330 },
  g440: { gridSize: 440 }
};
