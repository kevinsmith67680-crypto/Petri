// ---------------------------------------------------------------------------
// Client entry point.
//
// Picks a transport, forwards input to it, and drives the render loop. The
// only difference between offline and online play is which factory runs on
// line ~40; everything below it is identical.
//
//   index.html              -> offline, simulation runs in this tab
//   index.html?mode=online  -> connects to the WebSocket server
// ---------------------------------------------------------------------------

import { createLocalConnection } from "./local.js";
import { createSocketConnection } from "./net.js";
import { createRenderer, THEMES } from "./render.js";
import { createUI } from "./ui.js";
import { SERVER_URL } from "./config.js";
import { PRACTICE } from "../shared/wager.js";
import { MODES } from "../shared/modes.js";
import { PHASE_LOBBY } from "../shared/protocol.js";
import { createAccountClient } from "./account.js";

const params = new URLSearchParams(location.search);
const MODE = params.get("mode") === "online" ? "online" : "local";
const NAME = (params.get("name") || "You").slice(0, 16);

const settings = { theme: "light", map: true, board: true, grid: true, names: true, diag: false };

const canvas = document.getElementById("stage");
const mapCanvas = document.getElementById("minimap");
const renderer = createRenderer(canvas, mapCanvas);

const camera = { x: 1700, y: 1700, scale: renderer.initialScale() };
const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

let conn = null;
let running = false;
let startedAt = 0;
let elapsed = 0;
let best = 0;
let wasAlive = true;
let lastRank = 0;
let lastOf = 0;
let spectating = false;
let lastRunOrbs = 0, lastRunPeak = 0, lastRunEaten = 0;

// Frame rate over a one-second window rather than instantaneously, so the
// number is readable instead of flickering.
let fpsFrames = 0, fpsSince = 0, fps = 0;

// Accounts only exist server-side, so offline play is always a guest.
const api = MODE === "online" ? createAccountClient() : null;

const OFFLINE_AUTH_MSG =
  "Accounts need the server. Open this page with ?mode=online to sign in.";

function reconnect() {
  conn?.close?.();
  conn = connect(ui.getStake());
}

function applyAuth(payload) {
  ui.renderAuth(api?.account || null);
  // Signing in or out changes which transport is correct, so rebuild it.
  reconnect();
  // Career totals live server-side; refresh them whenever identity changes.
  if (api?.signedIn) {
    api.stats().then(r => ui.renderCareer(r.stats)).catch(() => {});
  } else {
    ui.renderCareer(null);
  }
  if (payload) {
    onAccount({
      balance: payload.balance,
      pot: payload.pot,
      staked: payload.staked,
      demo: payload.demo
    });
  }
}

const ui = createUI({
  settings,
  onStart: start,
  // Google bakes its theme in at render time, so the button has to be redrawn
  // or it stays light on a dark menu.
  onThemeChange: () => renderGoogleButton(),
  onRamp: action => conn?.sendRamp(action),
  onSharp: on => renderer.setSharp(on),
  auth: {
    // Every one of these guards `api`, which is null in guest mode. Without
    // the check the click throws "null is not an object" into the console and
    // the user sees nothing at all.
    async login(username, password) {
      if (!api) throw new Error(OFFLINE_AUTH_MSG);
      applyAuth(await api.login(username, password));
    },
    async signup(username, password, displayName) {
      if (!api) throw new Error(OFFLINE_AUTH_MSG);
      applyAuth(await api.signup(username, password, displayName));
    },
    async signOut() {
      await api?.logout();
      // Identity is bound at join time, so the socket has to go with it.
      // applyAuth reconnects, dropping the player back to local bot play.
      applyAuth(null);
    },
    async rename(displayName) {
      if (!api) throw new Error(OFFLINE_AUTH_MSG);
      const payload = await api.setDisplayName(displayName);
      applyAuth(payload);
      // Tell the server to re-read the name so it updates on the live cell
      // without needing a reconnect.
      conn?.sendRename?.();
    }
  }
});

function serverUrl() {
  // Precedence: explicit ?server=, then config.js, then the host that served
  // this page. The last case covers `npm start` and single-box deploys.
  const override = params.get("server") || SERVER_URL;
  if (override) return override;
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
}

