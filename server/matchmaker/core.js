// ---------------------------------------------------------------------------
// Matchmaking.
//
// Given a signed-in player, a stake and a region, find them a seat: pick a
// game server and a room, have that server reserve the seat, and hand back a
// short-lived signed ticket that the server will accept in place of anything
// the client says about itself.
//
// Rooms are also chosen by skill: each room reports the mean rating of the
// people in it and a window around that mean, which the server widens the
// longer the room's lobby waits. A player goes to a room they fit; failing
// that, to a new room; failing that, to the nearest room with a seat. Skill
// decides where a player sits, never whether they get a seat.
//
// Where a server fills its rooms with bots (test mode), the player's bot
// difficulty is part of the room too, like the stake: everyone in a room
// asked for the same bots, so nobody's pick is imposed on anyone else. A
// server with no bots reports no level, and the request's is ignored there.
//
// Stateless. Everything it knows it asks for on each request: the session
// and the player's current seat from the database, the rooms from the game
// servers themselves. Any number of matchmakers can run side by side, and one
// can be restarted at any moment without losing anybody.
//
// Servers are passed in as objects so the same logic runs standalone (talking
// to game servers over signed HTTP, see index.js) or inside a single game
// server that is its own and only server (see server/index.js):
//
//   { id, region, url,
//     status():      { canOpen, rooms: [{ id, mode, taken, cap, between, bots, skill }] }
//     reserve(req):  { ok: true, room, rsv, expiresAt } | { ok: false, code } }
//
// `bots` on a room is its bot level, or null where the room has no bots.
// `skill` is { rating, window }: rating null for a room with nobody in it.
// ---------------------------------------------------------------------------

import { MODES } from "../../shared/modes.js";
import { isBotLevel } from "../../shared/sim.js";
import { fitsSkill } from "../../shared/progress.js";
import { signTicket } from "../ticket.js";

export class MatchError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message);
    this.code = code;          // stake | auth | retry | full | unavailable | elsewhere
    this.status = status;
    Object.assign(this, extra);
  }
}

// A seat is held as "<server id>#<boot id>". Routing needs only the server.
export const serverOfHolder = holder => String(holder).split("#")[0];

function withTimeout(promise, ms) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms);
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

