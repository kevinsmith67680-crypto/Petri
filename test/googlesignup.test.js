// ---------------------------------------------------------------------------
// First Google sign-in, which creates an account and therefore needs a date of
// birth. Run with:  node test/googlesignup.test.js
//
// This exists because the flow dead-ended in production. The server refuses to
// create an account with no declared age, and the client told the player to
// enter a date — but the only thing that would submit it was pressing the
// Google button a second time, which nothing said to do and which the Google
// button will not always honour, since it does not reliably mint a fresh
// credential on demand. The player entered a date and nothing happened.
//
// The fix holds the refused credential and completes the sign-in the moment a
// date is chosen, so the assertions below are about that: one Google press,
// one date, an account.
//
// Boots client/main.js against stubbed DOM, fetch, WebSocket and Google, in
// the real order, because this is exactly the kind of fault a unit test on
// either half cannot see.
// ---------------------------------------------------------------------------

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const noop = () => {};
const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = noop)) });

class El {
  constructor(id = "") {
    this.id = id; this.attrs = {}; this.style = {}; this.handlers = {};
    this.hidden = false; this.disabled = false;
    this.textContent = ""; this.innerHTML = ""; this.value = "";
    this.offsetWidth = 0; this._lock = null;
    const set = new Set();
    this.classList = {
      add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
      toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : on ? set.add(c) : set.delete(c))
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
  click() { for (const fn of this.handlers.click || []) fn({ target: this }); }
  // Driving the real listener rather than calling an exported helper: the bug
  // was in the wiring, so the test has to exercise the wiring.
  fire(t) { return Promise.all((this.handlers[t] || []).map(fn => fn({ target: this }))); }
  querySelector() { return (this._lock ||= new El(`${this.id}:lock`)); }
  getContext() { return ctx2d; }
  getBoundingClientRect() { return { width: 132, height: 132 }; }
  scrollIntoView() {} focus() {} blur() {} appendChild() {}
}

const registry = new Map();
const created = [];
globalThis.document = {
  getElementById: id => {
    if (!registry.has(id)) registry.set(id, new El(id));
    return registry.get(id);
  },
  createElement: () => { const e = new El("created"); created.push(e); return e; },
  head: new El("head"), body: new El("body"), documentElement: new El("html"),
  addEventListener: noop, activeElement: null
};

globalThis.location = { search: "?mode=online", protocol: "http:", host: "localhost:8080" };
globalThis.performance = { now: () => Date.now() };
globalThis.requestAnimationFrame = noop;
globalThis.addEventListener = noop;
globalThis.localStorage = {
  _v: {}, getItem(k) { return this._v[k] ?? null; },
  setItem(k, v) { this._v[k] = v; }, removeItem(k) { delete this._v[k]; }
};
globalThis.window = {
  innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
  addEventListener: noop, google: undefined,
  location: globalThis.location, localStorage: globalThis.localStorage
};
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 1; this.handlers = {}; }
  addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
  send() {} close() { this.readyState = 3; }
};

// ── the server ──────────────────────────────────────────────────────────────

const ACCOUNT = { id: "g1", username: "g_sub", displayName: "Ada", provider: "google" };
const CREDENTIAL = "google.id.token.value";
const googleCalls = [];
let accountExists = false;

globalThis.fetch = async (url, opts = {}) => {
  const path = String(url);
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

  if (path.endsWith("/api/config")) return json(200, { googleClientId: "cid.apps.googleusercontent.com", demo: true });
  if (path.endsWith("/api/me")) return json(401, { error: "Not signed in." });
  if (path.endsWith("/api/stats")) return json(200, { stats: { matches: 0 }, matches: [] });

  if (path.endsWith("/api/google")) {
    const body = JSON.parse(opts.body || "{}");
    googleCalls.push(body);
    // Mirrors findOrCreateGoogle: an existing account ignores the date; a new
    // one is refused without it, and refused outright if it is under age.
    if (accountExists) return json(200, { token: "t".repeat(64), account: ACCOUNT, demo: true, balance: 0, pot: 0, staked: false });
    if (!body.dateOfBirth) return json(400, { error: "Confirm your date of birth to create an account.", code: "age_required" });
    if (body.dateOfBirth >= "2010-01-01") return json(403, { error: "You must be 18 or over to open an account.", code: "underage" });
    accountExists = true;
    return json(200, { token: "t".repeat(64), account: ACCOUNT, demo: true, balance: 0, pot: 0, staked: false });
  }
  return json(404, { error: "no route" });
};

// ── boot ────────────────────────────────────────────────────────────────────

await import("../client/main.js");
const settle = () => new Promise(r => setTimeout(r, 0));
await settle(); await settle();

const $ = id => document.getElementById(id);

// main.js loads Google's script on demand; stand in for it, then run the
// onload it attached so the real callback gets registered.
let googleCallback = null;
globalThis.window.google = {
  accounts: { id: {
    initialize: ({ callback }) => { googleCallback = callback; },
    renderButton: noop
  } }
};
const script = created.find(e => String(e.src || "").includes("gsi/client"));
check("the Google script was requested", !!script, script ? script.src : "none created");
if (script?.onload) script.onload();
await settle();
check("main.js registered a credential callback", typeof googleCallback === "function");

// ── the flow ────────────────────────────────────────────────────────────────

console.log("\n-- pressing Google with no account and no date --");

await googleCallback({ credential: CREDENTIAL });
await settle();

check("the credential was sent once", googleCalls.length === 1, `${googleCalls.length} call(s)`);
check("and carried no date", !googleCalls[0].dateOfBirth);
check("the date field is revealed", $("fDobWrap").hidden === false);
check("the player is told what to do",
  /date of birth/i.test($("authError").textContent), $("authError").textContent);
// The old message ended the trail here: it never said to press Google again,
// and a second press is not guaranteed to produce a credential.
check("the message does not send them back to the button",
  !/google button|press.*google|click.*google/i.test($("authError").textContent),
  $("authError").textContent);

console.log("\n-- entering a date finishes it, with no second press --");

$("fDob").value = "1990-05-04";
await $("fDob").fire("change");
await settle(); await settle();

check("the held credential was resent", googleCalls.length === 2, `${googleCalls.length} call(s)`);
check("the same credential was reused",
  googleCalls[1].credential === CREDENTIAL, String(googleCalls[1].credential));
check("this time with the date", googleCalls[1].dateOfBirth === "1990-05-04",
  String(googleCalls[1].dateOfBirth));
check("the account is signed in", localStorage.getItem("petri.session") === "t".repeat(64));

console.log("\n-- the credential is not reused afterwards --");

$("fDob").value = "1991-01-01";
await $("fDob").fire("change");
await settle();
check("changing the date again sends nothing", googleCalls.length === 2, `${googleCalls.length} call(s)`);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
