// ---------------------------------------------------------------------------
// The pellet grid's flat layout against the Map of buckets it replaced.
// Run with:
//   node test/pelletgrid.test.js
//
// shared/sim.js keeps its pellet index as one array sorted by bucket plus an
// offset table, rebuilt once a tick, with holes for pellets that leave a
// bucket and per-bucket arrival lists for those that join one between
// rebuilds (see "pellet spatial index"). It must hold exactly the pellets the
// Map of arrays held, and hand them out in exactly the same order: eat order,
// the orbs a snapshot lists and a bot's choice on a tie all follow it.
//
// So this builds a second copy of shared/sim.js with the Map version put back
// (verbatim but for the call signatures) and puts both through the same
// things, comparing what every bucket returns, in order:
//
//   - creation, sowing, a rebuild, ejected mass, eating, resetArena;
//   - pellets beyond the walls, below zero and far past the far edge, and an
//     arena made bigger after the grid was laid out;
//   - thousands of random inserts, moves, deaths and rebuilds;
//   - whole games played side by side, snapshots included.
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

// The Map of arrays as it shipped before the flat layout, with the call
// signatures the rest of sim.js now uses (gridInsert and gridMove take the
// world; bucketOf is the Map key).
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

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.join(here, "..", "shared");
const source = fs.readFileSync(path.join(shared, "sim.js"), "utf8");
const from = source.indexOf("// Laid out flat:");
const to = source.indexOf("const clamp = (v, a, b) =>", from);
if (from < 0 || to < 0 || source.indexOf("// Laid out flat:", from + 1) >= 0) {
  throw new Error("test/pelletgrid.test.js: cannot find the pellet grid in shared/sim.js to swap");
}
// The index's own operations, for the membership checks.
const EXPOSE = "\nexport { gridInsert as __gridInsert, gridMove as __gridMove, bucketOf as __bucketOf };\n";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-pelletgrid-"));
for (const [name, sim] of [["flat", source + EXPOSE], ["map", source.slice(0, from) + MAP_GRID + "\n" + source.slice(to) + EXPOSE]]) {
  fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, name, "package.json"), '{ "type": "module" }\n');
  fs.writeFileSync(path.join(dir, name, "sim.js"), sim);
  for (const f of ["protocol.js", "codec.js"]) fs.copyFileSync(path.join(shared, f), path.join(dir, name, f));
}
const load = async (name, f) => import(pathToFileURL(path.join(dir, name, f)).href);
const F = await load("flat", "sim.js"), M = await load("map", "sim.js");
const FP = await load("flat", "protocol.js"), MP = await load("map", "protocol.js");
fs.rmSync(dir, { recursive: true, force: true });

const GRID = 220;
const DT = 1 / F.TICK_HZ;

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

// ── what the index hands out ────────────────────────────────────────────────

// Every bucket on its own, a ring of buckets past each wall included, then
// some wide boxes: the whole arena and more, a giant's view from a corner,
// strips along each wall. Each as the ids visited, in order, dead ones
// marked, so a pellet in the wrong bucket, a missing one, an extra one or one
// out of order all show.
function print(sim, w, ring = 3) {
  const out = [];
  const visit = (x, y, r) => {
    const ids = [];
    sim.forEachPelletNear(w, x, y, r, p => ids.push(p.dead ? `${p.id}d` : p.id));
    out.push(ids.join(","));
  };
  const n = Math.ceil(w.size / GRID) + ring;
  for (let gx = -ring; gx < n; gx++) {
    for (let gy = -ring; gy < n; gy++) visit((gx + 0.5) * GRID, (gy + 0.5) * GRID, GRID / 2 - 1);
  }
  const s = w.size;
  visit(s / 2, s / 2, s);
  visit(s - 10, s - 10, 11000);
  for (const [x, y] of [[0, s / 2], [s, s / 2], [s / 2, 0], [s / 2, s]]) visit(x, y, 300);
  return out.join("|");
}
const same = (wf, wm, ring) => print(F, wf, ring) === print(M, wm, ring);

