// ---------------------------------------------------------------------------
// Snapshot encoding before and after the shared per-tick frame.
//
//   node --expose-gc bench/spatial/snapshot-cost.mjs [--scenarios standard,splits]
//        [--ticks 600] [--only old|new]
//
// Plays a scenario on the working tree's simulation and, every tick, encodes
// every player's snapshot twice from the same world: with encodeSnapshot as it
// was at OLD_REV (one client at a time, from scratch) and as it is now (one
// snapshotFrame per tick, shared). Each client has its own delta state per
// encoder, so the two streams are independent, and every pair of snapshots is
// compared byte for byte. The order alternates tick by tick so neither encoder
// always runs on a warm cache.
//
// --only runs one encoder alone, so the garbage it leaves behind can be
// counted on its own (collections and their time, per 1,000 ticks).
//
// Also prints where the bytes go, section by section, for the current
// encoder, which is what any change to the wire format would have to save.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

// The last revision with the one-client-at-a-time encoder.
const OLD_REV = "dd03e01";

process.env.SPATIAL_REV = "working";
const { loadVariant, ROOT } = await import("./build.mjs");
const { setupScenario, SCENARIOS } = await import("./scenarios.mjs");

const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const scenarios = arg("--scenarios", "low,moderate,full,standard,splits,eject,stress").split(",");
const TICKS = Number(arg("--ticks", 600));
const WARM = Number(arg("--warm", 200));
const ONLY = arg("--only", null);

// One simulation build for both encoders, so they read the same world through
// the same grid. The old protocol.js sits beside a copy of it.
const { sim, protocol: cur, dir } = await loadVariant({ tag: "snapcost" });
const oldDir = path.join(dir, "..", "snapcost-old");
fs.mkdirSync(oldDir, { recursive: true });
for (const f of ["sim.js", "codec.js", "package.json"]) fs.copyFileSync(path.join(dir, f), path.join(oldDir, f));
fs.writeFileSync(path.join(oldDir, "protocol.js"),
  execFileSync("git", ["-C", ROOT, "show", `${OLD_REV}:shared/protocol.js`], { encoding: "utf8" }));
// Same simulation module, so its exports must be the one instance: point the
// old protocol at the new copy's sim.js.
const oldSrc = fs.readFileSync(path.join(oldDir, "protocol.js"), "utf8").replace('from "./sim.js"', `from ${JSON.stringify(pathToFileURL(path.join(dir, "sim.js")).href)}`);
fs.writeFileSync(path.join(oldDir, "protocol.js"), oldSrc);
const old = await import(pathToFileURL(path.join(oldDir, "protocol.js")).href);

const gc = { n: 0, ms: 0 };
new PerformanceObserver(list => { for (const e of list.getEntries()) { gc.n++; gc.ms += e.duration; } }).observe({ entryTypes: ["gc"] });

const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

// Bytes per section of one encoded snapshot, from its decoded counts and the
// record sizes in protocol.js. Names are up to 32 bytes of UTF-8 each.
const nameBytes = n => Math.min(32, Buffer.byteLength(n));
function sections(bytes) {
  const s = cur.decodeSnapshot(bytes);
  const names = 2 + s.names.reduce((n, x) => n + 4 + nameBytes(x.name), 0);
  const cells = 2 + s.cells.reduce((n, c) => n + (c.mine ? 23 : 13), 0);
  const added = 2 + s.added.reduce((n, p) => n + (p.vx || p.vy ? 14 : 10), 0);
  const removed = 2 + 4 * s.removed.length;
  const viruses = 2 + 7 * s.viruses.length;
  const board = s.board ? 1 + s.board.reduce((n, r) => n + 6 + nameBytes(r.name), 0) : 0;
  const header = bytes.length - names - cells - added - removed - viruses - board;
  return { header, names, cells, added, removed, viruses, board, total: bytes.length };
}

