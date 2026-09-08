// ---------------------------------------------------------------------------
// Headless simulation test. Run with:  node test/sim.test.js
//
// The point of this file is not exhaustive coverage — it is proof that the
// simulation runs with no DOM, no canvas and no clock, which is exactly what
// the server needs. If someone reintroduces a browser dependency into
// shared/sim.js, this fails immediately.
// ---------------------------------------------------------------------------

import {
  createWorld, addPlayer, fillBots, stepWorld, setAim, queueAction,
  totalMass, centroid, leaderboard, TICK_HZ, WORLD, PELLETS, VIRUSES,
  radiusOf, MAX_CELLS, VIRUS_MASS, VIRUS_EAT_RATIO,
  advancePellet, EJECT_SPEED, EJECT_KEEP, EJECT_MASS, EJECT_OWNER_COOLDOWN
} from "../shared/sim.js";

let failures = 0;

function check(label, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

// ── determinism ─────────────────────────────────────────────────────────────

function runSeeded(seed, ticks) {
  const w = createWorld(seed);
  fillBots(w, 8);
  for (let i = 0; i < ticks; i++) stepWorld(w, 1 / TICK_HZ);
  return [...w.players.values()].map(p => Math.round(totalMass(p) * 1000));
}

const a = runSeeded(1234, 200);
const b = runSeeded(1234, 200);
const c = runSeeded(9999, 200);
check("same seed gives identical results", JSON.stringify(a) === JSON.stringify(b));
check("different seed diverges", JSON.stringify(a) !== JSON.stringify(c));

// ── a long run stays sane ───────────────────────────────────────────────────

const world = createWorld(42);
const me = addPlayer(world, { id: "me", name: "Tester" });
// Enough bots to match the arena's design density. With only a dozen in an
// 8,800-unit world they never meet, and the combat assertions below never
// get exercised.
fillBots(world, 90);

let orbEvents = 0;
let deaths = 0;
let maxCells = 0;

for (let i = 0; i < TICK_HZ * 120; i++) {   // two simulated minutes
  // Chase whatever orb is nearest, so the test player actually grows.
  if (me.alive && me.cells.length) {
    const c0 = centroid(me);
    let near = null, nd = Infinity;
    for (const p of world.pellets) {
      const d = (p.x - c0.x) ** 2 + (p.y - c0.y) ** 2;
      if (d < nd) { nd = d; near = p; }
    }
    if (near) setAim(world, "me", near.x - c0.x, near.y - c0.y);
    if (i % 400 === 399) queueAction(world, "me", "split");
  } else if (!me.alive) {
    queueAction(world, "me", "respawn");
  }

  const events = stepWorld(world, 1 / TICK_HZ);
  for (const e of events) {
    if (e.t === "orb" && e.id === "me") orbEvents++;
    if (e.t === "death") {
      deaths++;
      // Respawning starts a fresh run, so the player's own counter resets.
      if (e.id === "me") orbEvents = 0;
    }
  }
  maxCells = Math.max(maxCells, me.cells.length);
}

check("orb counter matches emitted events", me.orbs === orbEvents, `${me.orbs} / ${orbEvents}`);
check("player gained mass", totalMass(me) > 0);
check("pellet count held constant", world.pellets.length >= PELLETS, `${world.pellets.length}`);
check("virus count held constant", world.viruses.length === VIRUSES, `${world.viruses.length}`);
check("cell cap respected", maxCells <= MAX_CELLS, `peak ${maxCells}`);
check("deaths were observed", deaths > 0, `${deaths}`);

// ── no NaN, nothing outside the arena ───────────────────────────────────────

let bad = 0, outside = 0;
for (const p of world.players.values()) {
  for (const cell of p.cells) {
    if (!Number.isFinite(cell.x) || !Number.isFinite(cell.y) || !Number.isFinite(cell.mass)) bad++;
    const r = radiusOf(cell.mass);
    if (cell.x < -1 || cell.y < -1 || cell.x > WORLD + 1 || cell.y > WORLD + 1) outside++;
    if (cell.mass <= 0) bad++;
  }
}
check("no NaN or non-positive masses", bad === 0, `${bad} bad`);
check("all cells inside the arena", outside === 0, `${outside} outside`);

// ── virus behaviour ─────────────────────────────────────────────────────────

const vw = createWorld(7);
const big = addPlayer(vw, { id: "big", name: "Big" });
big.cells[0].mass = VIRUS_MASS * VIRUS_EAT_RATIO + 60;
big.cells[0].x = vw.viruses[0].x;
big.cells[0].y = vw.viruses[0].y;
stepWorld(vw, 1 / TICK_HZ);
check("swallowing a virus splits the cell", big.cells.length > 1, `${big.cells.length} pieces`);

const small = createWorld(8);
const tiny = addPlayer(small, { id: "tiny", name: "Tiny" });
tiny.cells[0].mass = 40;                       // below the virus threshold
tiny.cells[0].x = small.viruses[0].x;
tiny.cells[0].y = small.viruses[0].y;
stepWorld(small, 1 / TICK_HZ);
check("a small cell shelters on a virus", tiny.cells.length === 1);

// ── leaderboard ─────────────────────────────────────────────────────────────

const board = leaderboard(world);
const sorted = board.every((r, i) => i === 0 || board[i - 1].mass >= r.mass);
check("leaderboard is sorted by mass", sorted);


console.log("\n-- ejected mass behaves like a projectile --");
{
  const blobR = radiusOf(EJECT_KEEP);

  // It has to clear the mouth at every size. A fixed distance that clears a
  // small cell rests inside a large one's reach and is swallowed instantly.
  for (const mass of [40, 200, 800, 3000]) {
    const r = radiusOf(mass);
    const p = { x: r + blobR * 0.35, y: 0, vx: EJECT_SPEED, vy: 0, mass: EJECT_KEEP };
    let t = 0;
    while (t < 3) { advancePellet(p, 1 / 60, 8800); t += 1 / 60; }
    // One launch speed for everyone, so the clearance past the mouth is the
    // same 233 units at every size — the starting point already scales.
    const clearance = p.x - (r + blobR * 0.6);
    check(`a mass-${mass} cell throws clear of its own reach`,
      Math.abs(clearance - 233) < 3,
      `rests at ${p.x.toFixed(0)}, ${clearance.toFixed(0)} clear`);
  }

  // Driving straight on must not hoover it back up.
  const w1 = createWorld(9, { size: 8800, pellets: 0, viruses: 0 });
  const p1 = addPlayer(w1, { id: "me", name: "M" });
  p1.cells[0].mass = 200; p1.cells[0].x = 4400; p1.cells[0].y = 4400;
  setAim(w1, "me", 600, 0);
  queueAction(w1, "me", "eject");
  stepWorld(w1, 1 / TICK_HZ);
  const afterEject = p1.cells[0].mass;
  check("ejecting costs exactly EJECT_MASS", Math.round(200 - afterEject) === EJECT_MASS,
    afterEject.toFixed(1));
  // The cooldown holds for its full length: nothing comes back during it.
  // After that, a cell still driving forward will eventually catch up with
  // its own throw — that is the deliberate trade-off of a short cooldown, and
  // EJECT_OWNER_COOLDOWN is the dial if it should never happen.
  for (let i = 0; i < Math.ceil(EJECT_OWNER_COOLDOWN * TICK_HZ); i++) {
    setAim(w1, "me", 600, 0);
    stepWorld(w1, 1 / TICK_HZ);
  }
  check("nothing is reclaimed during the cooldown",
    Math.abs(p1.cells[0].mass - afterEject) < 0.5 && !!w1.pellets.find(p => p.owner === "me"),
    `mass ${p1.cells[0].mass.toFixed(1)} after ${EJECT_OWNER_COOLDOWN}s`);

  // And it must travel a visible distance, not dribble out. Measured against
  // a cell that stays put, so this is the throw and not the chase.
  {
    const wS = createWorld(9, { size: 8800, pellets: 0, viruses: 0 });
    const pS = addPlayer(wS, { id: "me", name: "M" });
    pS.cells[0].mass = 200; pS.cells[0].x = 4400; pS.cells[0].y = 4400;
    setAim(wS, "me", 900, 0);
    queueAction(wS, "me", "eject");
    stepWorld(wS, 1 / TICK_HZ);
    setAim(wS, "me", 0, 0);                       // stand still and watch
    for (let i = 0; i < 30; i++) stepWorld(wS, 1 / TICK_HZ);
    const b = wS.pellets.find(p => p.owner === "me");
    const rS = radiusOf(pS.cells[0].mass);
    const clear = b ? (Math.hypot(b.x - pS.cells[0].x, b.y - pS.cells[0].y) - rS) / rS : 0;
    check("the throw clears a mass-200 cell by several radii", clear > 2.5,
      `${clear.toFixed(1)} radii clear`);
  }

  // But turning round and going back for it must work.
  const w2 = createWorld(9, { size: 8800, pellets: 0, viruses: 0 });
  const p2 = addPlayer(w2, { id: "me", name: "M" });
  p2.cells[0].mass = 200; p2.cells[0].x = 4400; p2.cells[0].y = 4400;
  setAim(w2, "me", 600, 0);
  queueAction(w2, "me", "eject");
  stepWorld(w2, 1 / TICK_HZ);
  const base = p2.cells[0].mass;
  for (let i = 0; i < 40; i++) { setAim(w2, "me", -600, 0); stepWorld(w2, 1 / TICK_HZ); }
  for (let i = 0; i < 150; i++) {
    const b = w2.pellets.find(p => p.owner === "me");
    if (!b) break;
    const c = centroid(p2);
    setAim(w2, "me", b.x - c.x, b.y - c.y);
    stepWorld(w2, 1 / TICK_HZ);
  }
  check("going back for it deliberately does reclaim it",
    p2.cells[0].mass > base + EJECT_KEEP - 1,
    `${base.toFixed(0)} -> ${p2.cells[0].mass.toFixed(0)}`);

  // Anyone else can take it straight away: that is what feeding is.
  const w3 = createWorld(9, { size: 8800, pellets: 0, viruses: 0 });
  const thrower = addPlayer(w3, { id: "a", name: "A" });
  thrower.cells[0].mass = 200; thrower.cells[0].x = 4400; thrower.cells[0].y = 4400;
  setAim(w3, "a", 600, 0);
  queueAction(w3, "a", "eject");
  stepWorld(w3, 1 / TICK_HZ);
  // Move the thrower away immediately: otherwise it chases its own throw down
  // once the cooldown lapses, and there is nothing left to feed anyone with.
  thrower.cells[0].x = 1000; thrower.cells[0].y = 1000;
  setAim(w3, "a", 0, 0);
  // Let it come to rest: a blob still in flight is receding from a standing
  // player and cannot be caught, which is correct.
  for (let i = 0; i < 60; i++) stepWorld(w3, 1 / TICK_HZ);
  const blob = w3.pellets.find(p => p.owner === "a");
  check("it comes fully to rest", blob && blob.vx === 0 && blob.vy === 0,
    blob ? `vx ${blob.vx}` : "gone");
  const other = addPlayer(w3, { id: "b", name: "B" });
  other.cells[0].mass = 40;
  other.cells[0].x = blob.x; other.cells[0].y = blob.y;
  const otherBefore = other.cells[0].mass;
  stepWorld(w3, 1 / TICK_HZ);
  check("another player can take it immediately",
    other.cells[0].mass > otherBefore, `${otherBefore} -> ${other.cells[0].mass.toFixed(0)}`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
