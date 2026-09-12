// ---------------------------------------------------------------------------
// In-memory backend.
//
// Implements exactly the surface PgRepo does, so the server can run without a
// database and the same tests can be pointed at either. test/backend.test.js
// runs the identical suite against both, which is what keeps them honest.
//
// Everything is async even though nothing here needs to be: matching the
// Postgres signatures is what makes the two swappable.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { Ledger } from "../ledger.js";
import { DEFAULT_RAKE_BPS } from "../../shared/wager.js";
import { emptyStats } from "./pg.js";

// Keep in step with the `won` generated column in server/db/schema.sql.
// Changing it here alone will silently desync the two backends; the contract
// test in test/backend.test.js exists to catch exactly that.
export const WIN_TOP_N = 5;

export class MemoryRepo {
  constructor(store, { rakeBps = DEFAULT_RAKE_BPS } = {}) {
    this.store = store;
    this.ledger = new Ledger({ rakeBps });
  }

  // ── accounts ──────────────────────────────────────────────────────────────
  // These scan every account. Acceptable for development and for the handful
  // of accounts a local run creates; the Postgres backend uses indexes.

  async findAccountByUsername(username) {
    const lower = String(username).toLowerCase();
    return this.store.all("accounts").find(a => a.username.toLowerCase() === lower) || null;
  }

  async findAccountByDisplayName(name) {
    const lower = String(name).toLowerCase();
    return this.store.all("accounts").find(a => a.displayName.toLowerCase() === lower) || null;
  }

  async getAccount(id) { return this.store.get("accounts", id); }

  async findAccountByGoogleSub(sub) {
    if (!sub) return null;
    return this.store.all("accounts").find(a => a.googleSub === sub) || null;
  }

  async insertAccount({ username, displayName, password, googleSub = null, dateOfBirth = null, createdIp }) {
    // Re-check under the same tick the write happens, mirroring the unique
    // index the database enforces.
    if (await this.findAccountByUsername(username)) {
      const e = new Error("That username is taken."); e.code = "taken"; throw e;
    }
    if (await this.findAccountByDisplayName(displayName)) {
      const e = new Error("That display name is taken."); e.code = "taken"; throw e;
    }
    if (googleSub && await this.findAccountByGoogleSub(googleSub)) {
      const e = new Error("That Google account is already linked."); e.code = "taken"; throw e;
    }
    const account = {
      id: crypto.randomUUID(),
      username, displayName, password, googleSub, dateOfBirth,
      createdAt: Date.now(),
      createdIp,
      nameChangedAt: 0
    };
    this.store.put("accounts", account.id, account);
    return account;
  }

  async updateDisplayName(id, displayName) {
    const account = this.store.get("accounts", id);
    if (!account) return null;
    const clash = await this.findAccountByDisplayName(displayName);
    if (clash && clash.id !== id) {
      const e = new Error("That display name is taken."); e.code = "taken"; throw e;
    }
    account.displayName = displayName;
    account.nameChangedAt = Date.now();
    this.store.put("accounts", id, account);
    return account;
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  async insertSession({ id, accountId, expiresAt }) {
    this.store.put("sessions", id, { id, accountId, createdAt: Date.now(), expiresAt });
  }

  async findAccountBySession(sessionId) {
    const session = this.store.get("sessions", sessionId);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.store.remove("sessions", sessionId);
      return null;
    }
    return this.store.get("accounts", session.accountId) || null;
  }

  async getSession(id) { return this.store.get("sessions", id); }
  async deleteSession(id) { this.store.remove("sessions", id); }

  async sweepSessions() {
    const now = Date.now();
    let n = 0;
    for (const s of this.store.all("sessions")) {
      if (s.expiresAt < now) { this.store.remove("sessions", s.id); n++; }
    }
    return n;
  }

  // ── money ─────────────────────────────────────────────────────────────────

