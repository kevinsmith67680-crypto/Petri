// ---------------------------------------------------------------------------
// Matchmaking and tickets. Run with:  node test/matchmaker.test.js
//
// The matchmaker's decisions, against fake game servers, and the ticket that
// carries them. No network: the core takes its servers as objects, which is
// exactly what lets it run standalone or inside a single game server.
//
// test/fleet.test.js runs the real thing — a matchmaker and two game servers
// as separate processes over Postgres — under `npm run test:db`.
// ---------------------------------------------------------------------------

import {
  signTicket, verifyTicket, TicketError, signRequest, verifyRequest, assertSecret
} from "../server/ticket.js";
import { createMatchmaker, MatchError } from "../server/matchmaker/core.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const SECRET = "k".repeat(64);
const reason = fn => { try { fn(); return null; } catch (e) { return e instanceof TicketError ? e.reason : e.message; } };

console.log("\n-- tickets --");

{
  const claims = {
    srv: "eu-1", room: "standard-2", rsv: "abc", acct: "u1", name: "Ada",
    stake: 1_000_000, region: "eu", exp: Date.now() + 30_000
  };
  const t = signTicket(claims, SECRET);
  const back = verifyTicket(t, SECRET);
  check("a ticket reads back as issued",
    back.srv === "eu-1" && back.room === "standard-2" && back.acct === "u1" &&
    back.stake === 1_000_000 && back.name === "Ada", JSON.stringify(back));

  const [body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ ...back, stake: 2_000_000 })).toString("base64url");
  check("changing any claim breaks it", reason(() => verifyTicket(`${forged}.${sig}`, SECRET)) === "signature");
  check("so does another secret", reason(() => verifyTicket(t, "z".repeat(64))) === "signature");
  check("an expired one is refused",
    reason(() => verifyTicket(signTicket({ ...claims, exp: Date.now() - 1 }, SECRET), SECRET)) === "expired");
  check("one with no expiry is refused",
    reason(() => verifyTicket(signTicket({ ...claims, exp: undefined }, SECRET), SECRET)) === "expired");
  check("another format version is refused",
    reason(() => verifyTicket(signTicket({ ...claims, v: 2 }, SECRET), SECRET)) === "version");
  for (const junk of [null, 42, "", "nodot", "a.b.c", ".x", "x.", "x".repeat(2000), `${body}.`]) {
    const why = reason(() => verifyTicket(junk, SECRET));
    if (why !== "malformed" && why !== "signature") {
      check(`junk is refused: ${String(junk).slice(0, 20)}`, false, why);
    }
  }
  check("junk is refused without being decoded", true);
}

console.log("\n-- signed requests between services --");

{
  const body = JSON.stringify({ account: "u1", stake: 1_000_000 });
  const header = signRequest("/internal/reserve", body, SECRET);
  check("a signed request verifies", verifyRequest(header, "/internal/reserve", body, SECRET));
  check("not on another path", !verifyRequest(header, "/internal/status", body, SECRET));
  check("not with another body", !verifyRequest(header, "/internal/reserve", body + " ", SECRET));
  check("not with another secret", !verifyRequest(header, "/internal/reserve", body, "z".repeat(64)));
  const old = signRequest("/internal/reserve", body, SECRET, Date.now() - 60_000);
  check("not once it is stale", !verifyRequest(old, "/internal/reserve", body, SECRET));
  check("not with no header", !verifyRequest(undefined, "/internal/reserve", body, SECRET));
  // A ticket's MAC and a request's MAC are taken over different purposes, so
  // one can never be passed off as the other.
  const ticketSig = Buffer.from(signTicket({ exp: Date.now() + 1000 }, SECRET).split(".")[1], "base64url").toString("hex");
  check("a ticket signature is no use as a request signature",
    !verifyRequest(`t=${Date.now()},s=${ticketSig}`, "/internal/reserve", body, SECRET));
  check("a short secret is refused at startup", reason(() => assertSecret("short")) !== null);
  check("a long one is accepted", reason(() => assertSecret("x".repeat(32))) === null);
}

// ── a fake fleet ────────────────────────────────────────────────────────────

function fakeServer(id, region, rooms, { canOpen = true, down = false, refuse = false, slow = false } = {}) {
  const server = {
    id, region, url: `wss://${id}.example`,
    statusCalls: 0, reserveCalls: [],
    async status() {
      server.statusCalls++;
      if (slow) return new Promise(() => {});
      if (down) throw new Error("connection refused");
      return { canOpen, rooms };
    },
    async reserve(req) {
      server.reserveCalls.push(req);
      if (down) throw new Error("connection refused");
      if (refuse) return { ok: false, code: "full" };
      return { ok: true, room: req.room || `${id}-new`, rsv: `rsv-${server.reserveCalls.length}`, expiresAt: Date.now() + 10_000 };
    }
  };
  return server;
}

