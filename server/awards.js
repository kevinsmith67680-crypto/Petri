// ---------------------------------------------------------------------------
// Scoring a live round for XP and rating.
//
// Pure: given who was dealt in, how each of them left the round, and who was
// still standing at the whistle, it says what each account earns. The server
// does the reading and writing (awardProgress in server/index.js); the rules
// for XP and rating themselves are in shared/progress.js.
//
// entrants  Map of body -> { accountId, rating, games, out }
//           out is the order the entrant left the round in (eaten, or their
//           body gone because they did), 1 first; 0 if they never left it.
// survivors every body standing at the whistle, best first, bots included:
//           the same list the payout reads positions from.
// ---------------------------------------------------------------------------

import { xpForPlace, ratingChanges } from "../shared/progress.js";

// Finishing order among the entrants: survivors by their position at the
// whistle, then everyone eliminated, the last out first. A body that is gone
// without ever being marked out ties for last.
//
// Out beats standing: a body that was eaten and then respawned is still
// standing, but that is a second, unstaked life, and the entrant's result is
// the first one.
export function finishOrder(entrants, survivors) {
  const byAccount = new Map();
  for (const [body, e] of entrants) {
    const position = e.out ? 0 : survivors.indexOf(body) + 1;
    const group = position ? 0 : e.out ? 1 : 2;
    const row = { ...e, position, group };
    // One row per account: one person is one result, and Postgres will not
    // update a row twice in one statement. The better finish stands.
    const seen = byAccount.get(e.accountId);
    if (seen && compare(seen, row) <= 0) continue;
    byAccount.set(e.accountId, row);
  }
  const rows = [...byAccount.values()].sort(compare);
  const lastPlace = rows.findIndex(r => r.group === 2) + 1;
  rows.forEach((r, i) => { r.place = r.group === 2 ? lastPlace : i + 1; });
  return rows;
}

function compare(a, b) {
  return a.group - b.group || (a.group === 0 ? a.position - b.position : b.out - a.out);
}

// What each account earns from a round. Only accounts that earned something
// are listed: XP for a paid place, and a rating change whenever at least two
// people took part.
export function scoreRound(entrants, survivors, paidPositions) {
  const rows = finishOrder(entrants, survivors);
  // Rated against people only. Alone with bots in test mode there is nobody
  // to be rated against, though a win there still earns its XP.
  const rated = rows.length >= 2;
  const changes = ratingChanges(rows.map(r => ({
    id: r.accountId, rating: r.rating, games: r.games, place: r.place
  })));
  const results = rows.map(r => ({
    accountId: r.accountId,
    // The same line the payout draws: standing at the whistle in the paid
    // places, counted among everyone standing, bots included, exactly as
    // cashOut does. XP and money cannot disagree about who won.
    xp: xpForPlace(r.position, paidPositions),
    ratingChange: rated ? changes.get(r.accountId) : 0,
    rated,
    place: r.place
  })).filter(r => r.xp > 0 || r.rated);
  return { results, field: rows.length };
}
