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
import { TICK_HZ, advanceCell } from "../shared/sim.js";

// Other players are still rendered slightly in the past so their motion is
// smooth between ticks. 1.5 ticks rather than 2: enough of a buffer to absorb
// normal jitter, 25ms less lag than before.
const INTERP_MS = (1000 / TICK_HZ) * 1.5;

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

  // Locally predicted positions for our own cells, keyed by cell id. This is
  // what removes the round trip from the feel of the controls: we move now,
  // and reconcile against the server as its snapshots arrive.
  const predicted = new Map();

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: MSG.JOIN, name, stake, token }));
  });

  socket.addEventListener("message", ev => {
    // Text frames are control messages; binary frames are gameplay.
    if (typeof ev.data === "string") {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === MSG.WELCOME) {
        myNid = msg.nid;
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

    let snap;
    try {
      snap = decodeSnapshot(ev.data);
    } catch (err) {
      // Drop it whole. Never apply half a frame.
      if (++decodeErrors <= 3) console.warn("dropped malformed snapshot:", err.message);
      return;
    }

    applySnapshot(snap);
  });

  socket.addEventListener("close", () => emit("close"));
  socket.addEventListener("error", e => emit("error", e));

  function applySnapshot(snap) {
    const localNow = performance.now() / 1000;
    const offset = snap.time - localNow;
    // Track the smallest observed offset: that is the least-delayed packet.
    clockOffset = clockOffset === null ? offset : Math.min(clockOffset, offset);

    if (snap.keyframe) {
      pellets.clear();
      names.clear();
    }

    for (const n of snap.names) names.set(n.nid, n.name);

    for (const p of snap.added) {
      pellets.set(p.id, { x: p.x, y: p.y, ci: p.ci, big: !!p.big, gone: null });
    }
    for (const id of snap.removed) {
      const p = pellets.get(id);
      if (p) p.gone = snap.time;   // tombstone, not delete
    }
    // Purge tombstones the render clock has already passed.
    for (const [id, p] of pellets) {
      if (p.gone !== null && p.gone < snap.time - TOMBSTONE_SEC) pellets.delete(id);
    }

    if (snap.board) board = snap.board;

    frames.push(snap);
    while (frames.length > 20) frames.shift();
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

    for (const [id, c] of authoritative) {
      let p = predicted.get(id);
      if (!p) {
        predicted.set(id, { x: c.x, y: c.y, mass: c.m, vx: 0, vy: 0 });
        continue;
      }
      p.mass = c.m;

      const ghost = { x: c.x, y: c.y, mass: c.m, vx: 0, vy: 0 };
      if (age > 0) advanceCell(ghost, atx, aty, age);

      const ex = ghost.x - p.x, ey = ghost.y - p.y;
      if (Math.hypot(ex, ey) > SNAP_ERROR) {
        // Not a wrong guess but stale state: a split, a virus pop, a respawn.
        p.x = ghost.x; p.y = ghost.y; p.vx = 0; p.vy = 0;
      } else {
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

    for (const p of predicted.values()) advanceCell(p, tx, ty, dt);
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
      if (frame) socket.send(frame);
    },

    update(dt) {
      const now = performance.now();
      if (now - lastAimSent >= 1000 / AIM_HZ && socket.readyState === WebSocket.OPEN) {
        lastAimSent = now;
        socket.send(encodeAim(Math.round(pendingAim.x), Math.round(pendingAim.y)));
      }
      if (dt) predict(dt);
    },

    getView() {
      if (clockOffset === null) return null;
      const renderTime = performance.now() / 1000 + clockOffset - INTERP_MS / 1000;
      const snap = interpolate(renderTime);
      if (!snap) return null;

      // Render-time visibility: a tombstoned pellet is still drawn until the
      // render clock reaches the moment it actually died.
      const visible = [];
      for (const p of pellets.values()) {
        if (p.gone !== null && p.gone <= renderTime) continue;
        visible.push([p.x, p.y, p.ci, p.big ? 1 : 0]);
      }

      // Our own cells come from prediction; everyone else from interpolation.
      const cells = snap.cells.map(c => {
        const p = c.mine ? predicted.get(c.i) : null;
        return p
          ? { ...c, x: p.x, y: p.y, m: p.mass, n: names.get(c.o) || "" }
          : { ...c, n: names.get(c.o) || "" };
      });

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
