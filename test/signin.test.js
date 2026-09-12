// ---------------------------------------------------------------------------
// Sign-in integration. Run with:  node test/signin.test.js
//
// Boots client/main.js against stubbed DOM, fetch, WebSocket and canvas, then
// drives an actual sign-in through the form and asserts the wager tiers
// appear.
//
// This exists because a unit test on ui.js could not catch the bug it is
// guarding: ui.js was always correct, and main.js failed to tell it the server
// was reachable. The failure only shows up when the two run together, in the
// real order — guest connect, then restore, then sign in, then reconnect.
// ---------------------------------------------------------------------------

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

// ── DOM ─────────────────────────────────────────────────────────────────────

const noop = () => {};
const ctx2d = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = typeof k === "string" && k.startsWith("set") ? noop : noop))
});

class El {
  constructor(id = "") {
    this.id = id; this.attrs = {}; this.style = {}; this.handlers = {};
    this.hidden = false; this.disabled = false;
    this.textContent = ""; this.innerHTML = ""; this.value = "";
    this.offsetWidth = 0; this.clientWidth = 300; this._lock = null;
    const set = new Set();
    this.classList = {
      add: c => set.add(c), remove: c => set.delete(c),
      contains: c => set.has(c),
      toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : on ? set.add(c) : set.delete(c))
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
  click() { for (const fn of this.handlers.click || []) fn({ target: this }); }
  querySelector() { return (this._lock ||= new El(`${this.id}:lock`)); }
  getContext() { return ctx2d; }
  getBoundingClientRect() { return { width: 132, height: 132 }; }
  scrollIntoView() {} focus() {} blur() {}
  appendChild() {} 
}

const registry = new Map();
globalThis.document = {
  getElementById: id => {
    if (!registry.has(id)) registry.set(id, new El(id));
    return registry.get(id);
  },
  createElement: () => new El("created"),
  head: new El("head"),
  body: new El("body"),
  documentElement: new El("html"),
  addEventListener: noop,
  activeElement: null
};

globalThis.location = {
  search: "?mode=online",
  protocol: "http:",
  host: "localhost:8080"
};
globalThis.performance = { now: () => Date.now() };
globalThis.requestAnimationFrame = noop;
globalThis.addEventListener = noop;
globalThis.localStorage = {
  _v: {},
  getItem(k) { return this._v[k] ?? null; },
  setItem(k, v) { this._v[k] = v; },
  removeItem(k) { delete this._v[k]; }
};
globalThis.window = {
  innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
  addEventListener: noop, google: undefined,
  location: globalThis.location, localStorage: globalThis.localStorage
};

// ── network ─────────────────────────────────────────────────────────────────

const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor(url) {
    this.url = url; this.readyState = 1; this.handlers = {};
    this.sent = [];
    sockets.push(this);
  }
  addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
};

const ACCOUNT = { id: "u1", username: "ada", displayName: "Ada", provider: "password" };
const signupBodies = [];
let signedInOnServer = false;

globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  const json = (status, body) => ({
    ok: status < 400, status, json: async () => body
  });

  if (path.endsWith("/api/config")) return json(200, { googleClientId: null, demo: true });
  if (path.endsWith("/api/me")) {
    return signedInOnServer
      ? json(200, { account: ACCOUNT, demo: true, balance: 5_000_000, pot: 0, staked: false })
      : json(401, { error: "Not signed in." });
  }
  if (path.endsWith("/api/login")) {
    signedInOnServer = true;
    return json(200, {
      token: "t".repeat(64), account: ACCOUNT,
      demo: true, balance: 5_000_000, pot: 0, staked: false
    });
  }
  if (path.endsWith("/api/signup")) {
    signupBodies.push(JSON.parse(opts.body || "{}"));
    const body = signupBodies[signupBodies.length - 1];
    // Mirrors the server: an account cannot be created without a declared age.
    if (!body.dateOfBirth) {
      return json(400, { error: "Enter your date of birth.", code: "age" });
    }
    signedInOnServer = true;
    return json(201, {
      token: "s".repeat(64), account: ACCOUNT,
      demo: true, balance: 5_000_000, pot: 0, staked: false
    });
  }
  if (path.endsWith("/api/stats")) return json(200, { stats: { matches: 0 }, matches: [] });
  return json(404, { error: "no route" });
};

// ── boot ────────────────────────────────────────────────────────────────────

await import("../client/main.js");
const settle = () => new Promise(r => setTimeout(r, 0));
await settle(); await settle();   // let restore() and config() resolve

const $ = id => document.getElementById(id);
const shown = id => $(id).hidden === false;
const note = () => ($("stakeNote").hidden ? null : $("stakeNote").textContent);

console.log("\n-- before signing in --");

check("only practice is offered", shown("stakeFree") && !shown("stake1") && !shown("stake2"));
check("the line asks for a sign-in", note() === "Sign in to play for stakes.", String(note()));
check("no socket has been opened yet", sockets.length === 0, `${sockets.length}`);

console.log("\n-- signing in --");

$("fUser").value = "ada";
$("fPass").value = "password123";
$("btnAuth").click();
await settle(); await settle(); await settle();

