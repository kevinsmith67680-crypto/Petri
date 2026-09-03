// ---------------------------------------------------------------------------
// DOM chrome: readout, leaderboard, settings, and the start / death cards.
// Knows nothing about the simulation beyond the view shape.
// ---------------------------------------------------------------------------

import { formatUsdc, PRACTICE, STAKE_1_USDC } from "../shared/wager.js";

const $ = id => document.getElementById(id);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function createUI({ settings, onStart, onThemeChange, onCashOut, onRamp, auth }) {
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
    renameBox: $("renameBox")
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

  function update(view, elapsed, now) {
    if (!view) return;
    el.orbs.textContent = view.me.orbs;
    el.cells.textContent = view.me.eaten;
    el.mass.textContent = Math.round(view.me.mass);
    el.time.textContent = mmss(elapsed);

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

  $("btnCashOut").addEventListener("click", () => onCashOut?.());

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
      : "Play as a guest without an account, but wagering needs one.";
    $("authError").textContent = "";
  }

  function renderAuth(account) {
    signedIn = !!account;
    el.signedOut.hidden = signedIn;
    el.signedIn.hidden = !signedIn;
    if (account) {
      el.whoName.textContent = account.displayName;
      el.whoUser.textContent = `@${account.username}`;
      $("fPass").value = "";
    }
    // Wagering requires identity: a guest balance belongs to whoever opens
    // the next socket, which is to say nobody.
    el.stake1.disabled = !signedIn || account?.canWager === false;
    if (!signedIn) {
      setStake(PRACTICE);
      setRampNote("Sign in to wager. Guest play is practice only.");
    }
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
    getStake: () => stake,
    isSignedIn: () => signedIn
  };
}
