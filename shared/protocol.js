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
  radiusOf, totalMass, centroid, leaderboard, rankOf, MAX_WORLD, forEachPelletNear,
  PELLET_MASS, zoneBounds
} from "./sim.js";

// Positions travel as u16. createWorld enforces the same bound at construction
// so an oversized arena fails loudly rather than wrapping around as jitter.
export const WORLD_LIMIT = MAX_WORLD;

// Bump this whenever the binary layout changes: a new field in the snapshot
// header, a different pellet record, anything. The client sends it on join and
// the server refuses a mismatch, so a stale client gets told to reload instead
// of silently decoding every frame two bytes out of alignment — which looks
// like opponents scattered across the map and orbs that never appear.
//
// 10: the join presents a match ticket instead of a session token and stake.
// A page from before that would be refused every ticket and retry until it
// gave up; told its version is stale, it asks the player to reload instead.
// 11: the closing zone, behind FLAG_ZONE after the round block.
//
// 12: input acknowledgement and own-cell motion, for reconciliation. Aims and
// actions carry a sequence number; the snapshot says which one its tick used
// and how long before the tick it arrived, and carries the launch velocity and
// steering state of the viewer's own cells. Time is an f64 (see the header).
export const PROTOCOL_VERSION = 12;

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
export const FLAG_ZONE = 1 << 2;

// The closing zone, as the snapshot reports it. Nothing at all is sent before
// it is announced, so nobody learns where the safe square is early.
export const ZONE_WARNING = 1;    // announced; the edges have not moved yet
export const ZONE_CLOSING = 2;    // the edges are moving in
export const ZONE_CLOSED = 3;     // at the final square until the whistle

// Round phases. Guests running the local simulation have no rounds and send
// PHASE_NONE, which the client reads as "hide the clock".
export const PHASE_NONE = 0;
export const PHASE_LIVE = 1;
export const PHASE_INTERMISSION = 2;
export const PHASE_LOBBY = 3;
// The lobby is full and the round is a few seconds out. Its own phase rather
// than a flag on the lobby, so the count reaches the client on the snapshot
// clock every other timer already rides on.
export const PHASE_COUNTDOWN = 4;

const CELL_MINE = 1 << 0;
const CELL_COOLDOWN = 1 << 1;

// Pellet flags. Velocity is only carried when there is any, so a static orb
// still costs the same bytes it always did.
const PELLET_BIG = 1 << 0;
const PELLET_MINE = 1 << 1;
const PELLET_MOVING = 1 << 2;

export const KEYFRAME_TICKS = 100;  // 5s at 20Hz
export const BOARD_TICKS = 10;      // leaderboard at 2Hz; it changes slowly

// The viewer's own cells also carry their motion state, which is what lets the
// client replay its unacknowledged input from the server's position instead of
// guessing. Heading components are in [-1, 1]; speed is units per second.
const STEER_SCALE = 32767;
const SPEED_SCALE = 16;
const NO_STEER = 0xffff;   // speed sentinel: the cell has not been steered yet

// Byte costs per record, used by Reader.expect() to reject absurd counts.
// A cell is 13 bytes, or 23 with motion; the smaller is the safe lower bound.
const CELL_BYTES = 13;
const PELLET_BYTES = 10;
const REMOVE_BYTES = 4;
const VIRUS_BYTES = 7;

// The zone as the client needs it: what stage it is at, the whole seconds
// left in that stage, the safe area now and the square it is closing to.
function zoneView(world) {
  const z = world.zone;
  if (!z || world.time < z.warnAt) return null;
  const t = world.time;
  const state = t < z.startAt ? ZONE_WARNING : t < z.endAt ? ZONE_CLOSING : ZONE_CLOSED;
  const secs = state === ZONE_WARNING ? z.startAt - t : state === ZONE_CLOSING ? z.endAt - t : 0;
  return { state, secs: Math.min(255, Math.ceil(secs)), now: zoneBounds(z, t), to: z.to };
}

const writeBox = (w, b) => {
  w.u16(clampU16(Math.round(b.x0))); w.u16(clampU16(Math.round(b.y0)));
  w.u16(clampU16(Math.round(b.x1))); w.u16(clampU16(Math.round(b.y1)));
};
const readBox = r => ({ x0: r.u16(), y0: r.u16(), x1: r.u16(), y1: r.u16() });

// ── client -> server ────────────────────────────────────────────────────────

// `seq` numbers each aim so the snapshot can say which one the server has
// acted on. 16 bits wrap after half an hour at 30Hz; the client only ever
// looks a second or so back, and 0 is reserved for "none yet".
export function encodeAim(dx, dy, seq = 0) {
  return new Writer(8).u8(MSG.AIM).i16(dx).i16(dy).u16(seq).bytes();
}