if ($("authError").textContent) console.log("  authError:", $("authError").textContent);
// Signing in does NOT open a socket, because the practice tier is still
// selected and there is no practice room on the server: it refuses a join
// with no stake, by design. Opening one anyway meant every sign-in left the
// menu reading "Disconnected", and handed the player a refused socket to try
// to play the free tier through.
check("no socket is opened while the free tier is selected", sockets.length === 0,
  sockets.length ? sockets[0].url : "");
check("the account panel switched over", $("authSignedIn").hidden === false);

// The bug: main.js reconnected to the server but never cleared the flag it had
// set while connecting as a guest, so the menu went on insisting there was no
// server to wager against.
check("the 1.00 tier appears", shown("stake1"));
check("the 2.00 tier appears", shown("stake2"));
check("the sign-in line is cleared", note() === null, String(note()));
check("neither tier is locked", $("stake1").getAttribute("aria-disabled") !== "true"
  && $("stake2").getAttribute("aria-disabled") !== "true");

console.log("\n-- picking a stake --");

$("stake2").click();
check("2.00 can be selected", $("stake2").getAttribute("aria-checked") === "true");
check("choosing a tier alone still opens nothing", sockets.length === 0, `${sockets.length}`);

console.log("\n-- a refusal is never silent --");

// A refused connection used to write its reason into the pregame menu, which
// is hidden the moment the player presses Start. The result was a blank arena
// with the explanation sitting behind it, unreachable.
{
  $("stake1").click();
  $("btnStart").click();
  await settle();
  check("starting a staked run is what opens the socket", sockets.length === 1,
    `${sockets.length}`);
  const live = sockets[sockets.length - 1];
  // The join is written when the socket opens, so drive that first.
  (live.handlers.open || []).forEach(fn => fn());
  check("and it carries the tier that was chosen",
    /"stake":1000000/.test(String(live.sent[0] || "")), String(live.sent[0] || "").slice(0, 60));
  live.handlers.message.forEach(fn => fn({
    data: JSON.stringify({ type: "round_start", mode: "standard", number: 1, seconds: 120 })
  }));
  check("the game is running", $("startVeil").hidden === true);

  live.handlers.message.forEach(fn => fn({
    data: JSON.stringify({
      type: "account_error", code: "stale",
      reason: "This page is out of date. Reload to get the latest version."
    })
  }));
  check("a refusal puts a visible overlay in front of the player",
    $("errVeil").hidden === false);
  check("and says what went wrong",
    /out of date/i.test($("errText").textContent), $("errText").textContent);
  check("offering the action that fixes it",
    $("btnErrAction").textContent === "Reload", $("btnErrAction").textContent);
}

console.log("\n-- lobby and ready --");

const sock = sockets[sockets.length - 1];
$("stake1").click();
$("btnStart").click();
await settle();

const live = sockets[sockets.length - 1];
const lobbyMsg = p => JSON.stringify({
  type: "lobby", mode: "standard", ready: 0, connected: 1, min: 1, max: 150, phase: p, test: true
});

// PHASE_LOBBY is 3.
live.handlers.message.forEach(fn => fn({ data: lobbyMsg(3) }));
check("the lobby overlay opens", $("lobbyVeil").hidden === false);

const before = live.sent.length;
$("btnReady").click();
const sent = live.sent.slice(before).map(String);
check("pressing ready puts a frame on the wire",
  sent.some(m => m.includes('"type":"ready"') && m.includes('"ready":true')),
  sent.join(" ") || "nothing sent");

live.handlers.message.forEach(fn => fn({
  data: JSON.stringify({ type: "round_start", mode: "standard", number: 1, seconds: 120 })
}));
check("round_start closes the lobby", $("lobbyVeil").hidden === true);

// The bug: pushLobby fires on every join and leave, including mid-round, and
// the client was acting on it — dropping a live player back to the lobby.
live.handlers.message.forEach(fn => fn({ data: lobbyMsg(1) }));   // PHASE_LIVE
check("a lobby broadcast during a live round is ignored",
  $("lobbyVeil").hidden === true);

console.log("\n-- creating an account carries the date of birth --");

// Every layer around this one already handled the date: the form reads the
// field, the account client sends it, the server demands it. main.js took
// three arguments where the form passed four, so the fourth was dropped on
// the floor and EVERY attempt to create an account with a username and
// password was refused with "Enter your date of birth" no matter what the
// player typed. Nothing caught it because each layer was correct on its own.
{
  $("tabSignUp").click();
  $("fUser").value = "grace";
  $("fPass").value = "hopper19061";
  $("fName").value = "Grace";
  $("fDob").value = "1906-12-09";
  $("btnAuth").click();
  await settle(); await settle(); await settle();

  const sent = signupBodies[signupBodies.length - 1];
  check("the form reached the server", !!sent, sent ? "" : "nothing was posted");
  check("and carried the date of birth", sent?.dateOfBirth === "1906-12-09",
    JSON.stringify(sent?.dateOfBirth));
  check("along with the rest of the form",
    sent?.username === "grace" && sent?.displayName === "Grace",
    JSON.stringify(sent));
  check("so the account was created, not refused",
    !$("authError").textContent, $("authError").textContent);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
