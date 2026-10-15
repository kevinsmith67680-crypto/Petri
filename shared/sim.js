// ---------------------------------------------------------------------------
// Shared simulation.
//
// This module is the single source of truth for game rules. It runs unchanged
// in Node (authoritative server) and in the browser (offline mode). To keep
// that true it must never touch:
//
//   * the DOM or canvas
//   * performance.now() / Date.now()  — time comes from world.time
//   * Math.random()                   — randomness comes from world.rng
//
// Those three rules are what make the simulation testable headless and safe to
// run on a server. Everything visual lives in client/.
// ---------------------------------------------------------------------------

// ── tuning ──────────────────────────────────────────────────────────────────

// Default arena, sized for a 100-player lobby at ~770k units^2 per player.
// A world can override these — see shared/modes.js — so a 50-player room gets
// a smaller board rather than half the density. Must stay under 65535:
// positions travel as u16.
export const WORLD = 8800;          // square arena, world units
export const PELLETS = 4100;        // orbs kept in play at all times
export const VIRUSES = 90;
export const MAX_WORLD = 65535;
export const DEFAULT_BOTS = 14;     // guests only; the live arena runs botless

export const START_MASS = 20;
// Mass gained per orb. Was 3.375, at which a player farming orbs alone, with
// nobody to fight, reached 550 mass in the first minute and 3,500 by the
// whistle: past the 200 that breaks even on a stake in seconds, and paid as
// if it had been won. Growth is meant to come mostly from other players.
export const PELLET_MASS = 2;
export const EJECT_MASS = 16;       // mass spent ejecting
export const EJECT_KEEP = 13;       // mass the ejected blob carries
export const ORB_RADIUS = 6;        // a plain orb, fixed size regardless of mass
// No two orbs closer than this fraction of the gap an even lattice would give
// them — about 86 units in either arena. See sowOrbs.
export const ORB_SPACING = 0.65;
export const VIRUS_MASS = 110;
export const VIRUS_EAT_RATIO = 1.15; // how much bigger you must be to pop one
export const VIRUS_PIECES = 9;       // fragments a virus scatters you into

// Feeding a virus. Shoot ejected mass into one and it swells; the third hit
// splits it, and the new virus is shot off along the line the mass came in on.
// agar.io uses seven feeds; three is enough to be worth doing inside a
// ten-minute round without turning the board into a minefield.
export const VIRUS_FEED_HITS = 3;
// How the virus that is shot out travels. It coasts on its own, gentler
// friction rather than a cell's: at the cell rate a virus launched fast enough
// to matter is gone in a third of a second, and one launched slowly travels
// barely its own diameter — 107 units, against a diameter of 84. This pair
// puts it ~450 units out over about a second and a half, which reads as a
// heavy thing drifting into place and is far enough to aim at somebody.
//
// 820 units/second is also 41 per tick, just under the 45-unit radius of the
// smallest cell a virus can pop — so a virus cannot step straight over a cell
// it should have burst.
export const VIRUS_SPLIT_SPEED = 820;
const VIRUS_FRICTION = 0.97;          // per 1/60s, for readability
const VIRUS_DECAY = Math.pow(VIRUS_FRICTION, 60);
const VIRUS_LN = Math.log(VIRUS_DECAY);
// Ceiling on the population, as a multiple of the count the arena seeds. Past
// it a fed virus still resets, it just has nowhere to put the child — without
// this, a round long enough turns every arena into a wall of green.
export const VIRUS_MAX_RATIO = 1.5;
export const MAX_CELLS = 16;
// Size advantage needed to eat a rival. Lowered from 1.22 by 10%: you now
// need to be 9.8% bigger rather than 22%, so to swallow a mass-100 player you
// need 110 instead of 122. Contested chases resolve far more often.
//
// This is the single most load-bearing number in the game. It sets how fast
// the board consolidates, how dangerous a near-equal rival is, and how much a
// split gamble costs — lowering it makes the round more aggressive, and the
// leader snowballs sooner. Worth playing a full round before deciding it is
// right.
export const EAT_RATIO = 1.098;
// What absorbing a rival pays, as a multiple of its mass. Exactly its mass:
// at 1.2 every kill made a fifth of the victim out of nothing, and in a full
// room that compounded — a simulated 100-player round went from 2,000 mass on
// the board to 774,000 by 1:30 left, and the closing zone fed one player the
// lot.
export const EAT_BONUS = 1.0;
export const MERGE_DELAY = 1.75;     // multiplier on the rejoin cooldown
// Above DECAY_ABOVE a cell loses DECAY_RATE of its mass a second, so staying
// big means going on eating: 2 a second at 400, 8 at 1,600. Was 0.22%, which
// let a leader sit on a lead.
export const DECAY_ABOVE = 260;
export const DECAY_RATE = 0.005;

// Base movement rate. This was tuned when the arena was 3,400 units across and
// never revisited when it grew to 8,800 for a 100-player lobby — so crossing
// the board went from 11 seconds to 30, and a screen's width took over three.
// That is the "sluggish" that is left once the input latency is gone: not a
// delay, just a slow character on a big map.
//
// Speed still falls with mass at the same rate; only the base moves.
export const BASE_SPEED = 17;

// Split and burst physics. Velocity is in world units per second and decays
// exponentially. The old per-frame factor of 0.86 shed 90% of the travel in
// 255ms, which read as a pop; agar.io pieces visibly coast for half a second
// or more. CELL_FRICTION is the per-1/60s factor for readability; the exact
// per-second form is derived once below.
const CELL_FRICTION = 0.935;                 // ~0.6s to shed 90% of travel
const CELL_DECAY = Math.pow(CELL_FRICTION, 60);
const CELL_LN = Math.log(CELL_DECAY);
// Launch speed for a split piece of the given mass, units per second.
export const splitLaunchSpeed = half => 780 + Math.sqrt(half) * 40;

// Steering inertia. Without it a cell reverses direction in a single frame,
// which is what "too sharp" means — every twitch of the mouse becomes a hard
// corner. Heading and speed now ease toward their targets with an ~80ms time
// constant: a full reversal takes about a quarter of a second, and small
// cursor wobble is absorbed instead of drawn.
//
// Lives in the shared simulation so the server and the client's prediction
// steer identically; a client-only smoothing would fight the correction.
const STEER_RATE = 12;

// The closing zone. Late in a live round the safe area closes in, as in
// Fortnite: a square ZONE_SHRINK_TO of the arena's width, placed at random,
// and the four edges of the safe area slide in to it. A cell whose centre is
// outside the safe area loses mass fast and is gone below ZONE_MIN_MASS.
//
// The edges start moving when the round clock reads ZONE_AT_REMAINING, are
// announced ZONE_WARN_SECONDS before that, take ZONE_SHRINK_SECONDS to reach
// the final square, and hold there until the whistle. The far edge travels at
// most 40% of the arena in those 45 seconds — 78 units a second in Standard,
// which any cell short of 40,000 mass outruns — so anyone paying attention
// walks in. The drain is what punishes not paying attention.
export const ZONE_AT_REMAINING = 90;    // the clock reads 1:30
export const ZONE_WARN_SECONDS = 10;
export const ZONE_SHRINK_SECONDS = 45;  // closed at 0:45
export const ZONE_SHRINK_TO = 0.6;
// Lost per second by each cell outside: this share of its mass, plus a flat
// amount so a small cell cannot sit out there for ever. A 20-mass cell is
// gone in under three seconds; a 1,000-mass one halves in seven.
export const ZONE_DRAIN = 0.1;
export const ZONE_DRAIN_FLAT = 2;
export const ZONE_MIN_MASS = 10;

export const TICK_HZ = 20;           // authoritative server tick rate
export const STAIN_COUNT = 7;        // palette slots; colours live client-side

export const BOT_NAMES = [
  "Coccus", "Bacillus", "Spirillum", "Vibrio", "Amoeba", "Paramecium",
  "Euglena", "Volvox", "Diatom", "Rotifer", "Stentor", "Ciliate",
  "Chlorella", "Tardigrade", "Nostoc", "Spirogyra"
];

