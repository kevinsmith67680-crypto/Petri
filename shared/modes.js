// ---------------------------------------------------------------------------
// Game modes.
//
// Each mode is an independent room: its own world, lobby, round timer and
// arena. Shared between client and server so a mode cannot mean one thing in
// the menu and another on the server.
//
// Arena size is per mode, not a constant. A 50-player round in the arena built
// for 100 would be half as dense — you would spend the round wandering. Sizes
// hold ~770k units^2 per player either way, and orb and spore counts scale
// with area so the board feels the same at both sizes.
// ---------------------------------------------------------------------------

import { PRACTICE, STAKE_1_USDC, STAKE_2_USDC } from "./wager.js";

export const MODES = [
  {
    id: "standard",
    label: "Standard",
    blurb: "100 players. Top 5 are paid.",
    stake: STAKE_1_USDC,
    lobbyMin: 100,
    lobbyMax: 150,
    paidPositions: 5,
    roundSeconds: 600,
    world: { size: 8800, pellets: 4100, viruses: 90 }
  },
  {
    id: "highstakes",
    label: "High stakes",
    blurb: "50 players, tighter board. Top 5 are paid.",
    stake: STAKE_2_USDC,
    lobbyMin: 50,
    lobbyMax: 75,
    paidPositions: 5,
    roundSeconds: 600,
    // sqrt(770_667 * 50) ≈ 6200, and orbs and spores scale with the area.
    world: { size: 6200, pellets: 2035, viruses: 45 }
  }
];

export const DEFAULT_MODE = "standard";

export const modeById = id => MODES.find(m => m.id === id) || null;

// Practice is not a room: it runs locally in the player's own tab against
// bots, so it has no lobby, no stake and no server presence at all.
export const isPractice = stake => stake === PRACTICE;
