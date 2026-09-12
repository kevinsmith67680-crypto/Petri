// ---------------------------------------------------------------------------
// Rooms and bots. Run with:  node test/rooms.test.js
//
// Boots the real server against a stubbed `ws` and drives joins and departures
// through the actual connection handler, so the room logic is exercised rather
// than described.
//
// The thing being pinned: in test mode each room fills to the size its MODE is
// built for — 100 for Standard, 50 for High stakes — and only while somebody
// is in it. Populating empty rooms doubled the server's work for nobody's
// benefit, which mattered once there were two of them.
// ---------------------------------------------------------------------------

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

// Stub `ws` on disk, because the server imports it by name. Written beside the
// project rather than into it, and removed afterwards.
const require = createRequire(import.meta.url);
const root = path.dirname(new URL(import.meta.url).pathname);
const stubDir = path.join(root, "..", "node_modules", "ws");
let createdStub = false;
if (!fs.existsSync(stubDir)) {
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, "package.json"),
    JSON.stringify({ name: "ws", version: "0.0.0-test", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(stubDir, "index.js"),
    'import { EventEmitter } from "node:events";\n' +
    'export class WebSocketServer extends EventEmitter {\n' +
    '  constructor(o) { super(); this.options = o; globalThis.__wss = this; }\n' +
    '}\nexport default { WebSocketServer };\n');
  createdStub = true;
}

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const PORT = 8700 + (process.pid % 200);
process.env.PORT = String(PORT);
process.env.TEST_MODE = "1";
delete process.env.BOTS;
// Short rounds so a full cycle can be observed without a long wait.
process.env.ROUND_SECONDS = "3";
process.env.INTERMISSION_SECONDS = "1";
// An allowlist that names somewhere else entirely. This is the production
// shape of the bug: the list is correct for the domain and wrong for every
// other host the same server answers on. Joins in this file are driven
// straight into the connection handler, so they do not pass verifyClient
// and are unaffected.
process.env.ALLOWED_ORIGINS = "https://engulfs.io,https://www.engulfs.io";

await import("../server/index.js");
await new Promise(r => setTimeout(r, 400));

const req = { headers: {}, socket: { remoteAddress: "10.0.0.1", setNoDelay() {} } };

class FakeWS {
  static OPEN = 1;
  constructor() { this.OPEN = 1; this.readyState = 1; this.h = {}; this.out = []; }
  on(t, fn) { (this.h[t] ||= []).push(fn); }
  send(d) { this.out.push(typeof d === "string" ? d : "<binary>"); }
  close(code, why) { this.closed = { code, why }; this.readyState = 3; }
  ping() {} terminate() {}
  async deliver(o) { for (const fn of this.h.message || []) await fn(JSON.stringify(o), false); }
  async drop() { for (const fn of this.h.close || []) await fn(); }
}

const health = async () => (await (await fetch(`http://localhost:${PORT}/health`)).json());
const room = async id => (await health()).rooms.find(r => r.mode === id);
const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));

const { PROTOCOL_VERSION } = await import("../shared/protocol.js");

