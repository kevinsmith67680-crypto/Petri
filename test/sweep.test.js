// ---------------------------------------------------------------------------
// Fast things must not pass through what they should have hit. Run with:
//   node test/sweep.test.js
//
// Everything that moves is integrated as one straight step per tick, and
// collisions used to be tested only where that step ended. A small split half
// covers more ground in one 50ms step than its eat window on small prey is
// wide, and the server steps by measured time, up to 250ms, so a late tick did
// the same to thrown mass, shot viruses and big split pieces. Collisions are
// now tested along the step as well (see "swept collision" in shared/sim.js).
//
// These check that the step is covered, at every tick length the server can
// produce, without changing any rule: eat ratio, owner cooldown, receding
// mass, pop mass, the order players act in, one consumption per thing.
// ---------------------------------------------------------------------------

import {
  createWorld, addPlayer, stepWorld, queueAction, buildPelletGrid, forEachPelletNear,
  advanceCell, radiusOf, pelletRadius, EAT_RATIO, EAT_BONUS, PELLET_MASS, EJECT_SPEED,
  EJECT_KEEP, VIRUS_MASS, VIRUS_EAT_RATIO, VIRUS_SPLIT_SPEED, DECAY_RATE, TICK_HZ
} from "../shared/sim.js";

let failures = 0;

