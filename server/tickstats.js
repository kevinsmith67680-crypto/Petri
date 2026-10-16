// ---------------------------------------------------------------------------
// Per-tick timings over a rolling window, for /health and load tests.
//
// tickCost in index.js says how expensive ticks are on average. This says how
// they are distributed and where the time goes, which is what tells a server
// that is merely busy from one that stutters:
//
//   late      how long after its scheduled moment the tick started. The event
//             loop being busy, a GC pause or the machine being descheduled all
//             show here, and none of it shows in the tick's own cost.
//   sim       stepping every room's world.
//   snap      encoding and sending every client's snapshot.
//   total     the whole tick, rooms and bookkeeping.
//   bytes     snapshot bytes handed to sockets.
//
// Plus garbage collection, counted as it happens. Cheap enough to leave on: a
// few clock reads per room per tick.
// ---------------------------------------------------------------------------

import { PerformanceObserver } from "node:perf_hooks";

const FIELDS = ["late", "sim", "snap", "total", "bytes"];

export function createTickStats(size = 1200) {
  const s = { size, n: 0, at: 0, cur: { sim: 0, snap: 0, bytes: 0 }, gc: { count: 0, ms: 0, maxMs: 0 } };
  for (const f of FIELDS) s[f] = new Float64Array(size);
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        s.gc.count++;
        s.gc.ms += e.duration;
        if (e.duration > s.gc.maxMs) s.gc.maxMs = e.duration;
      }
    }).observe({ entryTypes: ["gc"] });
  } catch { /* no gc entries on this runtime: counts stay at zero */ }
  return s;
}

// Called once per tick, after every room has run.
export function recordTick(s, lateMs, totalMs) {
  const i = s.at;
  s.late[i] = lateMs;
  s.sim[i] = s.cur.sim;
  s.snap[i] = s.cur.snap;
  s.total[i] = totalMs;
  s.bytes[i] = s.cur.bytes;
  s.cur.sim = 0; s.cur.snap = 0; s.cur.bytes = 0;
  s.at = (i + 1) % s.size;
  if (s.n < s.size) s.n++;
}

// The most recent n entries of a ring, oldest first.
function recent(s, a, n) {
  const v = new Array(n);
  for (let k = 0; k < n; k++) v[k] = a[(s.at - n + k + s.size) % s.size];
  return v;
}

function spread(v) {
  const n = v.length;
  v.sort((x, y) => x - y);
  const at = q => v[Math.min(n - 1, Math.floor(q * n))];
  let sum = 0;
  for (const x of v) sum += x;
  const r = x => +x.toFixed(3);
  return { avg: r(sum / n), p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(v[n - 1]) };
}

// The window as /health reports it: the last `last` ticks, or all it holds.
export function summarise(s, hz, last = s.n) {
  const n = Math.max(0, Math.min(s.n, last | 0));
  if (!n) return { ticks: 0 };
  const out = { ticks: n };
  for (const f of ["late", "sim", "snap", "total"]) out[`${f}Ms`] = spread(recent(s, s[f], n));
  let bytes = 0;
  for (const b of recent(s, s.bytes, n)) bytes += b;
  out.bytesPerTick = Math.round(bytes / n);
  out.bytesPerSec = Math.round((bytes / n) * hz);
  out.gc = { count: s.gc.count, ms: +s.gc.ms.toFixed(1), maxMs: +s.gc.maxMs.toFixed(2) };
  return out;
}
