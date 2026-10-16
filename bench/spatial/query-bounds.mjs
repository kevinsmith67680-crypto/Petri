// ---------------------------------------------------------------------------
// Cost of one forEachPelletNear call against its radius: the Map grid
// against the flat (CSR) layout, which clamps the bucket range to the arena.
// At d93f567 that is current against csr; once the flat layout ships, mapgrid
// against current.
//
//   node bench/spatial/query-bounds.mjs
//
// The snapshot query radius is max(760, 9 x cell radius) (protocol.js:131),
// so a big cell asks for far more than the arena. The current query clamps
// the low bucket index at 0 but not the high one (sim.js:276-279), and every
// bucket past the wall is still a Map lookup.
// ---------------------------------------------------------------------------

import { performance } from "node:perf_hooks";
import { loadVariant } from "./build.mjs";

const out = [];
for (const [name, opts] of [["current", { counted: true }], ["csr", { csr: true, counted: true }], ["mapgrid", { mapgrid: true, counted: true }]]) {
  let sim;
  try { ({ sim } = await loadVariant(opts)); } catch (e) { console.log(`skip ${name}: ${e.message}`); continue; }
  sim.__S.spawnBox = null;
  const w = sim.createWorld(3, { pellets: 4100, viruses: 0 });
  sim.buildPelletGrid(w);
  for (const mass of [100, 5000, 20000, 40000, 95000]) {
    const R = Math.max(760, sim.radiusOf(mass) * 9);
    for (const [where, x, y] of [["centre", 4400, 4400], ["near far corner", 8200, 8200]]) {
      let seen = 0;
      const fn = () => { seen++; };
      for (let i = 0; i < 200; i++) sim.forEachPelletNear(w, x, y, R, fn);  // warm
      sim.__reset();
      const N = 2000;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) sim.forEachPelletNear(w, x, y, R, fn);
      const us = ((performance.now() - t0) / N) * 1000;
      out.push({ grid: name, mass, R: Math.round(R), where, bucketLookups: sim.__S.c.buckets / N, pelletsVisited: seen / (N + 200), usPerQuery: +us.toFixed(1) });
    }
  }
}
console.table(out);
