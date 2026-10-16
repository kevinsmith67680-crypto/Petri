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
//
// The full-speed reach on the end of aims and actions is NOT a version bump,
// deliberately. It is two bytes the server reads when they are there, and the
// client only sends them to a server whose welcome says `aimReach`. So a tab
// open from before keeps playing against a new server, and a new tab matched
// onto a server not yet redeployed keeps playing too — both steer by the old
// rule — instead of a whole room being told to reload mid-round.
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
// The whistle has gone and everyone is on the starting ring, but nobody can
// move yet. A few seconds to see where every opponent stands before the
// round begins, the same seconds for everyone. A new value in a byte that
// was already there, so the frame layout and PROTOCOL_VERSION are unchanged:
// a page from before it sees a still field for a moment, then plays as usual.
export const PHASE_HOLD = 5;

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
//
// `reach` is how far from a cell the aim point must be for it to steer at
// full speed, u16 world units; see steerThrottle in shared/sim.js. Left off,
// the frame is the one older servers expect; see PROTOCOL_VERSION.
export function encodeAim(dx, dy, seq = 0, reach) {
  const w = new Writer(10).u8(MSG.AIM).i16(dx).i16(dy).u16(seq);
  if (reach !== undefined) w.u16(reach);
  return w.bytes();
}

// An action carries the aim it was made with, numbered like any other aim.
// Splits go where that aim points, not wherever the last aim sent at 30Hz
// happened to, and the action is acknowledged in the same breath as the aim:
// once a snapshot has acted on the number, it has acted on the action. Sent
// separately, a tick could fall between the two and the client would drop the
// pieces it was showing before the server's arrived. It carries the reach
// too, for the same reason: the server takes the whole aim from it.
export function encodeAction(action, dx = 0, dy = 0, seq = 0, reach) {
  const idx = ACTIONS.indexOf(action);
  if (idx < 0) return null;
  const w = new Writer(10).u8(MSG.ACTION).u8(idx).i16(dx).i16(dy).u16(seq);
  if (reach !== undefined) w.u16(reach);
  return w.bytes();
}

// The reach on the end of an aim or an action. Absent from a client that
// predates it: 0, which steers by the old rule. One stray byte is still a
// malformed frame, and r.end() says so.
const readReach = r => (r.remaining >= 2 ? r.u16() : 0);

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
    const reach = readReach(r);
    r.end();
    return { type, x, y, seq, reach };
  }

  if (type === MSG.ACTION) {
    const idx = r.u8();
    const x = r.i16();
    const y = r.i16();
    const seq = r.u16();
    const reach = readReach(r);
    r.end();
    const action = ACTIONS[idx];
    if (!action) throw new RangeError("unknown action");
    return { type, action, x, y, seq, reach };
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
    // The pellets this client has been told are in view: their ids in the
    // order they were visited for its last snapshot, and how many; the same
    // ids in a hash table for lookups, and a second table that the next
    // snapshot's ids are put into before the two swap.
    knownOrder: new Float64Array(256),
    knownCount: 0,
    knownTable: new Float64Array(512),
    nextTable: new Float64Array(512),
    knownBits: 9,
    knownNames: new Set(),
    sinceKeyframe: stagger % KEYFRAME_TICKS,  // spread keyframes across clients
    sinceBoard: stagger % BOARD_TICKS
  };
}

