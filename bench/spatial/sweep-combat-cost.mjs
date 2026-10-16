// ---------------------------------------------------------------------------
// The swept test's cost in cellCombat, on identical states.
//
//   node bench/spatial/sweep-combat-cost.mjs
//
// Whole-game timings cannot compare the two fairly: once the sweep catches a
// kill the old test missed, the two games diverge. This plays the working
// tree's split-heavy scenario, freezes forty ticks' worth of cells as
// cellCombat sees them, and runs the old and new pair loops over the same
// frozen cells (eats are counted, not applied).
// ---------------------------------------------------------------------------
import { performance } from "node:perf_hooks";
// build.mjs reads the revision when it is imported, so set it first.
process.env.SPATIAL_REV = "working";
const { loadVariant } = await import("./build.mjs");
const { setupScenario } = await import("./scenarios.mjs");
const { sim } = await loadVariant({});
const { radiusOf, EAT_RATIO } = sim;
const { world, driver } = setupScenario(sim, "splits", 1);
const states = [];
for (let t = 0; t < 700; t++) {
  driver.step(world); sim.stepWorld(world, 0.05);
  if (t >= 300 && t % 10 === 0) {
    // Freeze every live player's cells as cellCombat would see them.
    states.push([...world.players.values()].filter(p => p.alive && p.cells.length)
      .map(p => p.cells.map(c => ({ x: c.x, y: c.y, mass: c.mass, startX: c.startX, startY: c.startY, startMass: c.startMass }))));
  }
}
function closestApproach(sx, sy, ex, ey) {
  const wx = ex - sx, wy = ey - sy, ww = wx * wx + wy * wy;
  let t = ww > 0 ? -(sx * wx + sy * wy) / ww : 1; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(sx + wx * t, sy + wy * t);
}
function oldLoop(ents) {
  let n = 0, narrow = 0;
  for (let i = 0; i < ents.length; i++) for (let j = 0; j < ents.length; j++) {
    if (i === j) continue;
    for (const a of ents[i]) { const ra = radiusOf(a.mass);
      for (let k = ents[j].length - 1; k >= 0; k--) { const b = ents[j][k];
        if (a.mass < b.mass * EAT_RATIO) continue;
        const dx = b.x - a.x; if (dx > ra || dx < -ra) continue;
        const dy = b.y - a.y; if (dy > ra || dy < -ra) continue;
        narrow++; const rb = radiusOf(b.mass); if (Math.hypot(dx, dy) < ra - rb * 0.55) n++; } } }
  return [n, narrow];
}
// cellCombat's pair loop as shipped: the band reject on end positions, then
// the swept reject, then the end test and, failing it, the swept one.
function newLoop(ents) {
  let n = 0, narrow = 0, step = 0;
  for (const cells of ents) for (const c of cells) {
    const s = Math.max(Math.abs(c.x - c.startX), Math.abs(c.y - c.startY));
    if (s > step) step = s;
  }
  const band = 2 * step;
  for (let i = 0; i < ents.length; i++) for (let j = 0; j < ents.length; j++) {
    if (i === j) continue;
    for (const a of ents[i]) { const ra = radiusOf(a.mass), rw = ra + band; const least = Math.min(a.startMass, a.mass);
      for (let k = ents[j].length - 1; k >= 0; k--) { const b = ents[j][k];
        if (a.mass < b.mass * EAT_RATIO) continue;
        const dx = b.x - a.x; if (dx > rw || dx < -rw) continue;
        const dy = b.y - a.y; if (dy > rw || dy < -rw) continue;
        const sx = b.startX - a.startX, sy = b.startY - a.startY;
        if ((sx > ra && dx > ra) || (sx < -ra && dx < -ra) || (sy > ra && dy > ra) || (sy < -ra && dy < -ra)) continue;
        narrow++; const rb = radiusOf(b.mass);
        let hit = Math.hypot(dx, dy) < ra - rb * 0.55;
        if (!hit && (sx !== dx || sy !== dy)) { const most = Math.max(b.startMass, b.mass);
          hit = least >= most * EAT_RATIO && closestApproach(sx, sy, dx, dy) < radiusOf(least) - radiusOf(most) * 0.55; }
        if (hit) n++; } } }
  return [n, narrow];
}
for (const [name, f] of [["endpoint only", oldLoop], ["swept", newLoop], ["endpoint only", oldLoop], ["swept", newLoop], ["endpoint only", oldLoop], ["swept", newLoop]]) {
  for (const s of states) f(s);                       // warm
  const times = []; let hits = 0, narrow = 0;
  for (const s of states) { const t0 = performance.now(); for (let r = 0; r < 5; r++) { const [h, nn] = f(s); hits += h; narrow += nn; } times.push((performance.now() - t0) / 5); }
  times.sort((a, b) => a - b);
  console.log(name, "states", states.length, "avg ms", (times.reduce((a, b) => a + b) / times.length).toFixed(3), "max ms", times.at(-1).toFixed(3), "narrow/state", (narrow / 5 / states.length).toFixed(1), "hits/state", (hits / 5 / states.length).toFixed(2));
}
