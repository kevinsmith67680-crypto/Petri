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
  radiusOf, MAX_CELLS, VIRUS_MASS, VIRUS_EAT_RATIO
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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
