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
    this.style = { setProperty(k, v) { this[k] = String(v); } };
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
  appendChild(child) { (this.children ||= []).push(child); return child; }
}

const registry = new Map();
globalThis.document = {
  getElementById: id => {
    if (!registry.has(id)) registry.set(id, new El(id));
    return registry.get(id);
  },
  createElement: () => new El("created"),
  body: new El("body"),
  documentElement: new El("html"),
  addEventListener() {},
  activeElement: null
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { createUI } = await import("../client/ui.js");
const { THEMES } = await import("../client/render.js");
const { PRACTICE, STAKE_1_USDC, STAKE_2_USDC, UNIT } = await import("../shared/wager.js");

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const $ = id => document.getElementById(id);
const settings = { theme: "light", map: true, board: true, grid: true, names: true, perf: false };
// What the lobby card reports: colours picked, and names sent to be saved.
const picked = [];
let renameImpl = async () => {};
const ui = createUI({
  settings, onStart() {}, onThemeChange() {}, onRamp() {},
  onColour: ci => picked.push(ci),
  auth: { rename: name => renameImpl(name) },
  shareUrl: "https://engulfs.io/?mode=online"
});

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

console.log("\n-- the pre-round countdown --");

// The number is ticked from the snapshot clock rather than a timer of the
// client's own, so it cannot drift away from when the round actually starts.
// PHASE_COUNTDOWN is 4.
ui.showLobby({ ready: 1, connected: 1, min: 1, max: 150, phase: 4, starts: 5 });
check("the count replaces the ready meter",
  $("lobbyCount").hidden === false && $("lobbyMeter").hidden === true);
// The card is opened by the lobby message, so the message has to carry the
// number. Left to the next frame, the card opens on the last count's "1".
check("and opens on the count, not on the last one's leftovers",
  $("lobbyCountNum").textContent === "5", $("lobbyCountNum").textContent);
ui.showLobby({ ready: 1, connected: 1, min: 1, max: 150, phase: 4, starts: 2 });
check("a player joining mid-count sees where it has got to",
  $("lobbyCountNum").textContent === "2", $("lobbyCountNum").textContent);
ui.renderCountdown({ phase: 4, remaining: 3, number: 0 });
check("it shows the seconds the server sent", $("lobbyCountNum").textContent === "3",
  $("lobbyCountNum").textContent);
ui.renderCountdown({ phase: 4, remaining: 0, number: 0 });
check("and the last tick is not a zero to sit on",
  $("lobbyCountNum").textContent === "Go", $("lobbyCountNum").textContent);

// A count that is called off has to put the lobby back as it was, or the
// player is left staring at a number that has stopped moving.
ui.showLobby({ ready: 0, connected: 1, min: 2, max: 150, phase: 3 });
check("cancelling restores the meter",
  $("lobbyCount").hidden === true && $("lobbyMeter").hidden === false);
ui.renderCountdown({ phase: 3, remaining: 0, number: 0 });
check("and the stale number is not ticked any more",
  $("lobbyCountNum").textContent === "Go", $("lobbyCountNum").textContent);

console.log("\n-- your cell, on the lobby card --");

const swatches = $("swatches").children;
const checked = () => swatches.map(b => b.getAttribute("aria-checked") === "true" ? 1 : 0).join("");
check("every colour in the palette is offered", swatches.length === 7, String(swatches.length));
check("each is named for a screen reader", swatches.every(b => b.getAttribute("aria-label")));

ui.setColour(null);
check("with nothing picked, no colour claims to be", checked() === "0000000", checked());
check("but the group is still one tab stop", swatches.filter(b => b.tabIndex === 0).length === 1);

swatches[4].click();
check("picking a colour reports it", picked.at(-1) === 4, JSON.stringify(picked));
check("and marks it, and only it, as chosen", checked() === "0000100", checked());
check("the preview is painted in it", $("lobbyMe").style["--me"] === THEMES.light.stains[4],
  $("lobbyMe").style["--me"]);
swatches[4].click();
check("picking it again is not another change", picked.length === 1, JSON.stringify(picked));

const arrow = key => { for (const fn of $("swatches").handlers.keydown) fn({ key, preventDefault() {} }); };
arrow("ArrowRight");
check("an arrow key moves the pick along", picked.at(-1) === 5 && checked() === "0000010", checked());
arrow("ArrowRight"); arrow("ArrowRight");
check("and wraps round at the end", picked.at(-1) === 0, String(picked.at(-1)));

// The server's choice, shown to a player who has not picked. Not a pick of
// their own, so it is not reported back as one.
const before = picked.length;
ui.setColour(2);
check("a colour handed in from outside is shown", checked() === "0010000", checked());
check("without being reported as the player's pick", picked.length === before);

$("swTheme").click();
check("the swatches follow the theme",
  swatches[1].style.background === THEMES.dark.stains[1], swatches[1].style.background);
check("and so does the preview", $("lobbyMe").style["--me"] === THEMES.dark.stains[2]);
$("swTheme").click();

const typeName = v => {
  $("fLobbyName").value = v;
  for (const fn of $("fLobbyName").handlers.input) fn({});
};
const save = async () => { $("btnLobbyName").click(); await new Promise(r => setTimeout(r, 0)); };

ui.renderAuth({ id: "a", username: "ada", displayName: "Ada" });
check("the name starts as the display name", $("fLobbyName").value === "Ada", $("fLobbyName").value);
check("and is what the cell says", $("mePreviewName").textContent === "Ada");
check("there is nothing to save yet", $("btnLobbyName").disabled === true);

typeName("Ada L");
check("the cell shows the name as it is typed", $("mePreviewName").textContent === "Ada L");
check("and it can now be saved", $("btnLobbyName").disabled === false);

const asked = [];
renameImpl = async name => {
  asked.push(name);
  ui.renderAuth({ id: "a", username: "ada", displayName: name.trim() });
};
await save();
check("saving sends the new name", asked.at(-1) === "Ada L", JSON.stringify(asked));
check("and settles on it", $("fLobbyName").value === "Ada L" && $("btnLobbyName").disabled === true);
check("the menu's account panel agrees", $("whoName").textContent === "Ada L");

renameImpl = async () => { throw new Error("That display name is taken."); };
typeName("Bo");
await save();
check("a refusal is said on the card", $("lobbyNameError").textContent === "That display name is taken.",
  $("lobbyNameError").textContent);
check("and what was typed is kept to fix", $("fLobbyName").value === "Bo");
check("the button is ready to try again", $("btnLobbyName").disabled === false &&
  $("btnLobbyName").textContent === "Save");
typeName("Bob");
check("typing clears the refusal", $("lobbyNameError").textContent === "");

typeName("   ");
check("a blank name cannot be saved", $("btnLobbyName").disabled === true);
check("and the cell keeps the saved one", $("mePreviewName").textContent === "Ada L");

console.log("\n-- the last game, on the lobby card --");

ui.renderLastGame(null);
check("with no game played, there is nothing to show", $("lastGame").hidden === true);

const lastMatch = {
  endedAt: Date.now() - 5 * 60_000, duration: 125, finishPosition: 2, playersInArena: 30,
  orbs: 88, playersEaten: 3, peakMass: 640, outcome: "survived", won: true,
  stake: 1 * UNIT, payout: 1.5 * UNIT
};
ui.renderLastGame(lastMatch);
check("a game played is shown", $("lastGame").hidden === false);
check("with what happened", $("lastLine").textContent === "Finished 2nd, in the paid places",
  $("lastLine").textContent);
check("and when", $("lastWhen").textContent === "5 min ago", $("lastWhen").textContent);
check("the numbers are laid out", /Peak mass<\/i><em>640/.test($("lastStats").innerHTML));
check("a gain is marked as one", /<em class="up">\+0\.50<small>USDC<\/small>/.test($("lastStats").innerHTML),
  $("lastStats").innerHTML);

const xHref = new URL($("shareX").href);
check("the X link carries the result", /finished 2nd/.test(xHref.searchParams.get("text")));
check("and points at the game", xHref.searchParams.get("url") === "https://engulfs.io/?mode=online");
check("the post carries no money", !/USDC|0\.50/.test(xHref.searchParams.get("text")));
check("Facebook, WhatsApp and Reddit are linked",
  ["shareFacebook", "shareWhatsApp", "shareReddit"].every(id => $(id).href.startsWith("https://")));
check("no share sheet is offered where the browser has none", $("btnShareNative").hidden === true);

// A browser that has a share sheet and a clipboard.
const sharedWith = [];
let clip = "";
Object.defineProperty(globalThis, "navigator", {
  configurable: true, writable: true,
  value: {
    share: async data => { sharedWith.push(data); },
    clipboard: { writeText: async t => { clip = t; } }
  }
});
ui.renderLastGame(lastMatch);
check("a share sheet is offered where there is one", $("btnShareNative").hidden === false);
for (const fn of $("btnShareNative").handlers.click) await fn({});
check("it is handed the words and the link",
  sharedWith.length === 1 && /finished 2nd/.test(sharedWith[0].text) &&
  sharedWith[0].url === "https://engulfs.io/?mode=online", JSON.stringify(sharedWith));

for (const fn of $("btnShareCopy").handlers.click) await fn({});
check("copy puts the post and the link on the clipboard",
  clip.startsWith("I finished 2nd") && clip.endsWith(" https://engulfs.io/?mode=online"), clip);
check("and says so", $("btnShareCopy").textContent === "Copied");

// A browser that refuses the clipboard, with no way round it.
globalThis.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
for (const fn of $("btnShareCopy").handlers.click) await fn({});
check("a refused copy says so rather than claiming success",
  $("btnShareCopy").textContent === "Copy failed", $("btnShareCopy").textContent);

// Dismissing the sheet is not an error worth surfacing.
globalThis.navigator.share = async () => { throw Object.assign(new Error("cancel"), { name: "AbortError" }); };
let threw = false;
try { for (const fn of $("btnShareNative").handlers.click) await fn({}); } catch { threw = true; }
check("closing the share sheet is not an error", !threw);

ui.renderLastGame(null);
check("signing out takes it away", $("lastGame").hidden === true);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