console.log("\nThe life of a board");
{
  const wf = F.createWorld(5), wm = M.createWorld(5);
  check("a new board, sown into an empty grid one orb at a time", same(wf, wm),
    `${wf.pellets.length} orbs, ${wf.grid.touched.length} buckets of arrivals`);
  F.stepWorld(wf, DT); M.stepWorld(wm, DT);
  check("after the first rebuild", same(wf, wm));

  // Players throwing mass and eating: blobs created mid-tick, moving across
  // buckets the next, eaten, and the eaten replaced.
  const r = rng(5);
  for (const w of [wf, wm]) {
    const sim = w === wf ? F : M;
    for (let i = 0; i < 30; i++) {
      const p = sim.addPlayer(w, { id: `h${i}`, name: `H${i}` });
      p.cells[0].x = 3000 + (i % 6) * 120; p.cells[0].y = 3000 + Math.floor(i / 6) * 120;
      p.cells[0].mass = 400;
    }
  }
  let agree = true, eaten = 0, thrown = 0;
  for (let t = 0; t < 120; t++) {
    const aims = Array.from({ length: 30 }, () => [(r() - 0.5) * 800, (r() - 0.5) * 800, r() < 0.4]);
    for (const [w, sim] of [[wf, F], [wm, M]]) {
      aims.forEach(([dx, dy, eject], i) => {
        sim.setAim(w, `h${i}`, dx, dy);
        if (eject) sim.queueAction(w, `h${i}`, "eject");
      });
    }
    F.stepWorld(wf, DT); M.stepWorld(wm, DT);
    for (const e of wf.events) if (e.t === "orb") eaten++;
    thrown += wf.pellets.filter(p => p.owner !== undefined && p.vx).length;
    if (t % 10 === 9 && !same(wf, wm, 1)) { agree = false; break; }
  }
  check("with mass thrown, crossing buckets, eaten and replaced", agree, `${eaten} eaten, ${thrown} blob-ticks in flight`);
  F.resetArena(wf); M.resetArena(wm);
  check("after resetArena", same(wf, wm));
}

console.log("\nPellets outside the arena");
{
  // A blob can be thrown from a cell pushed past a wall. Past the far wall by
  // a bucket or more, the grid widens to take it; a whole bucket or more
  // below zero, it is filed nowhere, where no query ever looked anyway.
  const make = sim => {
    const w = sim.createWorld(9, { size: 2000, pellets: 120, viruses: 0 });
    const spots = [[-500, 700], [-100, 900], [700, -300], [2100, 500], [2000 + 900, 1200], [1500, 2000 + 2500], [-30, -30], [5000, -10]];
    for (const [x, y] of spots) w.pellets.push({ id: w.nextId++, x, y, mass: 2, vx: 0, vy: 0, ci: 0 });
    sim.buildPelletGrid(w);
    return w;
  };
  const wf = make(F), wm = make(M);
  check("pellets past every wall, filed at a rebuild", same(wf, wm, 14), `grid ${Math.ceil(2000 / GRID) + 1} → ${wf.grid.cols} buckets a side`);
  // And moved: one in from far away, one out to a negative bucket.
  for (const [w, sim] of [[wf, F], [wm, M]]) {
    const far = w.pellets.find(p => p.x === 2900), low = w.pellets.find(p => p.x === -500);
    const a = sim.__bucketOf(w.grid, far); far.x = 1000; sim.__gridMove(w, far, a);
    const b = sim.__bucketOf(w.grid, low); low.x = 300; sim.__gridMove(w, low, b);
    const c = w.pellets[0], k = sim.__bucketOf(w.grid, c); c.x = -700; sim.__gridMove(w, c, k);
  }
  check("and moved in from outside, and out", same(wf, wm, 14));
}
{
  // An arena made bigger after the grid was laid out: a pellet moving into
  // the new ground lands past the grid's edge, and the grid widens in place.
  const make = sim => {
    const w = sim.createWorld(10, { size: 1500, pellets: 60, viruses: 0 });
    sim.stepWorld(w, DT);
    w.size = 4000;
    const p = w.pellets[0];
    p.x = 1400; p.vx = 60000; p.vy = 0;
    sim.stepWorld(w, DT);
    return w;
  };
  const before = Math.ceil(1500 / GRID) + 1;
  // Read the grid mid-tick: after the move, before the end-of-tick rebuild.
  const wf = F.createWorld(10, { size: 1500, pellets: 60, viruses: 0 });
  const wm = M.createWorld(10, { size: 1500, pellets: 60, viruses: 0 });
  F.stepWorld(wf, DT); M.stepWorld(wm, DT);
  for (const w of [wf, wm]) w.size = 4000;
  for (const [w, sim] of [[wf, F], [wm, M]]) {
    const p = w.pellets[0], k = sim.__bucketOf(w.grid, p);
    p.x = 3500; sim.__gridMove(w, p, k);
    const q = { id: w.nextId++, x: 3900, y: 3900, mass: 2, vx: 0, vy: 0, ci: 0 };
    w.pellets.push(q); sim.__gridInsert(w, q);
  }
  check("an arena grown after the grid was laid out", same(wf, wm, 3) && wf.grid.cols > before,
    `grid ${before} → ${wf.grid.cols} buckets a side, between rebuilds`);
  const gf = make(F), gm = make(M);
  check("and played on from there", same(gf, gm, 3));
}

