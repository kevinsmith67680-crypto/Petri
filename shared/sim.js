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
export const PELLET_MASS = 3.375;   // mass gained per orb
export const EJECT_MASS = 16;       // mass spent ejecting
export const EJECT_KEEP = 13;       // mass the ejected blob carries
export const ORB_RADIUS = 6;        // a plain orb, fixed size regardless of mass
export const VIRUS_MASS = 110;
export const VIRUS_EAT_RATIO = 1.15; // how much bigger you must be to pop one
export const VIRUS_PIECES = 9;       // fragments a virus scatters you into
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
export const EAT_BONUS = 1.20;       // mass multiplier when absorbing a rival
export const MERGE_DELAY = 1.75;     // multiplier on the rejoin cooldown
export const DECAY_ABOVE = 260;      // mass above which cells slowly shrink

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

export const TICK_HZ = 20;           // authoritative server tick rate
export const STAIN_COUNT = 7;        // palette slots; colours live client-side

export const BOT_NAMES = [
  "Coccus", "Bacillus", "Spirillum", "Vibrio", "Amoeba", "Paramecium",
  "Euglena", "Volvox", "Diatom", "Rotifer", "Stentor", "Ciliate",
  "Chlorella", "Tardigrade", "Nostoc", "Spirogyra"
];

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
  for (const p of world.pellets) {
    const k = key((p.x / GRID) | 0, (p.y / GRID) | 0);
    const bucket = g.get(k);
    if (bucket) bucket.push(p);
    else g.set(k, [p]);
  }
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
    rng: mulberry32(seed),
    tick: 0,
    time: 0,          // seconds since world creation; all timers use this
    nextId: 1,
    nextNid: 1,       // compact numeric player id, used on the wire
    pellets: [],
    pelletsDirty: false,
    grid: null,
    viruses: [],
    players: new Map(),
    events: []        // drained by the host each tick
  };

  for (let i = 0; i < world.pelletCount; i++) world.pellets.push(makePellet(world));
  for (let i = 0; i < world.virusCount; i++) world.viruses.push(makeVirus(world));
  return world;
}

const rand = (world, a, b) => a + world.rng() * (b - a);

function spawnPoint(world) {
  const pad = 140;
  return { x: rand(world, pad, world.size - pad), y: rand(world, pad, world.size - pad) };
}

function makePellet(world, x, y, mass, vx, vy, ci) {
  const p = x === undefined ? spawnPoint(world) : { x, y };
  return {
    id: world.nextId++,
    x: p.x, y: p.y,
    mass: mass || PELLET_MASS,
    vx: vx || 0, vy: vy || 0,
    ci: ci === undefined ? Math.floor(world.rng() * STAIN_COUNT) : ci
  };
}

function makeVirus(world) {
  const p = spawnPoint(world);
  return { id: world.nextId++, x: p.x, y: p.y, mass: VIRUS_MASS };
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
    jitter: world.rng() * Math.PI * 2
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
  player.cells = [makeCell(world, p.x, p.y, mass, player.ci)];
  player.alive = true;
  player.spawnedAt = world.time;
  player.rank = 0;
  player.of = 0;
  player.input.x = 0;
  player.input.y = 0;
  player.actions.length = 0;
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
    if (c.mass > DECAY_ABOVE) c.mass -= c.mass * 0.0022 * dt;
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

      if (!mergeable && d < ra + rb) {
        const push = (ra + rb - d) / 2;
        const nx = dx / d, ny = dy / d;
        const wa = b.mass / (a.mass + b.mass), wb = a.mass / (a.mass + b.mass);
        a.x -= nx * push * wa * 0.8; a.y -= ny * push * wa * 0.8;
        b.x += nx * push * wb * 0.8; b.y += ny * push * wb * 0.8;
      }
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
        world.viruses.splice(i, 1);
        world.viruses.push(makeVirus(world));
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

function driveBot(world, bot, dt) {
  const c0 = bot.cells[0];
  if (!c0) return { x: world.size / 2, y: world.size / 2 };
  // Almost every bot is one cell; centroid() allocates and this runs a
  // hundred times a tick.
  const me = bot.cells.length === 1 ? c0 : centroid(bot);
  const myMass = bot.cells.length === 1 ? c0.mass : totalMass(bot);

  let threat = null, threatD2 = Infinity, prey = null, preyD2 = Infinity;
  const canBeEatenBy = c0.mass * EAT_RATIO;
  const canEat = c0.mass / (EAT_RATIO * 1.1);
  for (const o of world.players.values()) {
    if (o === bot || !o.alive) continue;
    for (const c of o.cells) {
      // Cheap rejects first: an axis test, then squared distance. sqrt only
      // when a candidate is actually chosen.
      const dx = c.x - me.x; if (dx > SCAN || dx < -SCAN) continue;
      const dy = c.y - me.y; if (dy > SCAN || dy < -SCAN) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > SCAN2) continue;
      if (c.mass > canBeEatenBy) { if (d2 < threatD2) { threat = c; threatD2 = d2; } }
      else if (c.mass < canEat) { if (d2 < preyD2) { prey = c; preyD2 = d2; } }
    }
  }
  const threatD = threat ? Math.sqrt(threatD2) : Infinity;
  const preyD = prey ? Math.sqrt(preyD2) : Infinity;

  let tx, ty;
  if (threat && threatD < radiusOf(threat.mass) + 260) {
    tx = me.x - (threat.x - me.x) * 3;
    ty = me.y - (threat.y - me.y) * 3;
  } else if (prey && preyD < 430) {
    tx = prey.x; ty = prey.y;
  } else {
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

// ── the tick ────────────────────────────────────────────────────────────────

export function stepWorld(world, dt) {
  world.tick++;
  world.time += dt;
  world.events.length = 0;

  for (const p of world.pellets) advancePellet(p, dt, world.size);

  for (const ent of world.players.values()) {
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

  cellCombat(world);

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
        duration: Math.max(0, world.time - ent.spawnedAt)
      });
    }
  }

  // Sweep eaten pellets and top the arena back up. One pass, once a tick.
  if (world.pelletsDirty) {
    world.pellets = world.pellets.filter(p => !p.dead);
    while (world.pellets.length < world.pelletCount) world.pellets.push(makePellet(world));
    world.pelletsDirty = false;
  }

  // Rebuilt at the END of the tick, not the start. Pellets are created during
  // a tick (ejected mass, respawns) and ejected ones drift between buckets, so
  // an index built at the start is already wrong by the time snapshots are
  // encoded — which showed up as orbs flickering in and out of view.
  buildPelletGrid(world);

  return world.events;
}

// Wipe the arena for a fresh round: new orbs, new spores, everyone respawned
// at starting mass with their per-round counters cleared. The player set is
// kept, so connected clients roll straight into the next round.
export function resetArena(world) {
  world.pellets.length = 0;
  for (let i = 0; i < world.pelletCount; i++) world.pellets.push(makePellet(world));

  world.viruses.length = 0;
  for (let i = 0; i < world.virusCount; i++) world.viruses.push(makeVirus(world));

  for (const p of world.players.values()) {
    spawnPlayer(world, p);
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
