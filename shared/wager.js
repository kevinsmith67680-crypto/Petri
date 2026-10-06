// ---------------------------------------------------------------------------
// Wager primitives.
//
// MONEY IS NEVER A FLOAT. Every amount in this codebase is an integer count of
// micro-USDC (1 USDC = 1_000_000 units), which matches USDC's on-chain 6
// decimals exactly. `0.1 + 0.2 !== 0.3` is a rounding curiosity when it is a
// score and a liability when it is someone's balance.
//
// Number is safe to 2^53, which is about 9 billion USDC. Well past anything
// this will ever hold, but if it ever needed to, switch to BigInt here and
// nowhere else.
//
// This module is pure and shared, so the client formats amounts with exactly
// the same code the server settles them with.
// ---------------------------------------------------------------------------

export const USDC_DECIMALS = 6;
export const UNIT = 1_000_000;            // one USDC in micro-units

export const PRACTICE = 0;                // free play
export const STAKE_1_USDC = 1 * UNIT;
export const STAKE_2_USDC = 2 * UNIT;

// The tiers the pregame menu offers. Kept short deliberately.
export const STAKE_TIERS = [PRACTICE, STAKE_1_USDC, STAKE_2_USDC];

// House cut on winnings, in basis points. 0 while this is a demo; a real
// operator takes a rake here, and it must be disclosed to players.
export const DEFAULT_RAKE_BPS = 0;

// ── mass valuation ──────────────────────────────────────────────────────────
//
// What a player's mass is worth at a fixed rate. The HUD shows it live as
// "Mass value", and a survivor in the paid places is paid exactly this for the
// mass they finished on (server/index.js, settleSurvivor), so the two cannot
// drift apart.
//
// At 0.005 USDC per mass point spawning shows 0.10 against a 1.00 stake, and
// mass 200 breaks even. The rate is fixed rather than derived from the pot, so
// winners who grow large are paid more than was staked, and the house funds
// the difference. See README, "The mass readout", before real money.
export const MICRO_PER_MASS = 5_000;     // 0.005 USDC per mass point

export function valueOfMass(mass) {
  if (!Number.isFinite(mass) || mass <= 0) return 0;
  return Math.floor(mass) * MICRO_PER_MASS;
}

export function isValidStake(units) {
  return Number.isSafeInteger(units) && STAKE_TIERS.includes(units);
}

// "1234567" -> "1.23". Truncates rather than rounds: never display more money
// than the ledger actually holds.
export function formatUsdc(units, decimals = 2) {
  if (!Number.isFinite(units)) return "—";
  const neg = units < 0;
  const abs = Math.abs(Math.trunc(units));
  const whole = Math.floor(abs / UNIT);
  const frac = abs % UNIT;
  const shown = String(frac).padStart(USDC_DECIMALS, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole}${decimals > 0 ? "." + shown : ""}`;
}

// "1.25" -> 1250000. Rejects anything that is not a plain decimal amount.
export function parseUsdc(text) {
  const m = /^\s*(\d+)(?:\.(\d{1,6}))?\s*$/.exec(String(text));
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] || "").padEnd(USDC_DECIMALS, "0"));
  const units = whole * UNIT + frac;
  return Number.isSafeInteger(units) ? units : null;
}

export function rakeOn(amount, bps) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return 0;
  return Math.floor((amount * bps) / 10_000);
}
