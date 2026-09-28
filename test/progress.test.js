// ---------------------------------------------------------------------------
// XP, levels and rating. Run with:  node test/progress.test.js
//
// The arithmetic behind the levelling system and skill matchmaking, on its
// own: shared/progress.js is pure, so every rule can be pinned exactly.
// ---------------------------------------------------------------------------

import {
  XP_FOR_PLACE, xpForPlace, xpForLevel, levelOf,
  START_RATING, PROVISIONAL_GAMES, ratingChanges, rankOf, fitsSkill
} from "../shared/progress.js";
import { finishOrder, scoreRound } from "../server/awards.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

console.log("\n-- XP goes to the winners --");

check("first place earns the most", xpForPlace(1, 5) === XP_FOR_PLACE[0] && XP_FOR_PLACE[0] === 100);
check("each paid place earns less than the one above it",
  XP_FOR_PLACE.every((x, i) => i === 0 || x < XP_FOR_PLACE[i - 1]));
check("the last paid place still earns", xpForPlace(5, 5) === 25);
check("sixth of five paid places earns nothing", xpForPlace(6, 5) === 0);
check("a room paying more places than the table pays its last entry", xpForPlace(7, 8) === 25);
check("no finish, no XP", [0, -1, null, undefined, 1.5, NaN].every(p => xpForPlace(p, 5) === 0));

console.log("\n-- levels --");

check("everyone starts at level 1", levelOf(0).level === 1);
check("one first place is level 2", levelOf(xpForPlace(1, 5)).level === 2);
check("level 2 to 3 takes 200 more", xpForLevel(3) - xpForLevel(2) === 200);
let exact = true;
for (let l = 1; l <= 500; l++) {
  const at = xpForLevel(l);
  if (levelOf(at).level !== l || (l > 1 && levelOf(at - 1).level !== l - 1)) { exact = false; break; }
}
check("every level boundary is exact, up to level 500", exact);
const mid = levelOf(450);
check("progress within a level is reported", mid.level === 3 && mid.into === 150 && mid.need === 300,
  JSON.stringify(mid));
check("nonsense XP is level 1, not an error", levelOf(-5).level === 1 && levelOf("x").level === 1);

console.log("\n-- rating --");

{
  const two = ratingChanges([
    { id: "a", rating: START_RATING, games: 0, place: 1 },
    { id: "b", rating: START_RATING, games: 0, place: 2 }
  ]);
  check("between equals, the winner gains what the loser loses",
    two.get("a") > 0 && Math.abs(two.get("a") + two.get("b")) < 1e-9, `${two.get("a")} / ${two.get("b")}`);

  const upset = ratingChanges([
    { id: "low", rating: 900, games: 20, place: 1 },
    { id: "high", rating: 1300, games: 20, place: 2 }
  ]);
  const expectedWin = ratingChanges([
    { id: "high", rating: 1300, games: 20, place: 1 },
    { id: "low", rating: 900, games: 20, place: 2 }
  ]);
  check("beating a stronger player is worth more than beating a weaker one",
    upset.get("low") > expectedWin.get("high") * 3, `${upset.get("low")} vs ${expectedWin.get("high")}`);

  const settled = ratingChanges([
    { id: "a", rating: 1000, games: PROVISIONAL_GAMES, place: 1 },
    { id: "b", rating: 1000, games: PROVISIONAL_GAMES, place: 2 }
  ]);
  check("a new player's rating moves faster than a settled one's", two.get("a") > settled.get("a"));

  check("a field of one is not a contest",
    ratingChanges([{ id: "solo", rating: 1000, games: 0, place: 1 }]).get("solo") === 0);

  const tie = ratingChanges([
    { id: "a", rating: 1000, games: 20, place: 1 },
    { id: "b", rating: 1000, games: 20, place: 1 }
  ]);
  check("equal places between equals change nothing", tie.get("a") === 0 && tie.get("b") === 0);

  const field = Array.from({ length: 100 }, (_, i) => ({ id: i, rating: 1000, games: 0, place: i + 1 }));
  const big = ratingChanges(field);
  check("a hundred-player round moves nobody by more than K",
    [...big.values()].every(d => Math.abs(d) <= 48 + 1e-9), `first ${big.get(0).toFixed(1)}`);
  check("and the order of finish is the order of gain",
    [...big.values()].every((d, i, all) => i === 0 || d < all[i - 1]));
  check("the total is conserved among equals",
    Math.abs([...big.values()].reduce((s, d) => s + d, 0)) < 1e-6);
}

console.log("\n-- ranks --");

check("a new player starts in Silver", rankOf(START_RATING) === "Silver");
check("bands run Bronze to Diamond",
  rankOf(850) === "Bronze" && rankOf(1100) === "Gold" && rankOf(1350) === "Platinum" && rankOf(1600) === "Diamond");

