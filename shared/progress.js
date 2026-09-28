// ---------------------------------------------------------------------------
// Progress: experience, levels and skill rating.
//
// Two separate numbers, because they answer different questions.
//
//   XP      how much you have won. Only ever goes up, and only a win earns
//           it: finishing a live round in the paid places. Levels are XP on
//           a curve.
//   rating  how good you are. Goes up and down with every live round you
//           are dealt into, against the other people in it. This is what
//           matchmaking uses; a level would be the wrong input, since it
//           rewards playing a lot as much as playing well.
//
// Pure functions only, imported by the server (which decides) and the client
// (which displays). Nothing here touches money: XP and rating have no cash
// value and never move a balance.
// ---------------------------------------------------------------------------

// ── experience ──────────────────────────────────────────────────────────────

// XP by finishing position, first place first. A win is a paid place, the
// same line the payout draws, so XP and money can never disagree about who
// won. A room paying more places than this table lists pays its last entry.
export const XP_FOR_PLACE = Object.freeze([100, 70, 50, 35, 25]);

export function xpForPlace(position, paidPositions) {
  if (!Number.isInteger(position) || position < 1 || position > paidPositions) return 0;
  return XP_FOR_PLACE[Math.min(position, XP_FOR_PLACE.length) - 1];
}

// Total XP needed to reach a level: 50·L·(L−1). Level 2 is one first place,
// level 5 about ten, level 10 about forty-five. Each level asks for 100 more
// than the last, so early levels come quickly and later ones mean something.
export const xpForLevel = level => 50 * level * (level - 1);

export function levelOf(xp) {
  const total = Math.max(0, Math.floor(Number(xp) || 0));
  // Invert the curve, then correct for floating point at the boundaries.
  let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + total * 0.08)) / 2));
  while (xpForLevel(level + 1) <= total) level++;
  while (level > 1 && xpForLevel(level) > total) level--;
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { level, xp: total, into: total - floor, need: next - floor, next };
}

// ── rating ──────────────────────────────────────────────────────────────────

export const START_RATING = 1000;

// A new player's rating moves faster until it has had time to find its level,
// so someone strong is not stuck being matched with beginners for weeks.
export const PROVISIONAL_GAMES = 10;
const K_PROVISIONAL = 48;
const K_SETTLED = 24;

const expected = (mine, theirs) => 1 / (1 + Math.pow(10, (theirs - mine) / 400));

// Rating changes for one round, as a Map of id -> change.
//
// Multiplayer Elo: every pair in the field is scored as a head-to-head — the
// better finish wins it — against what the two ratings predicted, and each
// player's total is scaled by 1/(n−1). So one round can move a rating by at
// most K however big the field, and beating a strong player is worth more
// than beating a weak one.
//
// field: [{ id, rating, games, place }], place 1 best; equal places draw.
// Fewer than two players is not a contest, and nobody moves.
export function ratingChanges(field) {
  const out = new Map(field.map(p => [p.id, 0]));
  const n = field.length;
  if (n < 2) return out;
  for (const a of field) {
    let sum = 0;
    for (const b of field) {
      if (a === b) continue;
      const score = a.place < b.place ? 1 : a.place > b.place ? 0 : 0.5;
      sum += score - expected(a.rating, b.rating);
    }
    const k = (a.games ?? 0) < PROVISIONAL_GAMES ? K_PROVISIONAL : K_SETTLED;
    out.set(a.id, (k * sum) / (n - 1));
  }
  return out;
}

// Named bands for a rating, so a player can see where they sit without
// having to know what 1180 means.
export const RANKS = Object.freeze([
  { name: "Bronze", from: -Infinity },
  { name: "Silver", from: 900 },
  { name: "Gold", from: 1100 },
  { name: "Platinum", from: 1300 },
  { name: "Diamond", from: 1500 }
]);

export function rankOf(rating) {
  let name = RANKS[0].name;
  for (const r of RANKS) if (rating >= r.from) name = r.name;
  return name;
}

// ── skill matchmaking ───────────────────────────────────────────────────────

// Whether a room suits a player's rating. A room describes itself as the mean
// rating of the people in it and a window around that mean; the server widens
// the window the longer its lobby waits (see skillWindow in server/index.js),
// so a quiet evening still fills rooms. An empty room, or a player with no
// rating, fits anywhere.
export function fitsSkill(room, rating) {
  if (rating == null || !room || room.rating == null) return true;
  return Math.abs(rating - room.rating) <= room.window;
}