// ── bot difficulty ──────────────────────────────────────────────────────────
//
// What a bot is allowed to attack with, and how hard it plays for mass.
//
//   chase   how close prey has to be before a bot goes after it
//   lead    seconds ahead of a moving target a bot aims, 0 for straight at it
//   split   engulfing: splitting to launch half the cell onto smaller prey
//   virus   feeding a virus so the one it spits out bursts a larger cell
//
// Hard only, each absent on the other levels:
//
//   hunt    how far a bot will go looking for prey when it can see nobody at
//           all: in a crowded arena it fights and grazes where it is
//   graze   picks orbs by value for distance, thrown mass included, rather
//           than the nearest one, and heads straight for it
//   split.cells   splits again while still in up to this many pieces
//   split.double  seconds between the two halves of a double split, which
//                 throws a quarter past where a single split could reach
//   virus.see     how far off a bigger cell can be to line a virus up on it
//   virus.shield  how far a bot will run to put a virus between it and a
//                 chaser big enough to burst on it
//
// Easy is how bots played before levels existed: they chase and never split
// or shoot. A level is per world, so everyone in one arena faces the same
// bots.
export const BOT_LEVELS = Object.freeze({
  easy: Object.freeze({ chase: 430, lead: 0, split: null, virus: null }),
  normal: Object.freeze({
    chase: 500,
    lead: 0,
    // Only point-blank, near-certain kills, with a long wait between them.
    split: Object.freeze({ reach: 0.6, margin: 1.15, cooldown: 8, safe: 620 }),
    // Only a virus it is already standing behind: it will not walk to one.
    virus: Object.freeze({ travel: 140, minMass: 90, cooldown: 12, lead: 0, nerve: 150 })
  }),
  hard: Object.freeze({
    chase: 620,
    lead: 0.3,
    hunt: 1800,
    graze: true,
    split: Object.freeze({
      reach: 0.9, margin: 1.03, cooldown: 1.5, safe: 420, cells: 4, double: 0.15
    }),
    // Walks across to line a virus up, and holds its ground behind it while a
    // larger cell closes in: anything big enough to eat it pops on the way.
    virus: Object.freeze({
      travel: 520, minMass: 64, cooldown: 3, lead: 0.5, nerve: 90, see: 1000, shield: 400
    })
  })
});
export const BOT_LEVEL_IDS = Object.keys(BOT_LEVELS);
export const DEFAULT_BOT_LEVEL = "normal";
export const isBotLevel = id => Object.hasOwn(BOT_LEVELS, id);

// Change the bots of a running world. Takes effect on the next tick; a plan a
// bot is part way through is dropped rather than finished at the old level.
export function setBotLevel(world, id) {
  if (!isBotLevel(id)) return false;
  world.botLevel = id;
  for (const p of world.players.values()) if (p.bot) { p.plan = null; p.followUp = null; }
  return true;
}

export const radiusOf = m => Math.sqrt(m) * 4;

// Plain orbs are drawn at a fixed size; ejected mass is a real blob whose
// radius follows its mass, like a small cell. One function so the drawn size
// and the size you can actually eat are never allowed to disagree.
export const pelletRadius = p =>
  p.mass > PELLET_MASS ? radiusOf(p.mass) : ORB_RADIUS;

// Ejected mass leaves at EJECT_SPEED and coasts to a stop. Exported and used
// by BOTH ends: the server simulates it, and the client extrapolates from the
// velocity it was told, which is what makes the throw look continuous instead
// of arriving as one jump per snapshot.
// Ejecting throws a projectile that shoots clear of the cell and parks just
// outside its reach. Two constants shape it:
//
// One launch speed for every cell, as agar.io does it. Travel is therefore
// constant at EJECT_SPEED / EJECT_SNAP = 237 units, and because the blob
// spawns at the membrane the clearance past the mouth is constant too — 233
// units whatever the cell's size. A mass-200 cell throws to 299 from centre.
//
// A fixed distance from the CENTRE would not work: it would rest inside a
// large cell's reach. A fixed distance of TRAVEL does, because the starting
// point already scales with the radius.
export const EJECT_SPEED = 1304;       // world units per second at launch
const EJECT_SNAP = 5.5;                // 1/e-folds per second of travel

export const ejectLaunchSpeed = () => EJECT_SPEED;

// The thrower cannot pick its own mass back up for this long. Everyone else
// can take it immediately. Long enough that a cell continuing forward sails
// past rather than vacuuming it up, so recovering your own mass means turning
// round and going back for it — a decision, not an accident.
export const EJECT_OWNER_COOLDOWN = 0.6;

// Thrown mass can be reclaimed immediately — there is no immunity window.
//
// What stops a cell swallowing its own throw is physical rather than a timer:
// eatPellets ignores anything receding from the cell. A blob leaves at
// EJECT_SPEED and is moving away far faster than the cell can close, so it
// escapes; once it slows to a stop it becomes food like anything else, for
// its thrower as much as anyone. A blob thrown TOWARD you is closing, so it
// stays edible — which is what makes feeding work.
const PELLET_FRICTION = Math.exp(-EJECT_SNAP / 60);   // per 1/60s

// Per-second decay factor, and the exact integral of it over a step.
//
// Integrating this the naive way (x += v * dt, then decay v) makes the
// distance depend on the step size, so a client running at 60fps and a server
// at 20Hz disagree — measured at 146 units of drift over a third of a second,
// which is ten times the blob's own radius. Solving the integral exactly makes
// the result identical at any frame rate.
const PELLET_DECAY = Math.pow(PELLET_FRICTION, 60);
const PELLET_LN = Math.log(PELLET_DECAY);

export function advancePellet(p, dt, size = WORLD) {
  if (!p.vx && !p.vy) return;
  const f = Math.pow(PELLET_DECAY, dt);
  const travel = (f - 1) / PELLET_LN;        // integral of decay over dt
  p.x = clamp(p.x + p.vx * travel, ORB_RADIUS, size - ORB_RADIUS);
  p.y = clamp(p.y + p.vy * travel, ORB_RADIUS, size - ORB_RADIUS);
  p.vx *= f;
  p.vy *= f;
  if (Math.abs(p.vx) < 1 && Math.abs(p.vy) < 1) { p.vx = 0; p.vy = 0; }
}

// ── pellet spatial index ────────────────────────────────────────────────────
//
// With 4,100 orbs in an 8,800-unit arena, scanning the whole list once per
// cell per tick dominates the frame. A uniform grid turns "which orbs are near
// this cell" into a handful of bucket lookups.
//
// Rebuilt wholesale each tick rather than maintained incrementally: 4,100
// inserts costs a fraction of a millisecond and removes an entire class of
// stale-index bug.

const GRID = 220;                       // ~half the view radius of a small cell
const key = (gx, gy) => gx * 100003 + gy;   // prime stride, coords are >= 0

export function buildPelletGrid(world) {
  // Buckets are kept and emptied rather than the Map being cleared: clearing
  // it meant allocating ~1,600 fresh arrays every tick, and the garbage
  // collector was a quarter of the whole frame.
  const g = world.grid || (world.grid = new Map());
  for (const bucket of g.values()) bucket.length = 0;
  for (const p of world.pellets) gridInsert(g, p);
}

// Also used by sowOrbs, which indexes each orb the moment it is placed so the
// next one can keep its distance from it.
function gridInsert(g, p) {
  const k = key((p.x / GRID) | 0, (p.y / GRID) | 0);
  const bucket = g.get(k);
  if (bucket) bucket.push(p);
  else g.set(k, [p]);
}

// Visits every pellet in the buckets overlapping the box around (x, y, r).
// Callers still do their own circle test; this only narrows the candidates.
export function forEachPelletNear(world, x, y, r, fn) {
  // Lazily build rather than silently returning nothing: encodeSnapshot can be
  // called before the first tick, and an empty result there would look like
  // "no orbs in view" rather than "index not ready".
  if (!world.grid) buildPelletGrid(world);
  const x0 = Math.max(0, ((x - r) / GRID) | 0);
  const x1 = ((x + r) / GRID) | 0;
  const y0 = Math.max(0, ((y - r) / GRID) | 0);
  const y1 = ((y + r) / GRID) | 0;
  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const bucket = world.grid.get(key(gx, gy));
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
    }
  }
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ── deterministic randomness ────────────────────────────────────────────────

// mulberry32: small, fast, seedable. A seeded generator means a server can
// replay a match from its seed and inputs, and that tests are reproducible.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── world construction ──────────────────────────────────────────────────────

export function createWorld(seed = 1, opts = {}) {
  const size = opts.size ?? WORLD;
  if (size > MAX_WORLD) throw new RangeError(`arena ${size} exceeds u16`);
  const world = {
    seed,
    // Per-world so two rooms of different sizes can run side by side.
    size,
    pelletCount: opts.pellets ?? PELLETS,
    virusCount: opts.viruses ?? VIRUSES,
    botLevel: isBotLevel(opts.botLevel) ? opts.botLevel : DEFAULT_BOT_LEVEL,
    rng: mulberry32(seed),
    tick: 0,
    time: 0,          // seconds since world creation; all timers use this
    nextId: 1,
    nextNid: 1,       // compact numeric player id, used on the wire
    nextVid: 1,       // and the same for viruses, which the client matches on
    pellets: [],
    pelletsDirty: false,
    grid: null,
    viruses: [],
    players: new Map(),
    zone: null,       // the closing zone, when a round has planned one
    safe: null,       // and the safe area this tick, once its edges move
    events: []        // drained by the host each tick
  };

  sowOrbs(world);
  for (let i = 0; i < world.virusCount; i++) world.viruses.push(makeVirus(world));
  return world;
}

const rand = (world, a, b) => a + world.rng() * (b - a);

