// ---------------------------------------------------------------------------
// Load test: the real server, real WebSocket clients.
//
//   node bench/stress/run.mjs [--rev working|<git rev>] [--scenarios p10,p100,...]
//        [--warm 8] [--seconds 30] [--seed 1] [--out bench/stress/results/x.json]
//
// Boots a copy of the game server in TEST_MODE (in-memory accounts, no bots
// unless asked) and connects clients the way the browser does: sign up, ask
// /api/match for a ticket, open a WebSocket, join with the ticket, ready up.
// Once the round is live, each client steers on a random walk at 30Hz, splits
// and throws mass as its scenario says, and decodes every snapshot it gets,
// keeping the pellet set a real client would.
//
// Measured, after a warm-up and over a fixed window:
//
//   server   /health?window=N, from server/tickstats.js: how late each tick
//            started against its schedule, and how long stepping the worlds,
//            encoding and sending snapshots, and the whole tick took (avg,
//            p50, p95, p99, max); snapshot bytes per second; collections; RSS
//            and heap, sampled every two seconds; CPU time, from /proc.
//   clients  bytes received, the gap between snapshots as each client saw
//            it, ticks it never got a snapshot for, and any snapshot that
//            added a pellet it already had or removed one it never had.
//
// Scheduling stalls are made by stopping the server process (SIGSTOP) and
// resuming it (SIGCONT), which is what a long GC pause, a descheduled VM or
// a stuck event loop look like from outside. Latency, jitter and loss go
// through a TCP proxy in this process, since the container has no netem:
// every chunk is held for the latency plus or minus the jitter, in order, and
// a lost one is held for a retransmission timeout, delaying what follows it,
// the way TCP does.
//
// --rev <git rev> runs that revision's server instead, with the same
// tickstats hooks patched in, for before-and-after runs. The client side is
// always this tree's, which is fine while the wire format is unchanged.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { decodeSnapshot, encodeAim, encodeAction, PROTOCOL_VERSION, PHASE_LIVE } from "../../shared/protocol.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const REV = arg("--rev", "working");
const WARM = Number(arg("--warm", 8));
const SECONDS = Number(arg("--seconds", 30));
const SEED = Number(arg("--seed", 1));
const OUT = arg("--out", null);
const HZ = 20;

const STANDARD = 1_000_000, HIGH = 2_000_000;    // stakes, in micro-units: 1.00 and 2.00
export const SCENARIOS = {
  p10:     { label: "10 players", groups: [{ n: 10, stake: STANDARD }] },
  p50:     { label: "50 players", groups: [{ n: 50, stake: STANDARD }] },
  p100:    { label: "100 players", groups: [{ n: 100, stake: STANDARD }] },
  splits:  { label: "100 players, heavy splitting", groups: [{ n: 100, stake: STANDARD, split: 0.75, eject: 1.5 }] },
  p150:    { label: "150 players (stress)", groups: [{ n: 150, stake: STANDARD }], env: { LOBBY_MAX: "150" } },
  rooms:   { label: "Two rooms at once, 100 + 50", groups: [{ n: 100, stake: STANDARD }, { n: 50, stake: HIGH }] },
  eject:   { label: "100 players, heavy ejected mass", groups: [{ n: 100, stake: STANDARD, eject: 0.3 }] },
  stalls:  { label: "100 players, 50-250 ms stalls every 2 s", groups: [{ n: 100, stake: STANDARD, split: 3 }], stalls: { every: 2, min: 50, max: 250 } },
  network: { label: "100 players, 80 ± 30 ms latency, 1% loss", groups: [{ n: 100, stake: STANDARD, split: 3 }], net: { latency: 80, jitter: 30, loss: 0.01, rto: 200 } }
};
const scenarios = arg("--scenarios", Object.keys(SCENARIOS).join(",")).split(",");

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ── the server ──────────────────────────────────────────────────────────────

// A real `ws`, not the stub the server tests write into node_modules.
function findWs() {
  const tried = [process.env.STRESS_WS_DIR, ROOT].filter(Boolean);
  for (const dir of tried) {
    const p = path.join(dir, "node_modules", "ws");
    if (fs.existsSync(path.join(p, "lib", "websocket.js"))) return path.dirname(p);
  }
  const dir = path.join(os.tmpdir(), "petri-stress-ws");
  if (!fs.existsSync(path.join(dir, "node_modules", "ws", "lib", "websocket.js"))) {
    console.error("installing ws for the load test into", dir);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefix", dir, "ws@8.18.0"], { stdio: "inherit" });
  }
  return path.join(dir, "node_modules");
}