function connect(stake = PRACTICE) {
  // Signed-in players join the shared arena. Everyone else runs the same
  // simulation locally against bots. The server enforces this too — this
  // routing is so guests get a working game rather than a rejection.
  if (MODE === "online" && api?.signedIn) {
    const url = serverUrl();
    if (location.protocol === "https:" && url.startsWith("ws://")) {
      ui.setMode("Blocked: an https page cannot open a ws:// socket. Use wss://");
      ui.setWagerAvailable(false, "Wagering needs a wss:// connection to the server.");
      return createLocalConnection({ name: NAME, world: MODES[0].world });
    }
    const socket = createSocketConnection({
      url, name: NAME, stake, token: api?.token || null
    });
    socket.on("event", onEvent);
    socket.on("account", onAccount);
    socket.on("round", onRound);
    socket.on("welcome", w => ui.setTestMode(w.test));
    socket.on("reconnecting", ({ attempt, of }) => {
      // The game keeps its last frame on screen while this runs; it is a
      // pause, not an ending.
      ui.showReconnecting(attempt, of);
      ui.setMode(`Reconnecting… (${attempt} of ${of})`);
    });
    socket.on("reconnected", () => {
      ui.hideReconnecting();
      ui.setMode(`Online at ${url.replace(/^wss?:\/\//, "")}`);
    });
    socket.on("close", ev => {
      ui.hideReconnecting();
      ui.setMode("Disconnected");
      // Another connection took this account over — almost always a second
      // tab. Retrying would only fight it.
      if (ev && ev.code === 4001) {
        ui.showError({
          title: "Playing elsewhere",
          text: "This account opened the game in another tab or window.",
          action: "Play here instead",
          onAction: () => location.reload()
        });
        running = false;
        return;
      }
      // Mid-round, a closed socket means the game has stopped and nothing on
      // screen will ever change again. Say so.
      if (running) {
        ui.showError({
          title: "Disconnected",
          text: "The connection to the server was lost.",
          action: "Reload"
        });
        running = false;
      }
    });
    socket.on("error", () => ui.setMode(`Could not reach ${url}`));
    // Must be set on BOTH paths. The page connects as a guest before the
    // stored session has been validated, so this flag starts false; without
    // clearing it here, signing in reconnects to the server but the menu goes
    // on insisting that wagering needs one.
    ui.setWagerAvailable(true);
    ui.setMode(`Online at ${url.replace(/^wss?:\/\//, "")}`);
    return socket;
  }
  const local = createLocalConnection({
    name: api?.account?.displayName || NAME,
    world: MODES[0].world
  });
  local.on("event", onEvent);
  // Not signed in is not the same as no server. In online mode the server is
  // there and reachable, so wagering stays "possible" and the menu asks for a
  // sign-in; only genuinely offline play reports a missing server.
  ui.setWagerAvailable(MODE === "online", MODE === "online"
    ? "Sign in to play against other people and to wager."
    : "Wagering needs the server. Offline play is practice only.");
  ui.setMode(MODE === "online"
    ? "Practice against bots. Sign in to face other players."
    : "Offline. Add ?mode=online to the URL for accounts and live play.");
  return local;
}

// The orb counter used to ride on its own message type. The snapshot already
// carries the running total, so the client just watches it climb — one fewer
// message on the wire, and it works identically offline and online.
let lastOrbs = 0;
function syncCounter(view) {
  if (view.me.orbs > lastOrbs) ui.bumpCounter();
  lastOrbs = view.me.orbs;
}

function onEvent() { /* reserved for future server-pushed events */ }

// The round ended for everyone at once, so the death card would be wrong here:
// surviving to the whistle is not being eaten.
let ready = false;

function onRound(msg) {
  if (msg.type === "lobby") {
    ui.setTestMode(msg.test);
    // The server broadcasts lobby state on every join and leave, including
    // during a live round. Acting on those would drop a mid-game player back
    // to the lobby overlay because somebody else connected.
    if (msg.phase !== PHASE_LOBBY) return;
    if (spectating) { spectating = false; ui.hideSpectator(); }
    // The lobby overlay replaces the start card: in live mode you do not
    // press Start, you declare yourself ready and wait for the room.
    running = false;
    ui.setReady(ready);
    ui.showLobby(msg);
    return;
  }
  if (msg.type === "round_end") {
    running = false;
    wasAlive = false;
    // Readiness survives the intermission on the server, so the button starts
    // from wherever the player left it rather than silently resetting.
    ui.setNextReady(ready);
    ui.showRoundEnd({
      number: msg.number,
      standings: msg.standings,
      nextIn: msg.nextIn,
      myName: api?.account?.displayName
    });
    if (api?.signedIn) api.stats().then(r => ui.renderCareer(r.stats)).catch(() => {});
  } else if (msg.type === "round_start") {
    if (spectating) { spectating = false; ui.hideSpectator(); }
    ready = false;
    ui.setReady(false);
    ui.hideLobby();
    ui.hideRoundEnd();
    // The server has already respawned us into the fresh arena; just start
    // counting again locally.
    running = true;
    wasAlive = true;
    lastOrbs = 0;
    startedAt = performance.now();
    elapsed = 0;
  }
}

