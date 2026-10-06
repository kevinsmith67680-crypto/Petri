// ---------------------------------------------------------------------------
// Ledger tests. Run with:  node test/wager.test.js
//
// The headline check is CONSERVATION: total() must change only through
// deposit() and withdraw(). Every other operation moves value sideways. A
// settlement bug that quietly mints or destroys money is the kind of defect
// you otherwise learn about from an angry user, so it is fuzzed here across
// thousands of randomised operations.
// ---------------------------------------------------------------------------

import { Ledger, MockRamp, createRamp, InsufficientFunds } from "../server/ledger.js";
import {
  UNIT, PRACTICE, STAKE_1_USDC, formatUsdc, parseUsdc, isValidStake, rakeOn, valueOfMass
} from "../shared/wager.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}
function throws(label, fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(label, threw);
}

console.log("\n-- money formatting --");

check("one USDC is a million units", UNIT === 1_000_000);
check("formats whole amounts", formatUsdc(UNIT) === "1.00", formatUsdc(UNIT));
check("formats fractions", formatUsdc(1_250_000) === "1.25", formatUsdc(1_250_000));
check("formats zero", formatUsdc(0) === "0.00");
check("truncates rather than rounds", formatUsdc(1_999_999) === "1.99", formatUsdc(1_999_999));
check("parses back", parseUsdc("1.25") === 1_250_000);
check("parses integers", parseUsdc("3") === 3_000_000);
check("rejects junk", parseUsdc("1.2.3") === null && parseUsdc("abc") === null);
check("rejects negatives", parseUsdc("-1") === null);
check("round-trips", parseUsdc(formatUsdc(4_560_000, 6)) === 4_560_000);
check("only listed tiers are valid stakes",
  isValidStake(PRACTICE) && isValidStake(STAKE_1_USDC) && !isValidStake(500_000) && !isValidStake(1.5));
check("rake maths is integral", rakeOn(1_000_000, 250) === 25_000);
check("zero rake by default", rakeOn(1_000_000, 0) === 0);

console.log("\n-- ledger basics --");

const L = new Ledger();
L.deposit("alice", 5 * UNIT);
L.deposit("bob", 5 * UNIT);
check("deposits land", L.balanceOf("alice") === 5 * UNIT);
check("total reflects deposits", L.total() === 10 * UNIT);

L.lockStake("alice", STAKE_1_USDC);
L.lockStake("bob", STAKE_1_USDC);
check("staking moves balance into escrow",
  L.balanceOf("alice") === 4 * UNIT && L.potOf("alice") === UNIT);
check("staking does not change the total", L.total() === 10 * UNIT, String(L.total()));

L.claim("alice", "bob");
check("winner takes the pot", L.potOf("alice") === 2 * UNIT && L.potOf("bob") === 0);
check("claiming does not change the total", L.total() === 10 * UNIT);

const { paid } = L.cashOut("alice");
check("cash out realises escrow", paid === 2 * UNIT && L.balanceOf("alice") === 6 * UNIT);
check("cash out does not change the total", L.total() === 10 * UNIT);
check("cashing out an empty pot is a no-op", L.cashOut("alice").paid === 0);

throws("cannot stake more than you hold", () => L.lockStake("bob", 99 * UNIT));
throws("cannot withdraw more than you hold", () => L.withdraw("bob", 99 * UNIT));
throws("rejects fractional amounts", () => L.deposit("bob", 1.5));
throws("rejects negative amounts", () => L.deposit("bob", -5));
throws("rejects zero", () => L.deposit("bob", 0));

check("insufficient funds is typed", (() => {
  try { L.withdraw("nobody", UNIT); return false; }
  catch (e) { return e instanceof InsufficientFunds; }
})());

console.log("\n-- rake --");

const R = new Ledger({ rakeBps: 250 });   // 2.5%
R.deposit("carol", 10 * UNIT);
R.lockStake("carol", 4 * UNIT);
const cashed = R.cashOut("carol");
check("rake is taken from winnings", cashed.rake === 100_000 && cashed.paid === 3_900_000,
  `paid ${cashed.paid}, rake ${cashed.rake}`);
check("rake stays inside the system", R.total() === 10 * UNIT, String(R.total()));
check("house holds the rake", R.house === 100_000);

console.log("\n-- a paid place is paid its mass --");