// The tickstats hooks, for a revision from before they existed. The same
// lines as server/index.js has now.
function instrument(src) {
  if (src.includes("createTickStats")) return src;
  const once = (a, b) => {
    if (src.split(a).length !== 2) throw new Error(`instrument: anchor not found once: ${a.slice(0, 60)}`);
    src = src.replace(a, b);
  };
  once(`import { createMatchmaker } from "./matchmaker/core.js";\n`,
    `import { createMatchmaker } from "./matchmaker/core.js";\nimport { createTickStats, recordTick, summarise } from "./tickstats.js";\n`);
  once(`  const events = stepWorld(world, dt, round.phase === PHASE_HOLD);\n`,
    `  const events = stepWorld(world, dt, round.phase === PHASE_HOLD);\n  tickStats.cur.sim += performance.now() - tickAt;\n`);
  once(`  const view = roundView(room);\n`, `  const view = roundView(room);\n  const sendFrom = performance.now();\n`);
  once(`    ws.send(encodeSnapshot(world, player, meta.state, view, eye, tickAt));\n  }\n}`,
    `    const snap = encodeSnapshot(world, player, meta.state, view, eye, tickAt);\n    tickStats.cur.bytes += snap.length;\n    ws.send(snap);\n  }\n  tickStats.cur.snap += performance.now() - sendFrom;\n}`);
  once(`function tick() {\n  const tickStart = process.hrtime.bigint();`,
    `function tick(due) {\n  const tickStart = process.hrtime.bigint();\n  const late = Math.max(0, Date.now() - due);`);
  once(`  if (cost > 1000 / HZ) tickCost.behind++;\n}`, `  if (cost > 1000 / HZ) tickCost.behind++;\n  recordTick(tickStats, late, cost);\n}`);
  once(`  setTimeout(() => { tick(); scheduleTick(); }, Math.max(0, nextTickAt - Date.now()));`,
    `  const due = nextTickAt;\n  setTimeout(() => { tick(due); scheduleTick(); }, Math.max(0, due - Date.now()));`);
  once(`const tickCost = { avgMs: 0, worstMs: 0, behind: 0 };`,
    `const tickCost = { avgMs: 0, worstMs: 0, behind: 0 };\nconst tickStats = createTickStats(60 * HZ);`);
  once(`        overruns: tickCost.behind\n      }`,
    `        overruns: tickCost.behind,\n        window: summarise(tickStats, HZ, Number(url.searchParams.get("window")) || tickStats.n)\n      },\n` +
    `      memory: (({ rss, heapUsed, heapTotal, external }) => ({ rssMB: +(rss / 2 ** 20).toFixed(1), heapUsedMB: +(heapUsed / 2 ** 20).toFixed(1), heapTotalMB: +(heapTotal / 2 ** 20).toFixed(1), externalMB: +(external / 2 ** 20).toFixed(1) }))(process.memoryUsage())`);
  return src;
}