// Kept clear of the walls, so nothing spawns already pinned against one.
const SPAWN_PAD = 140;

// While the zone closes, anything new — an orb, a virus, a bot coming back —
// appears inside the safe area, never where it is already lethal. The safe
// area as it is now, not the square it is closing to: orbs left outside are
// still counted, so sowing every replacement into the final square packed
// nine in ten of them into a third of the board, past the room sowOrbs looks
// for, and tripled the tick. Same two draws either way, so a seeded world
// still replays identically.
function spawnPoint(world) {
  const z = world.safe;
  return {
    x: rand(world, (z ? z.x0 : 0) + SPAWN_PAD, (z ? z.x1 : world.size) - SPAWN_PAD),
    y: rand(world, (z ? z.y0 : 0) + SPAWN_PAD, (z ? z.y1 : world.size) - SPAWN_PAD)
  };
}

function makePellet(world, x, y, mass, vx, vy, ci) {
  return {
    id: world.nextId++,
    x, y,
    mass: mass || PELLET_MASS,
    vx: vx || 0, vy: vy || 0,
    ci: ci === undefined ? Math.floor(world.rng() * STAIN_COUNT) : ci
  };
}

// ── sowing orbs ─────────────────────────────────────────────────────────────
//
// Orbs are placed by Poisson-disc sampling: a point is drawn at random and
// kept only if no pellet already lies within orbGap of it, so the board is
// random without being clumpy.
//
// Uniform random placement is not even. It deals rich patches and bare
// stretches, and replacing eaten orbs at uniform random points makes that
// worse as a round goes on: the ground players graze is stripped, the ground
// nobody visits piles up, and where you happen to open decides how fast you
// can grow. With a minimum gap nowhere can hold much more than its share, and
// a replacement can only land where there is room for one, so it fills a gap
// instead of piling onto ground that is already full. README.md, "How orbs
// are placed", has the measurements.
//
// The same sampler deals the opening board and every replacement, so a board
// late in a round is the same kind of board as the one it opened on.
//
// The gap scales with the arena, as a fraction of the spacing an even lattice
// of the same count would have. Dart throwing slows as the board fills, and
// 0.65 is where it stays cheap on a full board — seven or eight darts a
// replacement — while still ruling out clumps. Past ORB_TRIES misses the
// clearest dart is used, so the count is always met; in play that is one or
// two orbs in ten thousand.
//
// A replacement never lands under a living cell. Every cell sits in the hole
// it has just eaten, which is exactly the room this sampler looks for, so
// without that rule a cell could park and collect the orbs refilling its own
// hole.
const ORB_TRIES = 60;

export const orbGap = world =>
  ORB_SPACING * (world.size - 2 * SPAWN_PAD) / Math.sqrt(world.pelletCount);

// Tops world.pellets up to the arena's count. The grid must be current: it is
// what each dart is checked against, and every orb placed is added to it.
function sowOrbs(world) {
  const want = world.pelletCount - world.pellets.length;
  if (want <= 0) return;
  if (!world.grid) buildPelletGrid(world);

  const cells = [];
  for (const p of world.players.values()) for (const c of p.cells) cells.push(c);

  const gap = orbGap(world);
  const clear = gap * gap;
  for (let n = 0; n < want; n++) {
    let x = 0, y = 0, best = -1;
    for (let i = 0; i < ORB_TRIES && best < clear; i++) {
      const p = spawnPoint(world);
      const room = underCell(cells, p.x, p.y) ? 0 : roomAt(world, p.x, p.y, gap);
      if (room > best) { best = room; x = p.x; y = p.y; }
    }
    const orb = makePellet(world, x, y);
    world.pellets.push(orb);
    gridInsert(world.grid, orb);
  }
}

// Squared distance from (x, y) to the nearest pellet, capped at r squared.
function roomAt(world, x, y, r) {
  let room = r * r;
  forEachPelletNear(world, x, y, r, p => {
    const dx = p.x - x, dy = p.y - y;
    const d = dx * dx + dy * dy;
    if (d < room) room = d;
  });
  return room;
}

