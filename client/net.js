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
import { TICK_HZ } from "../shared/sim.js";

const INTERP_MS = (1000 / TICK_HZ) * 2;   // render ~100ms behind the server
const AIM_HZ = 20;                         // no point sending faster than the tick
const TOMBSTONE_SEC = 1.0;                 // keep eaten pellets this long past death

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

    update() {
      const now = performance.now();
      if (now - lastAimSent >= 1000 / AIM_HZ && socket.readyState === WebSocket.OPEN) {
        lastAimSent = now;
        socket.send(encodeAim(Math.round(pendingAim.x), Math.round(pendingAim.y)));
      }
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

      return {
        time: snap.time,
        cells: snap.cells.map(c => ({ ...c, n: names.get(c.o) || "" })),
        pellets: visible,
        viruses: snap.viruses,
        me: { ...snap.me, id: snap.spectating ? snap.eyeNid : myNid },
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
