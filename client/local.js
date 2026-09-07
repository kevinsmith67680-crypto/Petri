// ---------------------------------------------------------------------------
// Offline connection.
//
// Runs the shared simulation inside the browser tab and exposes exactly the
// interface net.js does, so main.js cannot tell the difference. This is what
// makes the refactor pay for itself: single player is now just a server that
// happens to live in the same process.
//
// Unlike the real server this steps at the render rate rather than a fixed
// 20Hz tick, because with no network there is nothing to interpolate against
// and variable dt looks smoother. The simulation is dt-scaled, so both give
// materially the same game.
// ---------------------------------------------------------------------------

import {
  createWorld, addPlayer, fillBots, setAim, queueAction,
  stepWorld, totalMass, centroid, leaderboard, rankOf
} from "../shared/sim.js";
import { PHASE_NONE } from "../shared/protocol.js";
import { PELLET_MASS } from "../shared/sim.js";

export function createLocalConnection({ name = "You", bots = 14, seed, world: opts } = {}) {
  const world = createWorld(seed ?? (Math.random() * 1e9) | 0, opts);
  const me = addPlayer(world, { id: "me", name, ci: -1 });
  fillBots(world, bots);

  const listeners = { event: [], welcome: [], close: [], round: [] };
  const emit = (kind, payload) => listeners[kind].forEach(fn => fn(payload));

  return {
    mode: "local",
    ready: true,

    on(kind, fn) { listeners[kind]?.push(fn); },

    sendAim(dx, dy) { setAim(world, "me", dx, dy); },
    sendAction(action) { queueAction(world, "me", action); },

    // Driven by the render loop; the network version ignores dt entirely.
    update(dt) {
      const events = stepWorld(world, dt);
      for (const e of events) if (e.id === "me") emit("event", e);
    },

    // Same shape net.js returns, so render.js and ui.js stay transport-blind.
    getView() {
      const cells = [];
      for (const p of world.players.values()) {
        if (!p.alive) continue;
        for (const c of p.cells) {
          cells.push({
            i: c.id, x: c.x, y: c.y, m: c.mass, ci: c.ci,
            o: p.id, n: p.name,
            s: p.id === "me" && world.time < c.mergeAt ? 1 : 0
          });
        }
      }

      const pellets = world.pellets.map(p =>
        [p.x, p.y, p.ci, p.mass > PELLET_MASS ? 1 : 0, p.owner === "me" ? 1 : 0]);
      const viruses = world.viruses.map(v => [v.x, v.y]);
      const c = centroid(me);
      const rank = rankOf(world, "me");

      return {
        time: world.time,
        world: world.size,
        cells, pellets, viruses,
        me: {
          id: "me",
          alive: me.alive,
          orbs: me.orbs,
          eaten: me.eaten,
          mass: totalMass(me),
          peak: me.peak,
          x: c.x, y: c.y,
          rank: rank.rank,
          of: rank.of
        },
        board: leaderboard(world),
        // Practice has no timer. PHASE_NONE tells the HUD to hide the clock.
        round: { phase: PHASE_NONE, remaining: 0, number: 0 },
        spectating: false,
        eyeName: ""
      };
    },

    // Offline play never wagers: a balance held in this tab is free money, so
    // the local adapter refuses money operations outright rather than
    // pretending to hold value.
    // Guests play alone against bots, so there is nobody to wait for.
    sendReady() {},
    // Guests play alone against bots; there is nobody worth watching.
    sendSpectate() {},
    stats() { return { ping: 0, srvMs: 0, hz: 0, budgetMs: 0 }; },
    sendRamp() {},
    sendRename() {},

    close() { emit("close"); }
  };
}