const ADA = { id: "acct-ada", displayName: "Ada" };
const sessions = { good: ADA, bob: { id: "acct-bob", displayName: "Bob" } };
let seats = {};

function mm(servers, opts = {}) {
  return createMatchmaker({
    servers, secret: SECRET,
    resolveSession: async t => {
      if (t === "boom") throw new Error("connection reset");
      return sessions[t] || null;
    },
    findSeat: async id => seats[id] || null,
    statusTimeoutMs: 100,
    log: { warn() {}, error() {} },
    ...opts
  });
}

const refusal = async fn => {
  try { await fn(); return null; } catch (e) { return e instanceof MatchError ? e : e.message; }
};

const room = (id, mode, taken, between = true, cap = 150) => ({ id, mode, taken, cap, between });

console.log("\n-- who may be matched --");

{
  const m = mm([fakeServer("eu-1", "eu", [room("standard-1", "standard", 0)])]);
  const noStake = await refusal(() => m.match({ token: "good", stake: 3 }));
  check("an unknown stake is refused", noStake?.code === "stake" && noStake.status === 400);
  const noSession = await refusal(() => m.match({ token: "nope", stake: 1_000_000 }));
  check("no session is a sign-in problem", noSession?.code === "auth" && noSession.status === 401);
  const blip = await refusal(() => m.match({ token: "boom", stake: 1_000_000 }));
  check("a failed lookup is retryable, not a sign-in problem",
    blip?.code === "retry" && blip.status === 503 && !/sign in/i.test(blip.message), blip?.message);
}

console.log("\n-- grouped by region and stake --");

{
  seats = {};
  const eu = fakeServer("eu-1", "eu", [room("standard-1", "standard", 10), room("highstakes-1", "highstakes", 5)]);
  const us = fakeServer("us-1", "us", [room("standard-1", "standard", 90)]);
  const m = mm([eu, us]);

  const t = await m.match({ token: "good", stake: 1_000_000, region: "us" });
  check("a player asking for us is placed on a us server", t.server === "us-1" && t.region === "us",
    `${t.server} ${t.region}`);
  check("and told where to connect", t.url === "wss://us-1.example", t.url);
  check("and servers in other regions are not even asked", eu.statusCalls === 0);

  const d = await m.match({ token: "good", stake: 1_000_000, region: "mars" });
  check("an unknown region falls back to the default", d.server === "eu-1", d.server);

  const h = await m.match({ token: "good", stake: 2_000_000, region: "eu" });
  check("the stake picks the mode's room", h.room === "highstakes-1" && h.mode === "highstakes",
    `${h.room} ${h.mode}`);
  check("the reservation asks for that stake", eu.reserveCalls.at(-1).stake === 2_000_000);
}

console.log("\n-- the ticket carries the decision --");

{
  seats = {};
  const eu = fakeServer("eu-1", "eu", [room("standard-3", "standard", 4)]);
  const m = mm([eu], { ticketTtlMs: 5000 });
  const before = Date.now();
  const got = await m.match({ token: "good", stake: 1_000_000 });
  const c = verifyTicket(got.ticket, SECRET);
  check("it names the server and room", c.srv === "eu-1" && c.room === "standard-3", `${c.srv} ${c.room}`);
  check("and the reservation holding the seat", c.rsv === "rsv-1", c.rsv);
  check("the account, its name and the stake",
    c.acct === "acct-ada" && c.name === "Ada" && c.stake === 1_000_000, JSON.stringify(c));
  check("and the region", c.region === "eu");
  check("it is short-lived", c.exp <= before + 5000 + 50 && c.exp > before, `${c.exp - before}ms`);
  check("and never outlives its reservation", c.exp <= Date.now() + 10_000);
}

console.log("\n-- which server, which room --");

