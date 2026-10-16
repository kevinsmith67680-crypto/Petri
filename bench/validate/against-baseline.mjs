// ---------------------------------------------------------------------------
// The optimised game against the baseline it was optimised from, tick by tick.
//
//   node bench/validate/against-baseline.mjs [--rev a44cad8] [--ticks 1200]
//
// The cell-combat grid, the flat pellet grid and the shared snapshot frame
// were each built to change nothing but cost. This plays the same games on
// both, the baseline's shared/ from git and this tree's, and every tick
// compares:
//
//   - every player's cells (id, position, mass), counters (orbs eaten,
//     cells eaten, peak mass), standing (rank of field) and life;
//   - every pellet and virus, and the tick's events in order (orbs, bites,
//     pops, deaths);
//   - every player's snapshot, byte for byte, each build with its own
//     encoder and its own per-client state.
//
// And on this tree alone, every tick:
//
//   - the pellet index holds exactly the live pellets, each once (no
//     orphans, nothing missing, nothing eaten still filed);
//   - no mass is NaN or negative, and the mass in play (cells, pellets,
//     viruses) is reported, so the two builds' bookkeeping can be compared
//     scenario by scenario.
//
// Scoring, ranking and payouts are all computed from these (server/awards.js,
// the settlement in server/index.js), and none of that code changed, so
// identical states mean identical outcomes.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const BASE = arg("--rev", "a44cad8");
const TICKS = Number(arg("--ticks", 1200));

// The baseline's shared/ from git, beside this tree's.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-validate-"));
for (const [name, read] of [
  ["base", f => execFileSync("git", ["-C", ROOT, "show", `${BASE}:shared/${f}`], { encoding: "utf8" })],
  ["head", f => fs.readFileSync(path.join(ROOT, "shared", f), "utf8")]
]) {
  fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, name, "package.json"), '{ "type": "module" }\n');
  for (const f of ["sim.js", "protocol.js", "codec.js"]) fs.writeFileSync(path.join(dir, name, f), read(f));
}
const load = (name, f) => import(pathToFileURL(path.join(dir, name, f)).href);
const A = { sim: await load("base", "sim.js"), proto: await load("base", "protocol.js") };
const B = { sim: await load("head", "sim.js"), proto: await load("head", "protocol.js") };

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

function fingerprint(w) {
  let s = `${w.tick}|${w.time}|${JSON.stringify(w.events)}`;
  for (const p of w.players.values()) {
    s += `|${p.id},${p.alive ? 1 : 0},${p.orbs},${p.eaten},${p.peak},${p.rank},${p.of}`;
    for (const c of p.cells) s += `;${c.id},${c.x},${c.y},${c.mass},${c.vx},${c.vy},${c.mergeAt}`;
  }
  for (const p of w.pellets) s += `/${p.id},${p.x},${p.y},${p.mass}`;
  for (const v of w.viruses) s += `^${v.vid},${v.x},${v.y},${v.fed}`;
  return s;
}

// Everything the flat grid holds, against world.pellets: each live pellet
// filed once, and nothing else. Pellets a whole bucket below zero are filed
// nowhere by design.
function indexProblems(w) {
  const g = w.grid;
  if (!g || !g.items) return "no flat grid";
  const filed = new Map();
  const note = p => filed.set(p, (filed.get(p) || 0) + 1);
  for (const p of g.items) if (p !== null) note(p);
  for (const list of g.extra) if (list) for (const p of list) note(p);
  const want = w.pellets.filter(p => ((p.x / 220) | 0) >= 0 && ((p.y / 220) | 0) >= 0);
  for (const p of want) {
    const n = filed.get(p) || 0;
    if (n !== 1) return `pellet ${p.id} filed ${n} times`;
    filed.delete(p);
  }
  if (filed.size) return `${filed.size} filed pellet(s) not in play (first ${[...filed.keys()][0].id})`;
  return null;
}

const massIn = w => {
  let cells = 0, pellets = 0, viruses = 0, bad = 0;
  for (const p of w.players.values()) for (const c of p.cells) { cells += c.mass; if (!(c.mass >= 0)) bad++; }
  for (const p of w.pellets) { pellets += p.mass; if (!(p.mass >= 0)) bad++; }
  for (const v of w.viruses) viruses += v.mass;
  return { cells, pellets, viruses, bad };
};

