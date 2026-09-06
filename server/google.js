// ---------------------------------------------------------------------------
// Google ID token verification.
//
// THE ONLY THING THAT MATTERS HERE IS THE SIGNATURE CHECK.
//
// A Google ID token is a JWT: three base64url segments, and the middle one is
// a plain JSON payload containing an email and a user id. It is trivial to
// decode without verifying anything — and a server that reads that payload
// without checking the signature will happily log anyone in as anyone else,
// because the attacker simply writes whatever `sub` they like. That is the
// single most common way this integration is got wrong.
//
// So every token goes through, in order:
//   1. RS256 signature verified against Google's published public keys
//   2. `iss`  is one of Google's two accepted issuers
//   3. `aud`  is OUR client id, so a token minted for another site is refused
//   4. `exp` / `iat` are within tolerance
//   5. `email_verified` is true
//
// Implemented with node:crypto rather than a JWT library: Node can build a
// public key straight from a JWK, so the whole thing is about eighty lines
// and there is no dependency to keep patched.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const CLOCK_SKEW = 60;          // seconds of tolerance either way
const JWKS_TTL_MS = 3600_000;   // Google rotates keys; an hour is conservative

export class GoogleAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

let cache = { keys: new Map(), fetchedAt: 0 };

// Exposed so tests can inject a key and run the whole verifier offline.
export function _setKeys(jwks, at = Date.now()) {
  cache = { keys: new Map(jwks.map(k => [k.kid, k])), fetchedAt: at };
}

async function keyFor(kid, { allowRefetch = true } = {}) {
  const stale = Date.now() - cache.fetchedAt > JWKS_TTL_MS;
  if (!cache.keys.size || stale) await refreshKeys();

  let jwk = cache.keys.get(kid);
  // An unknown kid usually means Google rotated early. Refetch once rather
  // than rejecting a legitimate sign-in.
  if (!jwk && allowRefetch) {
    await refreshKeys();
    jwk = cache.keys.get(kid);
  }
  if (!jwk) throw new GoogleAuthError("Unrecognised signing key.");
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

async function refreshKeys() {
  let res;
  try {
    res = await fetch(JWKS_URL);
  } catch (err) {
    throw new GoogleAuthError(`Could not reach Google: ${err.message}`);
  }
  if (!res.ok) throw new GoogleAuthError(`Google returned ${res.status} for its keys.`);
  const body = await res.json();
  if (!Array.isArray(body.keys) || !body.keys.length) {
    throw new GoogleAuthError("Google returned no signing keys.");
  }
  cache = { keys: new Map(body.keys.map(k => [k.kid, k])), fetchedAt: Date.now() };
}

const b64url = seg => Buffer.from(seg, "base64url");
const decodeJson = seg => JSON.parse(b64url(seg).toString("utf8"));

export async function verifyIdToken(token, clientId) {
  if (!clientId) throw new GoogleAuthError("No Google client id configured.");
  if (typeof token !== "string" || token.length > 4096) {
    throw new GoogleAuthError("Malformed credential.");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new GoogleAuthError("Malformed credential.");

  let header, payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    throw new GoogleAuthError("Malformed credential.");
  }

  // Reject "alg": "none" and anything symmetric outright. Accepting the
  // algorithm the token asks for is a well-known forgery route.
  if (header.alg !== "RS256") throw new GoogleAuthError("Unexpected signing algorithm.");
  if (!header.kid) throw new GoogleAuthError("Credential has no key id.");

  const key = await keyFor(header.kid);
  const signed = `${parts[0]}.${parts[1]}`;
  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(signed),
    key,
    b64url(parts[2])
  );
  // Everything below this line is only meaningful because this passed.
  if (!ok) throw new GoogleAuthError("Signature did not verify.");

  if (!ISSUERS.has(payload.iss)) throw new GoogleAuthError("Unexpected issuer.");

  // aud may be a string or an array depending on the flow.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) {
    throw new GoogleAuthError("Credential was issued for a different application.");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW < now) {
    throw new GoogleAuthError("Credential has expired.");
  }
  if (typeof payload.iat === "number" && payload.iat - CLOCK_SKEW > now) {
    throw new GoogleAuthError("Credential is not valid yet.");
  }

  if (!payload.sub) throw new GoogleAuthError("Credential has no subject.");
  // An unverified email would let someone claim an address they do not own.
  if (payload.email && payload.email_verified !== true) {
    throw new GoogleAuthError("Google has not verified that email address.");
  }

  return {
    sub: String(payload.sub),
    email: payload.email ? String(payload.email) : null,
    name: payload.name ? String(payload.name) : null,
    givenName: payload.given_name ? String(payload.given_name) : null,
    picture: payload.picture ? String(payload.picture) : null
  };
}
