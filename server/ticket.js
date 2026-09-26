// ---------------------------------------------------------------------------
// Match tickets, and the signed requests the matchmaker sends game servers.
//
// A ticket is the matchmaker's word that this account may take this seat, at
// this stake, in this room, on this server, until it expires. The game server
// checks the signature and trusts the rest, so a join costs no database
// lookup and a client cannot choose its own room, stake or name.
//
//   <base64url(JSON claims)>.<base64url(HMAC-SHA256)>
//
// Claims:
//   v      format version
//   srv    game server id — the ticket is refused anywhere else
//   room   room id on that server; with srv, the room's address
//   rsv    the reservation holding the seat, single use
//   acct   account id
//   name   display name at the time of matching
//   stake  micro-USDC; selects the mode
//   region where the matchmaker placed the player
//   exp    epoch ms; tickets live seconds, not minutes
//
// Both sides share MATCH_SECRET. Every MAC is taken over a purpose prefix as
// well as the data, so a signature made for one purpose ("ticket") can never
// be replayed as another ("request").
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

export const TICKET_VERSION = 1;

// Anything longer is not a ticket we issued. Checked before any decoding, so
// junk costs nothing.
const MAX_TICKET = 1024;

// A signed request older than this is refused, which bounds how long a
// captured one could be replayed.
const REQUEST_SKEW_MS = 30_000;

export class TicketError extends Error {
  constructor(reason) {
    super(`ticket ${reason}`);
    this.reason = reason;          // malformed | signature | version | expired
  }
}

const mac = (secret, purpose, data) =>
  crypto.createHmac("sha256", secret).update(`${purpose}.${data}`).digest();

const sameBytes = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

export function signTicket(claims, secret) {
  const body = Buffer.from(JSON.stringify({ v: TICKET_VERSION, ...claims })).toString("base64url");
  return `${body}.${mac(secret, "ticket", body).toString("base64url")}`;
}

// Returns the claims, or throws a TicketError saying why not. The signature is
// checked before the body is parsed, so nothing unauthenticated is decoded.
export function verifyTicket(ticket, secret, now = Date.now()) {
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET) throw new TicketError("malformed");
  const parts = ticket.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new TicketError("malformed");

  const [body, sig] = parts;
  if (!sameBytes(Buffer.from(sig, "base64url"), mac(secret, "ticket", body))) {
    throw new TicketError("signature");
  }

  let claims;
  try { claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { throw new TicketError("malformed"); }
  if (!claims || typeof claims !== "object") throw new TicketError("malformed");
  if (claims.v !== TICKET_VERSION) throw new TicketError("version");
  if (!(Number(claims.exp) > now)) throw new TicketError("expired");
  return claims;
}

// ── internal requests ───────────────────────────────────────────────────────
//
// The matchmaker asks game servers for their rooms and for reservations over
// plain HTTP. Those endpoints hand out seats, so they are signed with the
// same shared secret: `X-Match-Signature: t=<ms>,s=<hex>` over the path and
// body, which stops a signature for one call being reused on another.

export function signRequest(path, body, secret, now = Date.now()) {
  const s = mac(secret, "request", `${now}.${path}.${body}`).toString("hex");
  return `t=${now},s=${s}`;
}

export function verifyRequest(header, path, body, secret, now = Date.now()) {
  const m = /^t=(\d{1,16}),s=([0-9a-f]{64})$/.exec(String(header || ""));
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now - t) > REQUEST_SKEW_MS) return false;
  return sameBytes(Buffer.from(m[2], "hex"), mac(secret, "request", `${t}.${path}.${body}`));
}

// A secret too short to be worth attacking with a guess.
export function assertSecret(secret, name = "MATCH_SECRET") {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error(
      `${name} must be set to at least 32 characters, and must be the same on the ` +
      `matchmaker and every game server. Generate one with: openssl rand -hex 32`
    );
  }
  return secret;
}