function check(label, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const DT = 1 / TICK_HZ;
// Every tick length the server can step by: nominal, late, and the 250ms cap.
const TICKS = [0.05, 0.1, 0.15, 0.2, 0.25];
const POP_MASS = VIRUS_MASS * VIRUS_EAT_RATIO;

// ── fixtures ────────────────────────────────────────────────────────────────

const bare = (seed = 1, size = 8800) => createWorld(seed, { size, pellets: 0, viruses: 0 });

// A human with no aim and no launch speed stays exactly where it is put.
function still(w, id, x, y, mass) {
  const p = addPlayer(w, { id, name: id });
  Object.assign(p.cells[0], { x, y, mass });
  return p;
}

// A cell already coasting, the way a split launches one, with nothing
// steering it.
function flung(w, id, x, y, mass, vx, vy = 0) {
  const p = still(w, id, x, y, mass);
  Object.assign(p.cells[0], { vx, vy });
  return p;
}

// Where a flung cell will be after one step of dt: the same advanceCell
// stepWorld runs, aimed where it already is.
function landing(c, dt) {
  const q = { ...c };
  advanceCell(q, c.x, c.y, dt, 8800);
  return q;
}

function orb(w, x, y, extra = {}) {
  const p = { id: w.nextId++, x, y, mass: PELLET_MASS, vx: 0, vy: 0, ci: 0, ...extra };
  w.pellets.push(p);
  return p;
}

function virus(w, x, y, vx = 0, vy = 0) {
  const v = { id: w.nextId++, vid: 900 + w.viruses.length, x, y, mass: VIRUS_MASS, fed: 0, vx, vy };
  w.viruses.push(v);
  return v;
}

const eats = (events, victim) => events.filter(e => e.t === "eat" && e.victim === victim);
const front = p => p.cells.reduce((a, b) => (b.x > a.x ? b : a));

// ── high-speed splitting at 20Hz ────────────────────────────────────────────
//
// A mass-120 cell splits at still mass-20 prey. Its half, mass 60, covers ~68
// units in its first step against an eat window 42 wide, so at some distances
// it used to land either side of the prey and never on it.

console.log("\n-- a split half eats the prey it passes over, at 20Hz --");
{
  const skipped = [], byParent = [];
  for (let ahead = 60; ahead <= 200; ahead += 5) {
    const w = bare(61);
    const H = still(w, "H", 2000, 2000, 120);
    const P = still(w, "P", 2000 + ahead, 2000, 20);
    H.input.x = 1000;
    queueAction(w, "H", "split");
    let passed = false;
    for (let t = 0; t < 8 && P.cells.length && !passed; t++) {
      stepWorld(w, DT);
      const piece = front(H);
      if (P.cells.length && piece.x - radiusOf(piece.mass) > P.cells[0].x) passed = true;
    }
    if (P.cells.length) { skipped.push(ahead); continue; }
    // The launched half did it, not the parent walking on later.
    if (H.cells.length !== 2 || front(H).mass < 60 + 20 * EAT_BONUS - 1) byParent.push(ahead);
  }
  check("no prey distance from 60 to 200 is stepped over", !skipped.length, skipped.join(","));
  check("and every kill is the launched half's", !byParent.length, byParent.join(","));
}

// ── every tick length ───────────────────────────────────────────────────────

console.log("\n-- each of these lands at every tick length from 50 to 250ms --");
{
  const missed = { feed: [], engulf: [], blob: [], shot: [], bigPop: [] };
  for (const dt of TICKS) {
    // A blob thrown straight at a virus 110 units ahead.
    {
      const w = bare(51);
      const A = still(w, "A", 2000, 2000, 120);
      A.input.x = 1000;
      queueAction(w, "A", "eject");
      stepWorld(w, DT);
      A.input.x = 0;
      const blob = w.pellets.find(p => p.owner === "A");
      const v = virus(w, blob.x + 110, blob.y);
      for (let i = 0; i < 6 && !v.fed; i++) stepWorld(w, dt);
      if (v.fed !== 1) missed.feed.push(dt);
    }
    // A mass-1000 cell splits onto still prey 180 units ahead: on the split
    // tick itself, after which the half is moving away.
    {
      const w = bare(52);
      const H = still(w, "H", 2000, 2000, 1000);
      const P = still(w, "P", 2180, 2000, 20);
      H.input.x = 1000;
      queueAction(w, "H", "split");
      stepWorld(w, dt);
      if (P.cells.length) missed.engulf.push(dt);
    }
    // A fresh throw from 60 units out, straight through a mass-20 cell.
    {
      const w = bare(53);
      const C = still(w, "C", 3000, 3000, 20);
      orb(w, 2940, 3000, { mass: EJECT_KEEP, vx: EJECT_SPEED, vy: 0, owner: "rival", ownerFree: 0 });
      buildPelletGrid(w);
      stepWorld(w, dt);
      if (C.orbs !== 1) missed.blob.push(dt);
    }
    // A shot virus fired across a mass-200 cell from 80 units out.
    {
      const w = bare(54);
      still(w, "C", 3000, 3000, 200);
      virus(w, 2920, 3000, VIRUS_SPLIT_SPEED, 0);
      const ev = stepWorld(w, dt);
      if (!ev.some(e => e.t === "pop" && e.id === "C")) missed.shot.push(dt);
    }
    // A mass-2000 cell splits; its mass-1000 half crosses a virus 330 ahead.
    {
      const w = bare(55);
      const H = still(w, "H", 2000, 2000, 2000);
      const v = virus(w, 2330, 2000);
      H.input.x = 1000;
      queueAction(w, "H", "split");
      let popped = false, passed = false;
      for (let i = 0; i < 12 && !popped && !passed; i++) {
        popped = stepWorld(w, dt).some(e => e.t === "pop" && e.id === "H");
        const piece = front(H);
        passed = !popped && piece.x - radiusOf(piece.mass) > v.x;
      }
      if (!popped) missed.bigPop.push(dt);
    }
  }
  check("a thrown blob feeds the virus it is thrown at", !missed.feed.length, missed.feed.join(","));
  check("a split half engulfs prey it passes on the split tick", !missed.engulf.length, missed.engulf.join(","));
  check("a blob thrown through a small cell is eaten", !missed.blob.length, missed.blob.join(","));
  check("a shot virus pops the cell it crosses", !missed.shot.length, missed.shot.join(","));
  check("a big split half pops the virus it crosses", !missed.bigPop.length, missed.bigPop.join(","));
}

// ── the query covers the whole step ─────────────────────────────────────────
//
// On a 250ms tick a flung piece travels ~265 units: an orb it passes near the
// start of the step is far outside a query box drawn around where it ends.

console.log("\n-- a long step eats along its whole length, and only there --");
{
  const dt = 0.25;
  const w = bare(56);
  const A = flung(w, "A", 2000, 3000, 150, 1700);
  const end = landing(A.cells[0], dt);
  const r = radiusOf(150), reach = r + pelletRadius({ mass: PELLET_MASS }) * 0.6;
  const inside = [], outside = [], beyond = [];
  for (let x = 2000; x <= end.x; x += 20) {
    inside.push(orb(w, x, 3000 + reach - 0.5));
    outside.push(orb(w, x, 3000 - reach - 0.5));
  }
  beyond.push(orb(w, end.x + reach + 2, 3000));
  buildPelletGrid(w);
  stepWorld(w, dt);
  const firstDist = end.x - inside[0].x;
  check(`every orb within reach of the step is eaten (${inside.length}, the first ${firstDist.toFixed(0)} units behind the end)`,
    inside.every(p => p.dead), `${inside.filter(p => !p.dead).length} left`);
  check("none just outside reach is", !outside.some(p => p.dead), `${outside.filter(p => p.dead).length} eaten`);
  check("nor past where the step ends", !beyond.some(p => p.dead));
  check("each counted once", A.orbs === inside.length, `${A.orbs} for ${inside.length}`);
}

// ── rules the sweep must not change ─────────────────────────────────────────

console.log("\n-- the rules are the same along the way --");
for (const dt of [0.05, 0.25]) {
  // Eat ratio: a half that cannot eat the cell it crosses leaves it alone.
  {
    const run = preyMass => {
      const w = bare(57);
      const H = still(w, "H", 2000, 2000, 1000);
      const P = still(w, "P", 2180, 2000, preyMass);
      H.input.x = 1000;
      queueAction(w, "H", "split");
      for (let i = 0; i < 4; i++) stepWorld(w, dt);
      return P.cells.length > 0;
    };
    // The half is 500: it eats 400 (500 >= 439) but not 470 (needs 516).
    check(`[${dt}] a half too small to eat what it crosses does not`, run(470));
    check(`[${dt}] and does eat what it is big enough for`, !run(400));
  }

  // Growth during the tick does not reach back along the path: a cell that
  // was too small when it passed the prey, and only grew past the eat ratio
  // by eating orbs where it landed, has not eaten it.
  {
    const run = startMass => {
      const w = bare(58);
      const A = flung(w, "A", 2000, 2000, startMass, 2400);
      const end = landing(A.cells[0], dt);
      const B = still(w, "B", (2000 + end.x) / 2, 2000, 100);
      for (let i = 0; i < 7; i++) orb(w, end.x + (i - 3), 2000);
      buildPelletGrid(w);
      stepWorld(w, dt);
      return { alive: B.cells.length > 0, grew: A.cells[0].mass - startMass };
    };
    const small = run(105), big = run(112);
    // 105 < 100 x 1.098 = 109.8 when it passed; 105 + 14 is past it at the end.
    check(`[${dt}] a cell that was too small as it passed does not eat on the way`,
      small.alive && small.grew > 109.8 - 105, `grew ${small.grew.toFixed(1)}`);
    check(`[${dt}] one big enough as it passed does`, !big.alive);
  }

  // Owner cooldown: a cell racing through its own fresh throw does not take
  // it back; through anyone else's, it does.
  {
    const run = owner => {
      const w = bare(59);
      const A = flung(w, "A", 2000, 2000, 100, 2400);
      const end = landing(A.cells[0], dt);
      const blob = orb(w, (2000 + end.x) / 2, 2000, { mass: EJECT_KEEP, owner, ownerFree: w.time + 0.6 });
      buildPelletGrid(w);
      stepWorld(w, dt);
      return blob.dead;
    };
    check(`[${dt}] own mass inside its cooldown is passed through`, !run("A"));
    check(`[${dt}] someone else's is eaten`, run("rival"));
  }

  // Receding: mass travelling away from a cell the whole time is not eaten,
  // even if it started inside its reach; mass travelling through it is.
  {
    const run = fromX => {
      const w = bare(60);
      const C = still(w, "C", 3000, 3000, 100);
      orb(w, fromX, 3000, { mass: EJECT_KEEP, vx: EJECT_SPEED, vy: 0, owner: "rival", ownerFree: 0 });
      buildPelletGrid(w);
      stepWorld(w, dt);
      return C.orbs === 1;
    };
    check(`[${dt}] mass receding the whole step is not eaten`, !run(3020));
    check(`[${dt}] mass passing through is`, run(2970));
  }

  // Pop mass: a piece too small to pop a virus crosses it untouched.
  {
    const w = bare(62);
    const H = still(w, "H", 2000, 2000, 200);
    const v = virus(w, 2150, 2000);
    H.input.x = 1000;
    queueAction(w, "H", "split");
    let popped = false;
    for (let i = 0; i < 6; i++) popped ||= stepWorld(w, dt).some(e => e.t === "pop");
    check(`[${dt}] a half below pop mass crosses a virus untouched`, !popped && w.viruses.includes(v));
  }

  // And growth past the pop line during the tick does not reach back either.
  {
    const run = startMass => {
      const w = bare(63);
      const A = flung(w, "A", 2000, 2000, startMass, 2400);
      const end = landing(A.cells[0], dt);
      virus(w, (2000 + end.x) / 2, 2000);
      for (let i = 0; i < 7; i++) orb(w, end.x + (i - 3), 2000);
      buildPelletGrid(w);
      return stepWorld(w, dt).some(e => e.t === "pop");
    };
    check(`[${dt}] a cell below pop mass as it passed does not pop on the way`, !run(POP_MASS - 6));
    check(`[${dt}] one above it does`, run(POP_MASS + 4));
  }

  // Feeding needs flight: a blob that runs out short of a virus misses.
  {
    const w = bare(64);
    const v = virus(w, 3200, 3000);
    orb(w, 3000, 3000, { mass: EJECT_KEEP, vx: 300, vy: 0, owner: "rival", ownerFree: 0 });
    buildPelletGrid(w);
    for (let i = 0; i < 20; i++) stepWorld(w, dt);
    check(`[${dt}] a blob that stops short does not feed`, v.fed === 0);
  }

  // Order: when two cells cross the same prey in one tick, the one that joined
  // first eats it, as when both reach it at the end of a tick.
  {
    const run = firstIn => {
      const w = bare(65);
      const ids = firstIn === "A1" ? ["A1", "A2"] : ["A2", "A1"];
      for (const id of ids) flung(w, id, 2000, id === "A1" ? 2000 : 2006, 200, 2400);
      const end = landing(w.players.get("A1").cells[0], dt);
      still(w, "P", (2000 + end.x) / 2, 2003, 20);
      const ev = stepWorld(w, dt);
      return eats(ev, "P").map(e => e.id);
    };
    const a = run("A1"), b = run("A2");
    check(`[${dt}] the first to join takes contested prey`, a.join() === "A1" && b.join() === "A2", `${a} / ${b}`);
  }
}

// ── nothing is consumed twice ───────────────────────────────────────────────

console.log("\n-- one consumption per thing --");
for (const dt of [0.05, 0.25]) {
  // Two pieces of different players cross one orb in the same tick.
  {
    const w = bare(66);
    const A1 = flung(w, "A1", 2000, 2000, 100, 2400);
    const A2 = flung(w, "A2", 2000, 2006, 100, 2400);
    const end = landing(A1.cells[0], dt);
    const o = orb(w, (2000 + end.x) / 2, 2003);
    buildPelletGrid(w);
    const before = A1.cells[0].mass + A2.cells[0].mass;
    stepWorld(w, dt);
    const gained = A1.cells[0].mass + A2.cells[0].mass - before;
    check(`[${dt}] an orb crossed by two cells at once is eaten once`,
      o.dead && A1.orbs + A2.orbs === 1 && Math.abs(gained - PELLET_MASS) < 1e-9, `${A1.orbs}+${A2.orbs}, +${gained}`);
  }

  // A blob that feeds a virus on its way is not also eaten by a cell past it.
  {
    const w = bare(67);
    const v = virus(w, 3060, 3000);
    const C = still(w, "C", 3130, 3000, 20);
    const blob = orb(w, 3000, 3000, { mass: EJECT_KEEP, vx: EJECT_SPEED, vy: 0, owner: "rival", ownerFree: 0 });
    buildPelletGrid(w);
    for (let i = 0; i < 4 && !blob.dead; i++) stepWorld(w, dt);
    check(`[${dt}] mass fed to a virus on the way is not eaten as well`, v.fed === 1 && C.orbs === 0, `fed ${v.fed}, eaten ${C.orbs}`);
  }

  // One fast cell crossing two prey and an orb in a single tick.
  {
    const w = bare(68);
    const A = flung(w, "A", 2000, 2000, 300, 3000);
    const end = landing(A.cells[0], dt);
    const span = end.x - 2000;
    const P1 = still(w, "P1", 2000 + span * 0.3, 2000, 20);
    const P2 = still(w, "P2", 2000 + span * 0.7, 2002, 30);
    orb(w, 2000 + span * 0.5, 2001);
    buildPelletGrid(w);
    const ev = stepWorld(w, dt);
    const expect = 300 - 300 * DECAY_RATE * dt + PELLET_MASS + (20 + 30) * EAT_BONUS;
    check(`[${dt}] a cell crossing two prey and an orb takes each once`,
      eats(ev, "P1").length === 1 && eats(ev, "P2").length === 1 && A.orbs === 1 &&
      !P1.cells.length && !P2.cells.length && Math.abs(A.cells[0].mass - expect) < 0.5,
      `mass ${A.cells[0].mass.toFixed(2)} vs ${expect.toFixed(2)}`);
  }
}

// ── a crowded arena under uneven ticks ──────────────────────────────────────
//
// Sixty players in a 2,000-unit arena, splitting, throwing and steering at
// random, stepped with a mix of 50 to 250ms ticks. Each tick is checked by an
// independent brute force: the motion of every cell, pellet and virus is
// sampled at 33 points along its step, and nothing may come within reach of a
// cell and survive. The brute force is deliberately conservative — sizes are
// the least favourable of the tick's start and end, a margin is taken off,
// and players who split, threw, merged or burst that tick are left out — so
// anything it reports is a collision the simulation really missed.

const DTS = [0.05, 0.05, 0.25, 0.1, 0.05, 0.15, 0.2, 0.05];

function crowd(seed, ticks) {
  const w = createWorld(seed, { size: 2000, pellets: 400, viruses: 6 });
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 60; i++) {
    const p = addPlayer(w, { id: `p${i}`, name: `p${i}` });
    p.cells[0].mass = 20 + rnd() * 600;
  }
  const stats = { ticks: 0, misses: [], dupCells: 0, badPos: 0, reappeared: 0, badIndex: 0,
    sweptOnly: 0, pairs: 0, eaten: 0 };
  const gone = new Set();
  for (let t = 0; t < ticks; t++) {
    const dt = DTS[t % DTS.length];
    const acted = new Set();
    for (const p of w.players.values()) {
      if (!p.alive) { queueAction(w, p.id, "respawn"); acted.add(p.id); continue; }
      const a = rnd() * Math.PI * 2;
      p.input.x = Math.cos(a) * 400; p.input.y = Math.sin(a) * 400;
      if (rnd() < 0.08) { queueAction(w, p.id, "split"); acted.add(p.id); }
      if (rnd() < 0.08) { queueAction(w, p.id, "eject"); acted.add(p.id); }
    }

    const cellsBefore = new Map(), setsBefore = new Map();
    for (const p of w.players.values()) {
      setsBefore.set(p.id, p.cells.map(c => c.id).join());
      for (const c of p.cells) cellsBefore.set(c.id, { x: c.x, y: c.y, m: c.mass, owner: p.id });
    }
    const pelletsBefore = new Map(w.pellets.map(p => [p.id, { x: p.x, y: p.y, ref: p }]));
    const virusesBefore = new Map(w.viruses.map(v => [v.id, { x: v.x, y: v.y }]));

    const ev = stepWorld(w, dt);
    stats.ticks++;

    // Plain invariants.
    const ids = [];
    for (const p of w.players.values()) for (const c of p.cells) {
      ids.push(c.id);
      // Not "inside the board": pushing a player's own pieces apart happens
      // after the wall clamp, which can leave one a few units over the line.
      // That predates the swept tests and is not theirs to fix; a step taken
      // along a path must still never throw anything further than that.
      const r = radiusOf(c.mass);
      if (!(c.x >= -r && c.x <= w.size + r && c.y >= -r && c.y <= w.size + r && c.mass > 0)) stats.badPos++;
    }
    if (new Set(ids).size !== ids.length) stats.dupCells++;
    const now = new Set(w.pellets.map(p => p.id));
    for (const id of gone) if (now.has(id)) stats.reappeared++;
    for (const id of pelletsBefore.keys()) if (!now.has(id)) { gone.add(id); stats.eaten++; }
    if (!indexExact(w)) stats.badIndex++;

    // Cells whose path this tick was nothing but movement.
    const plain = [];
    for (const p of w.players.values()) {
      if (acted.has(p.id) || !p.alive || setsBefore.get(p.id) !== p.cells.map(c => c.id).join()) continue;
      for (const c of p.cells) {
        const b = cellsBefore.get(c.id);
        plain.push({ c, owner: p.id, sx: b.x, sy: b.y, ex: c.x, ey: c.y, least: Math.min(b.m, c.mass) });
      }
    }

    // Surviving pellets against those cells.
    for (const p of w.pellets) {
      const b = pelletsBefore.get(p.id);
      if (!b) continue;
      const ux = p.vx || p.vy ? p.vx : p.x - b.x, uy = p.vx || p.vy ? p.vy : p.y - b.y;
      for (const k of plain) {
        if (p.owner === k.owner && w.time < p.ownerFree) continue;
        const reach = radiusOf(k.least) * 0.97 - 0.5 + pelletRadius(p) * 0.6;
        if (boxApart(b, p, k, reach)) continue;
        stats.pairs++;
        if (sampledHit(b.x - k.sx, b.y - k.sy, p.x - k.ex, p.y - k.ey, reach, ux, uy)) {
          stats.misses.push(`tick ${t + 1} (${dt}s): pellet ${p.id} through cell ${k.c.id}`);
        }
      }
    }
    // Surviving cells of other players.
    for (const k of plain) {
      for (const q of w.players.values()) {
        if (q.id === k.owner) continue;
        for (const v of q.cells) {
          const b = cellsBefore.get(v.id);
          if (!b) continue;
          const most = Math.max(b.m, v.mass);
          // A hair under the real ratio: decay moves masses a fraction of a
          // percent between where this reads them and where the sim does.
          if (k.least * 0.995 < most * EAT_RATIO) continue;
          const thr = radiusOf(k.least) * 0.97 - radiusOf(most) * 0.55 - 0.5;
          if (thr <= 0 || boxApart(b, v, k, thr)) continue;
          stats.pairs++;
          if (sampledHit(b.x - k.sx, b.y - k.sy, v.x - k.ex, v.y - k.ey, thr, 0, 0)) {
            stats.misses.push(`tick ${t + 1} (${dt}s): cell ${v.id} through cell ${k.c.id}`);
          }
        }
      }
    }
    // Surviving viruses against cells big enough to pop the whole tick. A
    // player pops one virus a tick at most, and at MAX_CELLS the pop adds no
    // pieces, so its cells still read as plain movement: skip it.
    const popped = new Set(ev.filter(e => e.t === "pop").map(e => e.id));
    for (const v of w.viruses) {
      const b = virusesBefore.get(v.id);
      if (!b) continue;
      for (const k of plain) {
        if (k.least * 0.995 <= POP_MASS || popped.has(k.owner)) continue;
        const r = radiusOf(k.least) * 0.97 - 0.5;
        if (boxApart(b, v, k, r)) continue;
        stats.pairs++;
        if (sampledHit(b.x - k.sx, b.y - k.sy, v.x - k.ex, v.y - k.ey, r, 0, 0)) {
          stats.misses.push(`tick ${t + 1} (${dt}s): virus ${v.id} through cell ${k.c.id}`);
        }
      }
    }

    // Pellets gone that no cell or virus was anywhere near where the pellet
    // ended up: they can only have been caught on the way.
    for (const [id, b] of pelletsBefore) {
      if (now.has(id)) continue;
      const q = b.ref;
      let near = false;
      for (const p of w.players.values()) for (const c of p.cells) {
        if (Math.hypot(c.x - q.x, c.y - q.y) < radiusOf(c.mass) + 20) near = true;
      }
      for (const v of w.viruses) if (Math.hypot(v.x - q.x, v.y - q.y) < radiusOf(v.mass) + 30) near = true;
      if (!near) stats.sweptOnly++;
    }
  }
  return { w, stats };
}

