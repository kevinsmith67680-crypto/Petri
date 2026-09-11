// ---------------------------------------------------------------------------
// Accounts, sessions and display names.
//
// Credible scaffolding, NOT audited authentication. It gets the well-known
// things right — per-user salts, a memory-hard KDF, timing-safe comparison,
// hashed session tokens, throttled login attempts — but before this guards
// anything of value it should be replaced by a managed identity provider, or
// at minimum reviewed by someone who does this for a living.
//
// EVERYTHING IS ASYNC ON PURPOSE. scryptSync takes roughly 100ms, and this
// process runs a 20Hz game loop on the same thread: a synchronous hash would
// drop two ticks for every login. Every password operation below yields.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { promisify } from "node:util";

import { MIN_AGE, MAX_AGE, parseDob, ageOn } from "../shared/age.js";

const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 30;

export const NAME_MIN = 3;
export const NAME_MAX = 16;
export const PASSWORD_MIN = 8;

// Names are drawn onto cells and into the leaderboard, so they are restricted
// to a conservative set. Unicode look-alikes are an impersonation vector, and
// with money involved impersonation matters more than expressiveness.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,14}[A-Za-z0-9]$/;
const USERNAME_RE = /^[a-z0-9_.-]{3,20}$/;

// "You" is what the local client labels your own cell; the rest are the usual
// impersonation targets.
const RESERVED = new Set([
  "you", "admin", "administrator", "mod", "moderator", "system", "server",
  "petri", "support", "staff", "official", "root", "null", "undefined", "bot"
]);

export class AccountError extends Error {
  constructor(message, code = "invalid") {
    super(message);
    this.name = "AccountError";
    this.code = code;
  }
}

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const norm = s => String(s ?? "").trim();

export function validateDisplayName(raw) {
  const name = norm(raw).replace(/\s+/g, " ");
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    throw new AccountError(`Name must be ${NAME_MIN} to ${NAME_MAX} characters.`);
  }
  if (!NAME_RE.test(name)) {
    throw new AccountError("Use letters, numbers, spaces, hyphens and underscores only.");
  }
  if (RESERVED.has(name.toLowerCase())) {
    throw new AccountError("That name is reserved.");
  }
  return name;
}

// The age gate. Applied wherever an account is CREATED, never where one is
// merely signed into: the check belongs to the act of opening an account, and
// re-asking an existing player on every login would only invite them to learn
// which answer gets them in.
//
// Returns the canonical YYYY-MM-DD to store. What is stored is the date the
// player asserted, not a boolean — "we let them in" is not auditable, and a
// later identity check has nothing to reconcile against.
export function validateDateOfBirth(raw, now = new Date()) {
  const dob = parseDob(raw);
  if (!dob) throw new AccountError("Enter your date of birth.", "age");
  if (dob.getTime() > now.getTime()) {
    throw new AccountError("That date of birth is in the future.", "age");
  }
  const age = ageOn(dob, now);
  if (age > MAX_AGE) throw new AccountError("Check that date of birth.", "age");
  if (age < MIN_AGE) {
    // Says what the rule is and nothing about how close they were. A message
    // that reveals the margin is an instruction for the retry.
    throw new AccountError(
      `You must be ${MIN_AGE} or over to open an account.`, "underage"
    );
  }
  return dob.toISOString().slice(0, 10);
}

export function validateUsername(raw) {
  const username = norm(raw).toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new AccountError("Username must be 3 to 20 characters: letters, numbers, dot, dash, underscore.");
  }
  if (RESERVED.has(username)) throw new AccountError("That username is reserved.");
  return username;
}

export class Accounts {
  // `repo` is either MemoryRepo or PgRepo. Everything below is async because
  // the Postgres implementation is; the memory one matches its signatures so
  // the two stay interchangeable.
  constructor(repo, { nameCooldownMs = 60_000 } = {}) {
    this.repo = repo;
    this.nameCooldownMs = nameCooldownMs;
    // Throttle state is in memory only: losing it on restart is acceptable,
    // and keeping it out of the store avoids a disk write per failed login.
    this.attempts = new Map();   // key -> { count, until }
  }