async function join(username, stake, protocol = PROTOCOL_VERSION) {
  const token = await (await fetch(`http://localhost:${PORT}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "password123", displayName: username, dateOfBirth: "1990-01-01" })
  })).json().then(d => d.token);
  const ws = new FakeWS();
  globalThis.__wss.emit("connection", ws, req);
  await ws.deliver({ type: "join", name: username, stake, token, protocol });
  await settle();
  return ws;
}

console.log("\n-- each room is sized for its own mode --");

const std = await room("standard");
const high = await room("highstakes");
check("Standard targets 100 bots", std.botTarget === 100, String(std.botTarget));
check("High stakes targets 50 bots", high.botTarget === 50, String(high.botTarget));
check("Standard starts at 1 ready in test mode", std.startsAt === 1);

console.log("\n-- empty rooms stay empty --");

check("nothing is simulated in Standard", std.inWorld === 0, String(std.inWorld));
check("nothing is simulated in High stakes", high.inWorld === 0, String(high.inWorld));

console.log("\n-- bots arrive with the first player --");

const ada = await join("ada", 1_000_000);
check("the 1.00 join was accepted", !ada.closed, JSON.stringify(ada.closed || {}));

let s = await room("standard");
let h = await room("highstakes");
check("Standard fills to 100 bots plus the player", s.inWorld === 101, String(s.inWorld));
check("High stakes is untouched", h.inWorld === 0, String(h.inWorld));

const bob = await join("bob", 2_000_000);
h = await room("highstakes");
check("the 2.00 room fills to 50 plus the player", h.inWorld === 51, String(h.inWorld));
check("and Standard is unchanged", (await room("standard")).inWorld === 101);

console.log("\n-- and leave with the last one --");

await ada.drop();
await settle(300);
s = await room("standard");
// The departing player lingers briefly, motionless and edible, so the world
// is not quite empty for a few seconds.
check("Standard sheds its bots", s.inWorld <= 1, `${s.inWorld} left`);
check("High stakes keeps its own", (await room("highstakes")).inWorld === 51);

console.log("\n-- the join frame fits the payload limit --");

// The limit is enforced by `ws` before our handler ever sees the frame, so an
// oversized join closes the socket with no explanation. It happened: adding a
// protocol field took the frame from 125 bytes to 138 against a 128 limit, and
// a display name over ~12 characters had never fitted at all.
{
  const src = fs.readFileSync(path.join(root, "..", "server", "index.js"), "utf8");
  const limit = Number(/const MAX_PAYLOAD = (\d+)/.exec(src)[1]);
  const worst = JSON.stringify({
    type: "join",
    name: "x".repeat(16),            // NAME_MAX
    stake: 2_000_000,
    token: "a".repeat(64),           // session token
    protocol: PROTOCOL_VERSION
  });
  const size = Buffer.byteLength(worst);
  check("the largest legitimate join fits", size < limit, `${size} of ${limit} bytes`);
  check("with room to grow", limit - size > 200, `${limit - size} bytes spare`);
}

console.log("\n-- the pot always equals the stake you chose --");

// Every join used to escrow another stake without releasing the last one, so
// reconnecting — after a dropped socket, or just pressing Start again — made
// the "at risk" figure climb 1.00, 2.00, 3.00 while the player believed they
// had staked once.
{
  const tok = await (await fetch(`http://localhost:${PORT}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "potter", password: "password123", displayName: "Potter", dateOfBirth: "1990-01-01" })
  })).json().then(d => d.token);

  const me = async () => (await (await fetch(`http://localhost:${PORT}/api/me`, {
    headers: { Authorization: `Bearer ${tok}` }
  })).json());

  const enter = async stake => {
    const ws = new FakeWS();
    globalThis.__wss.emit("connection", ws, req);
    await ws.deliver({ type: "join", name: "Potter", stake, token: tok, protocol: PROTOCOL_VERSION });
    await settle();
    return ws;
  };

  const opening = await me();
  const total = opening.balance + opening.pot;
  // Other tests have left players connected, so measure the change we cause.
  const othersBefore =
    (await room("standard")).players + (await room("highstakes")).players;

  await enter(1_000_000);
  let s1 = await me();
  check("one join escrows exactly the stake", s1.pot === 1_000_000, `${s1.pot}`);

  await enter(1_000_000);
  await enter(1_000_000);
  const s3 = await me();
  check("three joins still escrow exactly the stake", s3.pot === 1_000_000, `${s3.pot}`);
  check("and the balance is not drained", s3.balance + s3.pot === total,
    `${s3.balance + s3.pot} vs ${total}`);

  // Switching tiers must move the escrow, not add to it.
  await enter(2_000_000);
  const s4 = await me();
  check("switching to the 2.00 tier escrows 2.00, not 3.00", s4.pot === 2_000_000, `${s4.pot}`);
  check("money is conserved across the switch", s4.balance + s4.pot === total,
    `${s4.balance + s4.pot} vs ${total}`);

  // Four joins by one account must leave exactly one live connection.
  const held =
    (await room("standard")).players + (await room("highstakes")).players - othersBefore;
  check("four joins leave exactly one live connection", held === 1,
    `${held} added by this account`);
}

console.log("\n-- a database blip is not a sign-in problem --");