// The HUD's "Mass value" is what a paid place is paid. The house takes the
// pot and funds any difference, which can take it below zero, but value only
// moves: the total stays put.
const P = new Ledger();
P.deposit("dan", 5 * UNIT);
P.deposit("eve", 5 * UNIT);
P.lockStake("dan", STAKE_1_USDC);
P.lockStake("eve", STAKE_1_USDC);
P.claim("dan", "eve");                                   // dan's pot is 2.00
const big = P.payOut("dan", valueOfMass(640));           // 3.20
check("a paid place is paid the value of its mass",
  big.paid === 3_200_000 && P.balanceOf("dan") === 7_200_000, `${big.paid} / ${P.balanceOf("dan")}`);
check("the house takes the pot and funds the rest, below zero if it must",
  P.potOf("dan") === 0 && P.house === 2 * UNIT - 3_200_000, String(P.house));
check("and no value appears or disappears", P.total() === 10 * UNIT, String(P.total()));
P.lockStake("eve", STAKE_1_USDC);
const small = P.payOut("eve", valueOfMass(74));          // 0.37 on a 1.00 stake
check("a small mass is paid less than its stake",
  small.paid === 370_000 && P.balanceOf("eve") === 3_370_000, `${small.paid} / ${P.balanceOf("eve")}`);
check("nothing is paid without a pot", P.payOut("eve", valueOfMass(500)).paid === 0);
check("the total still holds", P.total() === 10 * UNIT, String(P.total()));
const PR = new Ledger({ rakeBps: 250 });
PR.deposit("fay", 5 * UNIT);
PR.lockStake("fay", STAKE_1_USDC);
const raked = PR.payOut("fay", 2 * UNIT);
check("rake comes off the payout", raked.rake === 50_000 && raked.paid === 1_950_000,
  `paid ${raked.paid}, rake ${raked.rake}`);
check("and stays inside the system", PR.total() === 5 * UNIT, String(PR.total()));

console.log("\n-- conservation under fuzzing --");

const F = new Ledger({ rakeBps: 175 });
const accounts = ["a", "b", "c", "d", "e"];
for (const a of accounts) F.deposit(a, 10 * UNIT);
const expected = F.total();

let mutations = 0, negatives = 0;
for (let i = 0; i < 20000; i++) {
  const a = accounts[Math.floor(Math.random() * accounts.length)];
  const b = accounts[Math.floor(Math.random() * accounts.length)];
  const op = Math.floor(Math.random() * 6);
  try {
    if (op === 0) F.lockStake(a, STAKE_1_USDC);
    else if (op === 1) F.claim(a, b);
    else if (op === 2) F.cashOut(a);
    else if (op === 3) F.forfeit(a);
    else if (op === 4) F.refund(a);
    else F.payOut(a, valueOfMass(20 + Math.floor(Math.random() * 3000)));
    mutations++;
  } catch { /* rejected operations are fine; they must not move money */ }

  if (F.total() !== expected) { failures++; console.log(` FAIL  total drifted at op ${i}`); break; }
  for (const acc of accounts) {
    if (F.balanceOf(acc) < 0 || F.potOf(acc) < 0) negatives++;
  }
}
check("total is invariant across 20k random operations",
  F.total() === expected, `${F.total()} vs ${expected}, ${mutations} applied`);
check("no account ever goes negative", negatives === 0, `${negatives} negatives`);

console.log("\n-- ramp placeholder --");

const ledger = new Ledger();
const ramp = createRamp({ ledger, real: false });
check("default ramp is not real", ramp.isReal === false);
check("mock ramp is what ships", ramp instanceof MockRamp);

await ramp.grant("newbie");
check("demo grant funds an account", ledger.balanceOf("newbie") === 5 * UNIT);
await ramp.grant("newbie");
check("demo grant is not repeatable", ledger.balanceOf("newbie") === 5 * UNIT);

const dep = await ramp.openDeposit("newbie");
const wit = await ramp.requestWithdrawal("newbie", UNIT, "0xdead");
check("deposits refuse while no ramp is connected", dep.ok === false && !!dep.reason);
check("withdrawals refuse while no ramp is connected", wit.ok === false && !!wit.reason);

// The safety interlock: asking for real money without a real implementation
// must be a hard failure, never a silent fallback to play money.
throws("REAL_MONEY without a real ramp refuses to start",
  () => createRamp({ ledger, real: true }));

console.log("\n-- audit trail --");
check("operations are recorded", ledger.audit.length > 0);
check("audit entries carry a kind and a time",
  ledger.audit.every(e => typeof e.kind === "string" && typeof e.at === "number"));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
