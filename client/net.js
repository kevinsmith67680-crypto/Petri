// ---------------------------------------------------------------------------
// Network connection.
//
// The client never simulates. It sends an aim vector plus discrete actions,
// and renders what the server tells it.
//
// Pellets now arrive as deltas, so this file keeps a cache and folds each
// snapshot into it. Two details matter:
//
//   * Removed pellets are TOMBSTONED rather than deleted. Because we render
//     ~100ms behind the server, deleting immediately would make an orb vanish
//     from under your cell before you visually reached it.
//   * A keyframe clears the cache before applying its contents, so a bug in
//     the delta path self-corrects within 5 seconds instead of persisting.
//
// A malformed frame throws out of decodeSnapshot and is dropped. It is never
// partially applied.
// ---------------------------------------------------------------------------

import {
  MSG, decodeSnapshot, encodeAim, encodeAction, KEYFRAME_TICKS
} from "../shared/protocol.js";
import {
  TICK_HZ, advanceCell, advancePellet, radiusOf, splitLaunchSpeed,
  EJECT_MASS, EJECT_KEEP, MAX_CELLS, PELLET_MASS, ORB_RADIUS,
  EJECT_SPEED, EJECT_OWNER_COOLDOWN
} from "../shared/sim.js";

// Other players are rendered slightly in the past so their motion is smooth
// between ticks. Expressed in TICKS, not milliseconds, because the server's
// rate is announced in the welcome — at 30Hz the same buffer is 50ms.
//
// ADAPTIVE. A fixed 1.5 ticks spends 75ms of lag insuring against jitter that
// a good connection does not have. The buffer only needs to cover the spread
// in arrival times, so it tracks measured jitter and sits near the floor on a
// steady link, widening only when packets actually arrive unevenly.
const INTERP_MIN = 1.2;   // a hair over one tick: one late packet no longer stalls
const INTERP_MAX = 2.5;

// Aim is 5 bytes. Sending it faster than the tick is not wasted — it means
// the server acts on a fresher vector the moment its tick comes round, which
// removes up to half a tick of input lag for 50 bytes a second.
const AIM_HZ = 30;

const TOMBSTONE_SEC = 1.0;                 // keep eaten pellets this long past death

// How hard a wrong prediction is pulled back toward the server. Too low and
// the client drifts; too high and every correction is a visible twitch.
const CORRECT_PER_SEC = 6;

// Past this the client is not wrong, it is out of date — a split, a virus
// pop, or a teleport after respawn. Snap rather than slide across the arena.
const SNAP_ERROR = 220;