function prepareApp(rev) {
  const dir = path.join(os.tmpdir(), "petri-stress", rev.replace(/\W/g, "_"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (rev === "working") {
    for (const d of ["server", "shared", "client"]) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  } else {
    execFileSync("sh", ["-c", `git -C "${ROOT}" archive ${rev} server shared client package.json | tar -x -C "${dir}"`]);
    const idx = path.join(dir, "server", "index.js");
    fs.writeFileSync(idx, instrument(fs.readFileSync(idx, "utf8")));
    if (!fs.existsSync(path.join(dir, "server", "tickstats.js"))) fs.copyFileSync(path.join(ROOT, "server", "tickstats.js"), path.join(dir, "server", "tickstats.js"));
  }
  fs.symlinkSync(findWs(), path.join(dir, "node_modules"));
  return dir;
}

async function startServer(app, port, env) {
  const child = spawn(process.execPath, [path.join(app, "server", "index.js")], {
    cwd: app,
    env: {
      ...process.env, PORT: String(port), TEST_MODE: "1", BOTS: "0",
      ROUND_SECONDS: "3600", COUNTDOWN_SECONDS: "2", HOLD_SECONDS: "1", STANDINGS_SECONDS: "1",
      MAX_CONN_PER_IP: "100000", MATCH_BURST: "100000", MATCH_RATE: "100000", LINGER_SEC: "1",
      DATA_FILE: "", DATABASE_URL: "", ALLOWED_ORIGINS: "", ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { child, log: () => log }; } catch {}
    if (child.exitCode !== null) break;
  }
  child.kill("SIGKILL");
  throw new Error(`server did not start:\n${log}`);
}

const health = async (port, window) =>
  (await fetch(`http://127.0.0.1:${port}/health${window ? `?window=${window}` : ""}`)).json();

// utime + stime of a process, in seconds, from /proc.
function cpuSeconds(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch { return NaN; }
}

// ── network conditions ──────────────────────────────────────────────────────

function startProxy(target, { latency, jitter, loss, rto }, rnd) {
  // One queue and one timer per direction, delivering strictly in order. A
  // timer per chunk is not enough: delays are rounded to whole milliseconds,
  // so two chunks less than one apart could fire swapped, which is a
  // reordered TCP stream and not something the network ever does.
  const lane = (from, to) => {
    let last = 0, timer = null;
    const queue = [];
    const flush = () => {
      timer = null;
      const now = performance.now();
      while (queue.length && queue[0].at <= now) {
        const { chunk } = queue.shift();
        if (!to.destroyed) to.write(chunk);
      }
      if (queue.length) timer = setTimeout(flush, Math.max(1, queue[0].at - now));
    };
    from.on("data", chunk => {
      const now = performance.now();
      let at = now + Math.max(0, latency + (rnd() * 2 - 1) * jitter);
      if (rnd() < loss) at += rto;                 // lost, and resent after a timeout
      at = Math.max(at, last);                     // and everything after waits behind it
      last = at;
      queue.push({ at, chunk });
      if (!timer) timer = setTimeout(flush, Math.max(1, at - now));
    });
    const end = () => { if (!to.destroyed) to.destroy(); };
    from.on("close", end); from.on("error", end);
  };
  const server = net.createServer(sock => {
    const up = net.connect(target, "127.0.0.1");
    sock.setNoDelay(true); up.setNoDelay(true);
    lane(sock, up); lane(up, sock);
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() })));
}

// ── a client ────────────────────────────────────────────────────────────────

class Client {
  constructor(i, group, WebSocket, rnd) {
    Object.assign(this, { i, group, WebSocket, rnd });
    this.heading = rnd() * Math.PI * 2;
    this.seq = 1;
    this.pellets = new Set();
    this.reset();
  }
  reset() {
    this.bytes = 0; this.snaps = 0; this.gaps = []; this.skipped = 0; this.errors = 0; this.lastAt = 0;
  }
  async signup(base) {
    const res = await fetch(`${base}/api/signup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `load${this.i}x${SEED}`, password: "password123", displayName: `Load ${this.i}`, dateOfBirth: "1990-01-01" })
    });
    const body = await res.json();
    if (!body.token) throw new Error(`signup ${this.i}: ${JSON.stringify(body)}`);
    this.token = body.token;
  }
  async join(base, wsUrl) {
    const res = await fetch(`${base}/api/match`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ stake: this.group.stake })
    });
    const got = await res.json();
    if (!got.ticket) throw new Error(`match ${this.i}: ${JSON.stringify(got)}`);
    await new Promise((resolve, reject) => {
      const ws = this.ws = new this.WebSocket(wsUrl, { headers: { origin: base } });
      ws.binaryType = "nodebuffer";
      const timer = setTimeout(() => reject(new Error(`join ${this.i}: no welcome`)), 15000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "join", ticket: got.ticket, protocol: PROTOCOL_VERSION })));
      ws.on("message", (data, binary) => {
        if (!binary) {
          const m = JSON.parse(String(data));
          if (m.type === "welcome") { clearTimeout(timer); resolve(); }
          if (m.type === "account_error") { clearTimeout(timer); reject(new Error(`join ${this.i}: ${m.reason}`)); }
          return;
        }
        this.onSnapshot(data);
      });
      ws.on("error", e => { clearTimeout(timer); reject(e); });
    });
  }
  onSnapshot(data) {
    const now = performance.now();
    let s;
    try { s = decodeSnapshot(data); } catch { this.errors++; return; }
    this.bytes += data.length;
    this.snaps++;
    if (this.lastAt) this.gaps.push(now - this.lastAt);
    this.lastAt = now;
    if (this.lastTick !== undefined && s.tick > this.lastTick + 1) this.skipped += s.tick - this.lastTick - 1;
    this.lastTick = s.tick;
    // The pellet set as client/net.js keeps it: a correct stream never adds
    // one it already has or removes one it never had.
    if (s.keyframe) this.pellets.clear();
    for (const p of s.added) { if (this.pellets.has(p.id)) this.errors++; this.pellets.add(p.id); }
    for (const id of s.removed) { if (!this.pellets.delete(id)) this.errors++; }
    this.alive = s.me.alive;
    this.phase = s.round.phase;
  }
  ready() { this.ws.send(JSON.stringify({ type: "ready", ready: true })); }
  // One 30Hz step: a little turn, an aim, and now and then an action.
  step(dt) {
    if (!this.alive || this.ws.readyState !== 1) return;
    this.heading += (this.rnd() - 0.5) * 0.5;
    const dx = Math.round(Math.cos(this.heading) * 400), dy = Math.round(Math.sin(this.heading) * 400);
    const seq = this.seq = (this.seq % 65535) + 1;
    this.ws.send(encodeAim(dx, dy, seq));
    for (const action of ["split", "eject"]) {
      const every = this.group[action];
      if (every && this.rnd() < dt / every) this.ws.send(encodeAction(action, dx, dy, seq));
    }
  }
  close() { try { this.ws.terminate(); } catch {} }
}

// Runs fn over items, at most k at a time.
async function pool(items, k, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(k, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// ── one scenario ────────────────────────────────────────────────────────────

async function runScenario(key, app, WebSocket, port) {
  const sc = SCENARIOS[key];
  const rnd = rng(SEED * 7919 + key.length);
  const { child, log } = await startServer(app, port, sc.env || {});
  const base = `http://127.0.0.1:${port}`;
  let proxy = null, stopStalls = () => {};
  try {
    if (sc.net) proxy = await startProxy(port, sc.net, rnd);
    const wsUrl = `ws://127.0.0.1:${proxy ? proxy.port : port}`;
    const clients = [];
    for (const g of sc.groups) for (let k = 0; k < g.n; k++) clients.push(new Client(clients.length, g, WebSocket, rng(SEED * 1000 + clients.length)));
    const t0 = performance.now();
    await pool(clients, 8, c => c.signup(base));
    await pool(clients, 16, c => c.join(base, wsUrl));
    for (const c of clients) c.ready();
    // Into the round: the count, the hold on the ring, then live.
    const liveBy = performance.now() + 20000;
    while (clients.some(c => c.phase !== PHASE_LIVE) && performance.now() < liveBy) await sleep(100);
    const live = clients.filter(c => c.phase === PHASE_LIVE).length;
    const setup = (performance.now() - t0) / 1000;

    let last = performance.now();
    const drive = setInterval(() => {
      const now = performance.now(), dt = (now - last) / 1000;
      last = now;
      for (const c of clients) c.step(dt);
    }, 1000 / 30);

    await sleep(WARM * 1000);
    for (const c of clients) c.reset();
    const stalls = [];
    if (sc.stalls) {
      let on = true;
      const one = async () => {
        while (on) {
          await sleep(sc.stalls.every * 1000);
          if (!on) break;
          const ms = sc.stalls.min + rnd() * (sc.stalls.max - sc.stalls.min);
          child.kill("SIGSTOP");
          await sleep(ms);
          child.kill("SIGCONT");
          stalls.push(ms);
        }
      };
      const running = one();
      stopStalls = async () => { on = false; await running; child.kill("SIGCONT"); };
    }
    const h0 = await health(port);
    const cpu0 = cpuSeconds(child.pid), at0 = performance.now();
    const mem = [];
    const sampler = setInterval(() => { health(port).then(h => mem.push(h.memory)).catch(() => {}); }, 2000);
    await sleep(SECONDS * 1000);
    clearInterval(sampler);
    await stopStalls();
    const cpu = (cpuSeconds(child.pid) - cpu0) / ((performance.now() - at0) / 1000);
    const h1 = await health(port, SECONDS * HZ);
    clearInterval(drive);

    const gaps = clients.flatMap(c => c.gaps);
    const rooms = (h1.rooms || []).filter(r => r.clients > 0 || r.inWorld > 0);
    const result = {
      scenario: key, label: sc.label, rev: REV, seconds: SECONDS, warm: WARM, setupSeconds: +setup.toFixed(1),
      clients: clients.length, live, aliveAtEnd: clients.filter(c => c.alive).length,
      rooms: rooms.length,
      server: {
        ...h1.tick.window,
        gc: { count: h1.tick.window.gc.count - h0.tick.window.gc.count, ms: +(h1.tick.window.gc.ms - h0.tick.window.gc.ms).toFixed(1), maxMs: h1.tick.window.gc.maxMs },
        cpuPercent: +(100 * cpu).toFixed(1),
        rssMB: { end: h1.memory.rssMB, peak: Math.max(h1.memory.rssMB, ...mem.map(m => m?.rssMB || 0)) },
        heapUsedMB: { end: h1.memory.heapUsedMB, peak: Math.max(h1.memory.heapUsedMB, ...mem.map(m => m?.heapUsedMB || 0)) },
        snapshotsHeld: h1.tick.snapshotsHeld ?? null
      },
      client: {
        kibPerSecEach: +(avg(clients.map(c => c.bytes)) / SECONDS / 1024).toFixed(2),
        snapshotsPerSec: +(avg(clients.map(c => c.snaps)) / SECONDS).toFixed(2),
        gapMs: { p50: +pct(gaps, 0.5).toFixed(1), p95: +pct(gaps, 0.95).toFixed(1), p99: +pct(gaps, 0.99).toFixed(1), max: +Math.max(0, ...gaps).toFixed(1) },
        skippedTicks: clients.reduce((n, c) => n + c.skipped, 0),
        protocolErrors: clients.reduce((n, c) => n + c.errors, 0)
      },
      stalls: stalls.length ? { count: stalls.length, avgMs: +avg(stalls).toFixed(0), maxMs: +Math.max(...stalls).toFixed(0) } : null,
      net: sc.net || null
    };
    for (const c of clients) c.close();
    return result;
  } catch (e) {
    e.message += `\n--- server log ---\n${log().slice(-3000)}`;
    throw e;
  } finally {
    await stopStalls();
    proxy?.close();
    child.kill("SIGCONT");
    child.kill("SIGKILL");
    await sleep(300);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

const WebSocket = createRequire(path.join(findWs(), "ws", "index.js"))(path.join(findWs(), "ws"));
const app = prepareApp(REV);
const results = [];
let port = 9300 + (process.pid % 300);
for (const key of scenarios) {
  if (!SCENARIOS[key]) throw new Error(`unknown scenario ${key}`);
  const r = await runScenario(key, app, WebSocket, port++);
  results.push(r);
  const s = r.server;
  console.error(`${key.padEnd(8)} sim ${s.simMs.avg}/${s.simMs.p99}  snap ${s.snapMs.avg}/${s.snapMs.p99}  total ${s.totalMs.avg}/${s.totalMs.p99}  late p99 ${s.lateMs.p99} max ${s.lateMs.max}  cpu ${s.cpuPercent}%  rss ${s.rssMB.peak}MB  ${r.client.kibPerSecEach}KiB/s each  gaps p99 ${r.client.gapMs.p99}  errors ${r.client.protocolErrors}`);
}

const meta = { rev: REV, node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length, warm: WARM, seconds: SECONDS, seed: SEED, date: new Date().toISOString() };
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ meta, results }, null, 2));

const f = (x, d = 2) => (x === undefined || x === null || Number.isNaN(x) ? "–" : Number(x).toFixed(d));
const rows = [];
rows.push(`Revision ${REV}; Node ${meta.node}, ${meta.cpu} (${meta.cores} cores); ${SECONDS} s measured after ${WARM} s of play; one server process, clients in another.`);
rows.push("");
rows.push("| Scenario | Rooms | Clients (alive at end) | Sim ms avg / p95 / p99 | Snapshots ms avg / p95 / p99 | Tick ms avg / p95 / p99 / max | Late ms p50 / p95 / p99 / max | CPU % | RSS MB peak | Heap MB peak | GC count / ms | Server KiB/s | Client KiB/s each | Snapshot gap ms p50 / p99 / max | Ticks missed | Protocol errors |");
rows.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const r of results) {
  const s = r.server, c = r.client;
  rows.push(`| ${r.label} | ${r.rooms} | ${r.clients} (${r.aliveAtEnd}) | ${f(s.simMs.avg)} / ${f(s.simMs.p95)} / ${f(s.simMs.p99)} | ` +
    `${f(s.snapMs.avg)} / ${f(s.snapMs.p95)} / ${f(s.snapMs.p99)} | ${f(s.totalMs.avg)} / ${f(s.totalMs.p95)} / ${f(s.totalMs.p99)} / ${f(s.totalMs.max)} | ` +
    `${f(s.lateMs.p50, 0)} / ${f(s.lateMs.p95, 0)} / ${f(s.lateMs.p99, 0)} / ${f(s.lateMs.max, 0)} | ${f(s.cpuPercent, 0)} | ${f(s.rssMB.peak, 0)} | ${f(s.heapUsedMB.peak, 0)} | ` +
    `${s.gc.count} / ${f(s.gc.ms, 0)} | ${f(s.bytesPerSec / 1024, 0)} | ${f(c.kibPerSecEach, 1)} | ${f(c.gapMs.p50, 0)} / ${f(c.gapMs.p99, 0)} / ${f(c.gapMs.max, 0)} | ${c.skippedTicks} | ${c.protocolErrors} |`);
}
console.log(rows.join("\n"));