function underCell(cells, x, y) {
  for (const c of cells) {
    const dx = c.x - x, dy = c.y - y, r = radiusOf(c.mass);
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

function makeVirus(world, x, y, vx = 0, vy = 0) {
  const p = x === undefined ? spawnPoint(world) : { x, y };
  return {
    id: world.nextId++,
    // Compact id for the wire, allocated the way player nids are. The client
    // needs it to tell one virus from another between snapshots, which is what
    // lets a shot one be interpolated instead of stepping at the tick rate.
    vid: (world.nextVid = (world.nextVid % 65534) + 1),
    x: p.x, y: p.y,
    mass: VIRUS_MASS,
    fed: 0,             // ejected blobs absorbed since the last split
    vx, vy
  };
}

// A shot virus coasts to a stop. Integrated exactly, for the same reason
// ejected mass is (see advancePellet): a client drawing at 60fps and a server
// stepping at 20Hz have to agree on where it ends up.
function advanceVirus(v, dt, size) {
  if (!v.vx && !v.vy) return;
  const f = Math.pow(VIRUS_DECAY, dt);
  const travel = (f - 1) / VIRUS_LN;
  const pad = radiusOf(v.mass);
  v.x = clamp(v.x + v.vx * travel, pad, size - pad);
  v.y = clamp(v.y + v.vy * travel, pad, size - pad);
  v.vx *= f;
  v.vy *= f;
  if (Math.abs(v.vx) < 1 && Math.abs(v.vy) < 1) { v.vx = 0; v.vy = 0; }
}

function makeCell(world, x, y, mass, ci) {
  return { id: world.nextId++, x, y, mass, ci, vx: 0, vy: 0, mergeAt: 0 };
}

// ── players ─────────────────────────────────────────────────────────────────

export function addPlayer(world, { id, name, bot = false, ci = null }) {
  const player = {
    id,
    // Compact numeric id for the binary protocol. Wraps within u16; a
    // collision needs 65k joins with the original player still connected.
    nid: (world.nextNid = (world.nextNid % 65534) + 1),
    name,
    bot,
    ci: ci === null ? Math.floor(world.rng() * STAIN_COUNT) : ci,
    cells: [],
    input: { x: 0, y: 0 },   // aim offset from own centroid, in world units
    actions: [],             // queued "split" / "eject" this tick
    alive: false,
    respawnAt: 0,
    spawnedAt: 0,
    rank: 0,          // live leaderboard position, refreshed each tick
    of: 0,
    orbs: 0,
    eaten: 0,
    peak: START_MASS,
    jitter: world.rng() * Math.PI * 2,
    // Bot attack state. Unused by humans.
    plan: null,              // a virus shot being lined up, see planVirusShot
    followUp: null,          // the second half of a double split, see doubleSplit
    nextSplit: 0,
    nextVirus: 0,
    // Staggered so a room full of bots does not all search for a virus shot
    // on the same tick.
    nextLook: world.time + (world.nextNid % 10) * 0.05
  };
  world.players.set(id, player);
  spawnPlayer(world, player);
  return player;
}

export function removePlayer(world, id) {
  world.players.delete(id);
}

export function spawnPlayer(world, player, mass = START_MASS) {
  const p = spawnPoint(world);
  placePlayer(world, player, p.x, p.y, mass);
}

// The body of a spawn once somewhere to put it has been decided.
function placePlayer(world, player, x, y, mass) {
  player.cells = [makeCell(world, x, y, mass, player.ci)];
  player.alive = true;
  player.spawnedAt = world.time;
  player.rank = 0;
  player.of = 0;
  player.input.x = 0;
  player.input.y = 0;
  player.actions.length = 0;
  player.plan = null;
  player.followUp = null;
  player.zoned = false;
}

// Target distance between neighbouring spawns. A lobby too big to seat at this
// spacing gets the widest ring the arena holds instead, which is tighter but
// still even — see spawnRing.
export const SPAWN_GAP = 520;

// Start everyone the same distance apart.
//
// Random spawn points decide the round before it begins: two players can open
// a body-length apart while a third has a quarter of the board to itself. A
// ring at equal angular spacing gives every player an identical opening — the
// same distance to either neighbour, to the centre, and to the wall — which is
// the only arrangement that is defensible with money on the table.
//
// Order matters: neighbours on the ring are whoever is adjacent in `players`,
// so a caller that wants humans spread through a field of bots interleaves
// them before calling.
export function spawnRing(world, players, mass = START_MASS) {
  const n = players.length;
  if (!n) return;

  const c = world.size / 2;
  const maxR = c - SPAWN_PAD;
  // Neighbours on a ring of radius r sit 2r·sin(pi/n) apart, so this is the
  // radius that puts them exactly SPAWN_GAP apart. A full 100-player lobby
  // asks for more room than the arena has and is clamped to the wall padding;
  // the spacing stays equal, just smaller than the target.
  const want = n > 1 ? SPAWN_GAP / (2 * Math.sin(Math.PI / n)) : 0;
  const r = Math.min(maxR, want);
  // Seeded, so a given world still replays identically. Without it the ring
  // lands on the same points every round and players learn the openings.
  const turn = world.rng() * Math.PI * 2;

  for (let i = 0; i < n; i++) {
    const a = turn + (i * Math.PI * 2) / n;
    placePlayer(world, players[i], c + Math.cos(a) * r, c + Math.sin(a) * r, mass);
  }
}

export function fillBots(world, target = DEFAULT_BOTS) {
  let bots = 0;
  for (const p of world.players.values()) if (p.bot) bots++;
  const taken = new Set([...world.players.values()].map(p => p.name));
  for (let i = bots; i < target; i++) {
    const name = BOT_NAMES.find(n => !taken.has(n)) || `Cell ${world.nextId}`;
    taken.add(name);
    const bot = addPlayer(world, { id: `bot:${world.nextId}`, name, bot: true, ci: i % STAIN_COUNT });
    bot.cells[0].mass = rand(world, 18, 46);
  }
}

// Aim is expressed as an offset from the player's own centroid, so it means
// the same thing regardless of the client's screen size or zoom level.
export function setAim(world, id, dx, dy) {
  const p = world.players.get(id);
  if (!p) return;
  const d = Math.hypot(dx, dy);
  const cap = world.size;                  // reject absurd values from clients
  const k = d > cap ? cap / d : 1;
  p.input.x = dx * k;
  p.input.y = dy * k;
}

export function queueAction(world, id, action) {
  const p = world.players.get(id);
  if (!p) return;
  if (action !== "split" && action !== "eject" && action !== "respawn") return;
  if (p.actions.length < 4) p.actions.push(action);   // cheap spam guard
}

export const totalMass = ent => ent.cells.reduce((s, c) => s + c.mass, 0);

export function centroid(ent) {
  let x = 0, y = 0, m = 0;
  for (const c of ent.cells) { x += c.x * c.mass; y += c.y * c.mass; m += c.mass; }
  return m ? { x: x / m, y: y / m } : { x: 0, y: 0 };
}

// ── mechanics ───────────────────────────────────────────────────────────────

// Movement for a single cell, exported so the CLIENT can run exactly this
// code to predict its own motion instead of waiting for a round trip. If the
// two ever diverge, prediction drifts and the correction becomes visible — so
// there must only be one copy of this maths, and this is it.
export function advanceCell(c, tx, ty, dt, size = WORLD) {
  const dx = tx - c.x, dy = ty - c.y;
  const d = Math.hypot(dx, dy);
  const r = radiusOf(c.mass);

  // Desired heading and speed this frame.
  let wantX = 0, wantY = 0, wantSpeed = 0;
  if (d > 1) {
    wantX = dx / d;
    wantY = dy / d;
    // Ease off as the aim point enters the cell so it settles instead of
    // jittering around the target.
    const throttle = clamp(d / (r * 0.9), 0, 1);
    wantSpeed = BASE_SPEED * Math.pow(c.mass, -0.24) * 60 * throttle;
  }

  // Ease the actual heading and speed toward them. A cell with no steering
  // state yet (first frame, or a ghost) adopts the target outright.
  const k = 1 - Math.exp(-STEER_RATE * dt);
  if (c.hx === undefined) { c.hx = wantX; c.hy = wantY; c.sp = wantSpeed; }
  else {
    c.hx += (wantX - c.hx) * k;
    c.hy += (wantY - c.hy) * k;
    c.sp += (wantSpeed - c.sp) * k;
  }
  c.x += c.hx * c.sp * dt;
  c.y += c.hy * c.sp * dt;
  // Launch velocity from a split or a virus burst, coasting to a stop.
  // Integrated exactly (see advancePellet) so the client's prediction of a
  // split and the server's simulation of it agree at any frame rate.
  if (c.vx || c.vy) {
    const f = Math.pow(CELL_DECAY, dt);
    const travel = (f - 1) / CELL_LN;          // integral of the decay over dt
    c.x += c.vx * travel;
    c.y += c.vy * travel;
    c.vx *= f;
    c.vy *= f;
    if (Math.abs(c.vx) < 1 && Math.abs(c.vy) < 1) { c.vx = 0; c.vy = 0; }
  }

  c.x = clamp(c.x, r, size - r);
  c.y = clamp(c.y, r, size - r);
}

function moveCells(world, ent, tx, ty, dt) {
  for (const c of ent.cells) {
    advanceCell(c, tx, ty, dt, world.size);
    // Decay stays server-side: it is a rule, not motion, and predicting it
    // would have the client quietly disagreeing about mass.
    if (c.mass > DECAY_ABOVE) c.mass -= c.mass * DECAY_RATE * dt;
  }
}

function resolveOwnCells(world, ent) {
  const cells = ent.cells;
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const ra = radiusOf(a.mass), rb = radiusOf(b.mass);
      const mergeable = world.time >= a.mergeAt && world.time >= b.mergeAt;

      if (mergeable && d < Math.max(ra, rb) - Math.min(ra, rb) * 0.4) {
        const big = a.mass >= b.mass ? a : b;
        const small = big === a ? b : a;
        big.mass += small.mass;              // rejoining is mass-neutral
        big.x = big.x * 0.7 + small.x * 0.3;
        big.y = big.y * 0.7 + small.y * 0.3;
        cells.splice(cells.indexOf(small), 1);
        return resolveOwnCells(world, ent);
      }

      if (!mergeable && d < ra + rb) pushApart(a, b, dx, dy, d, ra, rb, SEPARATE_PER_TICK);
    }
  }
}

// Own cells that cannot merge yet are pushed apart, closing this share of the
// overlap each tick.
const SEPARATE_PER_TICK = 0.8;
function pushApart(a, b, dx, dy, d, ra, rb, k) {
  const push = (ra + rb - d) / 2;
  const nx = dx / d, ny = dy / d;
  const wa = b.mass / (a.mass + b.mass), wb = a.mass / (a.mass + b.mass);
  a.x -= nx * push * wa * k; a.y -= ny * push * wa * k;
  b.x += nx * push * wb * k; b.y += ny * push * wb * k;
}

// The same push for the client's prediction, which has to keep split pieces
// apart exactly as the server will or it is corrected on every snapshot.
// Merging is left to the server: it moves mass, and a wrong guess at that is
// far more visible than a piece that overlaps for a frame.
//
// `steps` is how many server ticks `dt` spans. The push is a per-tick
// relaxation, not a rate, so a client stepping at its frame rate scales it to
// close the same share of the overlap per second as the server does.
export function separateCells(cells, locked, steps = 1) {
  const k = steps === 1
    ? SEPARATE_PER_TICK
    : 2 * (1 - Math.pow(1 - SEPARATE_PER_TICK / 2, steps));
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      if (!locked(a) && !locked(b)) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const ra = radiusOf(a.mass), rb = radiusOf(b.mass);
      if (d < ra + rb) pushApart(a, b, dx, dy, d, ra, rb, k);
    }
  }
}

function splitCell(world, ent, cell, dirX, dirY, mass) {
  const half = mass !== undefined ? mass : cell.mass / 2;
  cell.mass -= half;
  const child = makeCell(
    world,
    cell.x + dirX * radiusOf(cell.mass) * 0.4,
    cell.y + dirY * radiusOf(cell.mass) * 0.4,
    half, cell.ci
  );
  const power = splitLaunchSpeed(half);
  child.vx = dirX * power;
  child.vy = dirY * power;
  // Cooldown grows with fragment mass; bigger pieces stay apart longer.
  const cooldown = (11 + half * 0.022) * MERGE_DELAY;
  child.mergeAt = world.time + cooldown;
  cell.mergeAt = child.mergeAt;
  ent.cells.push(child);
  return child;
}

function aimFor(cell, tx, ty) {
  const dx = tx - cell.x, dy = ty - cell.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
}

function doSplit(world, ent, tx, ty) {
  const ready = ent.cells.filter(c => c.mass >= 36).sort((a, b) => b.mass - a.mass);
  let room = MAX_CELLS - ent.cells.length;
  for (const c of ready) {
    if (room <= 0) break;
    const a = aimFor(c, tx, ty);
    splitCell(world, ent, c, a.x, a.y);
    room--;
  }
}

function doEject(world, ent, tx, ty) {
  for (const c of ent.cells) {
    // Ejecting must cost more than it yields, or it becomes a mass printer.
    if (c.mass < EJECT_MASS * 2) continue;
    const a = aimFor(c, tx, ty);
    c.mass -= EJECT_MASS;
    const r = radiusOf(c.mass);
    const blobR = radiusOf(EJECT_KEEP);

    // Spawn clear of the owner's own eating reach. Placed any closer and the
    // blob is swallowed again the instant it appears, which made ejecting a
    // no-op that quietly returned most of the mass.
    // Emerging from the membrane, not detached in mid-air.
    const gap = r + blobR * 0.35;
    const blob = makePellet(
      world, c.x + a.x * gap, c.y + a.y * gap,
      EJECT_KEEP, a.x * EJECT_SPEED, a.y * EJECT_SPEED, c.ci
    );

    blob.owner = ent.id;
    blob.ownerFree = world.time + EJECT_OWNER_COOLDOWN;
    world.pellets.push(blob);
  }
}

