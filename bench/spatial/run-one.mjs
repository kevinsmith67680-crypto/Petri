// ---------------------------------------------------------------------------
// One benchmark run, one scenario, one variant, in a fresh process.
//
//   node --expose-gc bench/spatial/run-one.mjs <scenario> <variant>
//        [--counted] [--warm 300] [--ticks 900] [--seed 1] [--dt 0.05]
//
// A tick here is what the server does per room per tick: stepWorld, then one
// encodeSnapshot per player, sharing one snapshotFrame where the revision has
// it (server/index.js tickRoom). Sending is not included. Prints one JSON line.
// ---------------------------------------------------------------------------

import { PerformanceObserver, performance, constants } from "node:perf_hooks";
import { loadVariant, VARIANTS } from "./build.mjs";
import { setupScenario } from "./scenarios.mjs";

const argv = process.argv.slice(2);
const [scenario, variant] = argv;
const opt = (name, d) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : d);
const counted = argv.includes("--counted");
const WARM = opt("--warm", 300), TICKS = opt("--ticks", 900), SEED = opt("--seed", 1), DT = opt("--dt", 0.05);

if (!VARIANTS[variant]) throw new Error(`unknown variant ${variant}`);
const { sim, protocol } = await loadVariant({ ...VARIANTS[variant], counted });
let { world, driver, sc } = setupScenario(sim, scenario, SEED);
let clients = [...world.players.values()].map((p, i) => ({ p, cs: protocol.createClientState(i) }));

function tick() {
  driver.step(world);
  const t0 = performance.now();
  sim.stepWorld(world, DT);
  const t1 = performance.now();
  let bytes = 0;
  // One frame per tick shared by every snapshot, as tickRoom does. Revisions
  // from before frames have no snapshotFrame and encode each from scratch.
  const frame = protocol.snapshotFrame ? protocol.snapshotFrame(world) : null;
  for (const { p, cs } of clients) bytes += protocol.encodeSnapshot(world, p, cs, null, null, null, frame).length;
  return [t1 - t0, performance.now() - t1, bytes];
}

for (let i = 0; i < WARM; i++) tick();
// A transient scenario is warmed on a throwaway world, then measured from
// the first tick of a fresh one, so the state being measured is still there.
if (sc.transient) {
  ({ world, driver, sc } = setupScenario(sim, scenario, SEED + 1000));
  clients = [...world.players.values()].map((p, i) => ({ p, cs: protocol.createClientState(i) }));
}
const box = sc.cluster ? sim.__S.spawnBox.player : null;
const inBox = () => world.pellets.filter(p => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1).length;
const clusterTrace = {};
// Densest bucket, whichever grid layout is in use.
function occupancy() {
  let maxBucket = 0, buckets = 0;
  const g = world.grid;
  if (g instanceof Map) { for (const b of g.values()) { if (b.length) buckets++; maxBucket = Math.max(maxBucket, b.length); } }
  else if (g && g.start) {
    for (let k = 0; k + 1 < g.start.length; k++) { const n = g.start[k + 1] - g.start[k]; if (n) buckets++; maxBucket = Math.max(maxBucket, n); }
  }
  return { maxBucket, buckets };
}
let maxBucketFirstTick = 0;

globalThis.gc?.();
await new Promise(r => setTimeout(r, 20));
const gcStats = { count: 0, ms: 0, major: 0, majorMs: 0, maxPause: 0 };
const obs = new PerformanceObserver(list => {
  for (const e of list.getEntries()) {
    gcStats.count++;
    gcStats.ms += e.duration;
    gcStats.maxPause = Math.max(gcStats.maxPause, e.duration);
    if (e.detail?.kind === constants.NODE_PERFORMANCE_GC_MAJOR) { gcStats.major++; gcStats.majorMs += e.duration; }
  }
});
obs.observe({ entryTypes: ["gc"] });

sim.__reset();
const heap0 = process.memoryUsage().heapUsed;
let heapPeak = heap0;
const series = { total: [], sim: [], snap: [], bot: [], eat: [], combat: [], grid: [], gridFresh: [] };
let prev = { ...sim.__S.t };
let bytes = 0, cellsSum = 0, aliveSum = 0, pelletSum = 0, maxR = 0;

for (let i = 0; i < TICKS; i++) {
  const [s, n, b] = tick();
  if (i === 0) maxBucketFirstTick = occupancy().maxBucket;
  bytes += b;
  const t = sim.__S.t;
  series.total.push(s + n); series.sim.push(s); series.snap.push(n);
  for (const k of ["bot", "eat", "combat", "grid", "gridFresh"]) { series[k].push(t[k] - prev[k]); }
  prev = { ...t };
  let cells = 0, alive = 0;
  for (const p of world.players.values()) {
    if (p.alive) alive++;
    cells += p.cells.length;
    for (const c of p.cells) maxR = Math.max(maxR, sim.radiusOf(c.mass));
  }
  cellsSum += cells; aliveSum += alive; pelletSum += world.pellets.length;
  if (box && [0, 9, 19, 39, 99, 199, 299, 599, 899].includes(i)) clusterTrace[i + 1] = inBox();
  if (i % 25 === 0) heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
}
const heap1 = process.memoryUsage().heapUsed;
await new Promise(r => setTimeout(r, 50));      // let GC entries arrive
obs.disconnect();

const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const stat = a => ({ avg: avg(a), p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), max: Math.max(...a) });

const { maxBucket, buckets } = occupancy();

const perTick = {};
for (const [k, v] of Object.entries(sim.__S.c)) perTick[k] = v / TICKS;

const simExAI = series.sim.map((s, i) => s - series.bot[i]);
console.log(JSON.stringify({
  scenario, variant, counted, seed: SEED, dt: DT, warm: WARM, ticks: TICKS, label: sc.label,
  players: sc.players, pellets: sc.pellets,
  state: {
    avgCells: cellsSum / TICKS, avgAlive: aliveSum / TICKS, avgPellets: pelletSum / TICKS,
    maxRadius: maxR, nonEmptyBuckets: buckets, maxBucket, maxBucketFirstTick,
    ...(box ? { orbsInClusterAfterTick: clusterTrace } : {})
  },
  ms: {
    total: stat(series.total), sim: stat(series.sim), simExAI: stat(simExAI),
    totalExAI: stat(series.total.map((t, i) => t - series.bot[i])),
    snap: stat(series.snap), bot: stat(series.bot), eat: stat(series.eat),
    combat: stat(series.combat), grid: stat(series.grid), gridFresh: stat(series.gridFresh)
  },
  counters: perTick,
  bytesPerTick: bytes / TICKS,
  memory: { heapStartMB: heap0 / 2 ** 20, heapPeakMB: heapPeak / 2 ** 20, heapEndMB: heap1 / 2 ** 20 },
  gc: { ...gcStats, msPerTick: gcStats.ms / TICKS, pctOfTick: (100 * gcStats.ms) / series.total.reduce((a, b) => a + b, 0) }
}));
