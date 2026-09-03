// ---------------------------------------------------------------------------
// DOM chrome: readout, leaderboard, settings, and the start / death cards.
// Knows nothing about the simulation beyond the view shape.
// ---------------------------------------------------------------------------

import { formatUsdc, valueOfMass, PRACTICE, STAKE_1_USDC } from "../shared/wager.js";
import { PHASE_LIVE, PHASE_LOBBY } from "../shared/protocol.js";

const $ = id => document.getElementById(id);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function createUI({ settings, onStart, onThemeChange, onRamp, auth }) {
  const el = {
    orbs: $("orbCount"),
    mass: $("statMass"),
    rank: $("statRank"),
    cells: $("statCells"),
    time: $("statTime"),
    board: $("board"),
    boardList: $("boardList"),
    minimap: $("minimap"),
    startVeil: $("startVeil"),
    overVeil: $("overVeil"),
    mode: $("modeNote"),
    badge: $("demoBadge"),
    bal: $("balValue"),
    ramp: $("btnRamp"),
    rampNote: $("rampNote"),
    stakeFree: $("stakeFree"),
    stake1: $("stake1"),
    potBar: $("potBar"),
    potValue: $("potValue"),
    signedOut: $("authSignedOut"),
    signedIn: $("authSignedIn"),
    whoName: $("whoName"),
    whoUser: $("whoUser"),
    renameBox: $("renameBox"),
    wallet: $("walletBox"),
    clock: $("roundClock"),
    clockTime: $("clockTime"),
    roundVeil: $("roundVeil"),
    lobbyVeil: $("lobbyVeil"),
    money: $("moneyRow"),
    statValue: $("statValue"),
    statStaked: $("statStaked"),
    specBar: $("specBar"),
    specName: $("specName")
  };

  // The client holds no authority over money. This is a read-only echo of the
  // server ledger; every value here arrives from the server and is never
  // computed locally.
  let account = { balance: 0, pot: 0, staked: false, demo: true };
  let stake = PRACTICE;
  let signedIn = false;

  let tickTimer = null;
  let hudAt = 0;

  function bumpCounter() {
    el.orbs.classList.remove("tick");
    void el.orbs.offsetWidth;      // force reflow so the animation restarts
    el.orbs.classList.add("tick");
    clearTimeout(tickTimer);
    tickTimer = setTimeout(() => el.orbs.classList.remove("tick"), 300);
  }

  // The bar is the only affordance while dead, so it carries the whole
  // spectator UI: who you are watching, how to change, how to stop.
  function showSpectator(name) {
    el.specBar.hidden = false;
    el.specName.textContent = name || "…";
    el.overVeil.hidden = true;
  }

  function hideSpectator() { el.specBar.hidden = true; }

  function renderClock(round) {
    // The lobby overlay owns the screen while waiting, so no clock there.
    if (round && round.phase === PHASE_LOBBY) { el.clock.hidden = true; return; }
    // PHASE_NONE means practice: no timer, so no clock.
    if (!round || round.phase !== PHASE_LIVE) { el.clock.hidden = true; return; }
    el.clock.hidden = false;
    el.clockTime.textContent = mmss(round.remaining);
    el.clock.classList.toggle("ending", round.remaining <= 30);
  }

  let iAmReady = false;

  function showLobby(state) {
    el.lobbyVeil.hidden = false;
    el.roundVeil.hidden = true;
    el.overVeil.hidden = true;

    const { ready = 0, connected = 0, min = 0, max = 0 } = state || {};
    $("lobbyReady").textContent = ready;
    $("lobbyConnected").textContent = connected;
    $("lobbyMin").textContent = min;
    $("lobbyFill").style.width = `${Math.min(100, min ? (ready / min) * 100 : 0)}%`;

    const short = Math.max(0, min - ready);
    $("lobbyLine").textContent = short === 0
      ? "Starting now."
      : `Waiting for ${short} more player${short === 1 ? "" : "s"} to be ready.`;
    $("lobbyHint").textContent =
      `The match begins as soon as ${min} players are ready. Capacity ${max}.`;

    const btn = $("btnReady");
    btn.textContent = iAmReady ? "Ready — waiting for others" : "I'm ready";
    btn.setAttribute("aria-pressed", String(iAmReady));
  }

  function hideLobby() { el.lobbyVeil.hidden = true; }

  function showRoundEnd({ number, standings, nextIn, myName }) {
    // The round ending supersedes a death card: if you were eaten seconds
    // before the whistle, the standings are the more useful thing to see.
    el.overVeil.hidden = true;
    $("roundTitle").textContent = `Round ${number} over`;
    $("standingsList").innerHTML = standings.length
      ? standings.map(r =>
          `<div class="${r.name === myName ? "you" : ""}${r.paid ? " paid" : ""}">` +
          `<span>${r.position}. ${escapeHtml(r.name)}</span>` +
          `<em>${r.paid ? "paid &middot; " : ""}${r.mass}</em></div>`
        ).join("")
      : `<div><span>Nobody survived the round.</span><em></em></div>`;
    $("nextRound").textContent = `Next round in ${nextIn}s`;
    el.roundVeil.hidden = false;
  }

  function hideRoundEnd() { el.roundVeil.hidden = true; }

  function update(view, elapsed, now) {
    if (!view) return;
    renderClock(view.round);
    el.orbs.textContent = view.me.orbs;
    el.cells.textContent = view.me.eaten;
    el.mass.textContent = Math.round(view.me.mass);
    el.time.textContent = mmss(elapsed);

    // Live rounds only. In practice against bots there is no money involved,
    // so a cash figure there would be actively misleading.
    const live = view.round && view.round.phase === PHASE_LIVE;
    el.money.hidden = !live;
    if (live) {
      // Derived from the mass in the snapshot, which the server owns. This is
      // a rendering of authoritative state, not a balance the client keeps.
      el.statValue.textContent = formatUsdc(valueOfMass(view.me.mass));
      el.statStaked.textContent = formatUsdc(account.pot);
    }

    if (now - hudAt < 400) return;
    hudAt = now;

    el.rank.textContent = view.me.alive ? `${view.me.rank} of ${view.me.of}` : "—";

    if (settings.board) {
      el.boardList.innerHTML = view.board.map((r, i) =>
        `<li class="${r.id === view.me.id ? "you" : ""}">` +
        `<span>${i + 1}. ${escapeHtml(r.name)}</span><b>${r.mass}</b></li>`
      ).join("");
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── settings ──────────────────────────────────────────────────────────────

  const gearBtn = $("gearBtn");
  const panel = $("settings");

  gearBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    gearBtn.setAttribute("aria-expanded", String(!panel.hidden));
  });

  document.addEventListener("pointerdown", e => {
    if (panel.hidden || e.target.closest(".settings, .gear")) return;
    panel.hidden = true;
    gearBtn.setAttribute("aria-expanded", "false");
  });

  function bindSwitch(id, key, onChange) {
    const sw = $(id);
    sw.setAttribute("aria-checked", String(settings[key]));
    sw.addEventListener("click", () => {
      settings[key] = !settings[key];
      sw.setAttribute("aria-checked", String(settings[key]));
      onChange?.(settings[key]);
    });
  }

  const swTheme = $("swTheme");
  swTheme.addEventListener("click", () => {
    settings.theme = settings.theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", settings.theme);
    swTheme.setAttribute("aria-checked", String(settings.theme === "dark"));
    onThemeChange?.(settings.theme);
  });

  bindSwitch("swMap", "map", on => { el.minimap.hidden = !on; });
  bindSwitch("swBoard", "board", on => { el.board.hidden = !on; hudAt = 0; });
  bindSwitch("swGrid", "grid");
  bindSwitch("swNames", "names");

  // ── panels ────────────────────────────────────────────────────────────────

  $("btnStart").addEventListener("click", () => {
    document.activeElement?.blur?.();
    el.startVeil.hidden = true;
    el.overVeil.hidden = true;
    onStart();
  });

  $("btnAgain").addEventListener("click", () => {
    document.activeElement?.blur?.();
    el.overVeil.hidden = true;
    onStart();
  });

  const ordinal = n => {
    if (!n) return "—";
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  function renderCareer(stats) {
    const box = $("careerBox");
    if (!stats || !stats.matches) { box.classList.remove("on"); return; }
    box.classList.add("on");
    $("stMatches").textContent = stats.matches;
    const mins = Math.round(stats.timePlayed / 60);
    $("stTime").textContent = mins >= 60
      ? `${Math.floor(mins / 60)}h ${mins % 60}m`
      : `${mins}m`;
    $("stBest").textContent = ordinal(stats.bestPosition);
    $("stFirsts").textContent = stats.firstPlaces;
    $("stEaten").textContent = stats.playersEaten;
    $("stStreak").textContent = stats.longestStreak;
  }

  function showDeath({ orbs, peak, eaten, elapsed, best, rank, of }) {
    $("finalOrbs").textContent = orbs;
    $("finalMass").textContent = Math.round(peak);
    $("finalCells").textContent = eaten;
    $("finalPos").textContent = rank ? `${ordinal(rank)} of ${of}` : "—";
    $("finalTime").textContent = mmss(elapsed);
    $("finalBest").textContent = `${best} orbs`;
    $("overLine").textContent = orbs === 0
      ? "Something larger reached you before you absorbed anything."
      : "Something larger reached you.";
    el.overVeil.hidden = false;
    $("btnAgain").focus();
  }

  function setMode(text) { if (el.mode) el.mode.textContent = text; }

  // A banner rather than a quiet note: test mode changes the economics and
  // the lobby rules, and mistaking it for production is the failure worth
  // preventing.
  function setTestMode(on) {
    $("testFlag").hidden = !on;
    document.body.classList.toggle("is-test", !!on);
  }

  // ── wager menu ────────────────────────────────────────────────────────────

  function renderAccount() {
    el.bal.innerHTML = `${formatUsdc(account.balance)}<span>USDC</span>`;
    el.potValue.textContent = formatUsdc(account.pot);
    el.potBar.hidden = !(account.pot > 0);

    // Cannot stake what you do not have, and cannot stake at all as a guest.
    const affordable = account.balance >= STAKE_1_USDC;
    el.stake1.disabled = !affordable || !signedIn;
    if (!affordable && stake !== PRACTICE) setStake(PRACTICE);

    el.badge.hidden = !account.demo;
  }

  function setAccount(next) {
    account = { ...account, ...next };
    renderAccount();
  }

  function setStake(units) {
    stake = units;
    el.stakeFree.setAttribute("aria-checked", String(units === PRACTICE));
    el.stake1.setAttribute("aria-checked", String(units === STAKE_1_USDC));
  }

  el.stakeFree.addEventListener("click", () => setStake(PRACTICE));
  el.stake1.addEventListener("click", () => { if (!el.stake1.disabled) setStake(STAKE_1_USDC); });

  el.ramp.addEventListener("click", () => onRamp?.("deposit"));

  function setRampNote(text) { el.rampNote.textContent = text; }

  // Offline play has no server ledger, so wagering is meaningless there:
  // a client-side balance is just free money.
  function setWagerAvailable(available, reason) {
    el.stake1.disabled = !available;
    el.ramp.disabled = !available;
    if (!available) {
      setStake(PRACTICE);
      if (reason) setRampNote(reason);
    }
  }


  renderAccount();

  // ── accounts ──────────────────────────────────────────────────────────────

  let mode = "login";   // or "signup"

  function setAuthMode(next) {
    mode = next;
    $("tabSignIn").setAttribute("aria-selected", String(next === "login"));
    $("tabSignUp").setAttribute("aria-selected", String(next === "signup"));
    $("fNameWrap").hidden = next !== "signup";
    $("fPass").setAttribute("autocomplete", next === "signup" ? "new-password" : "current-password");
    $("btnAuth").textContent = next === "signup" ? "Create account" : "Sign in";
    $("authHint").textContent = next === "signup"
      ? "Password must be at least 8 characters. Your display name is what appears on your cell."
      : "Play against bots without an account. Sign in to face other players.";
    $("authError").textContent = "";
  }

  function renderAuth(account) {
    signedIn = !!account;
    el.signedOut.hidden = signedIn;
    el.signedIn.hidden = !signedIn;
    // A balance means nothing before you have an account, and the block costs
    // ~150px of a menu that already struggles to fit a laptop screen.
    el.wallet.hidden = !signedIn;
    if (account) {
      el.whoName.textContent = account.displayName;
      el.whoUser.textContent = `@${account.username}`;
      $("fPass").value = "";
    }
    // Wagering requires identity: a guest balance belongs to whoever opens
    // the next socket, which is to say nobody.
    el.stake1.disabled = !signedIn || account?.canWager === false;
    if (!signedIn) setStake(PRACTICE);
  }

  // Guest mode has no account API. Replace the form with an explanation
  // instead of leaving controls that throw when clicked.
  function setAuthAvailable(available, reason) {
    if (available) return;
    el.signedOut.innerHTML =
      `<p class="hint" style="margin:0">${escapeHtml(reason || "Accounts are unavailable.")}</p>`;
    el.signedOut.hidden = false;
  }

  $("tabSignIn").addEventListener("click", () => setAuthMode("login"));
  $("tabSignUp").addEventListener("click", () => setAuthMode("signup"));

  async function submitAuth() {
    const btn = $("btnAuth");
    const err = $("authError");
    err.textContent = "";
    btn.disabled = true;
    btn.textContent = mode === "signup" ? "Creating…" : "Signing in…";
    try {
      await auth?.[mode === "signup" ? "signup" : "login"](
        $("fUser").value,
        $("fPass").value,
        $("fName").value
      );
    } catch (e) {
      err.textContent = e.message || "Something went wrong.";
    } finally {
      btn.disabled = false;
      btn.textContent = mode === "signup" ? "Create account" : "Sign in";
    }
  }

  $("btnAuth").addEventListener("click", submitAuth);
  for (const id of ["fUser", "fPass", "fName"]) {
    $(id).addEventListener("keydown", e => { if (e.key === "Enter") submitAuth(); });
  }

  $("btnSignOut").addEventListener("click", () => auth?.signOut());

  $("btnRename").addEventListener("click", () => {
    el.renameBox.hidden = !el.renameBox.hidden;
    if (!el.renameBox.hidden) {
      $("fNewName").value = el.whoName.textContent;
      $("fNewName").focus();
    }
  });

  async function submitRename() {
    const err = $("renameError");
    err.textContent = "";
    try {
      await auth?.rename($("fNewName").value);
      el.renameBox.hidden = true;
    } catch (e) {
      err.textContent = e.message || "Could not change name.";
    }
  }

  $("btnSaveName").addEventListener("click", submitRename);
  $("fNewName").addEventListener("keydown", e => { if (e.key === "Enter") submitRename(); });

  setAuthMode("login");
  renderAuth(null);
  renderAccount();

  return {
    update, bumpCounter, showDeath, setMode, el,
    setAccount, setRampNote, setWagerAvailable, renderAuth, renderCareer,
    setAuthAvailable,
    showRoundEnd, hideRoundEnd, showLobby, hideLobby,
    showSpectator, hideSpectator, setTestMode,
    setReady: v => { iAmReady = v; },
    getStake: () => stake,
    isSignedIn: () => signedIn
  };
}