function burst(world, ent, cell) {
  const room = MAX_CELLS - ent.cells.length;
  const pieces = Math.min(room, VIRUS_PIECES);
  if (pieces <= 0) return;
  const chunk = cell.mass / (pieces + 1);
  const spin = world.rng() * Math.PI * 2;
  for (let i = 0; i < pieces; i++) {
    const ang = spin + (Math.PI * 2 * i) / pieces + rand(world, -0.18, 0.18);
    const frag = splitCell(world, ent, cell, Math.cos(ang), Math.sin(ang), chunk);
    frag.vx *= 1.4;   // fragments fly further so the pop reads clearly
    frag.vy *= 1.4;
  }
}

// Eaten pellets are flagged rather than spliced out, so the grid built at the
// start of the tick stays valid for everyone else. They are swept once at the
// end of the tick.
function eatPellets(world, ent) {
  for (const c of ent.cells) {
    const r = radiusOf(c.mass);
    forEachPelletNear(world, c.x, c.y, r + ORB_RADIUS * 3, p => {
      if (p.dead) return;
      // Your own mass is yours again only after the cooldown, so driving
      // forward sails past it instead of hoovering it up.
      if (p.owner === ent.id && world.time < p.ownerFree) return;
      // And nothing receding can have been swallowed, whoever threw it.
      if (p.vx || p.vy) {
        const away = (p.x - c.x) * p.vx + (p.y - c.y) * p.vy;
        if (away > 0) return;
      }
      const dx = p.x - c.x, dy = p.y - c.y;
      // An ejected blob is large enough that ignoring its radius would mean
      // visibly overlapping it without eating it.
      const reach = r + pelletRadius(p) * 0.6;
      if (dx * dx + dy * dy < reach * reach) {
        c.mass += p.mass;
        p.dead = true;
        world.pelletsDirty = true;
        ent.orbs++;
        world.events.push({ t: "orb", id: ent.id });
      }
    });
  }
}

// Ejected mass fed into a virus. Only mass still in flight counts: feeding is
// shooting a blob into one, not parking next to it, and a blob that runs out
// of travel short of the virus has missed.
//
// The hit is tested against the virus centre plus the blob's own radius, which
// is what the thrower sees — a blob visibly touching the spikes registers.
function feedViruses(world) {
  for (const p of world.pellets) {
    // Velocity first: it is the most selective test by a long way. Thousands
    // of orbs sit still, and this pass runs over all of them every tick.
    if (!p.vx && !p.vy) continue;
    if (p.dead || p.owner === undefined) continue;
    for (const v of world.viruses) {
      const dx = p.x - v.x, dy = p.y - v.y;
      const reach = radiusOf(v.mass) + pelletRadius(p);
      if (dx * dx + dy * dy > reach * reach) continue;

      p.dead = true;
      world.pelletsDirty = true;
      if (++v.fed < VIRUS_FEED_HITS) break;

      // Full. The child is shot off along the line the mass came in on, which
      // is the whole point: you aim a virus at somebody by choosing where you
      // stand when you feed it.
      v.fed = 0;
      const speed = Math.hypot(p.vx, p.vy) || 1;
      splitVirus(world, v, p.vx / speed, p.vy / speed);
      break;
    }
  }
}

// The population ceiling is checked here rather than at the feed, so the mass
// is always swallowed: a virus that cannot split is still a mass sink, not a
// wall that silently ignores you.
function splitVirus(world, parent, dirX, dirY) {
  if (world.viruses.length >= Math.round(world.virusCount * VIRUS_MAX_RATIO)) return;
  world.viruses.push(makeVirus(
    world, parent.x, parent.y, dirX * VIRUS_SPLIT_SPEED, dirY * VIRUS_SPLIT_SPEED
  ));
}

// A virus pops any cell big enough to swallow it, the moment that cell's body
// covers the virus centre. Smaller cells pass over untouched and can shelter.
function eatViruses(world, ent) {
  for (const c of ent.cells) {
    if (c.mass <= VIRUS_MASS * VIRUS_EAT_RATIO) continue;
    const r = radiusOf(c.mass);
    for (let i = world.viruses.length - 1; i >= 0; i--) {
      const v = world.viruses[i];
      if (Math.hypot(v.x - c.x, v.y - c.y) < r) {
        c.mass += v.mass * 0.4;
        v.dead = true;         // a bot may be holding it as a shot to line up
        world.viruses.splice(i, 1);
        // Topped back up only to the count the arena seeds. Replacing
        // unconditionally would make every fed split permanent, so a long
        // round could only ever gain viruses.
        if (world.viruses.length < world.virusCount) world.viruses.push(makeVirus(world));
        world.events.push({ t: "pop", id: ent.id, x: c.x, y: c.y });
        burst(world, ent, c);
        return;
      }
    }
  }
}

function cellCombat(world) {
  const ents = [...world.players.values()].filter(p => p.alive && p.cells.length);
  for (let i = 0; i < ents.length; i++) {
    for (let j = 0; j < ents.length; j++) {
      if (i === j) continue;
      const A = ents[i], B = ents[j];
      if (!A.cells.length || !B.cells.length) continue;
      for (const a of A.cells) {
        const ra = radiusOf(a.mass);
        for (let k = B.cells.length - 1; k >= 0; k--) {
          const b = B.cells[k];
          if (a.mass < b.mass * EAT_RATIO) continue;
          // Axis reject before the sqrt: with a hundred players this pair
          // loop runs ten thousand times a tick.
          const dx = b.x - a.x; if (dx > ra || dx < -ra) continue;
          const dy = b.y - a.y; if (dy > ra || dy < -ra) continue;
          const rb = radiusOf(b.mass);
          if (Math.hypot(dx, dy) < ra - rb * 0.55) {
            a.mass += b.mass * EAT_BONUS;
            B.cells.splice(k, 1);
            A.eaten++;
            world.events.push({ t: "eat", id: A.id, victim: B.id });
          }
        }
      }
    }
  }
}

const SCAN = 620, SCAN2 = SCAN * SCAN;

// A hunter only goes after prey at least this share of its own mass, and
// counts on catching it this often when weighing a hunt against grazing.
const HUNT_MEAL = 0.2;
const HUNT_ODDS = 0.5;

// The smallest cell a virus bursts.
const POP_MASS = VIRUS_MASS * VIRUS_EAT_RATIO;

// How far a fed virus's child coasts before it stops, ~450 units: its launch
// speed integrated under VIRUS_FRICTION, the same way advanceVirus moves it.
const VIRUS_TRAVEL = VIRUS_SPLIT_SPEED / -VIRUS_LN;

// Clearance between a bot's membrane and the virus it is throwing at. A throw
// travels ~237 units, so this lands every blob while it is still moving.
const VIRUS_SHOT_GAP = 55;

// Where a cell will be in t seconds if it holds its course: steering speed,
// plus whatever is left of a split or burst launch integrated the way
// advanceCell does it.
function ahead(c, t) {
  if (!t) return c;
  const sp = c.sp || 0;
  const coast = c.vx || c.vy ? (1 - Math.pow(CELL_DECAY, t)) / -CELL_LN : 0;
  return {
    x: c.x + (c.hx || 0) * sp * t + (c.vx || 0) * coast,
    y: c.y + (c.hy || 0) * sp * t + (c.vy || 0) * coast
  };
}

// How far from its centre a cell can engulf prey by splitting: where the
// launched half starts, how far it coasts, and how deep its body has to cover
// the prey. The same numbers splitCell and cellCombat use.
function splitReach(mass, preyMass) {
  const half = mass / 2;
  return radiusOf(half) * 1.4 + splitLaunchSpeed(half) / -CELL_LN
    - radiusOf(preyMass) * 0.55;
}

// The shot that bursts `target` with virus v. The child flies along the line
// from the virus to the target, and that line is set by the heading of the
// throw that fills the virus — so the bot stands behind the virus on it.
function virusShot(v, target, myMass) {
  const dx = target.x - v.x, dy = target.y - v.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const back = radiusOf(v.mass) + radiusOf(myMass) + VIRUS_SHOT_GAP;
  return { ux, uy, d, x: v.x - ux * back, y: v.y - uy * back };
}

// A child that has to coast most of its range to arrive has slowed to a crawl
// and is easy to step round, so only a target well inside it counts.
const inVirusRange = (d, targetMass) =>
  d > radiusOf(targetMass) && d - radiusOf(targetMass) < VIRUS_TRAVEL * 0.8;

