// ---------------------------------------------------------------------------
// Pregame stake gating. Run with:  node test/ui.test.js
//
// createUI is pure client logic with no network in it, so it can be exercised
// headlessly against a DOM stub. Worth doing: "which stakes can a signed-out
// player pick, and what happens when they try the others" is exactly the kind
// of rule that silently rots, and clicking through it by hand tests one
// combination at a time.
//
// The stub implements only what createUI actually touches.
// ---------------------------------------------------------------------------

class El {
  constructor(id = "") {
    this.id = id;
    this.attrs = {};
    this.style = {};
    this.handlers = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.offsetWidth = 0;
    this._lock = null;
    const set = new Set();
    this.classList = {
      add: c => set.add(c),
      remove: c => set.delete(c),
      contains: c => set.has(c),
      toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : on ? set.add(c) : set.delete(c))
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  click() { for (const fn of this.handlers.click || []) fn({ target: this }); }
  querySelector() { return (this._lock ||= new El(`${this.id}:lock`)); }
  scrollIntoView() {}
  focus() { globalThis.__focused = this.id; }
  blur() {}
}

const registry = new Map();
globalThis.document = {
  getElementById: id => {
    if (!registry.has(id)) registry.set(id, new El(id));
    return registry.get(id);
  },
  body: new El("body"),
  addEventListener() {},
  activeElement: null
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { createUI } = await import("../client/ui.js");
const { PRACTICE, STAKE_1_USDC, STAKE_2_USDC, UNIT } = await import("../shared/wager.js");

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const $ = id => document.getElementById(id);
const settings = { theme: "light", map: true, board: true, grid: true, names: true, perf: false };
const ui = createUI({ settings, onStart() {}, onThemeChange() {}, onRamp() {}, auth: {} });

const locked = id => $(id).getAttribute("aria-disabled") === "true";
const shown = id => $(id).hidden === false;
const note = () => ($("stakeNote").hidden ? null : $("stakeNote").textContent);

console.log("\n-- signed out --");

ui.renderAuth(null);
check("practice is offered", shown("stakeFree") && !locked("stakeFree"));
check("the 1.00 tier is hidden entirely", !shown("stake1"));
check("the 2.00 tier is hidden entirely", !shown("stake2"));
check("practice is the selection", ui.getStake() === PRACTICE);

// Hidden must not mean concealed: the player should still learn stakes exist.
check("a line says stakes need an account", note() === "Sign in to play for stakes.",
  String(note()));
check("and it reads as information, not an error",
  $("stakeNote").classList.contains("quiet"));

$("stakeFree").click();
check("choosing practice leaves the line in place", note() === "Sign in to play for stakes.");

console.log("\n-- signed in, funded --");

ui.renderAuth({ id: "a", username: "ada", displayName: "Ada" });
ui.setAccount({ balance: 5 * UNIT, pot: 0, staked: false, demo: true });
check("the tiers appear on sign-in", shown("stake1") && shown("stake2"));
check("1.00 is selectable", !locked("stake1"));
check("2.00 is selectable", !locked("stake2"));
check("the sign-in line is gone", note() === null, String(note()));

$("stake2").click();
check("2.00 can now be selected", ui.getStake() === STAKE_2_USDC, String(ui.getStake()));
check("no prompt is shown", note() === null);

console.log("\n-- signed in, thin balance --");

// Between the two prices: the cheaper tier stays open, the dearer one does not.
ui.setAccount({ balance: 1.5 * UNIT, pot: 0, staked: false, demo: true });
check("both tiers stay visible", shown("stake1") && shown("stake2"));
check("1.00 stays available", !locked("stake1"));
check("2.00 locks on its own price", locked("stake2"));
check("locked is not disabled, so it still takes a click", $("stake2").disabled === false);
check("the lock tag changes to Low balance",
  $("stake2").querySelector().textContent === "Low balance",
  $("stake2").querySelector().textContent);
check("the unaffordable selection falls back to practice", ui.getStake() === PRACTICE,
  String(ui.getStake()));

$("stake2").click();
check("clicking it explains the real reason", note() === "Not enough balance for that stake.",
  String(note()));

ui.setAccount({ balance: 0, pot: 0, staked: false, demo: true });
check("with nothing, both wager tiers lock", locked("stake1") && locked("stake2"));

console.log("\n-- offline --");

ui.renderAuth({ id: "a", username: "ada", displayName: "Ada" });
ui.setAccount({ balance: 5 * UNIT, pot: 0, staked: false, demo: true });
ui.setWagerAvailable(false, "Wagering needs the server.");
check("no server hides the tiers even when signed in and funded",
  !shown("stake1") && !shown("stake2"));
check("and it says so rather than asking for a sign-in",
  note() === "Wagering needs the server. Practice runs in this tab.", String(note()));

ui.setWagerAvailable(true);
check("restoring the server brings them back", shown("stake1") && shown("stake2"));

console.log("\n-- signing out mid-selection --");

$("stake2").click();
check("2.00 selected", ui.getStake() === STAKE_2_USDC);
ui.renderAuth(null);
check("signing out drops the stake back to practice", ui.getStake() === PRACTICE);
check("and hides the tiers again", !shown("stake1") && !shown("stake2"));
check("with the sign-in line restored", note() === "Sign in to play for stakes.");

console.log("\n-- at risk shows the stake, not the escrow --");

// The escrow grows when you eat a staked rival: their pot transfers to yours.
// That is winnings, not what you chose to put in, and showing it made the
// figure climb during a round for no reason the player could connect to.
ui.setAccount({ balance: 4 * UNIT, pot: 1 * UNIT, stake: 1 * UNIT, staked: true, demo: true });
check("shows the chosen stake", $("potValue").textContent === "1.00", $("potValue").textContent);
check("and the bar is visible", $("potBar").hidden === false);

ui.setAccount({ balance: 4 * UNIT, pot: 3 * UNIT, stake: 1 * UNIT, staked: true, demo: true });
check("two kills later it still shows the stake",
  $("potValue").textContent === "1.00", `${$("potValue").textContent} with a 3.00 escrow`);

ui.setAccount({ balance: 3 * UNIT, pot: 2 * UNIT, stake: 2 * UNIT, staked: true, demo: true });
check("a 2.00 tier shows 2.00", $("potValue").textContent === "2.00", $("potValue").textContent);

ui.setAccount({ balance: 5 * UNIT, pot: 0, stake: 0, staked: false, demo: true });
check("practice hides the bar entirely", $("potBar").hidden === true);

console.log("\n-- the HUD does not rewrite unchanged DOM --");

// Writing textContent invalidates style and layout even when the string is
// identical. From 30 seconds remaining the clock also carries a CSS
// animation, and rewriting an animating element every frame forces the
// animation to be re-resolved — which is what made the game stutter at
// exactly the half-minute mark.
let clockWrites = 0;
const clockEl = $("clockTime");
let clockText = "";
Object.defineProperty(clockEl, "textContent", {
  get: () => clockText,
  set: v => { clockWrites++; clockText = v; },
  configurable: true
});

const frame = remaining => ui.update({
  me: { orbs: 5, eaten: 0, mass: 100, alive: true, rank: 3, of: 20, id: 1 },
  round: { phase: 1, remaining, number: 1 },
  board: []
}, 12.3, 0);

for (let i = 0; i < 60; i++) frame(28);          // a second of frames, same value
check("one second of identical frames writes the clock once",
  clockWrites === 1, `${clockWrites} writes`);

clockWrites = 0;
for (let i = 0; i < 60; i++) frame(27);
check("and writes again only when the second changes",
  clockWrites === 1, `${clockWrites} writes`);

// The class that starts the animation must also only be touched on change.
let toggles = 0;
const realToggle = $("roundClock").classList.toggle;
$("roundClock").classList.toggle = (...a) => { toggles++; return realToggle.apply($("roundClock").classList, a); };
for (let i = 0; i < 60; i++) frame(26);
check("the ending class is not re-toggled every frame", toggles === 0, `${toggles} toggles`);

console.log("\n-- connect() must set the flag on every path --");

// A latching flag caused a real bug: the page connects as a guest before the
// stored session is validated, so wagerPossible starts false. The local branch
// set it; the online branch did not, so signing in reconnected to the server
// while the menu went on insisting wagering needed one.
//
// main.js cannot be imported here (it touches window and a canvas), so this is
// a source-level guard. Crude, but it catches exactly the regression.
const mainSrc = await (await import("node:fs/promises")).readFile(
  new URL("../client/main.js", import.meta.url), "utf8");
const connectFn = mainSrc.slice(
  mainSrc.indexOf("function connect("),
  mainSrc.indexOf("\nfunction onEvent")
);
check("connect() enables wagering on the online path",
  /setWagerAvailable\(true[,)]/.test(connectFn));
check("connect() disables it on the local path",
  /setWagerAvailable\(false/.test(connectFn));

// Counting calls against the word "return" used to stand in for this. It
// stopped meaning anything once one of the calls moved inside a socket
// callback, where it reports an unreachable server rather than settling a
// path out of the function — the count went to four against three returns
// while every path was still correct. So check the exits themselves.
for (const exit of ["return socket;", "return local;", "return createLocalConnection("]) {
  const i = connectFn.indexOf(exit);
  check(`"${exit}" settles wagering before it leaves`,
    i > 0 && /setWagerAvailable\(/.test(connectFn.slice(Math.max(0, i - 900), i)),
    i > 0 ? "" : "exit not found — has connect() been restructured?");
}

// ── round-end heading ───────────────────────────────────────────────────────
//
// Surviving to the whistle and being absorbed before it are different results
// and must not share a heading. Only survivors appear in the standings, so the
// presence of our own row is what separates the two.

console.log("\n-- round end --");

const roundTitle = () => $("roundTitle").textContent;
const placings = [
  { name: "Ada", mass: 900, position: 1, paid: true },
  { name: "Kev", mass: 700, position: 2, paid: true },
  { name: "Bo", mass: 500, position: 3, paid: true }
];
const endRound = myName =>
  ui.showRoundEnd({ number: 4, standings: placings, nextIn: 12, myName });

endRound("Bo");
check("a survivor is told the position they finished on",
  roundTitle() === "You finished 3rd", roundTitle());

endRound("Ada");
check("first place reads as first",
  roundTitle() === "You finished 1st", roundTitle());

// Absorbed before the whistle: no row of our own, so claiming a position here
// would invent one the player never held.
endRound("Ghost");
check("someone absorbed before the whistle is not given a position",
  roundTitle() === "Round 4 over", roundTitle());

ui.showRoundEnd({ number: 4, standings: [], nextIn: 12, myName: "Bo" });
check("an empty board falls back to the plain heading",
  roundTitle() === "Round 4 over", roundTitle());

endRound(undefined);
check("a missing display name cannot match a row",
  roundTitle() === "Round 4 over", roundTitle());

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
