// ---------------------------------------------------------------------------
// Game mode tests. Run with:  node test/modes.test.js
//
// Two rooms run side by side with different arena sizes, so the things worth
// checking are that the sizes are actually independent, that a world honours
// the size it was given, and that nothing has quietly gone back to reading the
// module-level WORLD constant.
// ---------------------------------------------------------------------------

import {
  createWorld, addPlayer, fillBots, stepWorld, resetArena, radiusOf,
  advanceCell, advancePellet, TICK_HZ, WORLD, MAX_WORLD, totalMass
} from "../shared/sim.js";
import { MODES, modeById } from "../shared/modes.js";
import { STAKE_1_USDC, STAKE_2_USDC, isValidStake, formatUsdc } from "../shared/wager.js";
import { encodeSnapshot, decodeSnapshot, createClientState } from "../shared/protocol.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

console.log("\n-- mode definitions --");

check("two modes exist", MODES.length === 2, MODES.map(m => m.id).join(", "));
const std = modeById("standard"), high = modeById("highstakes");
check("standard is 1.00 for 100", std.stake === STAKE_1_USDC && std.lobbyMin === 100);
check("high stakes is 2.00 for 50", high.stake === STAKE_2_USDC && high.lobbyMin === 50,
  `${formatUsdc(high.stake)} / ${high.lobbyMin}`);
check("both stakes are valid tiers", isValidStake(STAKE_1_USDC) && isValidStake(STAKE_2_USDC));
check("stakes are unique per mode",
  new Set(MODES.map(m => m.stake)).size === MODES.length);
check("every arena fits in u16", MODES.every(m => m.world.size <= MAX_WORLD));

// Density is the whole reason the smaller room has a smaller board.
for (const m of MODES) {
  const per = (m.world.size ** 2) / m.lobbyMin;
  check(`${m.id} holds ~770k units² per player`,
    per > 700_000 && per < 850_000, `${Math.round(per).toLocaleString()}`);
  const orbDensity = m.world.pellets / (m.world.size ** 2) * 1e6;
  check(`${m.id} orb density matches`, orbDensity > 50 && orbDensity < 55,
    `${orbDensity.toFixed(1)} per million units²`);
}

console.log("\n-- worlds are independent --");

const a = createWorld(1, std.world);
const b = createWorld(2, high.world);
check("each world keeps its own size", a.size === 8800 && b.size === 6200);
check("and its own orb count",
  a.pellets.length === std.world.pellets && b.pellets.length === high.world.pellets,
  `${a.pellets.length} / ${b.pellets.length}`);
check("and its own spore count",
  a.viruses.length === std.world.viruses && b.viruses.length === high.world.viruses);
check("the default is still the standard arena", createWorld(3).size === WORLD);

// Nothing may spawn or drift outside the smaller arena.
fillBots(b, 40);
for (let i = 0; i < TICK_HZ * 20; i++) stepWorld(b, 1 / TICK_HZ);
const outside = [];
for (const p of b.players.values()) {
  for (const c of p.cells) if (c.x < 0 || c.y < 0 || c.x > b.size || c.y > b.size) outside.push(c);
}
check("cells stay inside the smaller arena", outside.length === 0, `${outside.length} outside`);
const orbsOut = b.pellets.filter(p => p.x < 0 || p.y < 0 || p.x > b.size || p.y > b.size);
check("orbs stay inside it too", orbsOut.length === 0, `${orbsOut.length} outside`);
check("small-arena orbs are not spread over the big one",
  Math.max(...b.pellets.map(p => p.x)) < 8800 * 0.75,
  `furthest orb at x=${Math.round(Math.max(...b.pellets.map(p => p.x)))}`);

resetArena(b);
check("resetArena respects the world's own counts",
  b.pellets.length === high.world.pellets && b.viruses.length === high.world.viruses);

console.log("\n-- the client is told the size --");

const p1 = addPlayer(b, { id: "p1", name: "P" });
stepWorld(b, 1 / TICK_HZ);
const snap = decodeSnapshot(encodeSnapshot(b, p1, createClientState(0)));
check("arena size travels in the snapshot", snap.world === 6200, String(snap.world));

const snapA = decodeSnapshot(encodeSnapshot(a, addPlayer(a, { id: "pa", name: "A" }), createClientState(0)));
check("and differs per room", snapA.world === 8800 && snap.world === 6200);

// Client prediction clamps to the size it was given, not a constant.
const cell = { x: 6190, y: 100, mass: 20, vx: 0, vy: 0 };
advanceCell(cell, 99999, 100, 0.5, 6200);
check("prediction clamps to the room's arena", cell.x <= 6200 - radiusOf(20) + 0.01,
  `x=${cell.x.toFixed(0)}`);
const blob = { x: 6190, y: 100, mass: 13, vx: 5000, vy: 0 };
advancePellet(blob, 0.5, 6200);
check("thrown mass clamps too", blob.x <= 6200, `x=${blob.x.toFixed(0)}`);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