// ── what every snapshot of a tick shares ────────────────────────────────────
//
// Most of a snapshot is the same for every client in the room: where each
// cell is and how far it reaches, its record on the wire (unless it is the
// viewer's own), the viruses, the zone, the leaderboard. snapshotFrame works
// that out once, and each client's encodeSnapshot does only what depends on
// where it is looking and what it already knows. The bytes are exactly those
// of encoding each snapshot from scratch.
//
// A frame describes the world at one moment. The server makes one per room
// per tick, once the tick's bookkeeping is done, and uses it for that tick's
// snapshots only: nothing may change the world in between.
export function snapshotFrame(world) {
  let n = 0;
  for (const p of world.players.values()) if (p.alive) n += p.cells.length;
  const cells = new Array(n), owners = new Array(n);
  const xs = new Float64Array(n), ys = new Float64Array(n), reach = new Float64Array(n);
  const rec = new Writer(n * CELL_BYTES || 1);
  let i = 0;
  for (const p of world.players.values()) {
    if (!p.alive) continue;
    for (const c of p.cells) {
      cells[i] = c; owners[i] = p;
      xs[i] = c.x; ys[i] = c.y; reach[i] = radiusOf(c.mass);
      // As anyone but its owner sees it: no flags, no motion.
      rec.u32(c.id).u16(Math.round(c.x)).u16(Math.round(c.y)).u16(clampU16(Math.round(c.mass))).u16(p.nid).u8(0);
      i++;
    }
  }
  const vs = world.viruses, nv = vs.length;
  const vx = new Float64Array(nv), vy = new Float64Array(nv);
  const vrec = new Writer(nv * VIRUS_BYTES || 1);
  for (let k = 0; k < nv; k++) {
    const v = vs[k];
    vx[k] = v.x; vy[k] = v.y;
    vrec.u16(v.vid).u16(Math.round(v.x)).u16(Math.round(v.y)).u8(v.fed);
  }
  return {
    world, tick: world.tick, n, cells, owners, xs, ys, reach, rec: rec.bytes(),
    nv, vx, vy, vrec: vrec.bytes(),
    // The same for everyone in the room, so it is public, not scoped to a view.
    zone: zoneView(world),
    board: null      // worked out by the first snapshot this tick that carries it
  };
}

// The leaderboard, each row's name and mass already encoded; only the "this
// is you" byte differs between clients.
function boardOf(frame) {
  if (!frame.board) {
    const rows = leaderboard(frame.world);
    const w = new Writer(rows.length * 40 || 1);
    const ends = [];
    for (const row of rows) { w.str(row.name, 32); w.u32(row.mass); ends.push(w.length); }
    frame.board = { ids: rows.map(r => r.id), ends, bytes: w.bytes() };
  }
  return frame.board;
}

// Reused by every call: a snapshot is written here and copied out at its exact
// length, and these lists are refilled rather than allocated per client.
const out = new Writer(16384);
const shown = [], newNames = [], added = [], removed = [], virusesShown = [];

// The pellets in a view, as the grid visits them: ids and the pellets
// themselves, in order. One callback for every client, reading the query from
// these, so no closure is made per snapshot.
let seenIds = new Float64Array(1024);
const seenPellets = [];
let seenCount = 0, qx = 0, qy = 0, qr2 = 0;
function collect(p) {
  if (p.dead) return;
  const dx = p.x - qx, dy = p.y - qy;
  if (!(dx * dx + dy * dy < qr2)) return;
  if (seenCount === seenIds.length) {
    const grown = new Float64Array(seenCount * 2);
    grown.set(seenIds);
    seenIds = grown;
  }
  seenIds[seenCount] = p.id;
  seenPellets[seenCount++] = p;
}