// Every figure shown to the player originates here, from the server ledger.
// Nothing about the balance is computed client-side.
function onAccount(msg) {
  if (msg.type === "account_error") {
    // Always note it in the menu, but if the player has already started the
    // menu is hidden — so put it in front of them instead of leaving a blank
    // arena with an explanation nobody can see.
    ui.setRampNote(msg.reason);
    if (running || msg.code === "stale") {
      const stale = msg.code === "stale";
      ui.showError({
        title: stale ? "Out of date" : "Could not join",
        text: msg.reason,
        action: stale ? "Reload" : "Back to menu",
        onAction: stale ? () => location.reload() : () => { ui.hideError(); ui.showStart(); }
      });
      running = false;
    }
    return;
  }
  if (msg.type === "ramp_result") { ui.setRampNote(msg.reason || "Ramp unavailable."); return; }
  ui.setAccount({
    balance: msg.balance ?? 0,
    pot: msg.pot ?? 0,
    // The server sends this player's own stake. The HUD shows it rather than
    // the escrow, which grows with anything taken from other players.
    stake: msg.stake ?? 0,
    staked: !!msg.staked,
    demo: msg.demo !== false
  });
}

function start() {
  if (spectating) stopSpectating();
  const stake = ui.getStake();
  // A stake is locked at join time, so a wagered run needs a fresh socket.
  // Reusing the old one would let a client re-enter a paid run for free.
  if (!conn || (MODE === "online" && api?.signedIn && stake !== PRACTICE)) {
    conn?.close?.();
    conn = connect(stake);
  } else {
    conn.sendAction("respawn");
  }
  running = true;
  wasAlive = true;
  lastOrbs = 0;
  startedAt = performance.now();
  elapsed = 0;
}

// ── input ───────────────────────────────────────────────────────────────────

const onChrome = e =>
  !!(e.target?.closest?.(".touch, .settings, .gear, .card"));

window.addEventListener("pointermove", e => {
  if (onChrome(e)) return;
  pointer.x = e.clientX; pointer.y = e.clientY;
});

window.addEventListener("pointerdown", e => {
  if (e.pointerType === "touch") document.body.classList.add("is-touch");
  if (onChrome(e)) return;
  pointer.x = e.clientX; pointer.y = e.clientY;
});

window.addEventListener("touchstart",
  () => document.body.classList.add("is-touch"), { once: true, passive: true });

window.addEventListener("keydown", e => {
  if (e.code === "Escape") {
    const panel = document.getElementById("settings");
    if (!panel.hidden) { panel.hidden = true; return; }
  }
  if (!running || !conn) return;
  if (document.activeElement?.classList?.contains("switch")) return;
  if (e.code === "Space") { e.preventDefault(); conn.sendAction("split"); }
  else if (e.code === "KeyW") { e.preventDefault(); conn.sendAction("eject"); }
});

function startSpectating() {
  spectating = true;
  conn?.sendSpectate?.("next");
  ui.showSpectator("");
}

function stopSpectating() {
  spectating = false;
  conn?.sendSpectate?.("off");
  ui.hideSpectator();
}

document.getElementById("btnSpectate").addEventListener("click", startSpectating);
document.getElementById("specNext").addEventListener("click", () => conn?.sendSpectate?.("next"));
document.getElementById("specPrev").addEventListener("click", () => conn?.sendSpectate?.("prev"));
document.getElementById("specLeave").addEventListener("click", () => {
  stopSpectating();
  ui.showDeath({
    orbs: lastRunOrbs, peak: lastRunPeak, eaten: lastRunEaten,
    elapsed, best, rank: lastRank, of: lastOf
  });
});

// Opting in from the standings card. Same message as the lobby button, so
// the server does not care which one was pressed.
document.getElementById("btnNextReady").addEventListener("click", () => {
  ready = !ready;
  ui.setNextReady(ready);
  ui.setReady(ready);
  conn?.sendReady?.(ready);
});

document.getElementById("btnReady").addEventListener("click", () => {
  ready = !ready;
  ui.setReady(ready);
  conn?.sendReady?.(ready);
});

document.getElementById("btnSplit")
  .addEventListener("click", () => running && conn?.sendAction("split"));
document.getElementById("btnFeed")
  .addEventListener("click", () => running && conn?.sendAction("eject"));

window.addEventListener("resize", () => renderer.resize());

// ── loop ────────────────────────────────────────────────────────────────────