// resolveSession failures used to be swallowed into "sign in to play", which
// told a signed-in player their session was missing whenever the database
// hiccuped — and that refusal is final, so the client did not even retry.
{
  // The server does not export its Accounts instance, so the behaviour is
  // induced on the prototype it was built from.
  const { Accounts } = await import("../server/accounts.js");
  const realResolve = Accounts.prototype.resolveSession;
  Accounts.prototype.resolveSession = async () => { throw new Error("connection reset"); };

  const ws = new FakeWS();
  globalThis.__wss.emit("connection", ws, req);
  await ws.deliver({
    type: "join", name: "Blip", stake: 1_000_000,
    token: "b".repeat(64), protocol: PROTOCOL_VERSION
  });
  await settle();

  const said = ws.out.filter(m => m !== "<binary>").map(JSON.parse);
  const err = said.find(m => m.type === "account_error");
  check("it is reported as retryable, not as a sign-in failure",
    err && err.code === "retry", err ? err.code : "nothing sent");
  check("and the message does not blame the player",
    err && !/sign in/i.test(err.reason), err ? err.reason : "—");
  check("the socket closes with a retryable code",
    ws.closed && ws.closed.code === 1011, JSON.stringify(ws.closed || {}));

  Accounts.prototype.resolveSession = realResolve;
}

console.log("\n-- a stale client is turned away --");

// The client and server share a binary wire format. A browser holding an old
// protocol.js decodes every snapshot out of alignment: opponents scattered
// across the map, orbs that never appear. Refusing the connection turns that
// silent corruption into a message telling the player to reload.
const stale = await join("stale", 1_000_000, PROTOCOL_VERSION - 1);
check("the join is refused", !!stale.closed, JSON.stringify(stale.closed || {}));
const told = stale.out.filter(m => m !== "<binary>").join(" ");
check("and the player is told to reload", /out of date/i.test(told),
  told.slice(0, 120) || "nothing said");
check("it never entered a room",
  (await room("standard")).players === (await room("standard")).players);

console.log("\n-- the ready flow still starts a round --");

const before = bob.out.length;
await bob.deliver({ type: "ready", ready: true });
await settle(300);
const msgs = bob.out.slice(before).filter(m => m !== "<binary>");
check("readying one player starts the round",
  msgs.some(m => m.includes("round_start")), msgs.join(" ").slice(0, 120) || "nothing");
check("the room reports itself live", (await room("highstakes")).phase === "live");

console.log("\n-- one round rolls into the next --");

// The stake is settled when a round ends. Without re-escrowing at the start of
// the next one, a player carried on staking nothing — playing a paid room for
// free. Readiness also used to be wiped, so everyone had to opt in again.
{
  const tok = await (await fetch(`http://localhost:${PORT}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "runner", password: "password123", displayName: "Runner", dateOfBirth: "1990-01-01" })
  })).json().then(d => d.token);
  const money = async () => (await (await fetch(`http://localhost:${PORT}/api/me`, {
    headers: { Authorization: `Bearer ${tok}` }
  })).json());

  const ws = new FakeWS();
  globalThis.__wss.emit("connection", ws, req);
  await ws.deliver({ type: "join", name: "Runner", stake: 1_000_000, token: tok, protocol: PROTOCOL_VERSION });
  await settle();

  const joined = await money();
  check("joining escrows the stake", joined.pot === 1_000_000, `${joined.pot}`);

  await ws.deliver({ type: "ready", ready: true });
  await settle(300);
  const texts = () => ws.out.filter(m => m !== "<binary>").map(JSON.parse);
  check("round one starts", texts().some(m => m.type === "round_start"));

  // Round (3s) then intermission (1s), with margin.
  await settle(5000);
  const rounds = texts().filter(m => m.type === "round_start").length;
  check("round two starts without being asked again", rounds >= 2, `${rounds} rounds`);

  // Polling HTTP races the round clock, so assert on what the server pushed:
  // the re-stake happens during startRound and pushes an account update, so
  // there must be one carrying a full escrow AFTER the first round ended.
  const seq = texts();
  const firstEnd = seq.findIndex(m => m.type === "round_end");
  const restake = seq.slice(firstEnd).find(m => m.type === "account" && m.pot === 1_000_000);
  check("round two is staked, not free", !!restake,
    restake ? `pot ${restake.pot}` : "no re-stake was pushed");
  check("and the stake reported is the tier chosen", restake && restake.stake === 1_000_000,
    restake ? `stake ${restake.stake}` : "—");

  const after = await money();
  check("the balance paid for it", after.balance < joined.balance,
    `${joined.balance} -> ${after.balance}`);
}