const rows = [];
for (const key of scenarios) {
  const { world, driver } = setupScenario(sim, key, 1);
  const players = [...world.players.values()];
  const csOld = players.map((_, i) => old.createClientState(i));
  const csNew = players.map((_, i) => cur.createClientState(i));
  const tOld = [], tNew = [], bytes = [];
  const parts = {};
  let differ = 0;
  const encOld = () => { for (let i = 0; i < players.length; i++) players[i].__o = old.encodeSnapshot(world, players[i], csOld[i]); };
  const encNew = () => {
    const frame = cur.snapshotFrame(world);
    for (let i = 0; i < players.length; i++) players[i].__n = cur.encodeSnapshot(world, players[i], csNew[i], null, null, null, frame);
  };
  for (let t = 0; t < WARM; t++) { driver.step(world); sim.stepWorld(world, 0.05); if (ONLY !== "new") encOld(); if (ONLY !== "old") encNew(); }
  globalThis.gc?.();
  gc.n = 0; gc.ms = 0;
  const heap0 = process.memoryUsage().heapUsed;
  for (let t = 0; t < TICKS; t++) {
    driver.step(world);
    sim.stepWorld(world, 0.05);
    const order = ONLY ? [ONLY] : t % 2 ? ["old", "new"] : ["new", "old"];
    for (const which of order) {
      const t0 = performance.now();
      if (which === "old") encOld(); else encNew();
      (which === "old" ? tOld : tNew).push(performance.now() - t0);
    }
    if (!ONLY) {
      let b = 0;
      for (const p of players) {
        if (Buffer.compare(Buffer.from(p.__o), Buffer.from(p.__n)) !== 0) differ++;
        b += p.__n.length;
      }
      bytes.push(b);
      if (t % 20 === 0) {
        for (const p of players) {
          const s = sections(p.__n);
          for (const [k, v] of Object.entries(s)) parts[k] = (parts[k] || 0) + v;
        }
      }
    }
  }
  const heap1 = process.memoryUsage().heapUsed;
  await new Promise(r => setTimeout(r, 30));
  const row = { scenario: SCENARIOS[key].label, players: players.length, ticks: TICKS };
  if (tOld.length) Object.assign(row, { oldAvg: avg(tOld), oldP95: pct(tOld, 0.95), oldP99: pct(tOld, 0.99) });
  if (tNew.length) Object.assign(row, { newAvg: avg(tNew), newP95: pct(tNew, 0.95), newP99: pct(tNew, 0.99) });
  if (!ONLY) Object.assign(row, { differ, kibPerTick: avg(bytes) / 1024, parts });
  else Object.assign(row, { gcPer1000: (gc.n * 1000) / TICKS, gcMsPer1000: (gc.ms * 1000) / TICKS, heapGrowthMB: (heap1 - heap0) / 2 ** 20 });
  rows.push(row);
  console.error(`${key}: ${JSON.stringify(row)}`);
  for (const p of players) { delete p.__o; delete p.__n; }
}

const f = (x, d = 2) => (x === undefined ? "–" : x.toFixed(d));
console.log(`Node ${process.version}, ${os.cpus()[0]?.model}; ${TICKS} ticks after ${WARM} warm-up, dt 0.05; encoder at ${OLD_REV} against the working tree.`);
console.log("");
if (!ONLY) {
  console.log("All of a tick's snapshots, ms (one per player)");
  console.log("");
  console.log("| Scenario | Players | Before avg | p95 | p99 | After avg | p95 | p99 | Speed-up | Byte-identical | KiB a tick |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|");
  for (const r of rows) {
    console.log(`| ${r.scenario} | ${r.players} | ${f(r.oldAvg)} | ${f(r.oldP95)} | ${f(r.oldP99)} | ${f(r.newAvg)} | ${f(r.newP95)} | ${f(r.newP99)} | ` +
      `${(r.oldAvg / r.newAvg).toFixed(2)}x | ${r.differ === 0 ? `yes, all ${r.players * r.ticks}` : `NO: ${r.differ} differ`} | ${f(r.kibPerTick, 1)} |`);
  }
  console.log("");
  console.log("Where the bytes go (share of all snapshot bytes, sampled every 20th tick)");
  console.log("");
  console.log("| Scenario | Header | Names | Cells | Pellets added | Pellets removed | Viruses | Leaderboard |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const p = r.parts, pc = k => `${((100 * p[k]) / p.total).toFixed(0)}%`;
    console.log(`| ${r.scenario} | ${pc("header")} | ${pc("names")} | ${pc("cells")} | ${pc("added")} | ${pc("removed")} | ${pc("viruses")} | ${pc("board")} |`);
  }
} else {
  console.log(`Garbage left by the ${ONLY} encoder alone`);
  console.log("");
  console.log("| Scenario | Players | avg ms | p99 ms | GCs per 1,000 ticks | GC ms per 1,000 ticks |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    const a = ONLY === "old" ? r.oldAvg : r.newAvg, p = ONLY === "old" ? r.oldP99 : r.newP99;
    console.log(`| ${r.scenario} | ${r.players} | ${f(a)} | ${f(p)} | ${f(r.gcPer1000, 0)} | ${f(r.gcMsPer1000, 1)} |`);
  }
}
