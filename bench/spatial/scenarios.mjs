// ---------------------------------------------------------------------------
// Seeded scenarios and input drivers, shared by the correctness tests and
// the benchmarks. A driver only ever talks to the simulation through its
// public functions (setAim, queueAction) plus direct fixture edits to cell
// masses at setup or respawn — the same things a test fixture does. Nothing
// here touches the spatial index.
// ---------------------------------------------------------------------------

export const ARENA = 8800;           // the Standard mode arena
export const VIRUSES = 90;

// players / pellets follow the audit brief. `standard` is the live Standard
// mode exactly (shared/modes.js). Bots stand in for humans so the round has
// realistic movement, hunting, splitting and virus play; their AI time is
// measured separately and excluded from the "sim" figure, because the live
// arena is human-only and runs no AI at all.
export const SCENARIOS = {
  low:      { label: "Low population",      players: 10,  pellets: 500,  driver: "bots" },
  moderate: { label: "Moderate population", players: 50,  pellets: 1500, driver: "bots" },
  full:     { label: "Full lobby",          players: 100, pellets: 3000, driver: "bots" },
  // All 3,000 orbs and every spawn inside a 1,400-unit square (~2.5% of the
  // arena, ~40x the normal orb density). Top-ups follow the game's own
  // uniform rule, so the orb cluster is eaten down as it would be in play —
  // this is a transient state and is measured from its first tick.
  dense:    { label: "Dense cluster",       players: 100, pellets: 3000, driver: "bots", cluster: 1400, transient: true },
  stress:   { label: "Stress test",         players: 150, pellets: 5000, driver: "bots" },
  standard: { label: "Standard mode (live config)", players: 100, pellets: 4100, driver: "bots" },
  giants:   { label: "Very large cells",    players: 100, pellets: 3000, driver: "bots", giants: 6 },
  splits:   { label: "Rapid split + merge", players: 100, pellets: 3000, driver: "splits" },
  // Everyone throwing mass all the time, players spawned within a 3,000-unit
  // square so blobs fly into other cells: the moving-pellet stress case.
  eject:    { label: "Ejected-mass storm",  players: 100, pellets: 3000, driver: "eject", playerCluster: 3000 },
  churn:    { label: "Spawn + consume churn", players: 100, pellets: 3000, driver: "churn" }
};

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mid-round mass spread: median ~70, a long tail to ~3,000.
const midRoundMass = r => 20 * Math.exp(Math.log(150) * r() * r());

export function setupScenario(sim, key, seed = 1, overrides = {}) {
  const sc = { ...SCENARIOS[key], ...overrides };
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const size = sc.size || ARENA;

  const boxOf = side => {
    const h = side / 2, c = size / 2;
    return { x0: c - h, x1: c + h, y0: c - h, y1: c + h };
  };
  // Clustered spawns need the hook build.mjs adds; an unpatched module (see
  // head-check.mjs) can only run the scenarios that spawn where the game does.
  const box = sc.cluster ? { pellet: boxOf(sc.cluster), player: boxOf(sc.cluster) }
    : sc.playerCluster ? { player: boxOf(sc.playerCluster) } : null;
  if (sim.__S) sim.__S.spawnBox = box;
  else if (box) throw new Error(`scenario ${key} needs a build.mjs build`);

  const world = sim.createWorld(seed, {
    size, pellets: sc.pellets, viruses: sc.viruses ?? VIRUSES, botLevel: sc.botLevel || "hard"
  });
  // Only the initial orbs are clustered; refills land where the game puts
  // them. (Clustering the refills too turns the first cell big enough to
  // cover the square into a fountain that eats every refill as it lands.)
  if (sc.cluster) sim.__S.spawnBox = { player: boxOf(sc.cluster) };   // (sim.__S exists: checked above)

  const humans = sc.driver !== "bots";
  for (let i = 0; i < sc.players; i++) {
    const p = humans
      ? sim.addPlayer(world, { id: `h${i}`, name: `P${i}` })
      : sim.addPlayer(world, { id: `bot:${i}`, name: `B${i}`, bot: true, ci: i % 7 });
    // eject: within 4% of each other, so nobody can eat anybody at the start
    // (EAT_RATIO is 1.098) and the storm lasts instead of ending in one bite.
    p.cells[0].mass = sc.driver === "splits" ? 800 + rnd() * 2200
      : sc.driver === "eject" ? 1000 * (0.96 + rnd() * 0.08) : midRoundMass(rnd);
  }
  for (let i = 0; i < (sc.giants || 0); i++) {
    const p = world.players.get(humans ? `h${i}` : `bot:${i}`);
    p.cells[0].mass = 20000 + rnd() * 20000;          // radius 566-800
  }

  const driver = makeDriver(sim, sc.driver, rnd);
  return { world, sc, driver };
}

function makeDriver(sim, kind, rnd) {
  if (kind === "bots") return { step() {} };

  const heading = new Map();
  return {
    step(world) {
      const c = world.size / 2;
      let n = 0;
      for (const p of world.players.values()) {
        n++;
        // Respawn straight away, at the game's own starting mass. (Topping
        // respawns up to fixture mass turns every death into new mass for
        // whoever is biggest, and one cell soon outgrows the arena.)
        if (!p.alive) { sim.queueAction(world, p.id, "respawn"); continue; }
        if (kind === "splits" || kind === "eject") {
          let h = heading.get(p.id) ?? rnd() * Math.PI * 2;
          h += (rnd() - 0.5) * 0.6;
          heading.set(p.id, h);
          sim.setAim(world, p.id, Math.cos(h) * 500, Math.sin(h) * 500);
          if (kind === "splits") {
            // Staggered: everyone splits about every 0.75s and throws mass
            // every 1.5s, so pieces are always splitting and merging.
            if ((world.tick + n) % 15 === 0) sim.queueAction(world, p.id, "split");
            if ((world.tick + n) % 30 === 0) sim.queueAction(world, p.id, "eject");
          } else if ((world.tick + n) % 6 === 0) {
            sim.queueAction(world, p.id, "eject");      // every 0.3s
          }
        } else {
          // churn: everyone converges on the middle, so cells are eaten and
          // respawn continuously, and the pellets there are cleared and
          // re-seeded all the time.
          const me = sim.centroid(p);
          const tx = c + Math.cos(n) * 300, ty = c + Math.sin(n) * 300;
          sim.setAim(world, p.id, tx - me.x, ty - me.y);
          if ((world.tick + n) % 40 === 0) sim.queueAction(world, p.id, "split");
        }
      }
    }
  };
}

// Bit-exact fingerprint of everything collisions can affect.
export function hashWorld(world) {
  const f = new Float64Array(1), u = new Uint32Array(f.buffer);
  let h = 2166136261;
  const mix = v => {
    f[0] = v;
    h = Math.imul(h ^ u[0], 16777619);
    h = Math.imul(h ^ u[1], 16777619);
  };
  mix(world.tick); mix(world.nextId); mix(world.pellets.length); mix(world.viruses.length);
  for (const p of world.players.values()) {
    mix(p.alive ? 1 : 0); mix(p.orbs); mix(p.eaten); mix(p.cells.length);
    for (const c of p.cells) { mix(c.id); mix(c.x); mix(c.y); mix(c.mass); mix(c.vx); mix(c.vy); }
  }
  for (const p of world.pellets) { mix(p.id); mix(p.x); mix(p.y); mix(p.mass); }
  for (const v of world.viruses) { mix(v.id); mix(v.x); mix(v.y); mix(v.fed); }
  return h >>> 0;
}