console.log("\nRandom inserts, moves, deaths and rebuilds");
{
  let rounds = 0, mismatch = -1, holes = 0, arrivals = 0, widened = 0, outside = 0;
  for (let seed = 1; seed <= 40 && mismatch < 0; seed++) {
    const r = rng(seed);
    const size = [1200, 2000, 900][seed % 3];
    const wf = F.createWorld(seed, { size, pellets: 40 + ((r() * 120) | 0), viruses: 0 });
    const wm = M.createWorld(seed, { size, pellets: wf.pelletCount, viruses: 0 });
    const spot = () => {
      const k = r();
      // Mostly inside, some on bucket lines, some past a wall.
      if (k < 0.15) return Math.round(r() * size / GRID) * GRID + (r() < 0.5 ? 0 : -1e-9);
      if (k < 0.25) return r() < 0.5 ? -r() * 600 : size + r() * 1200;
      return r() * size;
    };
    for (let op = 0; op < 150; op++) {
      // Drawn once, for both worlds.
      const kind = r(), i = (r() * wf.pellets.length) | 0, x = spot(), y = spot();
      const dx = (r() - 0.5) * 300, dy = (r() - 0.5) * 300;
      for (const [w, sim] of [[wf, F], [wm, M]]) {
        const p = w.pellets[i];
        if (kind < 0.3) {
          const q = { id: w.nextId++, x, y, mass: 2, vx: 0, vy: 0, ci: 0 };
          w.pellets.push(q); sim.__gridInsert(w, q);
        } else if (kind < 0.7 && p) {
          const was = sim.__bucketOf(w.grid, p);
          if (kind < 0.55) { p.x += dx; p.y += dy; } else { p.x = x; p.y = y; }
          sim.__gridMove(w, p, was);
        } else if (kind < 0.8 && p) {
          p.dead = true;
        } else if (kind < 0.9) {
          w.pellets = w.pellets.filter(q => !q.dead);
          sim.buildPelletGrid(w);
        } else if (kind < 0.92) {
          w.size += 400;
        } else {
          sim.buildPelletGrid(w);
        }
      }
      if (wf.grid.items.some(p => p === null)) holes++;
      if (wf.grid.touched.length) arrivals++;
      if (wf.pellets.some(p => p.x < -GRID || p.y < -GRID)) outside++;
      rounds++;
      if (!same(wf, wm, 7)) { mismatch = rounds; break; }
    }
    if (wf.grid.cols > Math.ceil(size / GRID) + 1) widened++;
  }
  check(`${rounds} random operations leave both indexes handing out the same pellets in the same order`,
    mismatch < 0, mismatch < 0 ? "" : `first difference after operation ${mismatch}`);
  check("and they exercise it", holes > 1000 && arrivals > 2000 && widened > 10 && outside > 1000,
    `with holes ${holes}, arrivals ${arrivals}, below zero ${outside}, widened in ${widened} of 40 worlds`);
}

