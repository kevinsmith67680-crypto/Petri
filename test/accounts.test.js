// ---------------------------------------------------------------------------
// Account tests. Run with:  node test/accounts.test.js
//
// Focused on the things that are quietly wrong in most hand-rolled auth:
// password hashes that are reversible or comparable in variable time, session
// tokens stored in the clear, login errors that reveal whether a username
// exists, and name rules that allow impersonation.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { Accounts, AccountError, validateDisplayName, validateUsername }
  from "../server/accounts.js";
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

const ada = await accounts.signup({ username: "ada", password: "lovelace1843", displayName: "Ada" });
check("signup returns an account", !!ada.id && ada.username === "ada");
check("display name is stored", ada.displayName === "Ada");
check("public view hides the hash", !("password" in accounts.publicView(ada)));

await rejects("duplicate username rejected",
  () => accounts.signup({ username: "ada", password: "another1234", displayName: "Ada2" }), "taken");
await rejects("duplicate display name rejected",
  () => accounts.signup({ username: "ada2", password: "another1234", displayName: "ada" }), "taken");
await rejects("short password rejected",
  () => accounts.signup({ username: "bob", password: "short", displayName: "Bob" }));

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

await accounts.signup({ username: "grace", password: "hopper1906", displayName: "Grace" });
let clash = false;
try { await accounts.setDisplayName(ada.id, "Grace"); } catch (e) { clash = e.code === "taken"; }
check("cannot take another player's name", clash);
check("can keep your own name (no-op)",
  (await accounts.setDisplayName(ada.id, "Ada Byron")).displayName === "Ada Byron");

let invalid = false;
try { await accounts.setDisplayName(ada.id, "<b>"); } catch { invalid = true; }
check("rename applies the same validation", invalid);

const cooled = new Accounts(new MemoryRepo(new MemoryStore()), { nameCooldownMs: 60_000 });
const tim = await cooled.signup({ username: "tim", password: "berners1989", displayName: "Tim" });
await cooled.setDisplayName(tim.id, "Timothy");
let throttled = false;
try { await cooled.setDisplayName(tim.id, "Timbo"); } catch (e) { throttled = e.code === "throttled"; }
check("rename cooldown applies", throttled);

console.log("\n-- brute force --");

const bf = new Accounts(new MemoryRepo(new MemoryStore()));
await bf.signup({ username: "target", password: "correct12345", displayName: "Target" });
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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
