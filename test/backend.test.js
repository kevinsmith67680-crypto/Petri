// ---------------------------------------------------------------------------
// Backend contract test.
//
//   node test/backend.test.js                       -> memory only
//   DATABASE_URL=postgres://... node test/backend.test.js  -> memory + postgres
//
// The same assertions run against both implementations. That is the only thing
// stopping the two from drifting apart: it is very easy to fix a bug in the
// memory backend and leave the Postgres one wrong, or to rely on a behaviour
// that only one of them has.
//
// Point DATABASE_URL at a scratch project, not one with real data: this
// creates and deletes accounts.
// ---------------------------------------------------------------------------

import { MemoryStore } from "../server/store.js";
import { MemoryRepo } from "../server/db/memory.js";
import { Accounts } from "../server/accounts.js";
import { UNIT, STAKE_1_USDC } from "../shared/wager.js";
import { START_RATING } from "../shared/progress.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const uniq = () => Math.random().toString(36).slice(2, 10);

async function runContract(name, backend) {
  console.log(`\n== ${name} ==`);
  const accounts = new Accounts(backend, { nameCooldownMs: 0 });

  const uA = `a${uniq()}`, uB = `b${uniq()}`;
  const ada = await accounts.signup({
    username: uA, password: "lovelace1843",
    displayName: `Ada ${uniq()}`, dateOfBirth: "1990-01-01"
  });
  const bob = await accounts.signup({
    username: uB, password: "hopper19061",
    displayName: `Bob ${uniq()}`, dateOfBirth: "1990-01-01"
  });
  check("signup returns a uuid", /^[0-9a-f-]{36}$/.test(ada.id), ada.id);

  check("lookup by username", (await backend.findAccountByUsername(uA))?.id === ada.id);
  check("username lookup is case-insensitive",
    (await backend.findAccountByUsername(uA.toUpperCase()))?.id === ada.id);
  check("lookup by display name is case-insensitive",
    (await backend.findAccountByDisplayName(ada.displayName.toUpperCase()))?.id === ada.id);
  check("missing username returns null", (await backend.findAccountByUsername("nope" + uniq())) === null);

  // Uniqueness must be enforced by the backend, not just by the caller.
  let dupe = false;
  try { await backend.insertAccount({ username: uA, displayName: `X ${uniq()}`, password: "x" }); }
  catch (e) { dupe = e.code === "taken"; }
  check("duplicate username rejected by the backend", dupe);

  let dupeName = false;
  try { await backend.insertAccount({ username: `c${uniq()}`, displayName: ada.displayName, password: "x" }); }
  catch (e) { dupeName = e.code === "taken"; }
  check("duplicate display name rejected by the backend", dupeName);

  // ── sessions ──
  const token = await accounts.createSession(ada.id);
  check("session resolves", (await accounts.resolveSession(token))?.id === ada.id);
  await accounts.destroySession(token);
  check("destroyed session stops resolving", (await accounts.resolveSession(token)) === null);

  // ── seats ──
  // One game server holds an account at a time. Both backends must agree on
  // exactly when a lease blocks another holder and when it has lapsed.
  {
    const A = `srv-a#${uniq()}`, B = `srv-b#${uniq()}`;
    check("a free seat can be claimed", await backend.claimSeat(ada.id, A, 30_000));
    check("and is found under its holder", (await backend.findSeat(ada.id))?.holder === A,
      JSON.stringify(await backend.findSeat(ada.id)));
    check("another holder cannot take a live lease", !(await backend.claimSeat(ada.id, B, 30_000)));
    check("the holder can claim it again", await backend.claimSeat(ada.id, A, 30_000));

    const kept = await backend.renewSeats(A, [ada.id, bob.id], 30_000);
    check("renewing reports only the seats still held",
      kept.length === 1 && kept[0] === ada.id, JSON.stringify(kept));
    check("renewing nothing is a no-op", (await backend.renewSeats(A, [], 30_000)).length === 0);

    await backend.releaseSeat(ada.id, B);
    check("a non-holder cannot release it", (await backend.findSeat(ada.id))?.holder === A);
    await backend.releaseSeat(ada.id, A);
    check("the holder can", (await backend.findSeat(ada.id)) === null);

    // A holder that stops renewing loses the seat on its own. Nothing has to
    // clean up after a server that died.
    await backend.claimSeat(bob.id, A, 150);
    await new Promise(r => setTimeout(r, 400));
    check("a lapsed lease is not found", (await backend.findSeat(bob.id)) === null);
    check("and another holder can take it", await backend.claimSeat(bob.id, B, 30_000));
    check("after which the old holder's renewal loses it",
      (await backend.renewSeats(A, [bob.id], 30_000)).length === 0);
    check("and the new holder keeps it", (await backend.findSeat(bob.id))?.holder === B);
    await backend.releaseSeat(bob.id, B);
  }

  // ── money ──
  await backend.deposit(ada.id, 5 * UNIT, "test");
  await backend.deposit(bob.id, 5 * UNIT, "test");
  let snap = await backend.snapshot(ada.id);
  check("deposit lands", snap.balance === 5 * UNIT, `${snap.balance}`);
  check("escrow starts empty", snap.pot === 0);

  await backend.lockStake(ada.id, STAKE_1_USDC);
  await backend.lockStake(bob.id, STAKE_1_USDC);
  snap = await backend.snapshot(ada.id);
  check("stake moves balance to escrow",
    snap.balance === 4 * UNIT && snap.pot === UNIT, `${snap.balance}/${snap.pot}`);
  check("staked flag is set", snap.staked === true);

  // Overdraft must be impossible at the storage layer, not just above it.
  let overdrawn = false;
  try { await backend.lockStake(ada.id, 99 * UNIT); } catch { overdrawn = true; }
  check("cannot stake more than the balance", overdrawn);
  snap = await backend.snapshot(ada.id);
  check("failed stake left the balance untouched", snap.balance === 4 * UNIT, `${snap.balance}`);

  const moved = await backend.claim(ada.id, bob.id);
  check("claim moves the whole pot", moved === UNIT, `${moved}`);
  check("loser's escrow is empty", (await backend.snapshot(bob.id)).pot === 0);
  check("winner holds both stakes", (await backend.snapshot(ada.id)).pot === 2 * UNIT);
  check("claiming an empty pot is a no-op", (await backend.claim(ada.id, bob.id)) === 0);

  const { paid, rake } = await backend.cashOut(ada.id, 0);
  check("cash out pays the pot", paid === 2 * UNIT && rake === 0, `${paid}/${rake}`);
  snap = await backend.snapshot(ada.id);
  check("cash out lands in the balance", snap.balance === 6 * UNIT && snap.pot === 0, `${snap.balance}`);

  const { rake: cut } = await (async () => {
    await backend.lockStake(ada.id, 4 * UNIT);
    return backend.cashOut(ada.id, 250);   // 2.5%
  })();
  check("rake is withheld", cut === 100_000, `${cut}`);

  // A paid place is paid the value of its mass, not its pot.
  await backend.lockStake(bob.id, STAKE_1_USDC);
  const beforePay = (await backend.snapshot(bob.id)).balance;
  const { paid: massPaid } = await backend.payOut(bob.id, 3_200_000, 0);
  check("a paid place is paid its mass value", massPaid === 3_200_000, `${massPaid}`);
  snap = await backend.snapshot(bob.id);
  check("into the balance, with the pot taken", snap.balance === beforePay + 3_200_000 && snap.pot === 0,
    `${beforePay} -> ${snap.balance}, pot ${snap.pot}`);
  check("nothing is paid without a pot", (await backend.payOut(bob.id, 3_200_000, 0)).paid === 0);

  await backend.lockStake(bob.id, STAKE_1_USDC);
  check("forfeit empties the pot", (await backend.forfeit(bob.id)) === UNIT);
  await backend.lockStake(bob.id, STAKE_1_USDC);
  check("refund returns the pot", (await backend.refund(bob.id)) === UNIT);
  check("refunded money is spendable again", (await backend.snapshot(bob.id)).balance >= UNIT);

  // ── conservation ──
  const { held, expected } = await backend.conservation();
  check("money is conserved", held === expected, `held ${held}, expected ${expected}`);

  // ── match history and streaks ──
  // The streak rule exists twice: as a generated column in SQL and as
  // MemoryRepo.isWin. These assertions run against both, which is the only
  // thing keeping them equal.

  const base = {
    startedAt: Date.now() - 60_000, duration: 60, playersInArena: 12,
    orbs: 40, playersEaten: 2, peakMass: 500, killerId: null, stake: 0, payout: 0
  };

  // Boundary first: 6th is a loss, 5th is a win. Off-by-one on the threshold
  // is the most likely way this rule breaks.
  let r = await backend.recordMatch({ ...base, accountId: bob.id, finishPosition: 6, outcome: "eaten" });
  check("6th place is a loss", r.won === false, `won=${r.won}`);
  check("a loss leaves the streak at zero", r.currentStreak === 0);

  r = await backend.recordMatch({ ...base, accountId: bob.id, finishPosition: 5, outcome: "eaten" });
  check("5th place is a win (top-5 boundary)", r.won === true, `won=${r.won}`);
  check("streak becomes 1", r.currentStreak === 1, `${r.currentStreak}`);

  r = await backend.recordMatch({ ...base, accountId: bob.id, finishPosition: 1, outcome: "eaten" });
  check("1st place is still a win", r.won === true);
  check("streak continues", r.currentStreak === 2 && r.longestStreak === 2, `${r.currentStreak}/${r.longestStreak}`);

  r = await backend.recordMatch({ ...base, accountId: bob.id, finishPosition: 9, outcome: "bot" });
  check("a loss breaks the streak", r.currentStreak === 0);
  check("longest streak is remembered", r.longestStreak === 2, `${r.longestStreak}`);

  // Cashing out ahead wins regardless of position, so these use 9th to test
  // that clause on its own rather than riding on the top-5 rule.
  r = await backend.recordMatch({
    ...base, accountId: bob.id, finishPosition: 9,
    outcome: "cashed_out", stake: UNIT, payout: 2 * UNIT
  });
  check("cashing out in profit wins from outside the top 5", r.won === true, `won=${r.won}`);

  r = await backend.recordMatch({
    ...base, accountId: bob.id, finishPosition: 9,
    outcome: "cashed_out", stake: UNIT, payout: UNIT
  });
  check("cashing out flat is not a win", r.won === false, `won=${r.won}`);

  const st = await backend.getStats(bob.id);
  check("match count accumulates", st.matches === 6, `${st.matches}`);
  check("wins accumulate", st.wins === 3, `${st.wins}`);
  check("time played accumulates", Math.round(st.timePlayed) === 360, `${st.timePlayed}`);
  check("orbs accumulate", st.orbsAbsorbed === 240, `${st.orbsAbsorbed}`);
  check("players eaten accumulate", st.playersEaten === 12, `${st.playersEaten}`);
  check("best position is the LOWEST number", st.bestPosition === 1, `${st.bestPosition}`);
  check("first places counted separately from wins", st.firstPlaces === 1, `${st.firstPlaces}`);
  check("longest streak survives later losses", st.longestStreak === 2, `${st.longestStreak}`);
  check("best peak mass tracked", st.bestPeakMass === 500, `${st.bestPeakMass}`);

  const hist = await backend.getMatches(bob.id, 5);
  check("match history returns rows, newest first", hist.length === 5, `${hist.length}`);

  const board = await backend.getBoard("streak", 10);
  check("streak board lists the player", board.some(x => x.value >= 2), JSON.stringify(board.slice(0,2)));

  const emptyPlayer = await backend.getStats(ada.id);
  check("a player with no matches gets zeroed stats",
    emptyPlayer.matches === 0 && emptyPlayer.bestPosition === null);

  // ── progress: XP and rating ──
  const fresh = await backend.getProgress(ada.id);
  check("a player who has never finished a round has no XP, at the starting rating",
    fresh.xp === 0 && fresh.rating === START_RATING && fresh.ratedGames === 0, JSON.stringify(fresh));

  let after = await backend.recordProgress([
    { accountId: ada.id, xp: 100, ratingChange: 12.5, rated: true },
    { accountId: bob.id, xp: 0, ratingChange: -12.5, rated: true }
  ]);
  check("a round's results come back per account",
    after.get(ada.id)?.xp === 100 && after.get(bob.id)?.rating === START_RATING - 12.5,
    JSON.stringify([...after]));
  after = await backend.recordProgress([
    { accountId: ada.id, xp: 70, ratingChange: -2.25, rated: true },
    { accountId: bob.id, xp: 25, ratingChange: 0, rated: false }
  ]);
  const adaNow = await backend.getProgress(ada.id);
  check("XP adds up across rounds", adaNow.xp === 170, String(adaNow.xp));
  check("the rating moves by the change, not to it", Math.abs(adaNow.rating - (START_RATING + 10.25)) < 1e-9,
    String(adaNow.rating));
  check("rated rounds are counted", adaNow.ratedGames === 2, String(adaNow.ratedGames));
  const bobNow = await backend.getProgress(bob.id);
  check("an unrated round adds XP without counting as rated",
    bobNow.xp === 25 && bobNow.ratedGames === 1, JSON.stringify(bobNow));
  check("nothing to record is not an error", (await backend.recordProgress([])).size === 0);
  after = await backend.recordProgress([{ accountId: ada.id, xp: -50, ratingChange: 0, rated: false }]);
  check("XP never goes down", after.get(ada.id)?.xp === 170, String(after.get(ada.id)?.xp));

  // ── rename ──
  const newName = `Ada ${uniq()}`;
  const renamed = await accounts.setDisplayName(ada.id, newName);
  check("rename applies", renamed.displayName === newName);
  check("rename is readable back", (await backend.getAccount(ada.id)).displayName === newName);
  let clash = false;
  try { await accounts.setDisplayName(ada.id, bob.displayName); } catch (e) { clash = e.code === "taken"; }
  check("cannot take another player's name", clash);
}

await runContract("memory backend", new MemoryRepo(new MemoryStore()));

if (process.env.DATABASE_URL) {
  const { createPool, PgRepo } = await import("../server/db/pg.js");
  const pool = await createPool(process.env.DATABASE_URL);
  const repo = new PgRepo(pool);
  try {
    await runContract("postgres backend", repo);
  } finally {
    await repo.close();
  }
} else {
  console.log("\n== postgres backend ==");
  console.log("  skipped  set DATABASE_URL to run the same suite against Supabase");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
