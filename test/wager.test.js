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
  UNIT, PRACTICE, STAKE_1_USDC, formatUsdc, parseUsdc, isValidStake, rakeOn
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

console.log("\n-- conservation under fuzzing --");

const F = new Ledger({ rakeBps: 175 });
const accounts = ["a", "b", "c", "d", "e"];
for (const a of accounts) F.deposit(a, 10 * UNIT);
const expected = F.total();

let mutations = 0, negatives = 0;
for (let i = 0; i < 20000; i++) {
  const a = accounts[Math.floor(Math.random() * accounts.length)];
  const b = accounts[Math.floor(Math.random() * accounts.length)];
  const op = Math.floor(Math.random() * 5);
  try {
    if (op === 0) F.lockStake(a, STAKE_1_USDC);
    else if (op === 1) F.claim(a, b);
    else if (op === 2) F.cashOut(a);
    else if (op === 3) F.forfeit(a);
    else F.refund(a);
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
