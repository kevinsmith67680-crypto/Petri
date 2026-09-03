// ---------------------------------------------------------------------------
// Wire protocol.
//
// Text frames carry control messages (join, welcome) — rare, and easier to
// debug as JSON. Binary frames carry gameplay — aim, actions, snapshots.
//
// SCOPING RULES. Deltas replace per-tick recomputation with per-client
// remembered state, which is where information leaks get introduced. The two
// rules that prevent that, both enforced in encodeSnapshot:
//
//   1. The known set is REPLACED by the current in-view set every tick, never
//      merely added to. A pellet that leaves your view is dropped from your
//      known set immediately, so driving in circles cannot accumulate a map
//      of the arena. Your effective view radius is exactly viewRadius(), the
//      same as it was before deltas existed.
//
//   2. Removals are derived from (known - inView), never from eat events. A
//      pellet eaten outside your view was never in your known set, so it
//      produces no message at all. And because "eaten in view" and "left my
//      view" travel as the same removal record, a client cannot tell them
//      apart — no "something is feeding over there" signal.
//
// Keyframes exist so a client can resynchronise. Over WebSocket delivery is
// reliable and ordered so they are belt-and-braces, but they are required if
// this ever moves to WebTransport datagrams, and they bound the damage from
// any bug in the delta path.
// ---------------------------------------------------------------------------

import { Reader, Writer, clampU16 } from "./codec.js";
import {
  radiusOf, totalMass, centroid, leaderboard, rankOf, WORLD, forEachPelletNear,
  PELLET_MASS
} from "./sim.js";

// Positions travel as u16, so the arena must fit. Guard it here rather than
// discovering the wrap-around as jitter in production.
if (WORLD > 65535) throw new RangeError("WORLD exceeds u16; widen the position fields");

export const MSG = {
  JOIN: "join",        // text
  WELCOME: "welcome",  // text
  AIM: 2,              // binary
  ACTION: 3,           // binary
  SNAPSHOT: 5          // binary
};

export const ACTIONS = ["split", "eject", "respawn"];

export const FLAG_KEYFRAME = 1 << 0;
export const FLAG_BOARD = 1 << 1;

// Round phases. Guests running the local simulation have no rounds and send
// PHASE_NONE, which the client reads as "hide the clock".
export const PHASE_NONE = 0;
export const PHASE_LIVE = 1;
export const PHASE_INTERMISSION = 2;
export const PHASE_LOBBY = 3;

const CELL_MINE = 1 << 0;
const CELL_COOLDOWN = 1 << 1;

export const KEYFRAME_TICKS = 100;  // 5s at 20Hz
export const BOARD_TICKS = 10;      // leaderboard at 2Hz; it changes slowly

// Byte costs per record, used by Reader.expect() to reject absurd counts.
const CELL_BYTES = 13;
const PELLET_BYTES = 10;
const REMOVE_BYTES = 4;
const VIRUS_BYTES = 4;

// ── client -> server ────────────────────────────────────────────────────────

export function encodeAim(dx, dy) {
  return new Writer(8).u8(MSG.AIM).i16(dx).i16(dy).bytes();
}

export function encodeAction(action) {
  const idx = ACTIONS.indexOf(action);
  if (idx < 0) return null;
  return new Writer(4).u8(MSG.ACTION).u8(idx).bytes();
}

// Throws on anything malformed. The server treats a throw as "close the
// socket" rather than trying to recover, because a client that cannot speak
// the protocol has nothing useful to say.
export function decodeClientMessage(buffer) {
  const r = new Reader(buffer);
  const type = r.u8();

  if (type === MSG.AIM) {
    const x = r.i16();
    const y = r.i16();
    r.end();
    return { type, x, y };
  }

  if (type === MSG.ACTION) {
    const idx = r.u8();
    r.end();
    const action = ACTIONS[idx];
    if (!action) throw new RangeError("unknown action");
    return { type, action };
  }

  throw new RangeError(`unknown message type ${type}`);
}

// ── server -> client ────────────────────────────────────────────────────────

export function viewRadius(player) {
  const mass = totalMass(player) || 1;
  return Math.max(760, radiusOf(mass) * 9);
}