// Pellet ids in an open-addressed hash table of 2^bits slots, 0 for empty
// (ids start at 1). Kept at most half full, so a probe is a slot or two.
// Hashed by multiplying, on the low 32 bits of the id; the whole id is what
// is compared.
const slot = (id, bits) => Math.imul(id | 0, 0x9e3779b1) >>> (32 - bits);
function put(t, bits, id) {
  const mask = (1 << bits) - 1;
  let i = slot(id, bits);
  while (t[i] !== 0) i = (i + 1) & mask;
  t[i] = id;
}
function has(t, bits, id) {
  const mask = (1 << bits) - 1;
  for (let i = slot(id, bits); t[i] !== 0; i = (i + 1) & mask) if (t[i] === id) return true;
  return false;
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
//
// `frame` is this tick's snapshotFrame, shared across the room's clients; left
// out, or made for another world or tick, the call makes its own.
export function encodeSnapshot(world, player, cs, round = null, eye = null, tickAt = null, frame = null) {
  const f = frame && frame.world === world && frame.tick === world.tick ? frame : snapshotFrame(world);
  const view = eye && eye.alive && eye.cells.length ? eye : player;
  const spectating = view !== player;
  const keyframe = cs.sinceKeyframe <= 0;
  if (keyframe) {
    // A keyframe restates everything, so forget what we thought they knew.
    cs.knownCount = 0;
    cs.knownNames.clear();
    cs.sinceKeyframe = KEYFRAME_TICKS;
  }
  cs.sinceKeyframe--;

  const withBoard = cs.sinceBoard <= 0;
  if (withBoard) cs.sinceBoard = BOARD_TICKS;
  cs.sinceBoard--;

  const me = centroid(view);
  const R = viewRadius(view);
  const mx = me.x, my = me.y;

  // ── cells in view, plus any owner names this client has not been told ──
  // In view if its body reaches inside the view radius. A player's cells sit
  // together in the frame, so its name is checked at the first one seen.
  shown.length = 0;
  newNames.length = 0;
  const { xs, ys, reach, owners } = f;
  let named = null;
  for (let i = 0; i < f.n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my, r = R + reach[i];
    if (!(dx * dx + dy * dy < r * r)) continue;
    shown.push(i);
    const p = owners[i];
    if (p !== named) {
      named = p;
      if (!cs.knownNames.has(p.nid)) { cs.knownNames.add(p.nid); newNames.push(p); }
    }
  }

  // ── pellet delta, per the scoping rules at the top of this file ──
  // Grid query rather than a full scan: with thousands of orbs in the arena,
  // walking the whole list once per client per tick is the single most
  // expensive thing the server does.
  seenCount = 0; qx = mx; qy = my; qr2 = R * R;
  forEachPelletNear(world, mx, my, R, collect);
  const n = seenCount;
  // This snapshot's ids into the spare table, sized to stay half empty.
  let bits = 9;
  while ((1 << bits) < n * 2) bits++;
  let next = cs.nextTable;
  if (next.length < 1 << bits) next = new Float64Array(1 << bits);
  else next.fill(0, 0, 1 << bits);
  for (let k = 0; k < n; k++) put(next, bits, seenIds[k]);
  // Added: in view now, not known before, in the order visited.
  added.length = 0;
  for (let k = 0; k < n; k++) {
    if (!cs.knownCount || !has(cs.knownTable, cs.knownBits, seenIds[k])) added.push(seenPellets[k]);
  }
  // Removed: known before, not in view now, in the order they were sent.
  // Covers both "eaten while I was watching" and "scrolled out of my view".
  // Indistinguishable on the wire, deliberately. Every id seen now was either
  // known or added, so when the known ones seen account for all that were
  // known, nothing was removed, and the lookups can be skipped.
  removed.length = 0;
  if (n - added.length !== cs.knownCount) {
    for (let k = 0; k < cs.knownCount; k++) if (!has(next, bits, cs.knownOrder[k])) removed.push(cs.knownOrder[k]);
  }
  // Replace, never merge. This is rule 1. The old table is the next spare.
  if (cs.knownOrder.length < n) cs.knownOrder = new Float64Array(n * 2);
  cs.knownOrder.set(seenIds.subarray(0, n));
  cs.knownCount = n;
  cs.nextTable = cs.knownTable;
  cs.knownTable = next;
  cs.knownBits = bits;
  seenPellets.length = 0;

  virusesShown.length = 0;
  const vr = R + 60;
  for (let k = 0; k < f.nv; k++) {
    const dx = f.vx[k] - mx, dy = f.vy[k] - my;
    if (dx * dx + dy * dy < vr * vr) virusesShown.push(k);
  }
  // While spectating, every figure describes the player being watched — that
  // is what a spectator wants to see, and the viewer's own stats are frozen.
  const rank = rankOf(world, view.id);
  const mass = totalMass(view);
  const zone = f.zone;

  const w = out;
  w.o = 0;
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
  w.u16(Math.round(mx));
  w.u16(Math.round(my));
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

  // cells: everyone else's as the frame wrote them, the viewer's own here
  w.u16(shown.length);
  for (const i of shown) {
    const p = owners[i];
    if (p.id !== view.id) { w.raw(f.rec, i * CELL_BYTES, i * CELL_BYTES + CELL_BYTES); continue; }
    const c = f.cells[i];
    w.u32(c.id);
    w.u16(Math.round(c.x));
    w.u16(Math.round(c.y));
    w.u16(clampU16(Math.round(c.mass)));
    w.u16(p.nid);
    w.u8(CELL_MINE | (world.time < c.mergeAt ? CELL_COOLDOWN : 0));
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
  w.u16(virusesShown.length);
  for (const k of virusesShown) w.raw(f.vrec, k * VIRUS_BYTES, k * VIRUS_BYTES + VIRUS_BYTES);

  if (withBoard) {
    const b = boardOf(f);
    w.u8(b.ids.length);
    for (let i = 0; i < b.ids.length; i++) {
      w.raw(b.bytes, i ? b.ends[i - 1] : 0, b.ends[i]);
      w.u8(b.ids[i] === player.id ? 1 : 0);
    }
  }

  // Copied out: the same writer is reused for the next client, and the socket
  // may still be holding this snapshot when it is.
  return w.buf.slice(0, w.o);
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