  // ── password hashing ─────────────────────────────────────────────────────

  async hash(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${key.toString("hex")}`;
  }

  async verify(password, stored) {
    // Google accounts store no password. Refuse rather than treating an empty
    // hash as a match.
    if (!stored) return false;
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, N, r, p, saltHex, keyHex] = parts;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(keyHex, "hex");
    const actual = await scrypt(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p)
    });
    // Constant-time: a plain === leaks how much of the hash matched.
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  // ── throttling ───────────────────────────────────────────────────────────

  // Keyed by both username and IP, so neither spraying one password across
  // many accounts nor hammering one account gets far.
  throttleCheck(key) {
    const rec = this.attempts.get(key);
    if (rec && rec.until > Date.now()) {
      const secs = Math.ceil((rec.until - Date.now()) / 1000);
      throw new AccountError(`Too many attempts. Try again in ${secs}s.`, "throttled");
    }
  }

  throttleFail(key) {
    const rec = this.attempts.get(key) || { count: 0, until: 0 };
    rec.count++;
    if (rec.count >= 5) {
      // Back off geometrically, capped at five minutes.
      rec.until = Date.now() + Math.min(300_000, 2 ** (rec.count - 5) * 5000);
    }
    this.attempts.set(key, rec);
  }

  throttleReset(key) { this.attempts.delete(key); }

  // ── accounts ─────────────────────────────────────────────────────────────

  async byUsername(username) {
    return this.repo.findAccountByUsername(username);
  }

  async displayNameTaken(name, exceptId = null) {
    const found = await this.repo.findAccountByDisplayName(name);
    return !!found && found.id !== exceptId;
  }

  // ── federated sign-in ─────────────────────────────────────────────────────

  // Find the account for a Google subject, or make one.
  //
  // DELIBERATELY NOT LINKED BY EMAIL. It is tempting to match a Google email
  // against an existing account and merge them, and it is a well-known
  // account-takeover route: anyone who can get a Google address that matches
  // an existing user inherits their account. Accounts here hold no email at
  // all, so there is nothing to match against anyway. A Google sign-in is its
  // own account, keyed by the immutable `sub`.
  async findOrCreateGoogle({ sub, name, givenName, email, dateOfBirth, ip = "unknown" }) {
    const existing = await this.repo.findAccountByGoogleSub(sub);
    if (existing) return existing;

    // Past this line we are creating an account, not signing into one, so the
    // age gate applies exactly as it does to the password path. Google asserts
    // nothing about age, and a gate that only guarded the form would be no
    // gate at all — this route creates accounts in one click.
    if (!String(dateOfBirth ?? "").trim()) {
      throw new AccountError(
        "Confirm your date of birth to create an account.", "age_required"
      );
    }
    const dob = validateDateOfBirth(dateOfBirth);

    const displayName = await this.uniqueDisplayName(
      givenName || name || (email ? email.split("@")[0] : "Player")
    );

    return this.repo.insertAccount({
      // A username is required by the schema but never used to sign in here;
      // deriving it from the subject keeps it unique without exposing it.
      username: `g_${sub}`.slice(0, 20),
      displayName,
      password: null,          // no password: this account signs in via Google
      googleSub: sub,
      dateOfBirth: dob,
      createdIp: ip
    });
  }

  // Google display names collide constantly — every third person is "James".
  // Sanitise to our own rules, then add a numeric suffix until it is free.
  async uniqueDisplayName(raw) {
    let base;
    try {
      base = validateDisplayName(raw);
    } catch {
      base = "Player";
    }
    if (!(await this.displayNameTaken(base))) return base;

    for (let i = 2; i < 500; i++) {
      const suffix = String(i);
      const trimmed = base.slice(0, NAME_MAX - suffix.length - 1).trim();
      const candidate = `${trimmed} ${suffix}`;
      if (!(await this.displayNameTaken(candidate))) return candidate;
    }
    // Vanishingly unlikely, but never loop forever.
    return `Player ${Date.now().toString(36).slice(-5)}`;
  }

  async signup({ username, password, displayName, dateOfBirth, ip = "unknown" }) {
    const user = validateUsername(username);
    if (String(password ?? "").length < PASSWORD_MIN) {
      throw new AccountError(`Password must be at least ${PASSWORD_MIN} characters.`);
    }
    const name = validateDisplayName(displayName || username);
    // Before the uniqueness queries and before hashing: scrypt costs ~100ms on
    // the same thread the game loop runs on, and an ineligible signup should
    // not buy any of it.
    const dob = validateDateOfBirth(dateOfBirth);

    if (await this.byUsername(user)) throw new AccountError("That username is taken.", "taken");
    if (await this.displayNameTaken(name)) throw new AccountError("That display name is taken.", "taken");

    try {
      // The unique indexes are the real guard. The checks above only exist to
      // produce a friendlier message before the database refuses it.
      return await this.repo.insertAccount({
        username: user,
        displayName: name,
        password: await this.hash(password),
        dateOfBirth: dob,
        createdIp: ip
      });
    } catch (err) {
      if (err.code === "taken") throw new AccountError(err.message, "taken");
      throw err;
    }
  }

  async login({ username, password, ip = "unknown" }) {
    const user = validateUsername(username);
    const byUser = `u:${user}`;
    const byIp = `i:${ip}`;
    this.throttleCheck(byUser);
    this.throttleCheck(byIp);

    const account = await this.byUsername(user);
    // Hash against a dummy even when the account is missing, so response time
    // does not reveal whether a username exists. Password-less Google accounts
    // take the same path, so they are indistinguishable from a wrong password.
    const stored = account && account.password ? account.password : await this.dummyHash();
    const ok = await this.verify(String(password ?? ""), stored);

    if (!account || !ok) {
      this.throttleFail(byUser);
      this.throttleFail(byIp);
      // One message for both cases, deliberately.
      throw new AccountError("Incorrect username or password.", "credentials");
    }

    this.throttleReset(byUser);
    this.throttleReset(byIp);
    return account;
  }

  async dummyHash() {
    if (!this._dummy) this._dummy = await this.hash(crypto.randomBytes(16).toString("hex"));
    return this._dummy;
  }

  async setDisplayName(accountId, raw) {
    const account = await this.repo.getAccount(accountId);
    if (!account) throw new AccountError("No such account.", "missing");

    const name = validateDisplayName(raw);
    if (name === account.displayName) return account;

    const since = Date.now() - (account.nameChangedAt || 0);
    if (since < this.nameCooldownMs) {
      const secs = Math.ceil((this.nameCooldownMs - since) / 1000);
      throw new AccountError(`You can change your name again in ${secs}s.`, "throttled");
    }
    if (await this.displayNameTaken(name, accountId)) {
      throw new AccountError("That display name is taken.", "taken");
    }

    try {
      return await this.repo.updateDisplayName(accountId, name);
    } catch (err) {
      if (err.code === "taken") throw new AccountError(err.message, "taken");
      throw err;
    }
  }

  // ── sessions ─────────────────────────────────────────────────────────────

  // The raw token goes to the client once and is never stored. Only its hash
  // is kept, so a leaked store does not hand over live sessions.
  async createSession(accountId) {
    const token = crypto.randomBytes(32).toString("hex");
    await this.repo.insertSession({
      id: sha256(token),
      accountId,
      expiresAt: Date.now() + SESSION_DAYS * 86_400_000
    });
    return token;
  }

  async resolveSession(token) {
    // Reject the obviously wrong shape before touching the database, so a
    // flood of junk tokens costs no queries.
    if (typeof token !== "string" || token.length !== 64) return null;
    return this.repo.findAccountBySession(sha256(token));
  }

  async destroySession(token) {
    if (typeof token !== "string" || token.length !== 64) return;
    await this.repo.deleteSession(sha256(token));
  }

  async sweepSessions() { return this.repo.sweepSessions(); }

  // What the client is allowed to see. Never includes the password hash.
  publicView(account) {
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      createdAt: account.createdAt,
      // Lets the client show "signed in with Google" and hide the password
      // change UI, without ever exposing the Google subject itself.
      provider: account.googleSub ? "google" : "password"
    };
  }
}
