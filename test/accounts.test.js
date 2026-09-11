// ---------------------------------------------------------------------------
// Account tests. Run with:  node test/accounts.test.js
//
// Focused on the things that are quietly wrong in most hand-rolled auth:
// password hashes that are reversible or comparable in variable time, session
// tokens stored in the clear, login errors that reveal whether a username
// exists, and name rules that allow impersonation.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { Accounts, AccountError, validateDisplayName, validateUsername, validateDateOfBirth }
  from "../server/accounts.js";
import { latestEligibleDob } from "../shared/age.js";
import { MemoryStore } from "../server/store.js";
import { MemoryRepo } from "../server/db/memory.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}
async function rejects(label, fn, code = null) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  check(label, !!err && (!code || err.code === code), err ? `(${err.code || err.name})` : "(did not throw)");
}

const repo = new MemoryRepo(new MemoryStore());
const accounts = new Accounts(repo, { nameCooldownMs: 0 });

console.log("\n-- validation --");

check("accepts a normal name", validateDisplayName("Ada L") === "Ada L");
check("collapses whitespace", validateDisplayName("Ada   L") === "Ada L");
check("trims", validateDisplayName("  Ada  ") === "Ada");
for (const [label, bad] of [
  ["too short", "ab"], ["too long", "abcdefghijklmnopq"],
  ["leading space handled as short", " a "], ["control characters", "Ada\u0000L"],
  ["angle brackets", "<script>"], ["reserved", "Admin"], ["reserved lowercase", "you"]
]) {
  let threw = false;
  try { validateDisplayName(bad); } catch { threw = true; }
  check(`rejects ${label}`, threw);
}
check("usernames are lowercased", validateUsername("AdaL") === "adal");
let badUser = false;
try { validateUsername("a b"); } catch { badUser = true; }
check("rejects spaces in usernames", badUser);

console.log("\n-- password hashing --");

const hash = await accounts.hash("correct horse battery");
check("hash is not the password", !hash.includes("correct horse battery"));
check("hash records its parameters", hash.startsWith("scrypt$16384$8$1$"));
check("verifies the right password", await accounts.verify("correct horse battery", hash));
check("rejects the wrong password", !(await accounts.verify("wrong", hash)));

const hash2 = await accounts.hash("correct horse battery");
check("same password hashes differently (per-user salt)", hash !== hash2);
check("both still verify", await accounts.verify("correct horse battery", hash2));
check("garbage hash does not verify", !(await accounts.verify("x", "not-a-hash")));
check("empty stored hash does not verify", !(await accounts.verify("x", "")));

console.log("\n-- signup and login --");

const ada = await accounts.signup({ username: "ada", password: "lovelace1843", displayName: "Ada", dateOfBirth: "1990-01-01" });
check("signup returns an account", !!ada.id && ada.username === "ada");
check("display name is stored", ada.displayName === "Ada");
check("public view hides the hash", !("password" in accounts.publicView(ada)));

await rejects("duplicate username rejected",
  () => accounts.signup({ username: "ada", password: "another1234", displayName: "Ada2", dateOfBirth: "1990-01-01" }), "taken");
await rejects("duplicate display name rejected",
  () => accounts.signup({ username: "ada2", password: "another1234", displayName: "ada", dateOfBirth: "1990-01-01" }), "taken");
await rejects("short password rejected",
  () => accounts.signup({ username: "bob", password: "short", displayName: "Bob", dateOfBirth: "1990-01-01" }));

const back = await accounts.login({ username: "ada", password: "lovelace1843" });
check("login succeeds", back.id === ada.id);
check("login is case-insensitive on username",
  (await accounts.login({ username: "ADA", password: "lovelace1843" })).id === ada.id);

// The same message either way: a different one for "no such user" tells an
// attacker which usernames are worth attacking.
let missingMsg = "", wrongMsg = "";
try { await accounts.login({ username: "nobody", password: "whatever12" }); } catch (e) { missingMsg = e.message; }
try { await accounts.login({ username: "ada", password: "whatever12" }); } catch (e) { wrongMsg = e.message; }
check("unknown user and wrong password give the same error",
  missingMsg === wrongMsg && missingMsg.length > 0, missingMsg);

console.log("\n-- sessions --");