let last = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05) || 0;
  last = now;

  const th = THEMES[settings.theme];

  fpsFrames++;
  if (now - fpsSince >= 1000) {
    fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
    fpsFrames = 0;
    fpsSince = now;
  }
  // fps is measured here because only the render loop knows it; everything
  // else comes from the connection.
  if (settings.perf) ui.renderPerf({ fps, ...(conn?.stats?.() || {}) });

  if (conn) {
    // Aim is sent as an offset from our own centroid in world units, which is
    // viewport-independent — the server can read it without knowing anything
    // about this client's screen size or zoom.
    // getView allocates a fresh cell list and pellet array, so it is built
    // ONCE per frame. It used to be called twice — for aim and for render —
    // which doubled the per-frame garbage for no benefit.
    if (running || conn.mode === "online") conn.update(dt);

    const fresh = conn.getView();

    // Aim is measured from the predicted centroid, so it reflects where the
    // cell actually is on screen rather than where the server last said.
    if (fresh && running) {
      const target = renderer.screenToWorld(camera, pointer.x, pointer.y);
      conn.sendAim(target.x - fresh.me.x, target.y - fresh.me.y);
    }

    if (fresh) {
      if (running) elapsed = (now - startedAt) / 1000;
      renderer.follow(camera, fresh, dt);
      // Captured while alive: once you are eaten the snapshot has no standing.
      if (fresh.me.alive && fresh.me.rank) { lastRank = fresh.me.rank; lastOf = fresh.me.of; }
      syncCounter(fresh);
      ui.update(fresh, elapsed, now);

      // Track the run so Leave can restore the death card without asking the
      // server, whose `me` block now describes whoever we are watching.
      if (!spectating && fresh.me.alive) {
        lastRunOrbs = fresh.me.orbs;
        lastRunPeak = fresh.me.peak;
        lastRunEaten = fresh.me.eaten;
      }

      if (spectating) {
        ui.showSpectator(fresh.eyeName);
      }

      if (running && wasAlive && !fresh.me.alive && !spectating) {
        wasAlive = false;
        running = false;
        best = Math.max(best, fresh.me.orbs);
        ui.showDeath({
          orbs: fresh.me.orbs,
          peak: fresh.me.peak,
          eaten: fresh.me.eaten,
          elapsed,
          best,
          rank: lastRank,
          of: lastOf
        });
        // The match has just been written server-side, so re-read the totals.
        if (api?.signedIn) {
          api.stats().then(r => ui.renderCareer(r.stats)).catch(() => {});
        }
      }

      renderer.draw(fresh, camera, th, settings);
      renderer.drawMinimap(fresh, th, settings);
      return;
    }
  }

  renderer.draw(null, camera, th, settings);
}

// Loads Google Identity Services on demand and hands it the button container.
// The script is only fetched when the server says a client id is configured,
// so a deployment without Google pulls nothing from Google at all.
function setupGoogle(clientId) {
  if (!clientId || window.google?.accounts) return;

  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;
  script.onerror = () => ui.showGoogle(false);
  script.onload = () => {
    try {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async ({ credential }) => {
          try {
            // The credential is an ID token. It is worth nothing until the
            // server verifies its signature — nothing here reads its contents.
            applyAuth(await api.google(credential));
          } catch (err) {
            ui.setAuthError(err.message || "Google sign-in failed.");
          }
        }
      });
      renderGoogleButton();
      ui.showGoogle(true);
    } catch {
      ui.showGoogle(false);
    }
  };
  document.head.appendChild(script);
}

// Google's button is an iframe of a fixed pixel width, so it has to be told
// how wide to be. Matching the container keeps it flush with our own
// full-width Sign in button instead of floating narrower in the middle.
function renderGoogleButton() {
  const box = document.getElementById("googleBtn");
  if (!box || !window.google?.accounts?.id) return;
  box.innerHTML = "";
  const width = Math.max(200, Math.min(400, Math.round(box.clientWidth || 320)));
  window.google.accounts.id.renderButton(box, {
    theme: settings.theme === "dark" ? "filled_black" : "outline",
    size: "large",
    shape: "rectangular",
    logo_alignment: "center",
    text: "signin_with",
    width
  });
}

// Validate any stored session before the menu renders, so a returning player
// sees their name rather than a sign-in form that briefly flashes.
if (api) {
  api.restore().then(payload => applyAuth(payload)).catch(() => applyAuth(null));
  api.config()
    .then(cfg => setupGoogle(cfg.googleClientId))
    .catch(() => { /* server unreachable; the password form still works */ });
} else {
  // No server, no accounts: hide the form rather than leaving a button that
  // cannot work.
  ui.setAuthAvailable(false, OFFLINE_AUTH_MSG);
}

// Connect immediately so the arena is visible behind the start card.
conn = connect();
requestAnimationFrame(frame);