// Per-connection delta state. Held by the server, never by the client, so a
// client cannot lie about what it already knows to widen its own view.
export function createClientState(stagger = 0) {
  return {
    knownPellets: new Set(),
    knownNames: new Set(),
    sinceKeyframe: stagger % KEYFRAME_TICKS,  // spread keyframes across clients
    sinceBoard: stagger % BOARD_TICKS
  };
}

// `eye` is whose viewpoint the snapshot is built from. Normally that is the
// player themselves; when spectating it is the player being watched. This has
// to exist because area-of-interest culling keys off the viewer's position,
// and a dead player has none — without an eye a spectator would be sent an
// empty arena.
export function encodeSnapshot(world, player, cs, round = null, eye = null) {
  const view = eye && eye.alive && eye.cells.length ? eye : player;
  const spectating = view !== player;
  const keyframe = cs.sinceKeyframe <= 0;
  if (keyframe) {
    // A keyframe restates everything, so forget what we thought they knew.
    cs.knownPellets.clear();
    cs.knownNames.clear();
    cs.sinceKeyframe = KEYFRAME_TICKS;
  }
  cs.sinceKeyframe--;

  const withBoard = cs.sinceBoard <= 0;
  if (withBoard) cs.sinceBoard = BOARD_TICKS;
  cs.sinceBoard--;

  const me = centroid(view);
  const R = viewRadius(view);
  const near = (x, y, pad = 0) => {
    const dx = x - me.x, dy = y - me.y;
    const reach = R + pad;
    return dx * dx + dy * dy < reach * reach;
  };

  // ── cells in view, plus any owner names this client has not been told ──
  const cells = [];
  const newNames = [];
  for (const p of world.players.values()) {
    if (!p.alive) continue;
    let visible = false;
    for (const c of p.cells) {
      if (!near(c.x, c.y, radiusOf(c.mass))) continue;
      visible = true;
      cells.push({ c, p });
    }
    if (visible && !cs.knownNames.has(p.nid)) {
      cs.knownNames.add(p.nid);
      newNames.push(p);
    }
  }

  // ── pellet delta, per the scoping rules at the top of this file ──
  const inView = new Set();
  const added = [];
  // Grid query rather than a full scan: with thousands of orbs in the arena,
  // walking the whole list once per client per tick is the single most
  // expensive thing the server does.
  forEachPelletNear(world, me.x, me.y, R, p => {
    if (p.dead || !near(p.x, p.y)) return;
    inView.add(p.id);
    if (!cs.knownPellets.has(p.id)) added.push(p);
  });
  const removed = [];
  for (const id of cs.knownPellets) {
    // Covers both "eaten while I was watching" and "scrolled out of my view".
    // Indistinguishable on the wire, deliberately.
    if (!inView.has(id)) removed.push(id);
  }
  // Replace, never merge. This is rule 1.
  cs.knownPellets = inView;

  const viruses = world.viruses.filter(v => near(v.x, v.y, 60));
  // While spectating, every figure describes the player being watched — that
  // is what a spectator wants to see, and the viewer's own stats are frozen.
  const rank = rankOf(world, view.id);
  const mass = totalMass(view);

  const w = new Writer(1024);
  w.u8(MSG.SNAPSHOT);
  w.u8((keyframe ? FLAG_KEYFRAME : 0) | (withBoard ? FLAG_BOARD : 0));
  w.u32(world.tick);
  w.f32(world.time);

  // me
  w.u8(view.alive ? 1 : 0);
  w.u32(view.orbs);
  w.u32(view.eaten);
  w.u32(Math.round(mass));
  w.u32(Math.round(view.peak));
  w.u16(Math.round(me.x));
  w.u16(Math.round(me.y));
  w.u8(Math.min(255, rank.rank));
  w.u8(Math.min(255, rank.of));

  // round: phase, seconds left, round number. Five bytes a tick is nothing
  // next to the cell list, and it saves a separate message type.
  w.u8(round ? round.phase : PHASE_NONE);
  w.u16(round ? Math.max(0, Math.round(round.remaining)) : 0);
  w.u16(round ? round.number : 0);

  // spectating flag plus whose eyes we are borrowing, so the client can name
  // them from the name table it already has.
  w.u8(spectating ? 1 : 0);
  w.u16(view.nid || 0);

  // names
  w.u16(newNames.length);
  for (const p of newNames) { w.u16(p.nid); w.str(p.name, 32); }

  // cells
  w.u16(cells.length);
  for (const { c, p } of cells) {
    w.u32(c.id);
    w.u16(Math.round(c.x));
    w.u16(Math.round(c.y));
    w.u16(clampU16(Math.round(c.mass)));
    w.u16(p.nid);
    w.u8(
      (p.id === view.id ? CELL_MINE : 0) |
      (p.id === view.id && world.time < c.mergeAt ? CELL_COOLDOWN : 0)
    );
  }

  // pellets added / removed
  w.u16(added.length);
  for (const p of added) {
    w.u32(p.id);
    w.u16(Math.round(p.x));
    w.u16(Math.round(p.y));
    w.u8(p.ci);
    // Compared against the orb mass itself, not a literal. The previous
    // magic 10 exactly equalled EJECT_KEEP, so ejected blobs failed their own
    // strictly-greater test and drew as ordinary orbs.
    w.u8(p.mass > PELLET_MASS ? 1 : 0);
  }
  w.u16(removed.length);
  for (const id of removed) w.u32(id);

  // viruses
  w.u16(viruses.length);
  for (const v of viruses) { w.u16(Math.round(v.x)); w.u16(Math.round(v.y)); }

  if (withBoard) {
    const board = leaderboard(world);
    w.u8(board.length);
    for (const row of board) {
      w.str(row.name, 32);
      w.u32(row.mass);
      w.u8(row.id === player.id ? 1 : 0);
    }
  }

  return w.bytes();
}