const token = await accounts.createSession(ada.id);
check("token is 256 bits of hex", /^[0-9a-f]{64}$/.test(token));
check("token resolves to the account", (await accounts.resolveSession(token))?.id === ada.id);
check("rubbish token resolves to nothing", (await accounts.resolveSession("nope")) === null);
check("wrong-length token rejected", (await accounts.resolveSession("a".repeat(63))) === null);
check("null token rejected", (await accounts.resolveSession(null)) === null);

// The raw token must never be recoverable from storage.
const stored = repo.store.all("sessions");
check("raw token is not stored", !JSON.stringify(stored).includes(token));
check("token hash is stored", stored.some(s => s.id === crypto.createHash("sha256").update(token).digest("hex")));

await accounts.destroySession(token);
check("destroyed session stops resolving", (await accounts.resolveSession(token)) === null);

const expiring = await accounts.createSession(ada.id);
const rec = repo.store.all("sessions").find(s => s.accountId === ada.id);
rec.expiresAt = Date.now() - 1;
check("expired session stops resolving", (await accounts.resolveSession(expiring)) === null);

console.log("\n-- renaming --");

const renamed = await accounts.setDisplayName(ada.id, "Ada Byron");
check("name changes", renamed.displayName === "Ada Byron");
check("rename is persisted", (await repo.getAccount(ada.id)).displayName === "Ada Byron");

await accounts.signup({ username: "grace", password: "hopper1906", displayName: "Grace", dateOfBirth: "1990-01-01" });
let clash = false;
try { await accounts.setDisplayName(ada.id, "Grace"); } catch (e) { clash = e.code === "taken"; }
check("cannot take another player's name", clash);
check("can keep your own name (no-op)",
  (await accounts.setDisplayName(ada.id, "Ada Byron")).displayName === "Ada Byron");

let invalid = false;
try { await accounts.setDisplayName(ada.id, "<b>"); } catch { invalid = true; }
check("rename applies the same validation", invalid);

const cooled = new Accounts(new MemoryRepo(new MemoryStore()), { nameCooldownMs: 60_000 });
const tim = await cooled.signup({ username: "tim", password: "berners1989", displayName: "Tim", dateOfBirth: "1990-01-01" });
await cooled.setDisplayName(tim.id, "Timothy");
let throttled = false;
try { await cooled.setDisplayName(tim.id, "Timbo"); } catch (e) { throttled = e.code === "throttled"; }
check("rename cooldown applies", throttled);

console.log("\n-- google accounts --");

const g1 = await accounts.findOrCreateGoogle({ sub: "sub-aaa", givenName: "Ada", email: "ada@gmail.com", dateOfBirth: "1990-01-01" });
check("creates an account for a new subject", !!g1.id && g1.googleSub === "sub-aaa");
check("has no password", !g1.password);
check("takes a display name from the profile", g1.displayName === "Ada", g1.displayName);
check("public view reports the provider", accounts.publicView(g1).provider === "google");

const again = await accounts.findOrCreateGoogle({ sub: "sub-aaa", givenName: "Ada", dateOfBirth: "1990-01-01" });
check("the same subject returns the same account", again.id === g1.id);

// Google display names collide constantly; a suffix keeps them unique.
const g2 = await accounts.findOrCreateGoogle({ sub: "sub-bbb", givenName: "Ada", dateOfBirth: "1990-01-01" });
check("a colliding display name is suffixed", g2.displayName !== g1.displayName, g2.displayName);
check("and both still exist", g2.id !== g1.id);

// The account-takeover route this deliberately does not take.
const pw = await accounts.signup({ username: "mallory", password: "password1234", displayName: "Mallory", dateOfBirth: "1990-01-01" });
const viaGoogle = await accounts.findOrCreateGoogle({ sub: "sub-ccc", givenName: "Mallory", email: "mallory@gmail.com", dateOfBirth: "1990-01-01" });
check("a Google sign-in never adopts an existing password account",
  viaGoogle.id !== pw.id, "separate accounts");

// A password-less account must not be loginable with an empty password.
let sneaked = false;
try { await accounts.login({ username: g1.username, password: "" }); sneaked = true; } catch { /* expected */ }
check("a Google account cannot be signed into with a blank password", !sneaked);
let sneaked2 = false;
try { await accounts.login({ username: g1.username, password: "anything" }); sneaked2 = true; } catch { /* expected */ }
check("nor with any password", !sneaked2);

check("verify() refuses a null stored hash", !(await accounts.verify("x", null)));

console.log("\n-- brute force --");