const SCENARIOS = {
  standard: {
    label: "Standard arena, 100 hard bots",
    setup(sim) {
      const w = sim.createWorld(41, { size: 8800, pellets: 4100, viruses: 90, botLevel: "hard" });
      sim.fillBots(w, 100);
      const r = rng(41);
      for (const p of w.players.values()) p.cells[0].mass = 20 + Math.pow(r(), 2) * 1500;
      return w;
    }
  },
  splitting: {
    label: "60 players splitting and throwing, ticks 50-250 ms",
    dts: [0.05, 0.05, 0.25, 0.1, 0.05, 0.15, 0.2, 0.05],
    setup(sim) {
      const w = sim.createWorld(42, { size: 3000, pellets: 600, viruses: 10 });
      const r = rng(42);
      for (let i = 0; i < 60; i++) sim.addPlayer(w, { id: `h${i}`, name: `H${i}` }).cells[0].mass = 200 + r() * 1800;
      return w;
    },
    drive(sim, w, t) {
      const r = rng(9000 + t);
      let n = 0;
      for (const p of w.players.values()) {
        n++;
        if (!p.alive) { sim.queueAction(w, p.id, "respawn"); continue; }
        sim.setAim(w, p.id, (r() - 0.5) * 800, (r() - 0.5) * 800);
        if ((t + n) % 8 === 0) sim.queueAction(w, p.id, "split");
        if ((t + n) % 20 === 0) sim.queueAction(w, p.id, "eject");
      }
    }
  },
  zone: {
    label: "Thrown mass in a crowd, closing zone, a new round halfway",
    reset: 600,
    setup(sim) {
      const w = sim.createWorld(43, { size: 4000, pellets: 1500, viruses: 12 });
      for (let i = 0; i < 50; i++) {
        const p = sim.addPlayer(w, { id: `h${i}`, name: `H${i}` });
        p.cells[0].x = 1500 + (i % 10) * 100; p.cells[0].y = 1500 + Math.floor(i / 10) * 100;
        p.cells[0].mass = 150 + (i * 37) % 600;
      }
      sim.planZone(w, w.time + 40);
      return w;
    },
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
  },
  giants: {
    label: "Giants among 60 hard bots",
    setup(sim) {
      const w = sim.createWorld(44, { size: 6200, pellets: 2035, viruses: 45, botLevel: "hard" });
      sim.fillBots(w, 60);
      const r = rng(44);
      let i = 0;
      for (const p of w.players.values()) p.cells[0].mass = i++ < 6 ? 20000 + r() * 20000 : 20 + r() * 800;
      return w;
    }
  },
  stress: {
    label: "150 hard bots",
    setup(sim) {
      const w = sim.createWorld(45, { size: 8800, pellets: 5000, viruses: 90, botLevel: "hard" });
      sim.fillBots(w, 150);
      return w;
    }
  }
};

const rows = [];
let failed = 0;
for (const [key, sc] of Object.entries(SCENARIOS)) {
  const a = sc.setup(A.sim), b = sc.setup(B.sim);
  const ids = [...a.players.keys()];
  const csA = ids.map((_, i) => A.proto.createClientState(i)), csB = ids.map((_, i) => B.proto.createClientState(i));
  let diverged = null, snaps = 0, bytes = 0, events = { orb: 0, eat: 0, pop: 0, death: 0 }, index = null, worst = null;
  const dts = sc.dts || [0.05];
  const m0 = massIn(b);
  for (let t = 0; t < TICKS && !diverged; t++) {
    sc.drive?.(A.sim, a, t); sc.drive?.(B.sim, b, t);
    if (t === sc.reset) { A.sim.resetArena(a); B.sim.resetArena(b); }
    const dt = dts[t % dts.length];
    A.sim.stepWorld(a, dt); B.sim.stepWorld(b, dt);
    if (fingerprint(a) !== fingerprint(b)) { diverged = `state at tick ${t + 1}`; break; }
    for (const e of b.events) if (e.t in events) events[e.t]++;
    if (!index) { const why = indexProblems(b); if (why) index = `tick ${t + 1}: ${why}`; }
    const m = massIn(b);
    if (m.bad && !worst) worst = `tick ${t + 1}: ${m.bad} NaN or negative masses`;
    const frame = B.proto.snapshotFrame(b);
    for (let i = 0; i < ids.length; i++) {
      const x = A.proto.encodeSnapshot(a, a.players.get(ids[i]), csA[i]);
      const y = B.proto.encodeSnapshot(b, b.players.get(ids[i]), csB[i], null, null, null, frame);
      if (Buffer.compare(Buffer.from(x), Buffer.from(y)) !== 0) { diverged = `snapshot for ${ids[i]} at tick ${t + 1}`; break; }
      snaps++; bytes += y.length;
    }
  }
  const m1 = massIn(b);
  const ok = !diverged && !index && !worst;
  if (!ok) failed++;
  rows.push({ key, label: sc.label, ticks: TICKS, ok, diverged, index, worst, snaps, bytes, events, massStart: m0, massEnd: m1 });
  console.error(`${ok ? "PASS" : "FAIL"} ${key}: ${diverged || index || worst || `identical for ${TICKS} ticks, ${snaps} snapshots`}`);
}
fs.rmSync(dir, { recursive: true, force: true });

const f0 = x => Math.round(x).toLocaleString("en-GB");
console.log(`Baseline ${BASE} against this tree, ${TICKS} ticks a scenario.`);
console.log("");
console.log("| Scenario | Same state every tick | Same snapshot bytes | Index exact every tick | Orbs eaten | Bites | Pops | Deaths | Mass in cells, start → end | In pellets, start → end |");
console.log("|---|---|---|---|---:|---:|---:|---:|---:|---:|");
for (const r of rows) {
  const st = r.diverged?.startsWith("state") ? `**no**, ${r.diverged}` : "yes";
  const sn = r.diverged?.startsWith("snapshot") ? `**no**, ${r.diverged}` : r.diverged ? "–" : `yes, ${r.snaps.toLocaleString("en-GB")}`;
  console.log(`| ${r.label} | ${st} | ${sn} | ${r.index ? `**no**, ${r.index}` : "yes"} | ${r.events.orb} | ${r.events.eat} | ${r.events.pop} | ${r.events.death} | ` +
    `${f0(r.massStart.cells)} → ${f0(r.massEnd.cells)} | ${f0(r.massStart.pellets)} → ${f0(r.massEnd.pellets)} |`);
}
process.exitCode = failed ? 1 : 0;
