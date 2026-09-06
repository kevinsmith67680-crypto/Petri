// ---------------------------------------------------------------------------
// Google ID token verification tests. Run with:  node test/google.test.js
//
// Runs entirely offline. A throwaway RSA keypair stands in for Google's, its
// public half is injected into the verifier's JWKS cache, and tokens are
// signed locally. That means the forgery cases — the ones that actually
// matter — can be exercised without touching the network.
//
// The case worth caring about most is "tampered payload". A server that
// decodes the JWT without checking the signature will happily log an attacker
// in as anyone they name, and it will pass every other test you write.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { verifyIdToken, GoogleAuthError, _setKeys } from "../server/google.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}
async function rejects(label, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  check(label, err instanceof GoogleAuthError, err ? `(${err.message})` : "(did not throw)");
}

const CLIENT_ID = "1234.apps.googleusercontent.com";
const KID = "test-key-1";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
_setKeys([{ ...jwk, kid: KID, alg: "RS256", use: "sig" }]);

// A second, unrelated key: an attacker signing with their own.
const attacker = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");

function makeToken(payloadOverrides = {}, { key = privateKey, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", kid: KID, typ: "JWT", ...header });
  const body = b64({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "110000000000000000001",
    email: "ada@example.com",
    email_verified: true,
    name: "Ada Lovelace",
    given_name: "Ada",
    iat: now,
    exp: now + 3600,
    ...payloadOverrides
  });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${sig.toString("base64url")}`;
}

console.log("\n-- a valid token --");

const good = await verifyIdToken(makeToken(), CLIENT_ID);
check("accepts a properly signed token", good.sub === "110000000000000000001");
check("returns the profile", good.email === "ada@example.com" && good.givenName === "Ada");

console.log("\n-- forgery --");

// THE important one. Decode the payload, change the subject, re-encode, and
// keep the original signature. Any server that trusts the payload without
// verifying lets this through and hands over somebody else's account.
await rejects("rejects a tampered payload with the original signature", async () => {
  const parts = makeToken().split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  payload.sub = "999999999999999999999";
  payload.email = "attacker@example.com";
  await verifyIdToken(`${parts[0]}.${b64(payload)}.${parts[2]}`, CLIENT_ID);
});

await rejects("rejects a token signed with the wrong key",
  () => verifyIdToken(makeToken({}, { key: attacker.privateKey }), CLIENT_ID));

await rejects("rejects alg:none", async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "none", kid: KID, typ: "JWT" });
  const body = b64({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1", exp: now + 60 });
  await verifyIdToken(`${head}.${body}.`, CLIENT_ID);
});

await rejects("rejects a symmetric algorithm", async () => {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", kid: KID, typ: "JWT" });
  const body = b64({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1", exp: now + 60 });
  const sig = crypto.createHmac("sha256", "secret").update(`${head}.${body}`).digest("base64url");
  await verifyIdToken(`${head}.${body}.${sig}`, CLIENT_ID);
});

console.log("\n-- claim checks --");

await rejects("rejects a token minted for another application",
  () => verifyIdToken(makeToken({ aud: "someone-else.apps.googleusercontent.com" }), CLIENT_ID));

await rejects("rejects an unexpected issuer",
  () => verifyIdToken(makeToken({ iss: "https://evil.example.com" }), CLIENT_ID));

await rejects("rejects an expired token",
  () => verifyIdToken(makeToken({ exp: Math.floor(Date.now() / 1000) - 600 }), CLIENT_ID));

await rejects("rejects an unverified email",
  () => verifyIdToken(makeToken({ email_verified: false }), CLIENT_ID));

await rejects("rejects a token with no subject",
  () => verifyIdToken(makeToken({ sub: undefined }), CLIENT_ID));

check("accepts aud as an array", (await verifyIdToken(
  makeToken({ aud: ["other", CLIENT_ID] }), CLIENT_ID)).sub === "110000000000000000001");

check("tolerates small clock skew", (await verifyIdToken(
  makeToken({ exp: Math.floor(Date.now() / 1000) - 30 }), CLIENT_ID)).sub.length > 0);

console.log("\n-- malformed input --");

for (const [label, bad] of [
  ["empty string", ""],
  ["not a JWT", "hello"],
  ["two segments", "aaa.bbb"],
  ["garbage segments", "!!!.???.###"],
  ["null", null],
  ["a number", 12345],
  ["an oversized string", "a".repeat(5000)]
]) {
  await rejects(`rejects ${label}`, () => verifyIdToken(bad, CLIENT_ID));
}

await rejects("refuses to verify with no client id configured",
  () => verifyIdToken(makeToken(), ""));

await rejects("rejects an unknown key id", async () => {
  // No refetch is possible offline, so this also proves the verifier fails
  // closed when it cannot resolve a key.
  await verifyIdToken(makeToken({}, { header: { kid: "no-such-key" } }), CLIENT_ID);
});

// Fuzz: random bytes in JWT shape must always be refused.
let survived = 0;
for (let i = 0; i < 500; i++) {
  const seg = () => crypto.randomBytes(3 + Math.floor(Math.random() * 40)).toString("base64url");
  try { await verifyIdToken(`${seg()}.${seg()}.${seg()}`, CLIENT_ID); survived++; } catch { /* expected */ }
}
check("random tokens are never accepted", survived === 0, `${survived}/500 accepted`);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