const bf = new Accounts(new MemoryRepo(new MemoryStore()));
await bf.signup({ username: "target", password: "correct12345", displayName: "Target", dateOfBirth: "1990-01-01" });
let lockedAfter = null;
for (let i = 1; i <= 8; i++) {
  try {
    await bf.login({ username: "target", password: `guess${i}`, ip: "1.2.3.4" });
  } catch (e) {
    if (e.code === "throttled" && lockedAfter === null) lockedAfter = i;
  }
}
check("repeated failures get throttled", lockedAfter !== null, `locked after ${lockedAfter} attempts`);
await rejects("throttling blocks even the correct password",
  () => bf.login({ username: "target", password: "correct12345", ip: "1.2.3.4" }), "throttled");

// ── the 18+ gate ────────────────────────────────────────────────────────────
//
// The gate guards account CREATION, and there are two routes to that: the
// password form and the Google button, which makes an account in one click.
// Guarding only the first would leave the second wide open, so both are
// checked here.

console.log("\n-- age gate --");

// Fixed clock: the interesting cases are a day either side of an eighteenth
// birthday, and against the real date those would drift into meaninglessness.
const asOf = new Date(Date.UTC(2026, 8, 11));   // 2026-09-11

const dobOk = (label, value, expected) => {
  let got = null;
  try { got = validateDateOfBirth(value, asOf); } catch (e) { got = `threw:${e.code}`; }
  check(label, got === expected, `${got}`);
};
const dobRejects = (label, value, code) => {
  let err = null;
  try { validateDateOfBirth(value, asOf); } catch (e) { err = e; }
  check(label, !!err && err.code === code, err ? `(${err.code})` : "(did not throw)");
};

dobOk("eighteen today is old enough", "2008-09-11", "2008-09-11");
dobRejects("eighteen tomorrow is not", "2008-09-12", "underage");
dobRejects("a child is refused", "2015-06-01", "underage");
dobOk("a leap day is a real date", "2004-02-29", "2004-02-29");
// Date.UTC rolls impossible days forward rather than refusing them, so these
// would silently become 1 March and 2 March without the round-trip check.
dobRejects("29 February in a non-leap year is not", "2005-02-29", "age");
dobRejects("nor is 30 February", "2007-02-30", "age");
dobRejects("a future date is refused", "2030-01-01", "age");
dobRejects("an absurd age is refused", "1850-01-01", "age");
dobRejects("a missing date is refused", undefined, "age");
dobRejects("an empty date is refused", "", "age");
dobRejects("a non-ISO date is refused", "1/1/1990", "age");

const gated = new Accounts(new MemoryRepo(new MemoryStore()), { nameCooldownMs: 0 });

const adult = await gated.signup({
  username: "adult", password: "longenough1", displayName: "Adult",
  dateOfBirth: "1990-05-04"
});
check("an adult signup stores the declared date",
  adult.dateOfBirth === "1990-05-04", adult.dateOfBirth);

await rejects("signup without a date of birth is refused",
  () => gated.signup({ username: "nodob", password: "longenough1", displayName: "NoDob" }),
  "age");
await rejects("an underage signup is refused",
  () => gated.signup({
    username: "kid", password: "longenough1", displayName: "Kid",
    dateOfBirth: "2015-01-01"
  }), "underage");

// The one-click route. A new Google account is still a new account.
await rejects("a new Google account with no date is refused",
  () => gated.findOrCreateGoogle({ sub: "age-1", givenName: "Gee" }), "age_required");
await rejects("an underage Google account is refused",
  () => gated.findOrCreateGoogle({
    sub: "age-2", givenName: "Gee", dateOfBirth: "2015-01-01"
  }), "underage");

const gAdult = await gated.findOrCreateGoogle({
  sub: "age-3", givenName: "Gerald", dateOfBirth: "1988-03-02"
});
check("an adult Google account is created and keeps its date",
  gAdult.dateOfBirth === "1988-03-02", gAdult.dateOfBirth);

// Signing in is not creating: an existing account must not be re-interrogated,
// or every sign-in becomes another chance to guess the answer that works.
const gBack = await gated.findOrCreateGoogle({ sub: "age-3", givenName: "Gerald" });
check("returning to an existing Google account needs no date",
  gBack.id === gAdult.id);

check("the picker bound matches the rule",
  latestEligibleDob(asOf) === "2008-09-11", latestEligibleDob(asOf));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