// Engulfing: split when half of this cell still eats the prey and lands on
// it. Returns the aim, or null to leave it.
function engulf(world, bot, lvl, c0, prey) {
  const p = ahead(prey, lvl.lead);
  const dx = p.x - c0.x, dy = p.y - c0.y;
  const reach = splitReach(c0.mass, prey.mass) * lvl.split.reach;
  if (dx * dx + dy * dy > reach * reach) return null;
  bot.actions.push("split");
  bot.nextSplit = world.time + lvl.split.cooldown;
  return { x: p.x, y: p.y };
}

// Choose a virus to shoot at `target`. A bot big enough to pop has to be
// behind it already, since getting round to the far side means walking into
// the virus. A smaller one crosses it untouched.
function planVirusShot(world, bot, lvl, me, myMass, target, owner) {
  const aim = ahead(target, lvl.virus.lead);
  const pops = myMass > POP_MASS;
  let best = null, bestD = lvl.virus.travel;
  for (const v of world.viruses) {
    const shot = virusShot(v, aim, myMass);
    if (!inVirusRange(shot.d, target.mass)) continue;
    if (pops && (me.x - v.x) * shot.ux + (me.y - v.y) * shot.uy > 0) continue;
    const d = Math.hypot(shot.x - me.x, shot.y - me.y);
    if (d < bestD) { bestD = d; best = v; }
  }
  if (!best) return false;
  bot.plan = {
    v: best, owner: owner.id,
    until: world.time + 1 + bestD / 200,   // time to walk there, and settle
    firing: false, need: 0, shots: 0, nextShot: 0
  };
  return true;
}

function dropPlan(world, bot, wait) {
  bot.plan = null;
  bot.nextVirus = world.time + wait;
  return null;
}

// One tick of a virus shot: walk to the spot behind the virus, then throw
// until it is full. Returns where to steer, with `fire` set on an aim that
// must reach the throw untouched; null once the plan is over.
function stepVirusPlan(world, bot, lvl, me, myMass) {
  const plan = bot.plan;
  const v = plan.v;
  const owner = world.players.get(plan.owner);
  if (v.dead || !owner || !owner.alive || bot.cells.length !== 1) return dropPlan(world, bot, 1);

  // The target may have split since the plan was made. Aim at whichever of
  // its cells the virus would still burst, nearest the virus.
  let t = null, td = Infinity;
  for (const c of owner.cells) {
    if (c.mass <= POP_MASS) continue;
    const d = (c.x - v.x) ** 2 + (c.y - v.y) ** 2;
    if (d < td) { td = d; t = c; }
  }
  if (!t) return dropPlan(world, bot, 1);

  const shot = virusShot(v, ahead(t, lvl.virus.lead), myMass);
  // Out of range of this virus is not out of range of every virus. Look
  // again on the next tick rather than waiting out the usual pause.
  if (!inVirusRange(shot.d, t.mass)) {
    bot.nextLook = world.time;
    return dropPlan(world, bot, 0);
  }

  // Looser once firing, so a target drifting a little does not stop the
  // throws half way: a throw still lands anywhere within the virus's radius
  // of the line.
  const gx = shot.x - me.x, gy = shot.y - me.y;
  const slack = plan.firing ? 50 : 30;
  if (gx * gx + gy * gy > slack * slack) {
    if (world.time > plan.until) return dropPlan(world, bot, 1);
    return { x: shot.x, y: shot.y, fire: false };
  }

  if (!plan.firing) {
    plan.firing = true;
    plan.need = VIRUS_FEED_HITS - v.fed;
  }
  const c0 = bot.cells[0];
  if (c0.mass < EJECT_MASS * 2) return dropPlan(world, bot, lvl.virus.cooldown);
  if (world.time >= plan.nextShot) {
    bot.actions.push("eject");
    plan.shots++;
    plan.nextShot = world.time + 0.1;
    if (plan.shots >= plan.need) dropPlan(world, bot, lvl.virus.cooldown);
  }
  // Throw straight down the line the child will fly. The heading of the throw
  // decides where the virus goes, not the bot's exact spot, and an aim inside
  // the cell barely moves it.
  const k = radiusOf(myMass) * 0.25;
  return { x: me.x + shot.ux * k, y: me.y + shot.uy * k, fire: true };
}

// How far a double split reaches: the half is thrown, coasts for `delay`,
// then splits again and throws a quarter from where it has got to. Each throw
// is a fresh launch — a split piece does not inherit its parent's speed — so
// the quarter's reach is added to however far the half had flown.
function doubleSplitReach(mass, preyMass, delay) {
  const half = mass / 2, quarter = mass / 4;
  const flight = splitLaunchSpeed(half) * (1 - Math.pow(CELL_DECAY, delay)) / -CELL_LN;
  return radiusOf(half) * 0.4 + flight + radiusOf(quarter) * 1.4
    + splitLaunchSpeed(quarter) / -CELL_LN - radiusOf(preyMass) * 0.55;
}

// The first half of a double split: prey past a single split's reach that a
// quarter of this cell still eats. The second half is followUpSplit.
function doubleSplit(world, bot, lvl, lead, prey, owner) {
  const delay = lvl.split.double;
  const p = ahead(prey, lvl.lead + delay);
  const dx = p.x - lead.x, dy = p.y - lead.y;
  const reach = doubleSplitReach(lead.mass, prey.mass, delay) * lvl.split.reach;
  if (dx * dx + dy * dy > reach * reach) return null;
  bot.actions.push("split");
  bot.followUp = { at: world.time + delay, cell: prey, owner };
  bot.nextSplit = world.time + lvl.split.cooldown;
  return { x: p.x, y: p.y };
}

// Steer at the prey until the half is far enough out, then split again. Given
// up if the prey is gone, since the second split is only worth its risk with
// something to land on.
function followUpSplit(world, bot, lvl) {
  const f = bot.followUp;
  if (!f.owner.alive || !f.owner.cells.includes(f.cell)) { bot.followUp = null; return null; }
  const p = ahead(f.cell, lvl.lead);
  if (world.time >= f.at) {
    bot.actions.push("split");
    bot.followUp = null;
  }
  return { x: p.x, y: p.y };
}

// Somewhere to hide from a chaser big enough to burst on a virus: just past a
// nearby virus, on the far side from the chaser, so following means crossing
// it. Only for a bot small enough to pass over viruses itself, and never a
// spot that means running at the chaser to reach it.
function shelter(world, me, threat, range) {
  let best = null, bestD = range;
  const tx = threat.x - me.x, ty = threat.y - me.y;
  for (const v of world.viruses) {
    const vx = v.x - me.x; if (vx > range || vx < -range) continue;
    const vy = v.y - me.y; if (vy > range || vy < -range) continue;
    const ax = v.x - threat.x, ay = v.y - threat.y;
    const da = Math.hypot(ax, ay) || 1;
    // A virus the chaser is already on top of is no wall.
    if (da < radiusOf(threat.mass)) continue;
    const back = radiusOf(v.mass) * 0.8;
    const sx = v.x + (ax / da) * back, sy = v.y + (ay / da) * back;
    const mx = sx - me.x, my = sy - me.y;
    if (mx * tx + my * ty > 0) continue;
    const d = Math.hypot(mx, my);
    if (d < bestD) { bestD = d; best = { x: sx, y: sy }; }
  }
  return best;
}

// The orb most worth going for: mass for distance, so a cluster or a thrown
// blob (worth four orbs) beats a lone orb slightly nearer. Its own throw is
// left alone until the thrower may take it back.
function grazeTarget(world, bot, me) {
  let best = null, bestScore = 0;
  forEachPelletNear(world, me.x, me.y, 500, p => {
    if (p.dead) return;
    if (p.owner === bot.id && world.time < p.ownerFree) return;
    const score = p.mass / (Math.hypot(p.x - me.x, p.y - me.y) + 60);
    if (score > bestScore) { bestScore = score; best = p; }
  });
  return best;
}