// Relative motion sampled along the tick: target offset from (sx, sy) to
// (ex, ey), within r at a moment it is not travelling away along (ux, uy).
function sampledHit(sx, sy, ex, ey, r, ux, uy) {
  for (let i = 0; i <= 32; i++) {
    const t = i / 32, x = sx + (ex - sx) * t, y = sy + (ey - sy) * t;
    if (x * x + y * y < r * r && x * ux + y * uy <= 0) return true;
  }
  return false;
}

// Quick reject: the target's box over the tick never comes within r of the
// cell's box over the tick.
function boxApart(b, e, k, r) {
  return Math.min(b.x, e.x) > Math.max(k.sx, k.ex) + r || Math.max(b.x, e.x) < Math.min(k.sx, k.ex) - r ||
    Math.min(b.y, e.y) > Math.max(k.sy, k.ey) + r || Math.max(b.y, e.y) < Math.min(k.sy, k.ey) - r;
}

function indexExact(w) {
  const seen = new Map();
  forEachPelletNear(w, w.size / 2, w.size / 2, w.size, p => seen.set(p, (seen.get(p) || 0) + 1));
  if (seen.size !== w.pellets.length) return false;
  for (const p of w.pellets) if (seen.get(p) !== 1) return false;
  return true;
}

function fingerprint(w) {
  const parts = [w.tick, w.nextId];
  for (const p of w.players.values()) for (const c of p.cells) parts.push(c.id, c.x, c.y, c.mass);
  for (const p of w.pellets) parts.push(p.id, p.x, p.y);
  for (const v of w.viruses) parts.push(v.id, v.x, v.y, v.fed);
  return parts.join(",");
}

console.log("\n-- a crowded arena under uneven ticks --");
{
  const { w, stats } = crowd(7, 160);
  check(`no collision missed, by a sampled brute force (${stats.pairs} close passes over ${stats.ticks} ticks)`,
    stats.misses.length === 0, stats.misses.slice(0, 3).join("; "));
  check("and the crowd really did collide", stats.eaten > 200 && stats.pairs > 1000,
    `${stats.eaten} pellets gone, ${stats.pairs} passes`);
  check("some of it caught only along the way", stats.sweptOnly > 0, `${stats.sweptOnly} eaten clear of every cell's end`);
  check("no cell twice, none lost past a wall or out of mass", !stats.dupCells && !stats.badPos, `${stats.dupCells} / ${stats.badPos}`);
  check("no eaten pellet comes back", stats.reappeared === 0);
  check("index exact after every tick", stats.badIndex === 0, `${stats.badIndex} bad`);
  const again = crowd(7, 160);
  check("and the same seed plays out identically", fingerprint(w) === fingerprint(again.w));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