console.log("\n-- which rooms suit which players --");

check("an empty room suits anyone", fitsSkill({ rating: null, window: 100 }, 1500));
check("a player with no rating fits anywhere", fitsSkill({ rating: 1000, window: 100 }, null));
check("inside the window fits", fitsSkill({ rating: 1000, window: 200 }, 1180));
check("outside it does not", !fitsSkill({ rating: 1000, window: 200 }, 1250));
check("the window's edge counts as inside", fitsSkill({ rating: 1000, window: 200 }, 800));

console.log("\n-- scoring a live round --");

{
  // Bodies are just identities here. Bots stand in the survivor list the way
  // they do in test mode, and take paid places from people the same way.
  const body = name => ({ name });
  const [ada, bob, cy, dee, eve] = ["ada", "bob", "cy", "dee", "eve"].map(body);
  const botA = body("botA"), botB = body("botB");
  const entry = (accountId, out = 0, rating = START_RATING) => ({ accountId, rating, games: 20, out });

  const entrants = new Map([
    [ada, entry("ada")],            // survives, 2nd behind a bot
    [bob, entry("bob")],            // survives, 4th
    [cy, entry("cy", 1)],           // first out
    [dee, entry("dee", 2)],         // second out
    [eve, entry("eve")]             // survives, 7th: standing but unpaid
  ]);
  const survivors = [botA, ada, botB, bob, body("x"), body("y"), eve];

  const order = finishOrder(entrants, survivors);
  check("survivors first, by their position at the whistle",
    order.slice(0, 3).map(r => r.accountId).join() === "ada,bob,eve", order.map(r => r.accountId).join());
  check("then the eliminated, the last out ranked higher",
    order.slice(3).map(r => r.accountId).join() === "dee,cy");
  check("places run 1 to n", order.map(r => r.place).join() === "1,2,3,4,5");

  const { results, field } = scoreRound(entrants, survivors, 5);
  const xp = id => results.find(r => r.accountId === id)?.xp ?? 0;
  check("XP follows the payout's positions, bots counted", xp("ada") === xpForPlace(2, 5) && xp("bob") === xpForPlace(4, 5),
    `${xp("ada")} ${xp("bob")}`);
  check("standing but outside the paid places earns no XP", xp("eve") === 0);
  check("the eliminated earn no XP", xp("cy") === 0 && xp("dee") === 0);
  check("everyone in a contested round is rated", results.length === 5 && results.every(r => r.rated) && field === 5);
  const change = id => results.find(r => r.accountId === id).ratingChange;
  check("rating follows the finishing order among people",
    change("ada") > change("bob") && change("bob") > change("eve") && change("dee") > change("cy"));

  // Eaten, then back on a free respawn and standing at the whistle in first.
  // The result that counts is the staked life, which ended in the jaws.
  const respawned = new Map([[ada, entry("ada", 1)], [bob, entry("bob")]]);
  const again = scoreRound(respawned, [ada, bob], 5).results;
  check("a free respawn standing at the whistle wins nothing",
    again.find(r => r.accountId === "ada").xp === 0);
  // It still stands in the survivor list, as it does for the payout, so the
  // player behind it is paid — and earns XP — as second, not first.
  check("the place it holds is the one the payout sees",
    again.find(r => r.accountId === "bob").xp === xpForPlace(2, 5));
  check("and is rated as the loss it was", again.find(r => r.accountId === "ada").ratingChange < 0);

  // A body that vanished without being marked out ties for last.
  const vanished = finishOrder(new Map([[ada, entry("ada")], [bob, entry("bob")], [cy, entry("cy")]]), [ada]);
  check("bodies that vanished unmarked tie for last",
    vanished.map(r => `${r.accountId}${r.place}`).join() === "ada1,bob2,cy2", vanished.map(r => `${r.accountId}${r.place}`).join());

  // The same account twice (it should never happen) is one result.
  const twice = scoreRound(new Map([[ada, entry("ada", 1)], [bob, entry("ada")], [cy, entry("cy")]]), [bob, cy], 5).results;
  check("one account is one result, the better finish",
    twice.filter(r => r.accountId === "ada").length === 1 && twice.find(r => r.accountId === "ada").xp === 100);

  // Alone with bots: a win still earns XP, but there is nobody to be rated against.
  const solo = scoreRound(new Map([[ada, entry("ada")]]), [botA, ada], 5).results;
  check("alone with bots, a paid place earns XP", solo.length === 1 && solo[0].xp === 70);
  check("but no rating change", solo[0].rated === false && solo[0].ratingChange === 0);
  check("alone and unpaid, there is nothing to record",
    scoreRound(new Map([[ada, entry("ada")]]), [botA, botB, body(1), body(2), body(3), ada], 5).results.length === 0);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
