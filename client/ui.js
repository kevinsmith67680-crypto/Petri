// ---------------------------------------------------------------------------
// DOM chrome: readout, leaderboard, settings, and the start / death cards.
// Knows nothing about the simulation beyond the view shape.
// ---------------------------------------------------------------------------

import { formatUsdc, valueOfMass, PRACTICE, STAKE_1_USDC, STAKE_2_USDC } from "../shared/wager.js";
import { MODES } from "../shared/modes.js";
import { PHASE_LIVE, PHASE_LOBBY, PHASE_INTERMISSION } from "../shared/protocol.js";
import { MIN_AGE, latestEligibleDob } from "../shared/age.js";

const $ = id => document.getElementById(id);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function createUI({ settings, onStart, onThemeChange, onRamp, onSharp, auth }) {
  const el = {
    orbs: $("orbCount"),
    mass: $("statMass"),
    rank: $("statRank"),
    cells: $("statCells"),
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
    stake2: $("stake2"),
    stakeNote: $("stakeNote"),
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
    statValue: $("statValue"),
    specBar: $("specBar"),
    specName: $("specName")
  };

  // The client holds no authority over money. This is a read-only echo of the
  // server ledger; every value here arrives from the server and is never
  // computed locally.
  let account = { balance: 0, pot: 0, stake: 0, staked: false, demo: true };
  let stake = PRACTICE;
  let signedIn = false;
  let wagerPossible = true;

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

  // A refusal or a dropped connection has to be visible wherever the player
  // is. Previously the reason went to a note inside the pregame menu, which is
  // hidden during a round, so the player just saw an empty arena.
  function showError({ title, text, action, onAction }) {
    $("errTitle").textContent = title;
    $("errText").textContent = text;
    const btn = $("btnErrAction");
    btn.textContent = action || "Reload";
    btn.onclick = onAction || (() => location.reload());
    $("errVeil").hidden = false;
    // It sits above everything, so nothing else should be competing with it.
    el.startVeil.hidden = true;
    el.lobbyVeil.hidden = true;
    el.roundVeil.hidden = true;
    el.overVeil.hidden = true;
  }
  function hideError() { $("errVeil").hidden = true; }

  // Most drops recover in well under half a second. Showing a banner for that
  // is noise, so it waits before appearing — a recovery the player never sees
  // is the best kind.
  let reconnectTimer = null;
  function showBanner(text) {
    setText($("reconnectBar"), text);
    if ($("reconnectBar").hidden && reconnectTimer === null) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        $("reconnectBar").hidden = false;
      }, 600);
    }
  }
  function showReconnecting(attempt, of) {
    showBanner(attempt > 1 ? `Reconnecting… (${attempt} of ${of})` : "Reconnecting…");
  }
  // A connection that has never been live is not being re-established, and
  // saying so was actively misleading: the word arrived on a page the player
  // had only just loaded, describing a game they had not yet been in.
  function showConnecting(attempt, of) {
    showBanner(attempt > 1 ? `Connecting… (${attempt} of ${of})` : "Connecting…");
  }
  function hideReconnecting() {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    $("reconnectBar").hidden = true;
  }

  // Back to the pregame menu after a refusal that the player can act on —
  // a full room, or not enough balance to cover the stake they picked.
  function showStart() {
    $("errVeil").hidden = true;
    el.lobbyVeil.hidden = true;
    el.roundVeil.hidden = true;
    el.overVeil.hidden = true;
    el.startVeil.hidden = false;
  }

  // Writing textContent invalidates style and layout for that element even
  // when the string is identical. The HUD is updated every frame, so most of
  // those writes were pure waste — and on the clock it was actively harmful:
  // from 30 seconds remaining that element also carries a CSS animation, and
  // rewriting an animating element's text every frame forces the animation to
  // be re-resolved 60 times a second. That is the stutter that appeared at
  // exactly the half-minute mark.
  const shown = new Map();
  function setText(node, value) {
    const v = String(value);
    if (shown.get(node) === v) return;
    shown.set(node, v);
    node.textContent = v;
  }
  function setClass(node, name, on) {
    if (node.classList.contains(name) === !!on) return;
    node.classList.toggle(name, !!on);
  }

  function renderClock(round) {
    // The lobby overlay owns the screen while waiting, so no clock there.
    if (round && round.phase === PHASE_LOBBY) { el.clock.hidden = true; return; }
    // PHASE_NONE means practice: no timer, so no clock.
    if (!round || round.phase !== PHASE_LIVE) { el.clock.hidden = true; return; }
    el.clock.hidden = false;
    setText(el.clockTime, mmss(round.remaining));
    setClass(el.clock, "ending", round.remaining <= 30);
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

  // Ticks the intermission countdown on the standings card from the snapshot
  // clock, so the wait is visibly finite rather than a frozen "starting…".
  function renderIntermission(round) {
    if (!el.roundVeil || el.roundVeil.hidden) return;
    if (!round || round.phase !== PHASE_INTERMISSION) return;
    const left = Math.max(0, Math.ceil(round.remaining));
    setText($("nextRound"), left > 0
      ? `Next round in ${left}s`
      : "Starting…");
  }

  function setNextReady(on) {
    const btn = $("btnNextReady");
    btn.setAttribute("aria-pressed", String(!!on));
    setText(btn, on ? "In for the next round" : "I'm in for the next round");
  }

  function showRoundEnd({ number, standings, nextIn, myName }) {
    // The round ending supersedes a death card: if you were eaten seconds
    // before the whistle, the standings are the more useful thing to see.
    el.overVeil.hidden = true;
    // Only survivors are listed, so a row of our own means we were still
    // standing at the whistle — and the position on it is the one the round
    // actually finished on. Anyone absorbed before then has no row and keeps
    // the plain heading; the card they were just shown already said so.
    //
    // No denominator: standings counts who was LEFT, not who started, so
    // "3rd of 9" would read as a far smaller result than a hundred-player
    // round actually was.
    const mine = standings.find(r => r.name === myName);
    $("roundTitle").textContent = mine
      ? `You finished ${ordinal(mine.position)}`
      : `Round ${number} over`;
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
    renderIntermission(view.round);
    setText(el.orbs, view.me.orbs);
    setText(el.cells, view.me.eaten);
    setText(el.mass, Math.round(view.me.mass));

    // Live rounds only. In practice against bots there is no money involved,
    // so a cash figure there would be actively misleading.
    const live = view.round && view.round.phase === PHASE_LIVE;
    // Lives in the pot bar now, which is only shown when something is at
    // stake — so a practice run never displays a cash figure at all.
    if (live) {
      // Derived from the mass in the snapshot, which the server owns. This is
      // a rendering of authoritative state, not a balance the client keeps.
      setText(el.statValue, formatUsdc(valueOfMass(view.me.mass)));
    }

    if (now - hudAt < 400) return;
    hudAt = now;

    setText(el.rank, view.me.alive ? `${view.me.rank} of ${view.me.of}` : "—");

    if (settings.board) {
      // Rebuilding ten list items reparses HTML and drops every existing node.
      // Skip it when the rendered string has not changed.
      // Mark the paid places and rule a line under fifth, so the boundary
      // that decides who gets anything is visible at a glance.
      const paidTo = view.round && view.round.phase === PHASE_LIVE ? 5 : 0;
      const html = view.board.map((r, i) => {
        const cls = [
          r.id === view.me.id ? "you" : "",
          paidTo && i < paidTo ? "paid" : "",
          paidTo && i === paidTo - 1 && view.board.length > paidTo ? "cut" : ""
        ].filter(Boolean).join(" ");
        return `<li class="${cls}">` +
          `<span>${i + 1}. ${escapeHtml(r.name)}</span><b>${r.mass}</b></li>`;
      }).join("");
      if (shown.get(el.boardList) !== html) {
        shown.set(el.boardList, html);
        el.boardList.innerHTML = html;
      }
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
  bindSwitch("swDiag", "diag", on => { $("diagBox").hidden = !on; });
  bindSwitch("swPerf", "perf", on => { if (!on) $("perfBox").hidden = true; });
  bindSwitch("swSharp", "sharp", on => onSharp?.(on));
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

  // The heading used to be a fixed "You were absorbed" in the markup, so a run
  // that led the arena until the last second read exactly like one that died
  // first with nothing. It names the position actually reached instead.
  //
  // No money language here, deliberately. Being eaten forfeits the stake
  // whatever position you held — only survivors place — and this same card is
  // shown in practice, where there is no stake at all. A heading that hinted at
  // placing would therefore be wrong twice over.
  function deathCopy(rank, of, orbs) {
    const ranked = rank > 0 && of > 0;
    if (ranked && rank === 1) {
      return {
        title: "Absorbed in the lead",
        line: `You were top of ${of} when something larger reached you.`
      };
    }
    if (ranked) {
      return {
        title: `Absorbed in ${ordinal(rank)}`,
        line: `You were ${ordinal(rank)} of ${of} when something larger reached you.`
      };
    }
    return {
      title: "You were absorbed",
      line: orbs === 0
        ? "Something larger reached you before you absorbed anything."
        : "Something larger reached you."
    };
  }

  function showDeath({ orbs, peak, eaten, elapsed, best, rank, of }) {
    $("finalOrbs").textContent = orbs;
    $("finalMass").textContent = Math.round(peak);
    $("finalCells").textContent = eaten;
    $("finalPos").textContent = rank ? `${ordinal(rank)} of ${of}` : "—";
    $("finalTime").textContent = mmss(elapsed);
    $("finalBest").textContent = `${best} orbs`;
    const { title, line } = deathCopy(rank, of, orbs);
    $("overTitle").textContent = title;
    $("overLine").textContent = line;
    el.overVeil.hidden = false;
    $("btnAgain").focus();
  }

  // Thresholds are the point: a number with no sense of "good" is noise.
  // 60fps is a frame budget met, 100ms ping is where input starts to drag,
  // and jitter above half a tick is what forces a longer buffer.
  const row = (label, value, bad) =>
    `<div><span>${label}</span><b class="${bad ? "warn" : ""}">${value}</b></div>`;

  function renderDiagnostics(stats, scale) {
    $("diagBox").innerHTML =
      row("fps", Math.round(stats.fps), stats.fps < 50) +
      row("ping", `${Math.round(stats.ping)} ms`, stats.ping > 100) +
      row("jitter", `${Math.round(stats.jitter)} ms`, stats.jitter > 25) +
      row("buffer", stats.buffered, stats.buffered < 2) +
      row("zoom", scale.toFixed(2), false);
  }

  function setMode(text) { if (el.mode) el.mode.textContent = text; }

  // fps: how smoothly this machine is drawing.
  // ping: round trip to the server.
  // tick: what the server says a tick costs it, against its own budget.
  // Between them these separate three very different causes of "it feels laggy".
  function renderPerf(stats) {
    const box = $("perfBox");
    if (!settings.perf) { box.hidden = true; return; }
    box.hidden = false;
    const slowFps = stats.fps > 0 && stats.fps < 45;
    const slowPing = stats.ping > 120;
    const slowTick = stats.budgetMs > 0 && stats.srvMs > stats.budgetMs * 0.6;
    const html =
      `<div><span class="${slowFps ? "warn" : ""}">${stats.fps || "—"} fps</span></div>` +
      `<div><span class="${slowPing ? "warn" : ""}">${stats.ping >= 0 ? stats.ping + " ms ping" : "— ping"}` +
        `${stats.pingSpread > 30 ? ` <span class="warn">±${stats.pingSpread}</span>` : ""}</span></div>` +
      `<div><span class="${slowTick ? "warn" : ""}">${stats.srvMs >= 0 ? stats.srvMs.toFixed(1) : "—"} / ${stats.budgetMs || "—"} ms tick</span></div>` +
      `<div>${stats.interpMs != null ? stats.interpMs + " ms buffer" : ""}</div>` +
      `<div><span class="${stats.hz && stats.snapsPerSec > 0 && stats.snapsPerSec < stats.hz * 0.85 ? "warn" : ""}">` +
        `${stats.snapsPerSec >= 0 ? stats.snapsPerSec : "—"} / ${stats.hz || "—"} snapshots/s</span></div>`;
    // Rebuilt every frame otherwise, which is five elements torn down and
    // reparsed 60 times a second to show numbers that change once a second.
    if (shown.get(box) === html) return;
    shown.set(box, html);
    box.innerHTML = html;
  }

  // A banner rather than a quiet note: test mode changes the economics and
  // the lobby rules, and mistaking it for production is the failure worth
  // preventing.
  function setTestMode(on) {
    $("testFlag").hidden = !on;
    document.body.classList.toggle("is-test", !!on);
    // Test mode exists to find problems, so the numbers are on by default.
    if (on && !settings.perf) {
      settings.perf = true;
      $("swPerf").setAttribute("aria-checked", "true");
    }
  }

  // ── wager menu ────────────────────────────────────────────────────────────

  function renderAccount() {
    el.bal.innerHTML = `${formatUsdc(account.balance)}<span>USDC</span>`;
    // What this player staked in this game, and nothing else. The escrow can
    // be larger — eating a staked rival transfers their pot to you — but that
    // is winnings, not what you chose to put in.
    el.potValue.textContent = formatUsdc(account.stake || 0);
    el.potBar.hidden = !(account.stake > 0);

    // paintStakes drops an unaffordable selection back to practice itself.
    paintStakes();

    el.badge.hidden = !account.demo;
  }

  function setAccount(next) {
    account = { ...account, ...next };
    renderAccount();
  }

  const stakeButtons = [
    [PRACTICE, () => el.stakeFree],
    [STAKE_1_USDC, () => el.stake1],
    [STAKE_2_USDC, () => el.stake2]
  ];

  // Why a tier cannot be picked, or null if it can. One function so the greyed
  // state and the message a click produces can never disagree.
  function stakeBlockedBy(units) {
    if (units === PRACTICE) return null;
    if (!wagerPossible) return "offline";
    if (!signedIn) return "auth";
    if (account.balance < units) return "funds";
    return null;
  }

  const BLOCK_MESSAGE = {
    offline: "Wagering needs the server. Practice runs in this tab.",
    auth: "Sign in to play for stakes.",
    funds: "Not enough balance for that stake."
  };

  function showStakeNote(reason, quiet = false) {
    if (!reason) { el.stakeNote.hidden = true; return; }
    el.stakeNote.textContent = BLOCK_MESSAGE[reason] || "";
    el.stakeNote.classList.toggle("quiet", quiet);
    el.stakeNote.hidden = false;
  }

  // Clicking a locked tier is the prompt: say what is missing, then put the
  // player in front of the thing that fixes it.
  function promptFor(reason) {
    showStakeNote(reason);
    if (reason !== "auth") return;
    setAuthMode("login");
    el.signedOut.scrollIntoView({ block: "nearest", behavior: "smooth" });
    $("fUser").focus();
  }

  function paintStakes() {
    // Wager tiers only exist once there is an account to charge. Hidden rather
    // than shown locked: a row of greyed buttons is clutter on a screen whose
    // job is to get you signed in.
    const offerTiers = signedIn && wagerPossible;

    for (const [units, get] of stakeButtons) {
      const btn = get();
      if (units === PRACTICE) continue;
      btn.hidden = !offerTiers;
    }

    if (!offerTiers) {
      // Say that stakes exist, so hiding them is not the same as concealing
      // them. Quiet styling: it is information, not a failure.
      showStakeNote(wagerPossible ? "auth" : "offline", true);
      if (stake !== PRACTICE) setStake(PRACTICE);
      return;
    }

    for (const [units, get] of stakeButtons) {
      if (units === PRACTICE) continue;
      const blocked = stakeBlockedBy(units);
      const btn = get();
      // aria-disabled, not disabled: the button must still take the click, or
      // it swallows it and reads as broken.
      btn.setAttribute("aria-disabled", String(!!blocked));
      btn.removeAttribute("disabled");
      const lock = btn.querySelector(".lock");
      if (lock) lock.textContent = "Low balance";
    }
    if (stakeBlockedBy(stake)) setStake(PRACTICE);
    else if (el.stakeNote.classList.contains("quiet")) showStakeNote(null);
  }

  function setStake(units) {
    // Never let a blocked tier become the selection; the server would refuse
    // it anyway and the player would only find out at Start.
    if (stakeBlockedBy(units)) return;
    stake = units;
    if (!el.stakeNote.classList.contains("quiet")) showStakeNote(null);
    for (const [value, get] of stakeButtons) {
      get().setAttribute("aria-checked", String(units === value));
    }
    // The rules panel describes whichever mode is selected, so the lobby size
    // and arena on the left always match the stake chosen on the right.
    const mode = MODES.find(m => m.stake === units);
    if (mode) {
      $("ruleLobby").textContent = `${mode.lobbyMin} players`;
      $("ruleArena").textContent = `${mode.world.size} wide`;
    } else {
      $("ruleLobby").textContent = "bots only";
      $("ruleArena").textContent = "8800 wide";
    }
  }

  for (const [units, get] of stakeButtons) {
    get().addEventListener("click", () => {
      const blocked = stakeBlockedBy(units);
      if (blocked) promptFor(blocked);
      else setStake(units);
    });
  }

  el.ramp.addEventListener("click", () => onRamp?.("deposit"));

  function setRampNote(text) { el.rampNote.textContent = text; }

  // Offline play has no server ledger, so wagering is meaningless there:
  // a client-side balance is just free money.
  // A reason given explicitly always wins, and an empty one clears the note:
  // the menu is rebuilt on every connection change, so a line left over from
  // a previous state — "sign in to wager", to a player who just did — reads
  // as the menu arguing with itself.
  function setWagerAvailable(available, reason) {
    wagerPossible = !!available;
    el.ramp.disabled = !available;
    paintStakes();
    if (reason !== undefined) setRampNote(reason);
  }


  renderAccount();

  // ── accounts ──────────────────────────────────────────────────────────────

  let mode = "login";   // or "signup"

  function setAuthMode(next) {
    mode = next;
    $("tabSignIn").setAttribute("aria-selected", String(next === "login"));
    $("tabSignUp").setAttribute("aria-selected", String(next === "signup"));
    $("fNameWrap").hidden = next !== "signup";
    $("fDobWrap").hidden = next !== "signup";
    $("fPass").setAttribute("autocomplete", next === "signup" ? "new-password" : "current-password");
    $("btnAuth").textContent = next === "signup" ? "Create account" : "Sign in";
    $("authHint").textContent = next === "signup"
      ? `You must be ${MIN_AGE} or over to open an account. Password must be at least 8 ` +
        "characters, and your display name is what appears on your cell."
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
    paintStakes();
  }

  // Google renders its own button, so all we do is reveal the container and
  // hand it over. Hidden entirely when GOOGLE_CLIENT_ID is unset, rather than
  // showing a button that cannot work.
  function showGoogle(on) { $("googleBox").hidden = !on; }

  function setAuthError(text) { $("authError").textContent = text || ""; }

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
    btn.setAttribute("aria-busy", "true");
    btn.textContent = mode === "signup" ? "Creating account…" : "Signing in…";
    try {
      await auth?.[mode === "signup" ? "signup" : "login"](
        $("fUser").value,
        $("fPass").value,
        $("fName").value,
        $("fDob").value
      );
    } catch (e) {
      err.textContent = e.message || "Something went wrong.";
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.textContent = mode === "signup" ? "Create account" : "Sign in";
    }
  }

  $("btnAuth").addEventListener("click", submitAuth);
  for (const id of ["fUser", "fPass", "fName", "fDob"]) {
    $(id).addEventListener("keydown", e => { if (e.key === "Enter") submitAuth(); });
  }

  // Bounds the picker so an ineligible day cannot be chosen in the first
  // place. Cosmetic — a date input's max is trivially bypassed, and the server
  // rejects independently — but it turns a refusal into something the form
  // simply never offers.
  $("fDob").setAttribute("max", latestEligibleDob());

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
    setAuthAvailable, showGoogle, setAuthError, showError, hideError, showStart,
    renderIntermission, setNextReady, showReconnecting, showConnecting, hideReconnecting,
    showRoundEnd, hideRoundEnd, showLobby, hideLobby,
    showSpectator, hideSpectator, setTestMode, renderPerf, renderDiagnostics,
    setReady: v => { iAmReady = v; },
    getStake: () => stake,
    isSignedIn: () => signedIn,
    // The Google button lives outside this form but can still CREATE an
    // account, so the caller has to be able to hand the declared date over
    // with the credential. Empty unless the player is on the signup tab.
    authDob: () => (mode === "signup" ? $("fDob").value : ""),
    focusDob: () => { setAuthMode("signup"); $("fDob").focus(); }
  };
}
