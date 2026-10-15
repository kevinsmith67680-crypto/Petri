// ---------------------------------------------------------------------------
// Benchmark orchestrator.
//
//   node bench/spatial/bench.mjs [--quick] [--reps 3] [--scenarios a,b]
//        [--variants current,fresh,...] [--out results/bench.json]
//
// Runs every scenario x variant in its own process (run-one.mjs), takes the
// median of each statistic across repetitions, then one counted run per
// scenario for broad/narrow-phase counts. Prints markdown tables.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "./scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const QUICK = argv.includes("--quick");
const REPS = Number(arg("--reps", QUICK ? 1 : 3));
const WARM = Number(arg("--warm", QUICK ? 100 : 300));
const TICKS = Number(arg("--ticks", QUICK ? 200 : 900));
const scenarios = arg("--scenarios", Object.keys(SCENARIOS).join(",")).split(",");
const variants = arg("--variants", "current,fresh,csr,gcombat,all").split(",");
const out = arg("--out", null);
// --merge: start from an earlier results file and replace only the
// scenarios run now; tables then cover everything in the merged file.
const merge = arg("--merge", null);

function runOne(scenario, variant, extra = []) {
  const stdout = execFileSync(process.execPath, [
    "--expose-gc", path.join(here, "run-one.mjs"), scenario, variant,
    "--warm", String(WARM), "--ticks", String(TICKS), ...extra
  ], { encoding: "utf8", maxBuffer: 1 << 26 });
  return JSON.parse(stdout.trim().split("\n").pop());
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
// Median of every numeric leaf across repetitions.
function mergeReps(runs) {
  const walk = objs => {
    const o = objs[0];
    if (typeof o === "number") return median(objs);
    if (o === null || typeof o !== "object") return o;
    const r = {};
    for (const k of Object.keys(o)) r[k] = walk(objs.map(x => x[k]));
    return r;
  };
  return walk(runs);
}

const results = merge ? JSON.parse(fs.readFileSync(merge, "utf8")) : { meta: {
  node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length,
  reps: REPS, warm: WARM, ticks: TICKS, date: new Date().toISOString()
}, timing: {}, counted: {} };
if (merge) (results.meta.rerun ||= []).push({ scenarios, variants, reps: REPS, warm: WARM, ticks: TICKS, date: new Date().toISOString() });

for (const s of scenarios) {
  results.timing[s] = {};
  for (const v of variants) {
    const runs = [];
    for (let r = 0; r < REPS; r++) runs.push(runOne(s, v, ["--seed", String(1 + r)]));
    results.timing[s][v] = mergeReps(runs);
    const m = results.timing[s][v].ms;
    console.error(`${s.padEnd(9)} ${v.padEnd(8)} total ${m.total.avg.toFixed(2)}ms  p99 ${m.total.p99.toFixed(2)}  exAI ${m.totalExAI.avg.toFixed(2)}`);
  }
  for (const v of ["current", "gcombat"]) {
    if (!variants.includes(v)) continue;
    results.counted[s] = results.counted[s] || {};
    results.counted[s][v] = runOne(s, v, ["--counted", "--seed", "1"]);
  }
}

if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
// Tables cover every scenario in the results, in the canonical order.
const shown = Object.keys(SCENARIOS).filter(s => results.timing[s]);
const shownVariants = variants.filter(v => shown.every(s => results.timing[s][v]));

// ── tables ──────────────────────────────────────────────────────────────────

const f = (x, d = 2) => (x === undefined ? "–" : x.toFixed(d));
const rows = [];
rows.push(`Node ${results.meta.node}, ${results.meta.cpu} (${results.meta.cores} cores), ` +
  `${results.meta.reps} rep(s) x ${results.meta.ticks} measured ticks after ${results.meta.warm} warm-up, dt 0.05.` +
  (results.meta.rerun ? ` Re-run: ${results.meta.rerun.map(r => `${r.scenarios.join("/")} (${r.reps} x ${r.ticks} after ${r.warm})`).join("; ")}.` : ""));
rows.push("");
rows.push("Current implementation (ms per room tick; total = stepWorld + one snapshot per player)");
rows.push("");
rows.push("| Scenario | Players | Pellets | Cells | Total avg | p95 | p99 | Total excl. bot AI | p99 | Snapshots | Pellet grid rebuild | cellCombat | eatPellets | GC % | Heap MB |");
rows.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const s of shown) {
  const r = results.timing[s].current; if (!r) continue;
  const m = r.ms;
  rows.push(`| ${r.label} | ${r.players} | ${r.pellets} | ${f(r.state.avgCells, 0)} | ${f(m.total.avg)} | ${f(m.total.p95)} | ${f(m.total.p99)} | ` +
    `${f(m.totalExAI.avg)} | ${f(m.totalExAI.p99)} | ${f(m.snap.avg)} | ${f(m.grid.avg, 3)} | ${f(m.combat.avg, 3)} | ${f(m.eat.avg, 3)} | ${f(r.gc.pctOfTick, 1)} | ${f(r.memory.heapPeakMB, 1)} |`);
}
rows.push("");
rows.push("Broad / narrow phase per tick (counted build, current implementation)");
rows.push("");
rows.push("| Scenario | eat: candidates | eat: narrow tests | eats | combat: pair-loop iterations | combat: sqrt tests | combat eats | virus tests | snapshot pellet candidates | snapshot cell tests | buckets visited |");
rows.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const s of shown) {
  const r = results.counted[s]?.current; if (!r) continue;
  const c = r.counters;
  rows.push(`| ${r.label} | ${f(c.eatCand, 0)} | ${f(c.eatNarrow, 0)} | ${f(c.pelletEats, 1)} | ${f(c.combatIter, 0)} | ${f(c.combatNarrow, 1)} | ${f(c.combatEats, 2)} | ${f(c.virusTests, 0)} | ${f(c.snapCand, 0)} | ${f(c.snapCellTests, 0)} | ${f(c.buckets, 0)} |`);
}
rows.push("");
rows.push("Grid broad phase for cellCombat (counted build)");
rows.push("");
rows.push("| Scenario | naive pair-loop iterations | grid: bucket entries visited | grid: candidate tests | sqrt tests (both) | eats (both) |");
rows.push("|---|---:|---:|---:|---:|---:|");
for (const s of shown) {
  const a = results.counted[s]?.current, b = results.counted[s]?.gcombat; if (!a || !b) continue;
  rows.push(`| ${a.label} | ${f(a.counters.combatIter, 0)} | ${f(b.counters.combatGridVisits, 0)} | ${f(b.counters.combatIter, 0)} | ` +
    `${f(a.counters.combatNarrow, 1)} / ${f(b.counters.combatNarrow, 1)} | ${f(a.counters.combatEats, 2)} / ${f(b.counters.combatEats, 2)} |`);
}
rows.push("");
rows.push("Variants (ms per room tick, excluding bot AI; median of reps)");
rows.push("");
rows.push(`| Scenario | ${shownVariants.map(v => `${v} avg / p99`).join(" | ")} | ${shownVariants.map(v => `${v} combat`).join(" | ")} | ${shownVariants.map(v => `${v} grid`).join(" | ")} |`);
rows.push(`|---|${shownVariants.map(() => "---:").join("|")}|${shownVariants.map(() => "---:").join("|")}|${shownVariants.map(() => "---:").join("|")}|`);
for (const s of shown) {
  const t = results.timing[s];
  rows.push(`| ${t.current?.label || s} | ` +
    shownVariants.map(v => `${f(t[v].ms.totalExAI.avg)} / ${f(t[v].ms.totalExAI.p99)}`).join(" | ") + " | " +
    shownVariants.map(v => f(t[v].ms.combat.avg, 3)).join(" | ") + " | " +
    shownVariants.map(v => f(t[v].ms.grid.avg + t[v].ms.gridFresh.avg, 3)).join(" | ") + " |");
}
console.log(rows.join("\n"));
