// ---------------------------------------------------------------------------
// Two load-test runs side by side.
//
//   node bench/stress/compare.mjs before.json after.json [--replace extra.json ...]
//
// Prints, scenario by scenario, the server's tick figures and the clients'
// view for the run before and the run after. --replace takes further result
// files whose scenarios stand in for the same scenario in either run (a
// rerun of one scenario), matched by the revision each was run at.
// ---------------------------------------------------------------------------
import fs from "node:fs";

const argv = process.argv.slice(2);
const [beforeFile, afterFile] = argv;
const extra = [];
for (let i = 2; i < argv.length; i++) if (argv[i] === "--replace") extra.push(argv[++i]);

const before = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
const after = JSON.parse(fs.readFileSync(afterFile, "utf8"));
for (const file of extra) {
  const x = JSON.parse(fs.readFileSync(file, "utf8"));
  const into = x.meta.rev === before.meta.rev ? before : x.meta.rev === after.meta.rev ? after : null;
  if (!into) throw new Error(`${file}: revision ${x.meta.rev} is neither run's`);
  for (const r of x.results) {
    const i = into.results.findIndex(y => y.scenario === r.scenario);
    if (i >= 0) into.results[i] = r; else into.results.push(r);
  }
}

const f = (x, d = 2) => (x === undefined || x === null || Number.isNaN(x) ? "–" : Number(x).toFixed(d));
const pair = (a, b, d = 2) => `${f(a, d)} → ${f(b, d)}`;
const rows = [];
rows.push(`Before: ${before.meta.rev}. After: ${after.meta.rev}. ${after.meta.seconds} s measured after ${after.meta.warm} s of play; ${after.meta.cpu} (${after.meta.cores} cores), Node ${after.meta.node}.`);
rows.push("");
rows.push("Server, ms per tick (all rooms): before → after");
rows.push("");
rows.push("| Scenario | Clients (alive at end) | Simulation avg | p95 | p99 | Snapshots avg | p95 | p99 | Whole tick avg | p95 | p99 | max |");
rows.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const b of before.results) {
  const a = after.results.find(r => r.scenario === b.scenario);
  if (!a) continue;
  const s = b.server, t = a.server;
  rows.push(`| ${b.label} | ${b.clients} (${b.aliveAtEnd} → ${a.aliveAtEnd}) | ${pair(s.simMs.avg, t.simMs.avg)} | ${pair(s.simMs.p95, t.simMs.p95)} | ${pair(s.simMs.p99, t.simMs.p99)} | ` +
    `${pair(s.snapMs.avg, t.snapMs.avg)} | ${pair(s.snapMs.p95, t.snapMs.p95)} | ${pair(s.snapMs.p99, t.snapMs.p99)} | ` +
    `${pair(s.totalMs.avg, t.totalMs.avg)} | ${pair(s.totalMs.p95, t.totalMs.p95)} | ${pair(s.totalMs.p99, t.totalMs.p99)} | ${pair(s.totalMs.max, t.totalMs.max, 1)} |`);
}
rows.push("");
rows.push("Scheduling, resources and bandwidth: before → after");
rows.push("");
rows.push("| Scenario | Tick start late, ms p50 / p99 / max | Server CPU % | RSS MB, peak | Heap MB, peak | GCs / GC ms in the window | Server snapshot KiB/s | Client KiB/s each |");
rows.push("|---|---:|---:|---:|---:|---:|---:|---:|");
for (const b of before.results) {
  const a = after.results.find(r => r.scenario === b.scenario);
  if (!a) continue;
  const s = b.server, t = a.server;
  rows.push(`| ${b.label} | ${f(s.lateMs.p50, 0)} / ${f(s.lateMs.p99, 0)} / ${f(s.lateMs.max, 0)} → ${f(t.lateMs.p50, 0)} / ${f(t.lateMs.p99, 0)} / ${f(t.lateMs.max, 0)} | ` +
    `${pair(s.cpuPercent, t.cpuPercent, 1)} | ${pair(s.rssMB.peak, t.rssMB.peak, 0)} | ${pair(s.heapUsedMB.peak, t.heapUsedMB.peak, 0)} | ` +
    `${s.gc.count} / ${f(s.gc.ms, 0)} → ${t.gc.count} / ${f(t.gc.ms, 0)} | ${pair(s.bytesPerSec / 1024, t.bytesPerSec / 1024, 0)} | ${pair(b.client.kibPerSecEach, a.client.kibPerSecEach, 2)} |`);
}
rows.push("");
rows.push("What the clients saw: before → after");
rows.push("");
rows.push("| Scenario | Snapshots a second each | Gap between snapshots, ms p50 / p99 / max | Ticks missed | Protocol errors |");
rows.push("|---|---:|---:|---:|---:|");
for (const b of before.results) {
  const a = after.results.find(r => r.scenario === b.scenario);
  if (!a) continue;
  const c = b.client, d = a.client;
  rows.push(`| ${b.label} | ${pair(c.snapshotsPerSec, d.snapshotsPerSec, 1)} | ${f(c.gapMs.p50, 0)} / ${f(c.gapMs.p99, 0)} / ${f(c.gapMs.max, 0)} → ${f(d.gapMs.p50, 0)} / ${f(d.gapMs.p99, 0)} / ${f(d.gapMs.max, 0)} | ` +
    `${c.skippedTicks} → ${d.skippedTicks} | ${c.protocolErrors} → ${d.protocolErrors} |`);
}
const stalls = before.results.find(r => r.stalls) && after.results.find(r => r.stalls);
if (stalls) {
  const b = before.results.find(r => r.stalls), a = after.results.find(r => r.stalls);
  rows.push("");
  rows.push(`Stalls injected: ${b.stalls.count} before (avg ${b.stalls.avgMs} ms, max ${b.stalls.maxMs}), ${a.stalls.count} after (avg ${a.stalls.avgMs} ms, max ${a.stalls.maxMs}).`);
}
console.log(rows.join("\n"));
