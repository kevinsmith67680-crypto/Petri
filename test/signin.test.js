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
check("a socket was opened to the server", sockets.length === 1,
  sockets.length ? sockets[0].url : "none");
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

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
