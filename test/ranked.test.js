// ---------------------------------------------------------------------------
// XP and skill matchmaking against the real server. Run with:
//   node test/ranked.test.js
//
// Boots the server against a stubbed `ws`, over a data file seeded with
// players at different ratings, and drives matches and a round through the
// real matchmaker and connection handler. No bots, so a round's result is
// down to the people in it.
//
// What is being pinned:
//
//   * A player is seated with people near their rating: a room that fits,
//     else a new room, while players of similar rating share one.
//   * The welcome carries the player's XP and rating.
//   * At the whistle the paid places earn XP, everyone in the round is
//     rated, the result is written, and each player is told.
// ---------------------------------------------------------------------------

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { FileStore } from "../server/store.js";
import { MemoryRepo } from "../server/db/memory.js";
import { Accounts } from "../server/accounts.js";
import { START_RATING, xpForPlace } from "../shared/progress.js";

// Stub `ws` on disk, because the server imports it by name. Removed afterwards.
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

// ── seed players at known ratings ───────────────────────────────────────────

const dataFile = path.join(os.tmpdir(), `petri-ranked-${process.pid}.json`);
const PASSWORD = "password123";
const RATED = { pro: 1500, ace: 1450, mid: START_RATING, avg: START_RATING };
{
  const store = new FileStore(dataFile);
  const repo = new MemoryRepo(store);
  const accounts = new Accounts(repo);
  for (const [name, rating] of Object.entries(RATED)) {
    const a = await accounts.signup({
      username: name, password: PASSWORD, displayName: name, dateOfBirth: "1990-01-01"
    });
    if (rating !== START_RATING) {
      await repo.recordProgress([{ accountId: a.id, xp: 0, ratingChange: rating - START_RATING, rated: false }]);
    }
  }
  await store.close();
}

const PORT = 9300 + (process.pid % 200);
process.env.PORT = String(PORT);
process.env.DATA_FILE = dataFile;
process.env.TEST_MODE = "1";
process.env.MATCH_BURST = "1000";
process.env.BOTS = "0";
process.env.LOBBY_MAX = "4";
process.env.MAX_ROOMS = "4";
process.env.ROUND_SECONDS = "2";
process.env.COUNTDOWN_SECONDS = "1";
process.env.STANDINGS_SECONDS = "1";
// Fixed windows, so which room fits does not depend on how long this took.
process.env.SKILL_WINDOW = "200";
process.env.SKILL_WIDEN = "0";

await import("../server/index.js");
await new Promise(r => setTimeout(r, 400));

const { PROTOCOL_VERSION, PHASE_LOBBY } = await import("../shared/protocol.js");

const req = { headers: {}, socket: { remoteAddress: "10.0.0.7", setNoDelay() {} } };

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

const STANDARD = 1_000_000;
const settle = (ms = 200) => new Promise(r => setTimeout(r, ms));
const health = async () => (await (await fetch(`http://localhost:${PORT}/health`)).json());
const texts = ws => ws.out.filter(m => m !== "<binary>").map(JSON.parse);
const welcome = ws => texts(ws).find(m => m.type === "welcome");
const until = async (cond, ms = 10000) => {
  for (let t = 0; t < ms && !(await cond()); t += 50) await settle(50);
  return cond();
};

const api = async (route, { token, body } = {}) => (await fetch(`http://localhost:${PORT}/api/${route}`, {
  method: body ? "POST" : "GET",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined
})).json();

const tokens = {};
for (const name of Object.keys(RATED)) {
  tokens[name] = (await api("login", { body: { username: name, password: PASSWORD } })).token;
}

async function enter(name) {
  const got = await api("match", { token: tokens[name], body: { stake: STANDARD } });
  const ws = new FakeWS();
  globalThis.__wss.emit("connection", ws, req);
  await ws.deliver({ type: "join", ticket: got.ticket, protocol: PROTOCOL_VERSION });
  await settle();
  return ws;
}

console.log("\n-- the welcome carries XP and rating --");

const pro = await enter("pro");
const proIn = welcome(pro);
check("a seeded player is welcomed with their rating", proIn?.progress?.rating === 1500,
  JSON.stringify(proIn?.progress));
check("and their XP", proIn?.progress?.xp === 0);

console.log("\n-- seated by skill --");

check("the first player takes the standing room", proIn?.room === "standard-1", proIn?.room);
const mid = await enter("mid");
check("a 1000 player is not put in with a 1500 one: a room is opened for them",
  welcome(mid)?.room && welcome(mid).room !== "standard-1", welcome(mid)?.room);