{
  seats = {};
  // An existing room with a seat beats a server that could only open one.
  const opener = fakeServer("eu-a", "eu", [room("standard-1", "standard", 150)], { canOpen: true });
  const holder = fakeServer("eu-b", "eu", [room("standard-4", "standard", 30)]);
  let got = await mm([opener, holder]).match({ token: "good", stake: 1_000_000 });
  check("a free seat in an existing room beats opening a new one",
    got.server === "eu-b" && got.room === "standard-4", `${got.server} ${got.room}`);

  // Between rounds beats mid-round; then the fuller room.
  const live = fakeServer("eu-a", "eu", [room("standard-1", "standard", 120, false)]);
  const quiet = fakeServer("eu-b", "eu", [room("standard-2", "standard", 20, true)]);
  const busy = fakeServer("eu-c", "eu", [room("standard-3", "standard", 80, true)]);
  got = await mm([live, quiet, busy]).match({ token: "good", stake: 1_000_000 });
  check("a room between rounds beats one mid-round, and the fuller one wins",
    got.server === "eu-c" && got.room === "standard-3", `${got.server} ${got.room}`);

  // Every room full: open one where that is allowed.
  const full = fakeServer("eu-a", "eu", [room("standard-1", "standard", 150)], { canOpen: false });
  const roomy = fakeServer("eu-b", "eu", [room("standard-1", "standard", 150)], { canOpen: true });
  got = await mm([full, roomy]).match({ token: "good", stake: 1_000_000 });
  check("with every room full, a server that can open one is used",
    got.server === "eu-b" && roomy.reserveCalls[0].room === null, got.server);
  check("and one that cannot is not asked to", full.reserveCalls.length === 0);
}

console.log("\n-- servers that fail --");

{
  seats = {};
  const down = fakeServer("eu-a", "eu", [], { down: true });
  const up = fakeServer("eu-b", "eu", [room("standard-1", "standard", 3)]);
  let got = await mm([down, up]).match({ token: "good", stake: 1_000_000 });
  check("a server that does not answer is skipped", got.server === "eu-b", got.server);

  const slow = fakeServer("eu-a", "eu", [], { slow: true });
  const t0 = Date.now();
  got = await mm([slow, up]).match({ token: "good", stake: 1_000_000 });
  check("one that answers too slowly does not hold the match up",
    got.server === "eu-b" && Date.now() - t0 < 1000, `${Date.now() - t0}ms`);

  // Rankings are a moment old when acted on: a refusal moves to the next.
  const stale = fakeServer("eu-a", "eu", [room("standard-1", "standard", 140)], { refuse: true });
  const next = fakeServer("eu-b", "eu", [room("standard-2", "standard", 10)]);
  got = await mm([stale, next]).match({ token: "good", stake: 1_000_000 });
  check("a server that refuses the reservation passes it to the next",
    got.server === "eu-b" && stale.reserveCalls.length === 1, got.server);

  const fullUp = fakeServer("eu-a", "eu", [room("standard-1", "standard", 150)], { canOpen: false });
  const full = await refusal(() => mm([fullUp]).match({ token: "good", stake: 1_000_000 }));
  check("a region with no seat says the mode is full", full?.code === "full" && full.status === 503,
    full?.code);

  const allDown = await refusal(() => mm([down]).match({ token: "good", stake: 1_000_000 }));
  check("a region with nothing answering says so, and is retryable",
    allDown?.code === "unavailable" && allDown.retryMs > 0, allDown?.code);
}

console.log("\n-- a player already playing goes back where they are --");

{
  // The seat lease says which server holds the account. That server and no
  // other: it may hold a body the player can step back into, and it holds
  // their escrow, which no second server may touch.
  const eu = fakeServer("eu-1", "eu", [room("standard-1", "standard", 10)]);
  const us = fakeServer("us-1", "us", [room("standard-1", "standard", 10)]);
  seats = { "acct-ada": { holder: "us-1#9f3a" } };
  const got = await mm([eu, us]).match({ token: "good", stake: 1_000_000, region: "eu" });
  check("asking for eu while held by us-1 goes to us-1", got.server === "us-1", got.server);
  check("without ranking anything", eu.statusCalls === 0 && us.statusCalls === 0);
  check("and without suggesting a room: the server knows where the body is",
    us.reserveCalls.at(-1).room === null);

  const otherPlayer = await mm([eu, us]).match({ token: "bob", stake: 1_000_000, region: "eu" });
  check("someone else is placed as usual", otherPlayer.server === "eu-1", otherPlayer.server);

  seats = { "acct-ada": { holder: "retired-9#1111" } };
  const gone = await refusal(() => mm([eu, us]).match({ token: "good", stake: 1_000_000 }));
  check("held by a server this matchmaker does not know: wait for the lease",
    gone?.code === "elsewhere" && gone.status === 409 && gone.retryMs > 0, gone?.code);

  seats = { "acct-ada": { holder: "us-1#9f3a" } };
  const down = fakeServer("us-1", "us", [], { down: true });
  const unreachable = await refusal(() => mm([eu, down]).match({ token: "good", stake: 1_000_000 }));
  check("held by a server that is not answering: retry, never a second server",
    unreachable?.code === "unavailable" && eu.reserveCalls.length === 1, unreachable?.code);
  seats = {};
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