export function createSocketConnection({ url, name = "You", stake = 0, token = null } = {}) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  const listeners = { event: [], welcome: [], close: [], error: [], account: [], round: [] };
  const emit = (kind, payload) => listeners[kind].forEach(fn => fn(payload));

  const frames = [];              // recent snapshots for interpolation
  const pellets = new Map();      // id -> { x, y, ci, big, gone }
  const names = new Map();        // nid -> display name
  let board = [];
  let clockOffset = null;
  let lastAimSent = 0;
  const pendingAim = { x: 0, y: 0 };
  let myNid = null;
  let decodeErrors = 0;
  let serverHz = TICK_HZ;          // corrected by the welcome message

  // Diagnostics. "Feels laggy" is three different problems wearing the same
  // coat — a slow client, a slow server, or a slow network — and they need
  // different fixes, so each is measured separately.
  const diag = { ping: 0, jitter: 0, fps: 0, buffered: 0, srvMs: -1, snaps: 0, snapsPerSec: -1, snapWindow: 0 };
  let lastPingAt = 0;
  let lastArrival = 0;

  // Locally predicted positions for our own cells, keyed by cell id. This is
  // what removes the round trip from the feel of the controls: we move now,
  // and reconcile against the server as its snapshots arrive.
  const predicted = new Map();

  // Locally predicted results of a split or an eject, shown the instant the
  // key goes down. Without these the piece or the blob appears a full round
  // trip after the press — 80 to 200ms on a real link — which is most of why
  // the moves felt unnatural. They are provisional: dropped when the server's
  // real cells arrive, or after a short deadline if it never confirms.
  const ghostCells = [];      // { x, y, mass, vx, vy, age }
  const ghostBlobs = [];      // { x, y, vx, vy, age, ci }
  const GHOST_TTL = 0.45;     // seconds before an unconfirmed ghost is dropped

  // Orbs the predicted cell has swallowed but the server has not yet
  // confirmed. Hidden immediately; restored if the server disagrees. Without
  // this an eaten orb sat inside the cell for ~190ms on a normal link — the
  // one thing the client did not predict, and the most visible.
  const EAT_TTL = 0.8;
  let authoritativeCount = 0; // cells the server last said were ours

  // Arena size for this room, learned from the first snapshot. Prediction has
  // to clamp to the same bounds the server does or cells drift through walls.
  let worldSize = 0;

  // How far behind the server to render, in seconds. One tick of buffer plus
  // however much the arrivals are actually spreading.
  function interpSeconds() {
    const tickMs = 1000 / serverHz;
    const ticks = Math.min(INTERP_MAX, Math.max(INTERP_MIN, 1 + diag.jitter / tickMs));
    return (ticks * tickMs) / 1000;
  }
  // Derived from the tick rate, and re-derived when the server announces its
  // own. Referred to the old INTERP_MS name until an integration test caught
  // it: every online connection threw here, which left the client silently on
  // its guest connection.

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: MSG.JOIN, name, stake, token }));
  });

  socket.addEventListener("message", ev => {
    // Text frames are control messages; binary frames are gameplay.
    if (typeof ev.data === "string") {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "pong") {
        const rtt = performance.now() - msg.t;
        // Smoothed: a single sample bounces enough to be unreadable.
        diag.ping = diag.ping ? diag.ping * 0.7 + rtt * 0.3 : rtt;
        if (typeof msg.srvMs === "number") diag.srvMs = msg.srvMs;
        if (msg.hz) serverHz = msg.hz;
        return;
      }
      if (msg.type === MSG.WELCOME) {
        myNid = msg.nid;
        if (msg.tickHz) serverHz = msg.tickHz;
        emit("welcome", msg);
        emit("account", msg);
      } else if (msg.type === "account" || msg.type === "account_error" ||
                 msg.type === "ramp_result") {
        emit("account", msg);
      } else if (msg.type === "round_end" || msg.type === "round_start" ||
                 msg.type === "lobby") {
        emit("round", msg);
      }
      return;
    }

    // Decode AND apply inside the guard. applySnapshot used to sit outside it,
    // so a fault there escaped into the socket event handler and quietly froze
    // every later frame — the client kept rendering its first snapshot for
    // ever, which looks exactly like having no control.
    try {
      applySnapshot(decodeSnapshot(ev.data));
    } catch (err) {
      if (++decodeErrors <= 3) console.warn("dropped snapshot:", err.message);
    }
  });

  socket.addEventListener("close", () => emit("close"));
  socket.addEventListener("error", e => emit("error", e));

  function applySnapshot(snap) {
    const localNow = performance.now() / 1000;
    // Snapshots received per second. If this sits well below the server's
    // tick rate the server is overrunning its budget — that is a starved
    // instance, not a client or network problem.
    diag.snaps++;
    if (localNow - diag.snapWindow >= 1) {
      diag.snapsPerSec = Math.round(diag.snaps / Math.max(0.001, localNow - diag.snapWindow));
      diag.snaps = 0;
      diag.snapWindow = localNow;
    }
    const offset = snap.time - localNow;
    // Least-delayed packet in the RECENT window, not of all time. An all-time
    // minimum is sticky: one unusually fast early packet, or a server clock
    // that drifts, leaves renderTime pinned seconds behind — and then every
    // removal, tombstone and other player renders seconds late with it.
    snap._offset = offset;
    let best = offset;
    for (const f of frames) if (f._offset !== undefined && f._offset < best) best = f._offset;
    clockOffset = best;

    if (snap.world) worldSize = snap.world;

    if (snap.keyframe) {
      pellets.clear();
      names.clear();
    }

    for (const n of snap.names) names.set(n.nid, n.name);

    // Hand over only when the real blob arrives, and drop the oldest ghost
    // per real blob rather than all of them — two quick ejects would
    // otherwise lose the second one.
    for (const p of snap.added) {
      if (p.big && p.mine && ghostBlobs.length) ghostBlobs.shift();
    }
    for (const p of snap.added) {
      pellets.set(p.id, {
        x: p.x, y: p.y, ci: p.ci,
        big: !!p.big, mine: !!p.mine,
        vx: p.vx || 0, vy: p.vy || 0,
        gone: null,
        age: 0            // seconds since it entered view, for the immunity rule
      });
    }
    for (const id of snap.removed) {
      const p = pellets.get(id);
      if (!p) continue;
      // Already hidden by prediction: drop it outright, there is nothing left
      // for the tombstone's render-time fade to do.
      if (p.eatenAt !== undefined) { pellets.delete(id); continue; }
      p.gone = snap.time;          // tombstone, not delete
    }
    // Purge tombstones the render clock has already passed.
    for (const [id, p] of pellets) {
      if (p.gone !== null && p.gone < snap.time - TOMBSTONE_SEC) pellets.delete(id);
    }

    if (snap.board) board = snap.board;

    // Arrival spacing tells us how erratic the feed is, which is what the
    // interpolation buffer exists to absorb.
    const arrivedAt = performance.now();
    if (lastArrival) {
      const gap = Math.abs(arrivedAt - lastArrival - 1000 / serverHz);
      diag.jitter = diag.jitter * 0.8 + gap * 0.2;
    }
    lastArrival = arrivedAt;

    frames.push(snap);
    while (frames.length > 20) frames.shift();
    diag.buffered = frames.length;
  }

  const lerp = (a, b, k) => a + (b - a) * k;

  // Reconcile against the NEWEST snapshot, not the interpolated one. Our own
  // cells should track the freshest truth the server has sent; only other
  // players are worth rendering in the past.
  function predict(dt) {
    const newest = frames[frames.length - 1];
    if (!newest) return;

    // Spectating means `mine` marks somebody else's cells. Predicting those
    // from our aim would send them wandering off on their own.
    if (newest.spectating) { predicted.clear(); return; }

    const authoritative = new Map();
    for (const c of newest.cells) if (c.mine) authoritative.set(c.i, c);

    for (const id of [...predicted.keys()]) {
      if (!authoritative.has(id)) predicted.delete(id);
    }

    // A snapshot describes where we were when it was sent, not where we are.
    // Correcting straight onto it would drag the cell back by the flight
    // time and undo the prediction. So the server position is first replayed
    // forward by the packet's age, and we correct onto THAT. Halves the
    // steady-state error in testing.
    const age = clockOffset === null
      ? 0
      : Math.max(0, Math.min(0.5, performance.now() / 1000 + clockOffset - newest.time));

    let ax = 0, ay = 0, am = 0;
    for (const c of authoritative.values()) { ax += c.x * c.m; ay += c.y * c.m; am += c.m; }
    const atx = (am ? ax / am : 0) + pendingAim.x;
    const aty = (am ? ay / am : 0) + pendingAim.y;

    // New server cells mean a split or burst was confirmed: the ghosts have
    // done their job.
    if (authoritative.size > authoritativeCount) ghostCells.length = 0;
    authoritativeCount = authoritative.size;

    for (const [id, c] of authoritative) {
      let p = predicted.get(id);
      if (!p) {
        predicted.set(id, { x: c.x, y: c.y, mass: c.m, vx: 0, vy: 0 });
        continue;
      }
      // Mass is smoothed rather than stepped. Every orb eaten arrives as a
      // jump in radius at the tick rate, and because speed depends on mass
      // the movement jerked with it — visible as a faint 20Hz stutter.
      p.mass += (c.m - p.mass) * Math.min(1, dt * 12);

      const ghost = { x: c.x, y: c.y, mass: c.m, vx: 0, vy: 0 };
      if (age > 0) advanceCell(ghost, atx, aty, age, worldSize);

      const ex = ghost.x - p.x, ey = ghost.y - p.y;
      const err = Math.hypot(ex, ey);
      if (err > SNAP_ERROR) {
        // Not a wrong guess but stale state: a split, a virus pop, a respawn.
        p.x = ghost.x; p.y = ghost.y; p.vx = 0; p.vy = 0;
      } else if (err > 1.5) {
        // Dead zone: positions travel as whole units, so a sub-unit error is
        // quantisation noise, and correcting toward it wobbles the cell.
        const k = Math.min(1, dt * CORRECT_PER_SEC);
        p.x += ex * k;
        p.y += ey * k;
      }
    }

    if (!predicted.size) return;

    // Aim is an offset from our own centroid, exactly as the server reads it.
    let sx = 0, sy = 0, sm = 0;
    for (const p of predicted.values()) { sx += p.x * p.mass; sy += p.y * p.mass; sm += p.mass; }
    const cx = sm ? sx / sm : 0, cy = sm ? sy / sm : 0;
    const tx = cx + pendingAim.x, ty = cy + pendingAim.y;

    for (const p of predicted.values()) advanceCell(p, tx, ty, dt, worldSize);

    // Same test the server uses, so the client rarely guesses wrong.
    for (const cell of predicted.values()) {
      const r = radiusOf(cell.mass);
      const reach = r + ORB_RADIUS * 0.6;
      const reach2 = reach * reach;
      for (const o of pellets.values()) {
        if (o.gone !== null || o.eatenAt !== undefined) continue;
        // Your own thrown mass is off limits until the cooldown expires. The
        // margin covers the trip: it is already part-way through by the time
        // we hear about it, and guessing early would hide an orb the server
        // still has.
        if (o.mine && o.age < EJECT_OWNER_COOLDOWN + 0.3) continue;
        // Nothing receding can have been swallowed, whoever threw it.
        if (o.vx || o.vy) {
          if ((o.x - cell.x) * o.vx + (o.y - cell.y) * o.vy > 0) continue;
        }
        const dx = o.x - cell.x; if (dx > reach || dx < -reach) continue;
        const dy = o.y - cell.y; if (dy > reach || dy < -reach) continue;
        if (dx * dx + dy * dy < reach2) {
          o.eatenAt = 0;                       // age counter, in simulated seconds
          cell.mass += o.big ? EJECT_KEEP : PELLET_MASS;
        }
      }
    }
    // A locally eaten orb the server never removed was a wrong guess: bring
    // it back rather than leaving a hole in the field. But only once we have
    // actually moved off it — restoring an orb the cell is still sitting on
    // makes it blink, and the next frame eats it again.
    for (const o of pellets.values()) {
      o.age += dt;
      if (o.eatenAt === undefined) continue;
      o.eatenAt += dt;
      if (o.eatenAt <= EAT_TTL) continue;
      let covered = false;
      for (const cell of predicted.values()) {
        const reach = radiusOf(cell.mass) + ORB_RADIUS * 0.6;
        const dx = o.x - cell.x, dy = o.y - cell.y;
        if (dx * dx + dy * dy < reach * reach) { covered = true; break; }
      }
      if (covered) o.eatenAt = EAT_TTL;     // hold, re-check next frame
      else o.eatenAt = undefined;           // genuinely a wrong guess
    }

    for (let i = ghostCells.length - 1; i >= 0; i--) {
      const g = ghostCells[i];
      if ((g.age += dt) > GHOST_TTL) { ghostCells.splice(i, 1); continue; }
      advanceCell(g, tx, ty, dt, worldSize);
    }
    for (let i = ghostBlobs.length - 1; i >= 0; i--) {
      const g = ghostBlobs[i];
      if ((g.age += dt) > GHOST_TTL) { ghostBlobs.splice(i, 1); continue; }
      advancePellet(g, dt, worldSize);
    }
  }

  // Mirror what the server will do so the response is on screen this frame.
  // The server remains the authority: if it disagrees, its version replaces
  // these within one snapshot.
  function predictSplit() {
    let room = MAX_CELLS - predicted.size - ghostCells.length;
    const ready = [...predicted.values()].filter(p => p.mass >= 36).sort((a, b) => b.mass - a.mass);
    let cx = 0, cy = 0, cm = 0;
    for (const p of predicted.values()) { cx += p.x * p.mass; cy += p.y * p.mass; cm += p.mass; }
    const tx = (cm ? cx / cm : 0) + pendingAim.x, ty = (cm ? cy / cm : 0) + pendingAim.y;
    for (const p of ready) {
      if (room-- <= 0) break;
      const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy) || 1;
      const half = p.mass / 2;
      p.mass -= half;
      const speed = splitLaunchSpeed(half);
      ghostCells.push({
        x: p.x + (dx / d) * radiusOf(p.mass) * 0.4,
        y: p.y + (dy / d) * radiusOf(p.mass) * 0.4,
        mass: half, vx: (dx / d) * speed, vy: (dy / d) * speed, age: 0
      });
    }
  }

  function predictEject(ci) {
    let cx = 0, cy = 0, cm = 0;
    for (const p of predicted.values()) { cx += p.x * p.mass; cy += p.y * p.mass; cm += p.mass; }
    const tx = (cm ? cx / cm : 0) + pendingAim.x, ty = (cm ? cy / cm : 0) + pendingAim.y;
    for (const p of predicted.values()) {
      if (p.mass < EJECT_MASS * 2) continue;
      const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy) || 1;
      p.mass -= EJECT_MASS;
      const gap = radiusOf(p.mass) + radiusOf(EJECT_KEEP) * 0.35;
      ghostBlobs.push({
        x: p.x + (dx / d) * gap, y: p.y + (dy / d) * gap,
        vx: (dx / d) * EJECT_SPEED, vy: (dy / d) * EJECT_SPEED, age: 0, ci
      });
    }
  }

  // Blend the two frames straddling the render time. Cells are matched by id;
  // anything that appears or vanishes between them is taken as-is, since cells
  // are eaten instantly rather than fading.
  function interpolate(renderTime) {
    if (!frames.length) return null;
    if (frames.length === 1) return frames[0];

    let older = frames[0], newer = frames[frames.length - 1];
    for (let i = 0; i < frames.length - 1; i++) {
      if (frames[i].time <= renderTime && frames[i + 1].time >= renderTime) {
        older = frames[i];
        newer = frames[i + 1];
        break;
      }
    }
    if (renderTime >= newer.time) return newer;

    const span = newer.time - older.time;
    const k = span > 0 ? (renderTime - older.time) / span : 0;
    const prev = new Map(older.cells.map(c => [c.i, c]));

    const cells = newer.cells.map(c => {
      const p = prev.get(c.i);
      if (!p) return c;
      return { ...c, x: lerp(p.x, c.x, k), y: lerp(p.y, c.y, k), m: lerp(p.m, c.m, k) };
    });

    return { ...newer, cells };
  }

  return {
    mode: "online",
    get ready() { return socket.readyState === WebSocket.OPEN && frames.length > 0; },
    get id() { return myNid; },

    on(kind, fn) { listeners[kind]?.push(fn); },

    sendAim(dx, dy) { pendingAim.x = dx; pendingAim.y = dy; },

    sendAction(action) {
      if (socket.readyState !== WebSocket.OPEN) return;
      const frame = encodeAction(action);
      if (!frame) return;
      socket.send(frame);
      // Show it now; the server's version supersedes it on arrival.
      if (action === "split") predictSplit();
      else if (action === "eject") predictEject(-1);
    },

    update(dt) {
      const now = performance.now();
      if (now - lastAimSent >= 1000 / AIM_HZ && socket.readyState === WebSocket.OPEN) {
        lastAimSent = now;
        socket.send(encodeAim(Math.round(pendingAim.x), Math.round(pendingAim.y)));
      }
      if (dt) {
        // Thrown mass is sent once, with its velocity, and never re-sent —
        // so the client has to carry it forward itself. This loop went
        // missing in an edit and every blob sat frozen at its launch point
        // while the server moved it, which is what made ejecting look broken.
        // Advanced BEFORE prediction, so the eat test sees where it really is.
        for (const p of pellets.values()) {
          if (p.vx || p.vy) advancePellet(p, dt, worldSize);
        }
        predict(dt);
        diag.fps = diag.fps ? diag.fps * 0.9 + (1 / dt) * 0.1 : 1 / dt;
      }

      if (now - lastPingAt > 2000 && socket.readyState === WebSocket.OPEN) {
        lastPingAt = now;
        socket.send(JSON.stringify({ type: "ping", t: now }));
      }
    },

    // A method, not a getter: main.js calls conn.stats(). The two disagreed,
    // which would have thrown the moment the performance overlay was opened.
    stats() {
      return {
        ping: diag.ping ? Math.round(diag.ping) : -1,
        srvMs: diag.srvMs,
        hz: serverHz,
        budgetMs: serverHz ? +(1000 / serverHz).toFixed(1) : 0,
        jitter: Math.round(diag.jitter),
        interpMs: Math.round(interpSeconds() * 1000),
        snapsPerSec: diag.snapsPerSec,
        buffered: diag.buffered
      };
    },

    getView() {
      if (clockOffset === null) return null;
      const renderTime =
        performance.now() / 1000 + clockOffset - interpSeconds();
      const snap = interpolate(renderTime);
      if (!snap) return null;

      // Render-time visibility: a tombstoned pellet is still drawn until the
      // render clock reaches the moment it actually died.
      const visible = [];
      for (const p of pellets.values()) {
        if (p.gone !== null && p.gone <= renderTime) continue;
        if (p.eatenAt !== undefined) continue;   // predicted eaten
        visible.push([p.x, p.y, p.ci, p.big ? 1 : 0, p.mine ? 1 : 0]);
      }
      for (const g of ghostBlobs) visible.push([g.x, g.y, 0, 1, 1]);

      // Our own cells come from prediction; everyone else from interpolation.
      const cells = snap.cells.map(c => {
        const p = c.mine ? predicted.get(c.i) : null;
        return p
          ? { ...c, x: p.x, y: p.y, m: p.mass, n: names.get(c.o) || "" }
          : { ...c, n: names.get(c.o) || "" };
      });
      // Provisional split pieces, drawn as ours until the server confirms.
      for (let i = 0; i < ghostCells.length; i++) {
        const g = ghostCells[i];
        cells.push({ i: -1 - i, x: g.x, y: g.y, m: g.mass, o: myNid, mine: true, s: 1, n: "" });
      }

      // The camera must follow the predicted centroid, not the server's. This
      // is the single biggest part of the feel: a camera lagging behind your
      // input makes everything else seem sluggish too.
      let mx = snap.me.x, my = snap.me.y;
      if (predicted.size && !snap.spectating) {
        let sx = 0, sy = 0, sm = 0;
        for (const p of predicted.values()) { sx += p.x * p.mass; sy += p.y * p.mass; sm += p.mass; }
        if (sm) { mx = sx / sm; my = sy / sm; }
      }

      return {
        time: snap.time,
        world: snap.world || worldSize,
        cells,
        pellets: visible,
        viruses: snap.viruses,
        me: { ...snap.me, x: mx, y: my, id: snap.spectating ? snap.eyeNid : myNid },
        round: snap.round,
        spectating: snap.spectating,
        // Resolved from the name cache the snapshot already maintains.
        eyeName: snap.spectating ? (names.get(snap.eyeNid) || "") : "",
        board: board.map((r, i) => ({ id: r.you ? myNid : `x${i}`, name: r.name, mass: r.mass }))
      };
    },

    // Money actions travel as text frames: they are rare, and keeping them off
    // the 20Hz binary path means the hot loop stays 5 bytes per message.
    sendSpectate(dir) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "spectate", dir }));
      }
    },

    sendReady(ready) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ready", ready }));
      }
    },

    sendRename() {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "rename" }));
      }
    },

    sendRamp(action) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ramp", action }));
      }
    },

    close() { socket.close(); }
  };
}
