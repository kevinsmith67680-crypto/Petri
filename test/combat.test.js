// ---------------------------------------------------------------------------
// Player-versus-player collisions: the grid broad phase against brute force.
// Run with:
//   node test/combat.test.js
//
// cellCombat files every cell in a grid and tests each attacker cell only
// against the cells filed near it (see "cell combat" in shared/sim.js). The
// rule it implements is the plain all-pairs loop, written out below as the
// reference: every player in join order against every other in join order,
// each attacker cell in order against the victim's cells from the back, a
// bite landing at once. The two must agree on every bite, its order and every
// number, so this file builds a second copy of shared/sim.js with the
// reference in place of cellCombat and checks:
//
//   - hand-built cases: giants across many buckets, long steps across
//     buckets, walls, a victim filed in several buckets, the priority rules;
//   - thousands of random frozen states, compared bite for bite;
//   - whole games played side by side, tick by tick: a full 100-player
//     lobby, heavy splitting at varying tick lengths, and giants.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let failures = 0;

function check(label, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

// ── the two builds ──────────────────────────────────────────────────────────

// The rule, as plainly as it can be written. No broad phase and no early
// rejects: every cell of every player against every cell of every other.
const REFERENCE = `function cellCombat(world) {
  const ents = [...world.players.values()].filter(p => p.alive && p.cells.length);
  for (let i = 0; i < ents.length; i++) {
    for (let j = 0; j < ents.length; j++) {
      if (i === j) continue;
      const A = ents[i], B = ents[j];
      for (const a of A.cells) {
        const ra = radiusOf(a.mass);
        const least = Math.min(a.startMass, a.mass);
        for (let k = B.cells.length - 1; k >= 0; k--) {
          const b = B.cells[k];
          if (a.mass < b.mass * EAT_RATIO) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const sx = b.startX - a.startX, sy = b.startY - a.startY;
          let hit = Math.hypot(dx, dy) < ra - radiusOf(b.mass) * 0.55;
          if (!hit && (sx !== dx || sy !== dy)) {
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

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "shared", "sim.js"), "utf8");
const from = source.indexOf("function cellCombat(world) {");
const to = source.indexOf("const SCAN = 620", from);
if (from < 0 || to < 0 || source.indexOf("function cellCombat(world) {", from + 1) >= 0) {
  throw new Error("test/combat.test.js: cannot find cellCombat in shared/sim.js to swap");
}
// cellCombat is internal; both copies export it under one name for the
// frozen-state checks.
const EXPOSE = "\nexport { cellCombat as combatForTest };\n";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-combat-"));
fs.writeFileSync(path.join(dir, "grid.mjs"), source + EXPOSE);
fs.writeFileSync(path.join(dir, "pairs.mjs"), source.slice(0, from) + REFERENCE + source.slice(to) + EXPOSE);
const G = await import(pathToFileURL(path.join(dir, "grid.mjs")).href);
const P = await import(pathToFileURL(path.join(dir, "pairs.mjs")).href);
fs.rmSync(dir, { recursive: true, force: true });

const { radiusOf, EAT_RATIO, EAT_BONUS, MAX_CELLS, TICK_HZ } = G;
const DT = 1 / TICK_HZ;
const CELL_GRID = 256;               // as in shared/sim.js; only used to place fixtures
const bucket = v => Math.max(0, Math.floor(v / CELL_GRID));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── frozen states ───────────────────────────────────────────────────────────
//
// cellCombat reads only the players, their cells and the arena size, and
// writes masses, cells, eat counts and events. A frozen state is just that,
// so each build can be handed an identical copy.

let nextId = 1;
const arena = (size = 8800) => ({ size, players: new Map(), events: [] });
function player(w, id, cells) {
  const p = { id, alive: true, eaten: 0, cells };
  w.players.set(id, p);
  return p;
}
// A cell that went from (sx, sy) to (x, y) this tick, at startMass then mass.
const cell = (x, y, mass, sx = x, sy = y, startMass = mass) =>
  ({ id: nextId++, x, y, mass, startX: sx, startY: sy, startMass });

const outcome = w => JSON.stringify({
  events: w.events,
  players: [...w.players.values()].map(p => [p.id, p.eaten, p.cells.map(c => [c.id, c.mass])])
});

// Run both builds on copies of w. Returns the grid build's copy, and whether
// the reference agreed with it exactly.
function both(w) {
  const g = structuredClone(w), r = structuredClone(w);
  G.combatForTest(g);
  P.combatForTest(r);
  return { g, same: outcome(g) === outcome(r), r };
}
const cellsOf = (w, id) => w.players.get(id).cells;

console.log("\nLarge cells across many buckets");
{
  // A radius-800 giant, prey all round the edge of its body: the ones just
  // inside are filed in buckets several away from the giant's own.
  const w = arena();
  const giant = cell(4000, 4000, 40000);
  const ra = radiusOf(40000), rb = radiusOf(20), line = ra - rb * 0.55;
  // Just outside, and tested first (joined first), before the giant grows.
  const out = [], inn = [];
  for (let k = 0; k < MAX_CELLS; k++) {
    const a = (k / MAX_CELLS) * Math.PI * 2;
    out.push(cell(4000 + Math.cos(a) * (line + 0.5), 4000 + Math.sin(a) * (line + 0.5), 20));
    inn.push(cell(4000 + Math.cos(a + 0.2) * (line - 0.5), 4000 + Math.sin(a + 0.2) * (line - 0.5), 20));
  }
  player(w, "giant", [giant]);
  player(w, "outside", out);
  player(w, "inside", inn);
  const buckets = new Set(inn.map(c => `${bucket(c.x)},${bucket(c.y)}`));
  const { g, same } = both(w);
  check("a giant eats prey anywhere just inside its reach", cellsOf(g, "inside").length === 0,
    `${MAX_CELLS - cellsOf(g, "inside").length}/${MAX_CELLS} eaten, filed in ${buckets.size} buckets`);
  check("and none just outside it", cellsOf(g, "outside").length === MAX_CELLS);
  check("bite for bite as the reference", same);
}
{
  // A giant victim, filed by its centre only, eaten by a bigger giant whose
  // centre is two buckets away.
  const ra = radiusOf(40000), rb = radiusOf(20000), line = ra - rb * 0.55;
  for (const [d, eaten] of [[line - 0.5, true], [line + 0.5, false]]) {
    const w = arena();
    player(w, "big", [cell(3000, 3000, 40000)]);
    player(w, "victim", [cell(3000 + d, 3000, 20000)]);
    const { g, same } = both(w);
    check(`a giant victim ${eaten ? "inside" : "outside"} the line is ${eaten ? "" : "not "}eaten across ${bucket(3000 + d) - bucket(3000)} buckets`,
      (cellsOf(g, "victim").length === 0) === eaten && same);
  }
}

console.log("\nPaths across buckets");
{
  // A 900-unit step across five buckets, prey half way along.
  const w = arena();
  player(w, "fast", [cell(1900, 3000, 400, 1000, 3000)]);
  player(w, "middle", [cell(1450, 3020, 20)]);
  player(w, "beside", [cell(1450, 3000 + radiusOf(400) + 5, 20)]);
  const { g, same } = both(w);
  check("a 900-unit step eats prey half way along, in a bucket neither end is in",
    cellsOf(g, "middle").length === 0 && bucket(1450) !== bucket(1000) && bucket(1450) !== bucket(1900));
  check("but not prey beside the path", cellsOf(g, "beside").length === 1);
  check("bite for bite as the reference", same);
}
{
  // Two paths crossing, in a bucket neither cell started or ended in.
  const w = arena();
  player(w, "across", [cell(2800, 2300, 400, 2000, 2300)]);
  player(w, "down", [cell(2400, 1900, 20, 2400, 2700)]);
  const { g, same } = both(w);
  check("two cells crossing in a bucket neither started or ended in still meet",
    cellsOf(g, "down").length === 0 && same);
}
{
  // A victim whose path covers four buckets (it crosses a corner) is met in
  // each one the attacker searches, and eaten once.
  const c = 5 * CELL_GRID;
  const w = arena();
  player(w, "eater", [cell(c, c, 2000)]);
  player(w, "corner", [cell(c + 30, c + 30, 20, c - 30, c - 30)]);
  const { g, same } = both(w);
  const ev = g.events.filter(e => e.t === "eat");
  check("a victim filed in four buckets is eaten once",
    ev.length === 1 && g.players.get("eater").eaten === 1 &&
    cellsOf(g, "eater")[0].mass === 2000 + 20 * EAT_BONUS && same,
    `${ev.length} bite(s), mass ${cellsOf(g, "eater")[0].mass}`);
}
{
  // Cells pushed a little past the wall are still filed and found.
  for (const [label, x] of [["left", -40], ["right", 8800 + 40]]) {
    const w = arena();
    player(w, "eater", [cell(x, 4000, 400)]);
    player(w, "prey", [cell(x + (x < 0 ? 25 : -25), 4000, 20)]);
    const { g, same } = both(w);
    check(`past the ${label} wall`, cellsOf(g, "prey").length === 0 && same);
  }
}
{
  // A cell built by hand without a start is taken to have stood still, as
  // the reference treats it.
  const w = arena();
  const a = { id: nextId++, x: 3000, y: 3000, mass: 400 };
  player(w, "eater", [a]);
  player(w, "near", [{ id: nextId++, x: 3020, y: 3000, mass: 20 }]);
  player(w, "far", [{ id: nextId++, x: 3400, y: 3000, mass: 20 }]);
  const { g, same } = both(w);
  check("cells without a start: eaten where they are, nothing along the way",
    cellsOf(g, "near").length === 0 && cellsOf(g, "far").length === 1 && same);
}

console.log("\nPriority rules");
{
  // Two players can eat the same cell: the one who joined first does.
  for (const first of ["p1", "p2"]) {
    const w = arena();
    const second = first === "p1" ? "p2" : "p1";
    player(w, first, [cell(3000, 3000, 400)]);
    player(w, second, [cell(3030, 3000, 400)]);
    player(w, "victim", [cell(3015, 3000, 20)]);
    const { g, same } = both(w);
    check(`a contested victim goes to whoever joined first (${first})`,
      g.players.get(first).eaten === 1 && g.players.get(second).eaten === 0 && same);
  }
}
{
  // Victim cells are tried from the back, at the attacker's live mass. 57
  // can eat 50 but not 55; having eaten 50 it could eat 55, but 55 was tried
  // first and is not tried again until the next tick.
  const w = arena();
  player(w, "a", [cell(3000, 3000, 57)]);
  player(w, "v", [cell(3001, 3000, 50), cell(3000, 3001, 55)]);
  const { g, same } = both(w);
  check("victim cells are tried from the back, each once a tick",
    cellsOf(g, "v").length === 1 && cellsOf(g, "v")[0].mass === 55 && same);
  // The other way round, the growth from the first bite eats the second.
  const w2 = arena();
  player(w2, "a", [cell(3000, 3000, 57)]);
  player(w2, "v", [cell(3000, 3001, 55), cell(3001, 3000, 50)]);
  const r2 = both(w2);
  check("and in the other order both go", cellsOf(r2.g, "v").length === 0 && r2.same);
}
{
  // A bite grows the cell. Its next victims are searched for at the new
  // size, so prey that was outside its first search, in another bucket, is
  // eaten if its player comes later in join order, and not if earlier.
  //
  // Late sits 150 out: across the bucket line, past the first reach (117) and
  // inside the reach after the meal (158 at 85% of it).
  const x = 10 * CELL_GRID - 140;           // 126 short of the bucket line
  const ra = radiusOf(1000);
  const grown = radiusOf(1000 + 900 * EAT_BONUS);
  for (const [order, eaten] of [[["a", "meal", "late"], true], [["a", "late", "meal"], false]]) {
    const w = arena();
    const cells = { a: [cell(x, 3000, 1000)], meal: [cell(x - 10, 3000, 900)], late: [cell(x + 150, 3000, 20)] };
    for (const id of order) player(w, id, cells[id]);
    const { g, same } = both(w);
    check(`growth reaches a later player in another bucket: ${order.join(" > ")}`,
      (cellsOf(g, "late").length === 0) === eaten && cellsOf(g, "meal").length === 0 && same,
      `first reach ${(ra - radiusOf(20) * 0.55).toFixed(0)}, after ${(grown - radiusOf(20) * 0.55).toFixed(0)}, prey at 150`);
  }
}
{
  // A cell eaten earlier in the pass attacks nobody afterwards.
  const w = arena();
  player(w, "top", [cell(3000, 3000, 4000)]);
  // Top reaches middle but not bottom, even after eating middle; middle
  // would have reached bottom.
  player(w, "middle", [cell(3200, 3000, 400)]);
  player(w, "bottom", [cell(3260, 3000, 20)]);
  const { g, same } = both(w);
  check("a cell eaten earlier in the pass does not attack later in it",
    cellsOf(g, "middle").length === 0 && cellsOf(g, "bottom").length === 1 && same);
}
{
  // Nothing carries over between calls: rooms of different sizes share the
  // grid. A crowded state, then the same in a smaller arena (where it lies
  // past the wall, all filed in the last buckets), then the first again. The
  // bites cannot depend on the arena size.
  const r = rng(77);
  const base = arena(8800);
  for (let i = 0; i < 30; i++) {
    const cells = [];
    for (let k = 0; k < 8; k++) {
      const x = 3000 + r() * 600, y = 3000 + r() * 600;
      cells.push(cell(x, y, 10 + r() * 800, x - 40 + r() * 80, y - 40 + r() * 80));
    }
    player(base, `p${i}`, cells);
  }
  const run = size => { const w = structuredClone(base); w.size = size; G.combatForTest(w); return outcome(w); };
  const first = run(8800), small = run(2000), again = run(8800);
  const ref = structuredClone(base);
  P.combatForTest(ref);
  check("nothing carries over between calls or arena sizes",
    first === again && small === first && first === outcome(ref), `${JSON.parse(first).events.length} bites`);
}

console.log("\nRandom frozen states, compared bite for bite");
{
  const SIZES = [8800, 6200, 2000, 600, 65535];
  let states = 0, mismatches = 0, bites = 0, multi = 0, firstBad = null;
  const TRIALS = 3000;
  for (let trial = 0; trial < TRIALS; trial++) {
    const r = rng(1000 + trial);
    const size = SIZES[trial % SIZES.length];
    const w = arena(size);
    // A few hot spots, so cells crowd together, plus some strewn anywhere.
    const spots = Array.from({ length: 1 + ((r() * 4) | 0) }, () => [r() * size, r() * size]);
    const nPlayers = 2 + ((r() * 30) | 0);
    for (let i = 0; i < nPlayers; i++) {
      const cells = [];
      const n = 1 + ((r() * MAX_CELLS) | 0);
      for (let k = 0; k < n; k++) {
        const [hx, hy] = spots[(r() * spots.length) | 0];
        const spread = r() < 0.2 ? size : 40 + r() * 400;
        let x = hx + (r() - 0.5) * spread, y = hy + (r() - 0.5) * spread;
        // On a bucket line, or a little past a wall.
        if (r() < 0.1) x = Math.round(x / CELL_GRID) * CELL_GRID + (r() - 0.5) * 1e-6;
        if (r() < 0.05) x = r() < 0.5 ? -r() * 60 : size + r() * 60;
        const mass = r() < 0.08 ? 5000 + r() * 35000 : 10 + Math.pow(r(), 3) * 3000;
        // Still, walking, or flying across buckets (a split half at a late tick).
        const kind = r();
        const step = kind < 0.3 ? 0 : kind < 0.8 ? r() * 25 : 50 + r() * 850;
        const a = r() * Math.PI * 2;
        const startMass = r() < 0.3 ? mass * (0.7 + r() * 0.6) : mass;
        if (r() < 0.02) cells.push({ id: nextId++, x, y, mass });      // built by hand
        else cells.push(cell(x, y, mass, x - Math.cos(a) * step, y - Math.sin(a) * step, startMass));
      }
      player(w, `p${i}`, cells);
    }
    const { g, same } = both(w);
    states++;
    if (!same) { mismatches++; if (firstBad === null) firstBad = trial; }
    const eats = g.events.length;
    bites += eats;
    if ([...g.players.values()].some(p => p.eaten > 1)) multi++;
  }
  check(`${states} random states give the same bites, in the same order`, mismatches === 0,
    mismatches ? `first mismatch at trial ${firstBad}` : "");
  check("and they exercise it", bites > 5000 && multi > 300, `${bites} bites, ${multi} states where a player ate more than once`);
}

// ── whole games ─────────────────────────────────────────────────────────────
//
// The same game in both builds, tick by tick. Everything a bite changes is
// compared every tick; one difference anywhere and the games stop matching.

function fingerprint(w) {
  let s = `${w.tick}|${w.pellets.length}|${w.viruses.length}|${JSON.stringify(w.events)}`;
  for (const p of w.players.values()) {
    s += `|${p.id},${p.alive ? 1 : 0},${p.eaten},${p.orbs}`;
    for (const c of p.cells) s += `;${c.id},${c.x},${c.y},${c.mass}`;
  }
  return s;
}

function lockstep(label, setup, ticks, { dts = [DT], drive = () => {} } = {}) {
  const a = setup(G), b = setup(P);
  let diverged = -1, kills = 0, maxCells = 0;
  for (let t = 0; t < ticks; t++) {
    drive(G, a, t); drive(P, b, t);
    const dt = dts[t % dts.length];
    G.stepWorld(a, dt); P.stepWorld(b, dt);
    if (fingerprint(a) !== fingerprint(b)) { diverged = t + 1; break; }
    for (const e of a.events) if (e.t === "eat") kills++;
    let cells = 0;
    for (const p of a.players.values()) cells += p.cells.length;
    if (cells > maxCells) maxCells = cells;
  }
  check(`${label}: identical for ${ticks} ticks`, diverged < 0,
    diverged < 0 ? `${kills} kills, up to ${maxCells} cells` : `first difference at tick ${diverged}`);
  return kills;
}

console.log("\nWhole games, side by side");
{
  // A full lobby: 100 bots on hard, which split to kill, in the live arena.
  const kills = lockstep("full 100-player lobby", sim => {
    const w = sim.createWorld(7, { size: 8800, pellets: 3000, viruses: 90, botLevel: "hard" });
    sim.fillBots(w, 100);
    // Mid-round sizes, so there is something to hunt from the first tick.
    const r = rng(7);
    for (const p of w.players.values()) p.cells[0].mass = 20 + Math.pow(r(), 2) * 1500;
    return w;
  }, 300);
  check("full lobby: kills happen", kills >= 20, `${kills}`);
}
{
  // Heavy splitting: 60 players splitting and throwing mass all the time,
  // crowded together, at tick lengths the server can produce.
  const DTS = [0.05, 0.05, 0.25, 0.1, 0.05, 0.15, 0.2, 0.05];
  const heading = new Map();
  const kills = lockstep("heavy splitting, varying tick length", sim => {
    const w = sim.createWorld(11, { size: 3000, pellets: 600, viruses: 10 });
    const r = rng(11);
    for (let i = 0; i < 60; i++) {
      const p = sim.addPlayer(w, { id: `h${i}`, name: `H${i}` });
      p.cells[0].mass = 200 + r() * 1800;
    }
    return w;
  }, 400, {
    dts: DTS,
    drive(sim, w, t) {
      const r = rng(5000 + t);
      let n = 0;
      for (const p of w.players.values()) {
        n++;
        if (!p.alive) { sim.queueAction(w, p.id, "respawn"); continue; }
        const h = (heading.get(`${sim === G}:${p.id}`) ?? n) + (r() - 0.5) * 0.8;
        heading.set(`${sim === G}:${p.id}`, h);
        sim.setAim(w, p.id, Math.cos(h) * 400, Math.sin(h) * 400);
        if ((t + n) % 8 === 0) sim.queueAction(w, p.id, "split");
        if ((t + n) % 20 === 0) sim.queueAction(w, p.id, "eject");
      }
    }
  });
  check("heavy splitting: kills happen", kills >= 100, `${kills}`);
}
{
  // Giants: cells of radius 570-800 spanning dozens of buckets among bots.
  const kills = lockstep("giants among 40 bots", sim => {
    const w = sim.createWorld(13, { size: 5000, pellets: 1500, viruses: 20, botLevel: "hard" });
    sim.fillBots(w, 40);
    const r = rng(13);
    let i = 0;
    for (const p of w.players.values()) {
      p.cells[0].mass = i++ < 5 ? 20000 + r() * 20000 : 20 + r() * 800;
    }
    return w;
  }, 300);
  check("giants: kills happen", kills >= 20, `${kills}`);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exitCode = failures ? 1 : 0;