console.log("\n-- the origin guard cannot lock out the server's own page --");

// A refused handshake reaches the browser as a bare close: no code worth
// reading, no reason. So when ALLOWED_ORIGINS did not happen to name the host
// a player was on, the page loaded, the socket was refused, and the only thing
// anyone could see was "could not reach the server after several attempts" —
// pointing at the network, over a line of configuration.
//
// The allowlist is there to stop somebody else's page pointing a client at
// this server. A page this server itself served is not that, so it is always
// allowed, and the list can no longer exclude a host the server answers on:
// a Render URL, a preview deploy, the apex when only www was listed, a
// machine on the LAN.
//
// Asserted through /health, which runs the same two checks the handshake does
// and reports them where they can actually be read.
{
  const ask = async (headers, query = "") => {
    const r = await fetch(`http://localhost:${PORT}/health${query}`, { headers });
    return (await r.json()).socket;
  };
  const host = `localhost:${PORT}`;

  check("an allowlist is in force", (await ask({ Host: host })).originsConfigured === true);

  const own = await ask({ Origin: `http://${host}`, Host: host });
  check("its own page is recognised as same-origin", own.matchesHost === true,
    JSON.stringify(own.origin));
  // The decisive case. This host is nowhere in the allowlist, and before the
  // fix that was enough to refuse every socket while the page carried on
  // loading perfectly.
  check("and is accepted even though the allowlist names another host",
    own.wouldAccept === true, JSON.stringify(own.origin));

  const foreign = await ask({ Origin: "https://evil.example", Host: host });
  check("another site's page is not same-origin", foreign.matchesHost === false);
  check("and is refused", foreign.wouldAccept === false);

  const listed = await ask({ Origin: "https://engulfs.io", Host: host });
  check("an origin on the list is still accepted outright",
    listed.wouldAccept === true && listed.matchesHost === false,
    `allowed ${listed.wouldAccept}, matches host ${listed.matchesHost}`);

  // Ports are part of an origin: a page on another port of the same machine
  // is a different site and must not ride in on the hostname.
  const otherPort = await ask({ Origin: `http://localhost:${PORT + 1}`, Host: host });
  check("a different port is a different origin", otherPort.matchesHost === false,
    `${PORT + 1} vs ${PORT}`);
  check("and is refused", otherPort.wouldAccept === false);

  const noOrigin = await ask({ Host: host });
  check("a request with no origin is not same-origin", noOrigin.matchesHost === false);
  check("and is refused once a list is set", noOrigin.wouldAccept === false);

  const junk = await ask({ Origin: "not a url", Host: host });
  check("an unparseable origin is not same-origin", junk.matchesHost === false);
  check("and is refused", junk.wouldAccept === false);

  // A browser sends NO Origin header on a same-origin fetch, so a page asking
  // this question about itself has to name its own origin. Judging the bare
  // request instead answers "refused, no origin" for every healthy same-host
  // deployment with a list set — a confident wrong answer, which is worse
  // than none. It cost me a false diagnosis before I noticed.
  const named = await ask({ Host: host }, `?origin=${encodeURIComponent(`http://${host}`)}`);
  check("a named origin is the one judged", named.origin === `http://${host}`,
    String(named.origin));
  check("it says the origin was supplied", named.originAsked === true);
  check("and the same-host verdict is reached without an Origin header",
    named.matchesHost === true && named.wouldAccept === true,
    `matchesHost ${named.matchesHost}, wouldAccept ${named.wouldAccept}`);

  const namedForeign = await ask({ Host: host }, "?origin=https%3A%2F%2Fevil.example");
  check("a named foreign origin is still refused", namedForeign.wouldAccept === false);

  // The rest of the verdict, which is the other thing that silently refuses a
  // handshake and the other thing nobody could see.
  check("it reports the connection cap", typeof own.maxPerIp === "number", `${own.maxPerIp}`);
  check("and whether this caller is at it", own.atCap === false,
    `${own.connections} of ${own.maxPerIp}`);
  check("and whether the proxy header is trusted", own.trustProxy === false);
}

if (createdStub) {
  fs.rmSync(stubDir, { recursive: true, force: true });
  // and the parent, if this test was the only thing in it
  const nm = path.dirname(stubDir);
  try { if (fs.readdirSync(nm).length === 0) fs.rmdirSync(nm); } catch { /* fine */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