export function createMatchmaker({
  servers,
  secret,
  resolveSession,            // token -> account | null; throws if it could not check
  findSeat,                  // accountId -> { holder } | null
  findSkill = async () => null,  // accountId -> rating | null; null seats by fill alone
  ticketTtlMs = 30_000,
  defaultRegion = servers[0]?.region,
  statusTimeoutMs = 1500,
  reserveTimeoutMs = 3000,
  now = Date.now,
  log = console
}) {
  if (!servers.length) throw new Error("the matchmaker needs at least one game server");
  const byId = new Map(servers.map(s => [s.id, s]));
  const regions = [...new Set(servers.map(s => s.region))];

  // Where in a region someone could sit for this mode, best first.
  //
  // The rule is the one each server applies to its own rooms (seatFor), lifted
  // to the region:
  //
  //   1. a room whose skill window the player fits, between rounds before
  //      mid-round, then the fuller — so a region fills its rooms rather than
  //      spreading a quiet evening across half-empty lobbies;
  //   2. otherwise a new room, on a server that can open one;
  //   3. otherwise the room with a seat nearest the player's rating.
  async function rank(candidates, mode, bots, rating) {
    const answers = await Promise.all(candidates.map(async server => {
      try {
        return { server, status: await withTimeout(server.status(), statusTimeoutMs) };
      } catch (err) {
        log.warn?.(`matchmaker: ${server.id} did not report its rooms: ${err.message}`);
        return null;
      }
    }));

    const scored = [];
    for (const a of answers) {
      if (!a) continue;
      for (const r of a.status.rooms || []) {
        if (r.mode !== mode.id || r.taken >= r.cap) continue;
        // A room without bots has no level to disagree with.
        if (bots && r.bots && r.bots !== bots) continue;
        const between = r.between ? 1 : 0;
        if (fitsSkill(r.skill, rating)) {
          scored.push({ server: a.server, room: r.id, key: [3, between, r.taken] });
        } else {
          const gap = Math.abs(rating - r.skill.rating);
          scored.push({ server: a.server, room: r.id, key: [1, between, -gap] });
        }
      }
      if (a.status.canOpen) scored.push({ server: a.server, room: null, key: [2, 0, 0] });
    }
    scored.sort((x, y) => y.key[0] - x.key[0] || y.key[1] - x.key[1] || y.key[2] - x.key[2]);
    return { scored, reachable: answers.filter(Boolean).length };
  }

  // Ask each candidate in turn until one holds a seat. Rankings are a moment
  // old by the time they are acted on, so a refusal just moves to the next.
  async function reserveOn(options, { account, mode, bots, rating }) {
    let answered = 0;
    for (const { server, room } of options) {
      let res;
      try {
        res = await withTimeout(
          server.reserve({ account: account.id, stake: mode.stake, room, bots, rating }),
          reserveTimeoutMs
        );
      } catch (err) {
        log.warn?.(`matchmaker: ${server.id} did not answer a reservation: ${err.message}`);
        continue;
      }
      answered++;
      if (!res?.ok) continue;

      const exp = Math.min(now() + ticketTtlMs, res.expiresAt ?? Infinity);
      const ticket = signTicket({
        srv: server.id, room: res.room, rsv: res.rsv,
        acct: account.id, name: account.displayName,
        stake: mode.stake, region: server.region, exp
      }, secret);
      return {
        ticket, url: server.url ?? null, server: server.id, region: server.region,
        room: res.room, mode: mode.id, expiresAt: exp
      };
    }
    return { answered };
  }

  async function match({ token, stake, region, bots }) {
    const mode = MODES.find(m => m.stake === Number(stake));
    if (!mode) throw new MatchError("stake", 400, "No game is played at that stake.");
    // Not a level is no preference, not an error: an older client sends none.
    const level = isBotLevel(bots) ? bots : null;

    // "No such session" and "could not check" are different answers. Folding
    // the second into the first tells a signed-in player to sign in whenever
    // the database hiccups, and that answer is final.
    let account, seat, rating = null;
    try {
      account = await resolveSession(token);
      if (account) seat = await findSeat(account.id);
    } catch (err) {
      log.error?.("matchmaker: session lookup failed:", err.message);
      throw new MatchError("retry", 503, "The server could not check your session. Retrying.");
    }
    if (!account) {
      throw new MatchError("auth", 401,
        "Sign in to play against other people. Guests play against bots.");
    }
    // Without a rating the player is seated by fill alone, which is how every
    // match worked before ratings existed: a failed lookup costs the skill
    // match, never the seat.
    try {
      const found = await findSkill(account.id);
      rating = Number.isFinite(found) ? found : null;
    } catch (err) {
      log.warn?.(`matchmaker: no rating for ${account.id}: ${err.message}`);
    }

    // Already held by a server: that one and no other, whatever region was
    // asked for. It may be holding a body mid-round that the player can step
    // back into, and it is certainly holding their escrow; a second server
    // would be refused the seat anyway.
    if (seat) {
      const home = byId.get(serverOfHolder(seat.holder));
      if (!home) {
        throw new MatchError("elsewhere", 409,
          "You are still in a game on another server. Try again in a few seconds.",
          { retryMs: 5000 });
      }
      const got = await reserveOn([{ server: home, room: null }], { account, mode, bots: level, rating });
      if (got.ticket) return got;
      throw new MatchError("unavailable", 503,
        "The server holding your game is not answering. Try again in a few seconds.",
        { retryMs: 3000 });
    }

    const where = regions.includes(region) ? region : defaultRegion;
    const { scored, reachable } = await rank(servers.filter(s => s.region === where), mode, level, rating);
    const got = await reserveOn(scored, { account, mode, bots: level, rating });
    if (got.ticket) return got;

    if (!reachable) {
      throw new MatchError("unavailable", 503,
        "No game server in your region is answering. Try again shortly.", { retryMs: 3000 });
    }
    throw new MatchError("full", 503,
      `Every ${mode.label} room is full right now. Try the other mode, or try again shortly.`);
  }

  return {
    match,
    regions: () => regions.map(id => ({
      id, servers: servers.filter(s => s.region === id).length, default: id === defaultRegion
    })),
    servers
  };
}
