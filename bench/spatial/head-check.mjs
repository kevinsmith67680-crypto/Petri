// ---------------------------------------------------------------------------
// Re-checks the audit's index bugs, and times the live Standard config,
// against UNPATCHED shared/ modules at any revision.
//
//   node --expose-gc bench/spatial/head-check.mjs              (working tree)
//   node --expose-gc bench/spatial/head-check.mjs --rev d93f567
//
// build.mjs patches one pinned revision; this needs no patches, so it keeps
// working as shared/sim.js changes. It only uses exported functions.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { ROOT } from "./build.mjs";
import { setupScenario } from "./scenarios.mjs";

const argv = process.argv.slice(2);
const rev = argv.includes("--rev") ? argv[argv.indexOf("--rev") + 1] : null;
const TICKS = argv.includes("--ticks") ? Number(argv[argv.indexOf("--ticks") + 1]) : 900;

let dir = path.join(ROOT, "shared");
if (rev) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), `petri-${rev}-`));
  const files = execFileSync("git", ["-C", ROOT, "ls-tree", "--name-only", `${rev}:shared`], { encoding: "utf8" }).trim().split("\n");
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f), execFileSync("git", ["-C", ROOT, "show", `${rev}:shared/${f}`], { encoding: "utf8", maxBuffer: 1 << 26 }));
  }
  fs.writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
}
const sim = await import(pathToFileURL(path.join(dir, "sim.js")).href);
const protocol = await import(pathToFileURL(path.join(dir, "protocol.js")).href);
const at = rev || execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + " (working tree)";

const DT = 1 / 20;
const bare = () => sim.createWorld(3, { pellets: 0, viruses: 0 });
function human(w, id, x, y, mass) {
  const p = sim.addPlayer(w, { id, name: id });
  Object.assign(p.cells[0], { x, y, mass });
  return p;
}
const pellet = (w, x, y, extra = {}) => {
  const p = { id: w.nextId++, x, y, mass: sim.PELLET_MASS, vx: 0, vy: 0, ci: 0, ...extra };
  w.pellets.push(p);
  return p;
};

// B1 (correctness.mjs C3): a thrown blob indexed where it was last tick.
const b1 = (() => {
  const w = bare();
  const me = human(w, "me", 480, 1000, 20);
  const blob = pellet(w, 430, 1000, { mass: 13, vx: 800, vy: 0, owner: "rival", ownerFree: 0 });
  sim.buildPelletGrid(w);
  sim.stepWorld(w, DT);
  const dist = Math.abs(blob.x - me.cells[0].x), reach = sim.radiusOf(me.cells[0].mass) + sim.pelletRadius(blob) * 0.6;
  return { inReach: dist < reach, eatenThatTick: !!blob.dead, dist: +dist.toFixed(1), reach: +reach.toFixed(1) };
})();

// B2 (correctness.mjs C2): the index after resetArena.
const b2 = (() => {
  const w = bare();
  w.pelletCount = 400;
  for (let i = 0; i < 400; i++) pellet(w, 200 + (i % 20) * 400, 200 + Math.floor(i / 20) * 400);
  const me = human(w, "me", 4400, 4400, 20);
  sim.stepWorld(w, DT);
  sim.resetArena(w);
  const live = new Set(w.pellets), seen = new Set();
  sim.forEachPelletNear(w, w.size / 2, w.size / 2, w.size, p => seen.add(p));
  let stale = 0, missing = 0;
  for (const p of seen) if (!live.has(p)) stale++;
  for (const p of live) if (!seen.has(p)) missing++;
  const snap = protocol.decodeSnapshot(protocol.encodeSnapshot(w, me, protocol.createClientState(0)));
  const ids = new Set(w.pellets.map(p => p.id));
  return { staleEntries: stale, unindexed: missing, ghostOrbsInFirstSnapshot: snap.added.filter(p => !ids.has(p.id)).length };
})();

// Standard config, hard bots, one snapshot per player. Unpatched, so bot AI
// cannot be separated out here; compare this figure only with itself.
const { world, driver } = setupScenario(sim, "standard", 1);
const clients = [...world.players.values()].map((p, i) => ({ p, cs: protocol.createClientState(i) }));
const step = () => {
  driver.step(world);
  const t0 = performance.now();
  sim.stepWorld(world, DT);
  const t1 = performance.now();
  for (const { p, cs } of clients) protocol.encodeSnapshot(world, p, cs);
  return [t1 - t0, performance.now() - t1];
};
for (let i = 0; i < 300; i++) step();
globalThis.gc?.();
const sims = [], totals = [];
for (let i = 0; i < TICKS; i++) { const [s, n] = step(); sims.push(s); totals.push(s + n); }
const q = (a, k) => [...a].sort((x, y) => x - y)[Math.floor(k * a.length)];
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

console.log(JSON.stringify({
  revision: at,
  b1, b2,
  standardWithBotAI: {
    ticks: TICKS,
    totalAvg: +avg(totals).toFixed(2), totalP99: +q(totals, 0.99).toFixed(2),
    simAvg: +avg(sims).toFixed(2), snapAvg: +(avg(totals) - avg(sims)).toFixed(2)
  }
}, null, 2));