// Decoded into a plain object; the client folds it into its caches.
export function decodeSnapshot(buffer) {
  const r = new Reader(buffer);
  const type = r.u8();
  if (type !== MSG.SNAPSHOT) throw new RangeError(`expected snapshot, got ${type}`);

  const flags = r.u8();
  const tick = r.u32();
  const time = r.f32();
  if (!Number.isFinite(time)) throw new RangeError("bad time");

  const me = {
    alive: r.u8() === 1,
    orbs: r.u32(),
    eaten: r.u32(),
    mass: r.u32(),
    peak: r.u32(),
    x: r.u16(),
    y: r.u16(),
    rank: r.u8(),
    of: r.u8()
  };

  const round = { phase: r.u8(), remaining: r.u16(), number: r.u16() };
  const spectating = r.u8() === 1;
  const eyeNid = r.u16();

  const names = [];
  // Strings are variable length, so a per-record byte cost is not meaningful;
  // bound the count by the pessimistic minimum of 3 bytes each instead.
  const nameCount = r.expect(r.u16(), 3);
  for (let i = 0; i < nameCount; i++) names.push({ nid: r.u16(), name: r.str() });

  const cells = [];
  const cellCount = r.expect(r.u16(), CELL_BYTES);
  for (let i = 0; i < cellCount; i++) {
    const id = r.u32();
    const x = r.u16();
    const y = r.u16();
    const m = r.u16();
    const o = r.u16();
    const f = r.u8();
    cells.push({ i: id, x, y, m, o, s: f & CELL_COOLDOWN ? 1 : 0, mine: !!(f & CELL_MINE) });
  }

  const added = [];
  const addCount = r.expect(r.u16(), PELLET_BYTES);
  for (let i = 0; i < addCount; i++) {
    added.push({ id: r.u32(), x: r.u16(), y: r.u16(), ci: r.u8(), big: r.u8() });
  }

  const removed = [];
  const remCount = r.expect(r.u16(), REMOVE_BYTES);
  for (let i = 0; i < remCount; i++) removed.push(r.u32());

  const viruses = [];
  const virusCount = r.expect(r.u16(), VIRUS_BYTES);
  for (let i = 0; i < virusCount; i++) viruses.push([r.u16(), r.u16()]);

  let board = null;
  if (flags & FLAG_BOARD) {
    board = [];
    const n = r.expect(r.u8(), 6);
    for (let i = 0; i < n; i++) {
      board.push({ name: r.str(), mass: r.u32(), you: r.u8() === 1 });
    }
  }

  r.end();

  return {
    keyframe: !!(flags & FLAG_KEYFRAME),
    tick, time, me, round, spectating, eyeNid,
    names, cells, added, removed, viruses, board
  };
}