// ── whole games ─────────────────────────────────────────────────────────────

function fingerprint(w) {
  let s = `${w.tick}|${JSON.stringify(w.events)}`;
  for (const p of w.players.values()) {
    s += `|${p.id},${p.alive ? 1 : 0},${p.orbs},${p.eaten}`;
    for (const c of p.cells) s += `;${c.id},${c.x},${c.y},${c.mass}`;
  }
  for (const p of w.pellets) s += `/${p.id},${p.x},${p.y}`;
  return s;
}

function lockstep(label, setup, ticks, { dts = [DT], drive = () => {}, watch = 6, reset = -1 } = {}) {
  const a = setup(F), b = setup(M);
  const ids = [...a.players.keys()].slice(0, watch);
  const csA = ids.map((_, i) => FP.createClientState(i)), csB = ids.map((_, i) => MP.createClientState(i));
  let diverged = -1, why = "", orbs = 0, bytes = 0;
  for (let t = 0; t < ticks && diverged < 0; t++) {
    drive(F, a, t); drive(M, b, t);
    if (t === reset) { F.resetArena(a); M.resetArena(b); }
    const dt = dts[t % dts.length];
    F.stepWorld(a, dt); M.stepWorld(b, dt);
    if (fingerprint(a) !== fingerprint(b)) { diverged = t + 1; why = "state"; break; }
    // Snapshots list orbs in index order, so they must match byte for byte.
    for (let i = 0; i < ids.length; i++) {
      const x = FP.encodeSnapshot(a, a.players.get(ids[i]), csA[i]);
      const y = MP.encodeSnapshot(b, b.players.get(ids[i]), csB[i]);
      if (Buffer.compare(Buffer.from(x), Buffer.from(y)) !== 0) { diverged = t + 1; why = "snapshot"; break; }
      bytes += x.length;
    }
    for (const e of a.events) if (e.t === "orb") orbs++;
  }
  check(`${label}: identical for ${ticks} ticks, snapshots byte for byte`, diverged < 0,
    diverged < 0 ? `${orbs} orbs eaten, ${(bytes / 1024).toFixed(0)} KiB of snapshots compared` : `first difference (${why}) at tick ${diverged}`);
}

console.log("\nWhole games, side by side");
lockstep("Standard arena, 100 hard bots", sim => {
  const w = sim.createWorld(21, { size: 8800, pellets: 4100, viruses: 90, botLevel: "hard" });
  sim.fillBots(w, 100);
  return w;
}, 300);
{
  // Everyone throwing mass in a crowd, at tick lengths the server can
  // produce, with the zone closing so orbs are sown into a shrinking square,
  // and a fresh round halfway.
  const DTS = [0.05, 0.05, 0.25, 0.1, 0.05, 0.15, 0.2, 0.05];
  lockstep("thrown mass in a crowd, closing zone, varying ticks, reset halfway", sim => {
    const w = sim.createWorld(22, { size: 4000, pellets: 1500, viruses: 12 });
    for (let i = 0; i < 50; i++) {
      const p = sim.addPlayer(w, { id: `h${i}`, name: `H${i}` });
      p.cells[0].x = 1500 + (i % 10) * 100; p.cells[0].y = 1500 + Math.floor(i / 10) * 100;
      p.cells[0].mass = 150 + (i * 37) % 600;
    }
    sim.planZone(w, w.time + 30);
    return w;
  }, 400, {
    dts: DTS,
    reset: 200,
    drive(sim, w, t) {
      const r = rng(7000 + t);
      let n = 0;
      for (const p of w.players.values()) {
        n++;
        if (!p.alive) { sim.queueAction(w, p.id, "respawn"); continue; }
        sim.setAim(w, p.id, (r() - 0.5) * 900, (r() - 0.5) * 900);
        if ((t + n) % 3 === 0) sim.queueAction(w, p.id, "eject");
        if ((t + n) % 25 === 0) sim.queueAction(w, p.id, "split");
      }
    }
  });
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exitCode = failures ? 1 : 0;
