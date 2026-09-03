// ---------------------------------------------------------------------------
// Server-authoritative ledger.
//
// The same rule that governs movement governs money, only harder: the client
// never decides. It does not hold a balance, it is not asked what it thinks it
// has, and it cannot spend what the server has not credited. The client's
// balance display is a read-only echo of this file.
//
// INVARIANT: total() never changes except through deposit() and withdraw().
// Every other operation moves value between accounts. test/wager.test.js
// asserts this across thousands of randomised operations, because a settlement
// bug that mints or destroys money is the kind of thing you find out about
// from your users.
//
// THIS IS NOT PRODUCTION-READY. It is an in-memory map. A real deployment
// needs a database with real transactions, because this loses every balance on
// restart, and Render restarts services routinely. See README before wiring a
// ramp to it.
// ---------------------------------------------------------------------------

import { rakeOn, DEFAULT_RAKE_BPS } from "../shared/wager.js";

export class InsufficientFunds extends Error {
  constructor(have, need) {
    super(`insufficient funds: have ${have}, need ${need}`);
    this.name = "InsufficientFunds";
  }
}

export class Ledger {
  constructor({ rakeBps = DEFAULT_RAKE_BPS, auditLimit = 5000 } = {}) {
    this.balances = new Map();   // account -> settled, withdrawable units
    this.escrow = new Map();     // account -> units at risk in the current run
    this.house = 0;              // rake and unclaimed forfeits
    this.rakeBps = rakeBps;
    this.audit = [];
    this.auditLimit = auditLimit;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  balanceOf(account) { return this.balances.get(account) || 0; }
  potOf(account) { return this.escrow.get(account) || 0; }

  total() {
    let sum = this.house;
    for (const v of this.balances.values()) sum += v;
    for (const v of this.escrow.values()) sum += v;
    return sum;
  }

  snapshot(account) {
    return {
      balance: this.balanceOf(account),
      pot: this.potOf(account),
      staked: this.potOf(account) > 0
    };
  }

  // ── audit ────────────────────────────────────────────────────────────────

  record(kind, detail) {
    this.audit.push({ at: Date.now(), kind, ...detail });
    if (this.audit.length > this.auditLimit) this.audit.shift();
  }

  // ── value entering and leaving the system ────────────────────────────────
  // These are the ONLY two operations that change total().

  deposit(account, units, ref = "mock") {
    this.assertAmount(units);
    this.balances.set(account, this.balanceOf(account) + units);
    this.record("deposit", { account, units, ref });
    return this.balanceOf(account);
  }

  withdraw(account, units, ref = "mock") {
    this.assertAmount(units);
    const have = this.balanceOf(account);
    if (have < units) throw new InsufficientFunds(have, units);
    this.balances.set(account, have - units);
    this.record("withdraw", { account, units, ref });
    return this.balanceOf(account);
  }

  // ── internal transfers ───────────────────────────────────────────────────

  // Move a stake from settled balance into escrow at the start of a run.
  lockStake(account, units) {
    this.assertAmount(units);
    const have = this.balanceOf(account);
    if (have < units) throw new InsufficientFunds(have, units);
    this.balances.set(account, have - units);
    this.escrow.set(account, this.potOf(account) + units);
    this.record("stake", { account, units });
    return this.snapshot(account);
  }

  // Winner takes the loser's entire pot. Called when one staked player eats
  // another. Returns the amount moved.
  claim(winner, loser) {
    const pot = this.potOf(loser);
    if (pot <= 0) return 0;
    this.escrow.set(loser, 0);
    this.escrow.set(winner, this.potOf(winner) + pot);
    this.record("claim", { winner, loser, units: pot });
    return pot;
  }

  // The player died to something that cannot hold a stake — a bot, or the
  // simulation itself. Nobody won it, so it goes to the house.
  //
  // This is a DESIGN SMELL, not a feature: it means the operator profits from
  // a bot killing a paying player, which is indefensible. The real fix is that
  // wagered players never share a world with bots. See README.
  forfeit(account) {
    const pot = this.potOf(account);
    if (pot <= 0) return 0;
    this.escrow.set(account, 0);
    this.house += pot;
    this.record("forfeit", { account, units: pot });
    return pot;
  }

  // Return an untouched stake — used when a run is voided rather than lost,
  // e.g. the server restarts or a match is cancelled.
  refund(account) {
    const pot = this.potOf(account);
    if (pot <= 0) return 0;
    this.escrow.set(account, 0);
    this.balances.set(account, this.balanceOf(account) + pot);
    this.record("refund", { account, units: pot });
    return pot;
  }

  // Realise escrow back into withdrawable balance, less rake.
  cashOut(account) {
    const pot = this.potOf(account);
    if (pot <= 0) return { paid: 0, rake: 0 };
    const rake = rakeOn(pot, this.rakeBps);
    const paid = pot - rake;
    this.escrow.set(account, 0);
    this.house += rake;
    this.balances.set(account, this.balanceOf(account) + paid);
    this.record("cashout", { account, units: paid, rake });
    return { paid, rake };
  }

  assertAmount(units) {
    if (!Number.isSafeInteger(units) || units <= 0) {
      throw new RangeError(`amount must be a positive integer of micro-USDC, got ${units}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ramp placeholder.
//
// A Ramp is whatever moves real value between a player's wallet and this
// ledger. Nothing here touches a chain, a custodian, or an exchange. The
// interface exists so that the rest of the server is already written against
// the shape a real one would have.
//
// MockRamp hands out play money and is the only implementation that ships.
// Setting REAL_MONEY=1 without providing a real Ramp is a hard startup error
// rather than a silent fallback, so this cannot be turned on by accident.
// ---------------------------------------------------------------------------

export class Ramp {
  get isReal() { return false; }
  // eslint-disable-next-line no-unused-vars
  async openDeposit(account) { throw new Error("Ramp.openDeposit not implemented"); }
  // eslint-disable-next-line no-unused-vars
  async requestWithdrawal(account, units, destination) { throw new Error("Ramp.requestWithdrawal not implemented"); }
}

export class MockRamp extends Ramp {
  constructor({ ledger, backend, welcomeGrant = 5_000_000 } = {}) {
    super();
    // Either a raw Ledger (tests) or a backend implementing the same money
    // surface (the server). Both expose snapshot/deposit.
    this.backend = backend || ledger;
    this.welcomeGrant = welcomeGrant;   // 5.00 demo USDC per new account
  }

  get isReal() { return false; }

  // Called once per new account. Real money never appears this way.
  async grant(accountId) {
    const snap = await this.backend.snapshot(accountId);
    if (snap.balance > 0 || snap.pot > 0) return snap.balance;
    return this.backend.deposit(accountId, this.welcomeGrant, "demo-grant");
  }

  async openDeposit() {
    return {
      ok: false,
      reason: "No payment ramp is connected. Balances here are demo credits with no cash value."
    };
  }

  async requestWithdrawal() {
    return {
      ok: false,
      reason: "No payment ramp is connected. Demo credits cannot be withdrawn."
    };
  }
}

export function createRamp({ ledger, backend, real = false }) {
  if (real) {
    // Deliberately fatal. Wiring a real ramp means implementing Ramp against
    // a custodian or on-chain contract and returning it here, having read the
    // "Before real money" checklist in the README.
    throw new Error(
      "REAL_MONEY=1 but no real Ramp implementation exists. " +
      "Refusing to start: see the 'Before real money' section of the README."
    );
  }
  return new MockRamp({ ledger, backend });
}