  async ensureBalance() { /* Ledger creates entries lazily */ }
  async snapshot(accountId) { return this.ledger.snapshot(accountId); }
  async deposit(accountId, units, ref) { return this.ledger.deposit(accountId, units, ref); }
  async lockStake(accountId, units) {
    this.ledger.lockStake(accountId, units);
    return { balance: this.ledger.balanceOf(accountId), pot: this.ledger.potOf(accountId) };
  }
  async claim(winnerId, loserId) { return this.ledger.claim(winnerId, loserId); }
  async cashOut(accountId, rakeBps) {
    if (rakeBps !== undefined) this.ledger.rakeBps = rakeBps;
    return this.ledger.cashOut(accountId);
  }
  async forfeit(accountId) { return this.ledger.forfeit(accountId); }
  async refund(accountId) { return this.ledger.refund(accountId); }
  async potOf(accountId) { return this.ledger.potOf(accountId); }
  async balanceOf(accountId) { return this.ledger.balanceOf(accountId); }

  // ── matches and stats ─────────────────────────────────────────────────────
  // The streak rules here must match petri.record_match exactly. They are
  // asserted side by side in test/backend.test.js for that reason.

  // Mirrors the `won` generated column in schema.sql. One rule, two
  // implementations — the contract test is what keeps them equal.
  // A win is a top-5 finish, or cashing out ahead of your stake.
  static isWin(m) {
    return (m.finishPosition != null && m.finishPosition <= WIN_TOP_N)
      || (m.outcome === "cashed_out" && (m.payout || 0) > (m.stake || 0));
  }

  async recordMatch(m) {
    const matches = (this.store.data.matches ||= {});
    const id = Object.keys(matches).length + 1;
    const won = MemoryRepo.isWin(m);
    const row = { id, won, endedAt: Date.now(), ...m };
    matches[id] = row;
    this.store.dirty = true;

    const all = (this.store.data.player_stats ||= {});
    const s = all[m.accountId] || { accountId: m.accountId, ...emptyStats() };

    s.matches += 1;
    s.wins += won ? 1 : 0;
    s.timePlayed += m.duration || 0;
    s.orbsAbsorbed += m.orbs || 0;
    s.playersEaten += m.playersEaten || 0;
    s.bestPeakMass = Math.max(s.bestPeakMass, m.peakMass || 0);
    // Best position is the lowest number, so min, not max.
    if (m.finishPosition != null) {
      s.bestPosition = s.bestPosition == null
        ? m.finishPosition
        : Math.min(s.bestPosition, m.finishPosition);
    }
    s.firstPlaces += m.finishPosition === 1 ? 1 : 0;
    s.currentStreak = won ? s.currentStreak + 1 : 0;
    s.longestStreak = Math.max(s.longestStreak, s.currentStreak);
    s.totalStaked += m.stake || 0;
    s.totalWon += m.payout || 0;
    s.lastPlayedAt = Date.now();

    all[m.accountId] = s;
    this.store.dirty = true;

    return { matchId: id, won, currentStreak: s.currentStreak, longestStreak: s.longestStreak };
  }

  async getStats(accountId) {
    const s = this.store.data.player_stats?.[accountId];
    if (!s) return emptyStats();
    const { accountId: _ignored, ...rest } = s;
    return rest;
  }

  async getMatches(accountId, limit = 10) {
    return Object.values(this.store.data.matches || {})
      .filter(m => m.accountId === accountId)
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, Math.min(50, Math.max(1, limit)));
  }

  async getBoard(kind = "mass", limit = 10) {
    const field = { mass: "bestPeakMass", streak: "longestStreak", orbs: "orbsAbsorbed" }[kind];
    if (!field) throw new Error(`unknown board ${kind}`);
    const rows = [];
    for (const [id, s] of Object.entries(this.store.data.player_stats || {})) {
      const account = this.store.get("accounts", id);
      if (account && s[field] > 0) rows.push({ name: account.displayName, value: s[field] });
    }
    return rows.sort((a, b) => b.value - a.value).slice(0, limit);
  }

  async conservation() {
    const held = this.ledger.total();
    const expected = this.ledger.audit
      .filter(e => e.kind === "deposit").reduce((s, e) => s + e.units, 0)
      - this.ledger.audit.filter(e => e.kind === "withdraw").reduce((s, e) => s + e.units, 0);
    return { held, expected };
  }

  async close() { await this.store.flush?.(); }
}