const avg = await enter("avg");
check("another 1000 player joins them there, not the stronger room",
  welcome(avg)?.room === welcome(mid)?.room, welcome(avg)?.room);
const ace = await enter("ace");
check("a 1450 player joins the 1500 one", welcome(ace)?.room === "standard-1", welcome(ace)?.room);

const rooms = (await health()).rooms.filter(r => r.mode === "standard");
const strong = rooms.find(r => r.id === "standard-1");
const weaker = rooms.find(r => r.id === welcome(mid)?.room);
check("each room reports the mean rating of its players",
  strong?.skill?.rating === 1475 && weaker?.skill?.rating === 1000,
  rooms.map(r => `${r.id}:${r.skill?.rating}±${r.skill?.window}`).join(" "));

console.log("\n-- a round is scored --");

// Both 1000 players ready up; with no bots and nobody moving, both are still
// standing at the whistle, so both are in the paid places.
await mid.deliver({ type: "ready", ready: true });
await avg.deliver({ type: "ready", ready: true });
const told = await until(() =>
  texts(mid).some(m => m.type === "progress") && texts(avg).some(m => m.type === "progress"));
check("both players are told their progress after the round", told);

const pm = texts(mid).find(m => m.type === "progress");
const pa = texts(avg).find(m => m.type === "progress");
const [first, second] = pm?.place === 1 ? [pm, pa] : [pa, pm];
check("first and second, of two", first?.place === 1 && second?.place === 2 && first?.of === 2,
  `${first?.place}/${second?.place} of ${first?.of}`);
check("first place earns first-place XP", first?.gained === xpForPlace(1, 5) && first?.xp === first?.gained,
  JSON.stringify(first));
check("second earns second-place XP", second?.gained === xpForPlace(2, 5));
check("the winner's rating goes up and the other's down, by the same amount",
  first?.ratingChange > 0 && Math.abs(first.ratingChange + second.ratingChange) < 1e-9,
  `${first?.ratingChange} / ${second?.ratingChange}`);
check("the new rating is reported", Math.abs(first?.rating - (START_RATING + first?.ratingChange)) < 1e-9);
check("and the round counted as rated", first?.rated === true && first?.ratedGames === 1);

// Written, not just announced.
const winnerName = first === pm ? "mid" : "avg";
const stats = await api("stats", { token: tokens[winnerName] });
check("the XP is stored", stats.progress?.xp === xpForPlace(1, 5), JSON.stringify(stats.progress));
check("and so is the rating", Math.abs(stats.progress?.rating - first?.rating) < 1e-9);

check("players in another room are untouched", !texts(pro).some(m => m.type === "progress"));

console.log("\n-- each paid place is told what it won --");

// The congratulations card is built from this, so it has to be the ledger's
// figures: the stake and what was actually paid. Nobody ate anybody, so each
// pot is the player's own stake and that is what comes back.
for (const [ws, name] of [[mid, "mid"], [avg, "avg"]]) {
  const seq = texts(ws);
  const at = seq.findIndex(m => m.type === "result");
  const r = seq[at];
  check(`${name} is told their own result`, r?.placed === true && [1, 2].includes(r?.place),
    JSON.stringify(r));
  check(`${name}'s stake and payout are the ledger's`,
    r?.stake === STANDARD && r?.paid === STANDARD && r?.settled === true, JSON.stringify(r));
  // The balance lands first, so the card can show what the payout produced.
  const before = seq.slice(0, at).reverse().find(m => m.type === "account");
  const opened = welcome(ws);
  check(`${name}'s balance is pushed first, with the pot paid out`,
    before?.pot === 0 && before?.balance === opened.balance + STANDARD,
    `${opened?.balance} -> ${before?.balance}, pot ${before?.pot}`);
}

console.log("\n-- and then everyone is back in the lobby --");

{
  // The standings are up for STANDINGS_SECONDS first; the lobby follows.
  const back = () => {
    const seq = texts(mid);
    return seq.slice(seq.findIndex(m => m.type === "round_end") + 1)
      .find(m => m.type === "lobby" && m.phase === PHASE_LOBBY);
  };
  await until(() => !!back(), 4000);
  check("after the standings the room is back in the lobby, nobody ready",
    back()?.ready === 0, JSON.stringify(back()));
  await settle(2500);
  check("and no round starts until someone readies again",
    texts(mid).filter(m => m.type === "round_start").length === 1);
}

for (const ws of [pro, mid, avg, ace]) {
  await ws.deliver({ type: "leave" });
  await ws.drop();
}

fs.rmSync(dataFile, { force: true });
if (createdStub) fs.rmSync(stubDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