// An action carries the aim it was made with, numbered like any other aim.
// Splits go where that aim points, not wherever the last aim sent at 30Hz
// happened to, and the action is acknowledged in the same breath as the aim:
// once a snapshot has acted on the number, it has acted on the action. Sent
// separately, a tick could fall between the two and the client would drop the
// pieces it was showing before the server's arrived.
export function encodeAction(action, dx = 0, dy = 0, seq = 0) {
  const idx = ACTIONS.indexOf(action);
  if (idx < 0) return null;
  return new Writer(8).u8(MSG.ACTION).u8(idx).i16(dx).i16(dy).u16(seq).bytes();
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
    const seq = r.u16();
    r.end();
    return { type, x, y, seq };
  }

  if (type === MSG.ACTION) {
    const idx = r.u8();
    const x = r.i16();
    const y = r.i16();
    const seq = r.u16();
    r.end();
    const action = ACTIONS[idx];
    if (!action) throw new RangeError("unknown action");
    return { type, action, x, y, seq };
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
//
// `tickAt` is when this tick was stepped, on the same millisecond clock the
// server stamped `player.inputAt` with when the aim arrived. The difference is
// what lets the client place this snapshot on its own timeline without knowing
// its ping. Omitted, the snapshot acknowledges nothing and the client falls
// back to correcting onto the server's position as it stands.
export function encodeSnapshot(world, player, cs, round = null, eye = null, tickAt = null) {
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
  // The same for everyone in the room, so it is public, not scoped to a view.
  const zone = zoneView(world);

  const w = new Writer(1024);
  w.u8(MSG.SNAPSHOT);
  w.u8((keyframe ? FLAG_KEYFRAME : 0) | (withBoard ? FLAG_BOARD : 0) | (zone ? FLAG_ZONE : 0));
  w.u32(world.tick);
  // An f64, not an f32. world.time counts from the room's creation and a room
  // lives as long as the process, so an f32 lost precision with uptime: a 16ms
  // step after two days and 62ms after a week, longer than a tick. The client
  // interpolates other players on this clock, so they got steadily jerkier the
  // longer the server had been up.
  w.f64(world.time);
  // Rooms differ in size, so the client is told rather than assuming.
  w.u16(world.size);

  // Which aim this tick acted on, and how long before the tick it arrived.
  // Always the viewer's own, even while spectating someone else.
  const acked = tickAt !== null && player.inputSeq ? player.inputSeq : 0;
  w.u16(acked);
  w.u16(acked ? clampU16(Math.round(tickAt - player.inputAt)) : 0);

  // me. Alive is 1; dead is 0, or 2 when the closing zone drained them, so
  // the death card can say which on the same frame that shows the death.
  w.u8(view.alive ? 1 : view.zoned ? 2 : 0);
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

  // zone: 18 bytes, and only in the last stretch of a round.
  if (zone) {
    w.u8(zone.state);
    w.u8(zone.secs);
    writeBox(w, zone.now);
    writeBox(w, zone.to);
  }

  // spectating flag plus whose eyes we are borrowing, so the client can name
  // them from the name table it already has.
  w.u8(spectating ? 1 : 0);
  w.u16(view.nid || 0);

  // names, each with the owner's colour. The colour rides here rather than on
  // every cell record because it belongs to the player, not the cell: it is
  // sent once when the player comes into view, the same as the name. Without
  // it the client had no colour for anyone but itself.
  w.u16(newNames.length);
  for (const p of newNames) { w.u16(p.nid); w.str(p.name, 32); w.u8(p.ci); }

  // cells
  w.u16(cells.length);
  for (const { c, p } of cells) {
    const mine = p.id === view.id;
    w.u32(c.id);
    w.u16(Math.round(c.x));
    w.u16(Math.round(c.y));
    w.u16(clampU16(Math.round(c.mass)));
    w.u16(p.nid);
    w.u8(
      (mine ? CELL_MINE : 0) |
      (mine && world.time < c.mergeAt ? CELL_COOLDOWN : 0)
    );
    if (mine) {
      // Launch velocity from a split or a burst. Without it a confirmed split
      // piece was predicted as standing still while the server flew it, and
      // was dragged along behind until the correction caught up.
      w.i16(Math.round(c.vx || 0));
      w.i16(Math.round(c.vy || 0));
      // Steering state, so a replay resumes the turn the cell is part-way
      // through rather than snapping to the new heading.
      const steered = c.sp !== undefined;
      w.i16(steered ? Math.round(c.hx * STEER_SCALE) : 0);
      w.i16(steered ? Math.round(c.hy * STEER_SCALE) : 0);
      w.u16(steered ? Math.min(NO_STEER - 1, Math.round(c.sp * SPEED_SCALE)) : NO_STEER);
    }
  }

  // pellets added / removed
  w.u16(added.length);
  for (const p of added) {
    const moving = !!(p.vx || p.vy);
    w.u32(p.id);
    w.u16(Math.round(p.x));
    w.u16(Math.round(p.y));
    w.u8(p.ci);
    w.u8(
      // Compared against the orb mass itself, not a literal. A previous magic
      // 10 exactly equalled EJECT_KEEP, so blobs failed their own
      // strictly-greater test and drew as ordinary orbs.
      (p.mass > PELLET_MASS ? PELLET_BIG : 0) |
      // So the client can draw your own ejected mass in your own colour.
      (p.owner === view.id ? PELLET_MINE : 0) |
      (moving ? PELLET_MOVING : 0)
    );
    if (moving) {
      // A pellet is sent once and never re-sent, so without velocity a thrown
      // blob would appear at its launch point and never move on screen. The
      // client extrapolates from this using the same function the server runs.
      w.i16(Math.round(p.vx));
      w.i16(Math.round(p.vy));
    }
  }
  w.u16(removed.length);
  for (const id of removed) w.u32(id);

  // viruses
  // id, position, and how many blobs have been fed in. The id is what lets the
  // client match a virus between snapshots and interpolate a shot one instead
  // of stepping it at the tick rate; the feed count is what makes it swell on
  // screen, which is the only warning anybody gets that it is about to split.
  w.u16(viruses.length);
  for (const v of viruses) {
    w.u16(v.vid);
    w.u16(Math.round(v.x));
    w.u16(Math.round(v.y));
    w.u8(v.fed);
  }

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
  const time = r.f64();
  const world = r.u16();
  if (!Number.isFinite(time)) throw new RangeError("bad time");
  const ack = r.u16();
  const ackAge = r.u16();

  const life = r.u8();
  const me = {
    alive: life === 1,
    zoned: life === 2,
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
  let zone = null;
  if (flags & FLAG_ZONE) {
    const state = r.u8();
    if (state < ZONE_WARNING || state > ZONE_CLOSED) throw new RangeError("bad zone state");
    zone = { state, secs: r.u8(), now: readBox(r), to: readBox(r) };
  }
  const spectating = r.u8() === 1;
  const eyeNid = r.u16();

  const names = [];
  // Strings are variable length, so a per-record byte cost is not meaningful;
  // bound the count by the pessimistic minimum of 4 bytes each instead.
  const nameCount = r.expect(r.u16(), 4);
  for (let i = 0; i < nameCount; i++) names.push({ nid: r.u16(), name: r.str(), ci: r.u8() });

  const cells = [];
  const cellCount = r.expect(r.u16(), CELL_BYTES);
  for (let i = 0; i < cellCount; i++) {
    const id = r.u32();
    const x = r.u16();
    const y = r.u16();
    const m = r.u16();
    const o = r.u16();
    const f = r.u8();
    const cell = { i: id, x, y, m, o, s: f & CELL_COOLDOWN ? 1 : 0, mine: !!(f & CELL_MINE) };
    if (cell.mine) {
      cell.vx = r.i16();
      cell.vy = r.i16();
      const hx = r.i16(), hy = r.i16(), sp = r.u16();
      // Left undefined when unsteered, which is what advanceCell reads as
      // "adopt the target heading outright" — the same as the server will.
      if (sp !== NO_STEER) {
        cell.hx = hx / STEER_SCALE;
        cell.hy = hy / STEER_SCALE;
        cell.sp = sp / SPEED_SCALE;
      }
    }
    cells.push(cell);
  }

  const added = [];
  const addCount = r.expect(r.u16(), PELLET_BYTES);
  for (let i = 0; i < addCount; i++) {
    const id = r.u32(), x = r.u16(), y = r.u16(), ci = r.u8(), flags = r.u8();
    const moving = !!(flags & PELLET_MOVING);
    added.push({
      id, x, y, ci,
      big: !!(flags & PELLET_BIG),
      mine: !!(flags & PELLET_MINE),
      vx: moving ? r.i16() : 0,
      vy: moving ? r.i16() : 0
    });
  }

  const removed = [];
  const remCount = r.expect(r.u16(), REMOVE_BYTES);
  for (let i = 0; i < remCount; i++) removed.push(r.u32());

  const viruses = [];
  const virusCount = r.expect(r.u16(), VIRUS_BYTES);
  for (let i = 0; i < virusCount; i++) {
    const vid = r.u16();
    viruses.push([r.u16(), r.u16(), r.u8(), vid]);
  }

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
    tick, time, world, ack, ackAge, me, round, zone, spectating, eyeNid,
    names, cells, added, removed, viruses, board
  };
}