function driveBot(world, bot, dt) {
  const c0 = bot.cells[0];
  if (!c0) return { x: world.size / 2, y: world.size / 2 };
  const lvl = BOT_LEVELS[world.botLevel] || BOT_LEVELS[DEFAULT_BOT_LEVEL];
  // Almost every bot is one cell; centroid() allocates and this runs a
  // hundred times a tick.
  const me = bot.cells.length === 1 ? c0 : centroid(bot);
  const myMass = bot.cells.length === 1 ? c0.mass : totalMass(bot);
  const whole = bot.cells.length === 1;

  // The second half of a double split already under way comes first.
  if (bot.followUp) {
    const go = followUpSplit(world, bot, lvl);
    if (go) return go;
  }

  // A bot that splits again while in pieces judges what it can engulf by its
  // biggest piece. Otherwise by its first cell, as always.
  let lead = c0;
  if (!whole && lvl.split && lvl.split.cells > 1) {
    for (const c of bot.cells) if (c.mass > lead.mass) lead = c;
  }

  // What the level can attack with right now. A virus shot needs a whole
  // cell; a split needs no more pieces than the level allows.
  const split = lvl.split && bot.cells.length <= (lvl.split.cells || 1) && lead.mass >= 36 &&
    world.time >= bot.nextSplit ? lvl.split : null;
  const double = split && split.double && whole && lead.mass >= 72 ? split : null;
  const look = lvl.virus && whole && !bot.plan && c0.mass >= lvl.virus.minMass &&
    world.time >= bot.nextVirus && world.time >= bot.nextLook;
  if (look) bot.nextLook = world.time + 0.5;

  let threat = null, threatD2 = Infinity, prey = null, preyD2 = Infinity;
  // Prey that half of this cell still eats, for a split.
  let bite = null, biteD2 = Infinity;
  // Anything that could eat half of this cell, if it split.
  let exposed = false;
  // The same for a double split, which lands a quarter.
  let bite4 = null, bite4Owner = null, bite4D2 = Infinity, exposed4 = false;
  // Prey further off than the bot can see from where it is, for a hunter:
  // the best meal for the distance, and only a meal worth the trip. A cell a
  // fraction of the bot's size is faster than it and barely worth catching,
  // and chasing one across the arena is mass not eaten on the way.
  let hunted = null, huntedScore = 0;
  const meal = lead.mass * HUNT_MEAL;
  // Anyone at all in sight. A bot with company fights and grazes where it
  // is: in a crowded arena there is always prey somewhere further off, and
  // chasing it means never stopping to eat.
  let company = false;
  // The nearest cell a virus would burst, for a virus shot.
  let big = null, bigOwner = null, bigD2 = Infinity;
  const canBeEatenBy = c0.mass * EAT_RATIO;
  const canEat = lead.mass / (EAT_RATIO * 1.1);
  const canBite = split ? lead.mass / 2 / (EAT_RATIO * split.margin) : 0;
  const canBite4 = double ? lead.mass / 4 / (EAT_RATIO * split.margin) : 0;
  // The smallest piece a split leaves: that is what an onlooker could eat.
  let piece = Infinity;
  if (split) for (const c of bot.cells) piece = Math.min(piece, c.mass >= 36 ? c.mass / 2 : c.mass);
  const eatsHalf = piece * EAT_RATIO;
  const eatsQuarter = lead.mass / 4 * EAT_RATIO;
  const safe2 = split ? split.safe * split.safe : 0;
  const hunt2 = lvl.hunt ? lvl.hunt * lvl.hunt : 0;
  const see = look && lvl.virus.see ? lvl.virus.see : SCAN;
  const see2 = see * see;
  // As far as anything above needs to look. SCAN on every level without a
  // hunt or a longer virus sight, which is exactly the old search.
  const view = Math.max(SCAN, lvl.hunt || 0, look ? see : 0);
  const view2 = view * view;
  for (const o of world.players.values()) {
    if (o === bot || !o.alive) continue;
    for (const c of o.cells) {
      // Cheap rejects first: an axis test, then squared distance. sqrt only
      // when a candidate is actually chosen.
      const dx = c.x - me.x; if (dx > view || dx < -view) continue;
      const dy = c.y - me.y; if (dy > view || dy < -view) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > view2) continue;
      if (d2 <= SCAN2) {
        company = true;
        if (c.mass > canBeEatenBy) { if (d2 < threatD2) { threat = c; threatD2 = d2; } }
        else if (c.mass < canEat) { if (d2 < preyD2) { prey = c; preyD2 = d2; } }
        if (c.mass < canBite && d2 < biteD2) { bite = c; biteD2 = d2; }
        if (d2 < safe2 && c.mass >= eatsHalf) exposed = true;
        if (double) {
          if (c.mass < canBite4 && d2 < bite4D2) { bite4 = c; bite4Owner = o; bite4D2 = d2; }
          if (d2 < safe2 && c.mass >= eatsQuarter) exposed4 = true;
        }
      }
      if (hunt2 && d2 > SCAN2 && d2 <= hunt2 && c.mass < canEat && c.mass >= meal) {
        // Mass gained per unit of distance, like an orb's score in
        // grazeTarget, discounted for the chance the prey gets away.
        const score = (c.mass * EAT_BONUS * HUNT_ODDS) / (Math.sqrt(d2) + 200);
        if (score > huntedScore) { hunted = c; huntedScore = score; }
      }
      if (look && d2 <= see2 && c.mass > POP_MASS && c.mass >= canEat && d2 < bigD2) {
        big = c; bigOwner = o; bigD2 = d2;
      }
    }
  }
  const threatD = threat ? Math.sqrt(threatD2) : Infinity;
  const preyD = prey ? Math.sqrt(preyD2) : Infinity;

  // A bot throwing at a virus holds its ground longer. The virus stands
  // between it and the target, and anything big enough to eat it pops first.
  const nerve = bot.plan && bot.plan.firing ? lvl.virus.nerve : 260;

  let tx, ty, go;
  if (threat && threatD < radiusOf(threat.mass) + nerve) {
    // Run behind a virus if the chaser would burst on it; otherwise run.
    const hide = lvl.virus && lvl.virus.shield && threat.mass > POP_MASS && myMass < POP_MASS
      ? shelter(world, me, threat, lvl.virus.shield) : null;
    if (hide) { tx = hide.x; ty = hide.y; }
    else {
      tx = me.x - (threat.x - me.x) * 3;
      ty = me.y - (threat.y - me.y) * 3;
    }
  } else if (split && bite && !exposed && (go = engulf(world, bot, lvl, lead, bite))) {
    return go;
  } else if (double && bite4 && !exposed4 && (go = doubleSplit(world, bot, lvl, lead, bite4, bite4Owner))) {
    return go;
  } else if ((bot.plan || (look && big && planVirusShot(world, bot, lvl, me, myMass, big, bigOwner))) &&
             (go = stepVirusPlan(world, bot, lvl, me, myMass))) {
    if (go.fire) return go;
    tx = go.x; ty = go.y;
  } else if (prey && preyD < lvl.chase) {
    const p = ahead(prey, lvl.lead);
    tx = p.x; ty = p.y;
  } else {
    // A hunt has to beat grazing. Crossing the arena after prey is mass not
    // eaten on the way, which is a poor trade in a crowded arena, where
    // there is always prey somewhere; in an empty one, prey is the only big
    // meal there is.
    const best = lvl.graze ? grazeTarget(world, bot, me) : null;
    const grazeScore = best ? best.mass / (Math.hypot(best.x - me.x, best.y - me.y) + 60) : 0;
    if (hunted && !company && huntedScore > grazeScore) {
      const p = ahead(hunted, lvl.lead);
      tx = p.x; ty = p.y;
    } else if (best) { tx = best.x; ty = best.y; }
    else {
      // Nearest orb via the spatial grid, not a scan of the whole arena. With
      // 100 bots and 4,100 orbs the scan was 410,000 distance checks a tick —
      // 80% of the free tier's tick budget on its own, and the reason the
      // server fell behind. Search widens if the neighbourhood is bare.
      let near = null, nd = Infinity;
      for (const reach of [300, 700, 1500]) {
        forEachPelletNear(world, me.x, me.y, reach, p => {
          if (p.dead) return;
          const d = (p.x - me.x) ** 2 + (p.y - me.y) ** 2;
          if (d < nd) { nd = d; near = p; }
        });
        if (near) break;
      }
      bot.jitter += dt * 0.7;
      if (near) { tx = near.x + Math.cos(bot.jitter) * 40; ty = near.y + Math.sin(bot.jitter) * 40; }
      else { tx = world.size / 2 + Math.cos(bot.jitter) * 900; ty = world.size / 2 + Math.sin(bot.jitter) * 900; }
    }
  }

  if (myMass >= VIRUS_MASS * VIRUS_EAT_RATIO) {
    for (const v of world.viruses) {
      if (Math.hypot(v.x - me.x, v.y - me.y) < 130) {
        tx = me.x - (v.x - me.x) * 2;
        ty = me.y - (v.y - me.y) * 2;
        break;
      }
    }
  }

  return { x: clamp(tx, 60, world.size - 60), y: clamp(ty, 60, world.size - 60) };
}

// ── the closing zone ────────────────────────────────────────────────────────

// How far inside the safe area's edge a bot keeps its aim: a couple of
// seconds' grace against an edge moving in at under 80 units a second, plus
// room for its own body. A big bot in pieces spreads them around its aim, and
// with only the grace they hung outside and bled.
const ZONE_BOT_MARGIN = 160;
const zoneMarginOf = mass => ZONE_BOT_MARGIN + radiusOf(mass) * 1.5;

// Plan this round's zone, given when the round ends on world.time. The final
// square is drawn from the world's own generator, so a seeded world replays
// the same zone. A round too short to give the full warning before its edges
// would move — a short ROUND_SECONDS — gets the warning anyway and starts
// late; one too short for even that gets no zone.
export function planZone(world, roundEndsAt) {
  // The announcement first, and the rest from it: in a short round it is
  // exactly now, where now + 10 - 10 can come out a hair after now and miss
  // the snapshot sent on the tick the round opens.
  const warnAt = Math.max(world.time, roundEndsAt - ZONE_AT_REMAINING - ZONE_WARN_SECONDS);
  const startAt = warnAt + ZONE_WARN_SECONDS;
  if (!(startAt < roundEndsAt)) { world.zone = null; return null; }
  // Whole units, because they travel as u16: the square the client draws and
  // the square the server enforces are then exactly the same square.
  const side = Math.round(world.size * ZONE_SHRINK_TO);
  const x = Math.round(rand(world, 0, world.size - side));
  const y = Math.round(rand(world, 0, world.size - side));
  world.zone = {
    size: world.size,
    warnAt,
    startAt,
    endAt: Math.min(roundEndsAt, startAt + ZONE_SHRINK_SECONDS),
    to: { x0: x, y0: y, x1: x + side, y1: y + side }
  };
  return world.zone;
}

// The safe area at a moment: the whole arena until the edges start to move,
// the final square once they have arrived, and each edge moving at its own
// steady speed between the two.
export function zoneBounds(zone, time) {
  const k = clamp((time - zone.startAt) / (zone.endAt - zone.startAt), 0, 1);
  const { to, size } = zone;
  return {
    x0: to.x0 * k, y0: to.y0 * k,
    x1: size + (to.x1 - size) * k, y1: size + (to.y1 - size) * k
  };
}

// A cell is outside when its centre is, the same test the minimap answers.
export const outsideZone = (b, x, y) => x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1;

function drainOutside(world, ent, safe, dt) {
  for (let i = ent.cells.length - 1; i >= 0; i--) {
    const c = ent.cells[i];
    if (!outsideZone(safe, c.x, c.y)) continue;
    c.mass -= (c.mass * ZONE_DRAIN + ZONE_DRAIN_FLAT) * dt;
    if (c.mass >= ZONE_MIN_MASS) continue;
    ent.cells.splice(i, 1);
    // The zone took the last of them. Nobody ate this player, and the death
    // event has to say so, or settlement pays whoever bit them last.
    if (!ent.cells.length) ent.zoned = true;
  }
}

// ── the tick ────────────────────────────────────────────────────────────────

// `held` freezes every player where they stand: the start of a round, with
// the field on its starting ring. Nobody steers, splits, throws, eats or is
// eaten, bots included, and actions sent meanwhile are dropped rather than
// kept, so nobody banks a split to fire on the first free tick. Aim is still
// taken, so everyone leaves the ring on the same tick, heading wherever they
// were pointing. Time and the orb index still advance as usual.
export function stepWorld(world, dt, held = false) {
  world.tick++;
  world.time += dt;
  world.events.length = 0;
  // Once a tick, for everyone who needs it: the drain, the bots, the host.
  world.safe = world.zone && world.time >= world.zone.startAt
    ? zoneBounds(world.zone, world.time) : null;

  for (const p of world.pellets) advancePellet(p, dt, world.size);
  for (const v of world.viruses) advanceVirus(v, dt, world.size);
  // After both have moved, so a blob and a virus travelling toward each other
  // are tested where they actually are this tick.
  feedViruses(world);

  for (const ent of world.players.values()) {
    if (held) { ent.actions.length = 0; continue; }
    if (!ent.alive) {
      if (ent.bot && world.time >= ent.respawnAt) {
        spawnPlayer(world, ent, rand(world, 18, 34));
      } else if (!ent.bot && ent.actions.includes("respawn")) {
        spawnPlayer(world, ent);
        ent.orbs = 0; ent.eaten = 0; ent.peak = START_MASS;
      }
      ent.actions.length = 0;
      continue;
    }

    // Target is the player's own centroid plus their aim offset, which keeps
    // the meaning of "aim" independent of any client's viewport.
    const me = centroid(ent);
    let tx, ty;
    if (ent.bot) {
      const t = driveBot(world, ent, dt);
      tx = t.x; ty = t.y;
      // Nothing a bot wants is worth having outside the safe area, so
      // whatever it was after, it aims inside. Applied here rather than in
      // driveBot so every one of its plans is covered, splits included.
      if (world.safe) {
        const m = zoneMarginOf(totalMass(ent));
        tx = clamp(tx, world.safe.x0 + m, world.safe.x1 - m);
        ty = clamp(ty, world.safe.y0 + m, world.safe.y1 - m);
      }
    } else {
      tx = me.x + ent.input.x;
      ty = me.y + ent.input.y;
    }

    for (const action of ent.actions) {
      if (action === "split") doSplit(world, ent, tx, ty);
      else if (action === "eject") doEject(world, ent, tx, ty);
    }
    ent.actions.length = 0;

    moveCells(world, ent, tx, ty, dt);
    resolveOwnCells(world, ent);
    eatPellets(world, ent);
    eatViruses(world, ent);
    if (world.safe) drainOutside(world, ent, world.safe, dt);
    ent.peak = Math.max(ent.peak, totalMass(ent));
  }

  // Refresh standings before combat. A player whose cells are eaten this tick
  // has zero mass by the time the death is detected, so their finishing
  // position has to be read from the moment before the fatal bite.
  if (world.tick % 4 === 0) {
    const standings = [];
    for (const p of world.players.values()) {
      if (p.alive && p.cells.length) { p._m = totalMass(p); standings.push(p); }
    }
    standings.sort((a, b) => b._m - a._m);
    // The denominator is everyone who started, not everyone still breathing.
    // "3 of 12" halfway through a hundred-player round tells you nothing about
    // the round you are actually in; "3 of 101" does.
    const field = world.players.size;
    for (let i = 0; i < standings.length; i++) {
      standings[i].rank = i + 1;
      standings[i].of = field;
    }
  }

  if (!held) cellCombat(world);

  for (const ent of world.players.values()) {
    if (ent.alive && ent.cells.length === 0) {
      ent.alive = false;
      ent.respawnAt = world.time + rand(world, 2.5, 5);
      // Everything a match record needs travels with the event, because the
      // player object is reset the moment they respawn.
      world.events.push({
        t: "death",
        id: ent.id,
        rank: ent.rank,
        of: ent.of,
        orbs: ent.orbs,
        eaten: ent.eaten,
        peak: Math.round(ent.peak),
        duration: Math.max(0, world.time - ent.spawnedAt),
        // Drained by the closing zone rather than eaten.
        zone: !!ent.zoned
      });
    }
  }

  // Sweep eaten pellets. One pass, once a tick.
  if (world.pelletsDirty) {
    world.pellets = world.pellets.filter(p => !p.dead);
    world.pelletsDirty = false;
  }

  // Rebuilt at the END of the tick, not the start. Pellets are created during
  // a tick (ejected mass, respawns) and ejected ones drift between buckets, so
  // an index built at the start is already wrong by the time snapshots are
  // encoded — which showed up as orbs flickering in and out of view.
  buildPelletGrid(world);

  // Then the arena is topped back up against it, so each replacement keeps
  // its distance from everything still in play. sowOrbs indexes what it adds.
  sowOrbs(world);

  return world.events;
}

// Wipe the arena for a fresh round: new orbs, new spores, everyone respawned
// at starting mass with their per-round counters cleared. The player set is
// kept, so connected clients roll straight into the next round.
export function resetArena(world) {
  // First, so the fresh orbs and spores below are spread over the whole arena
  // rather than inside the last round's final square.
  world.zone = null;
  world.safe = null;

  world.viruses.length = 0;
  for (let i = 0; i < world.virusCount; i++) world.viruses.push(makeVirus(world));

  // Evenly spaced rather than scattered: a fresh round should not hand anyone
  // a neighbour within eating distance while someone else opens alone.
  spawnRing(world, [...world.players.values()]);

  // Sown after the ring, so the cells it keeps clear of are this round's and
  // not wherever the last round left them. The index is emptied first: it
  // still holds the old board, and sowOrbs spaces against it.
  world.pellets.length = 0;
  buildPelletGrid(world);
  sowOrbs(world);

  for (const p of world.players.values()) {
    p.orbs = 0;
    p.eaten = 0;
    p.peak = START_MASS;
  }
  world.events.length = 0;
}

// ── read models ─────────────────────────────────────────────────────────────

export function leaderboard(world, limit = 10) {
  return [...world.players.values()]
    .filter(p => p.alive)
    .map(p => ({ id: p.id, name: p.name, mass: Math.round(totalMass(p)) }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, limit);
}

// Standings are computed once per tick in stepWorld and stored on each
// player. Reading them here instead of re-sorting means a room of 100 does
// one sort a tick rather than one per client — which was 100 sorts.
export function rankOf(world, id) {
  const p = world.players.get(id);
  if (p && p.alive && p.rank) return { rank: p.rank, of: p.of };
  // Fallback for a player not yet ranked (first tick, or dead).
  let of = 0;
  for (const q of world.players.values()) if (q.alive && q.cells.length) of++;
  return { rank: 0, of };
}
