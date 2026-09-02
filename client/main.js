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

const params = new URLSearchParams(location.search);
const MODE = params.get("mode") === "online" ? "online" : "local";
const NAME = (params.get("name") || "You").slice(0, 16);

const settings = { theme: "light", map: true, board: true, grid: true, names: true };

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

const ui = createUI({
  settings,
  onStart: start,
  onThemeChange: () => {}
});

function serverUrl() {
  // Precedence: explicit ?server=, then config.js, then the host that served
  // this page. The last case covers `npm start` and single-box deploys.
  const override = params.get("server") || SERVER_URL;
  if (override) return override;
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
}

function connect() {
  if (MODE === "online") {
    const url = serverUrl();
    if (location.protocol === "https:" && url.startsWith("ws://")) {
      ui.setMode("Blocked: an https page cannot open a ws:// socket. Use wss://");
      return createLocalConnection({ name: NAME });
    }
    const socket = createSocketConnection({ url, name: NAME });
    socket.on("event", onEvent);
    socket.on("close", () => ui.setMode("Disconnected"));
    socket.on("error", () => ui.setMode(`Could not reach ${url}`));
    ui.setMode(`Online at ${url.replace(/^wss?:\/\//, "")}`);
    return socket;
  }
  const local = createLocalConnection({ name: NAME });
  local.on("event", onEvent);
  ui.setMode("Offline, simulation running in this tab");
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

function start() {
  if (!conn) conn = connect();
  else conn.sendAction("respawn");
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

  if (conn) {
    // Aim is sent as an offset from our own centroid in world units, which is
    // viewport-independent — the server can read it without knowing anything
    // about this client's screen size or zoom.
    const target = renderer.screenToWorld(camera, pointer.x, pointer.y);
    const view = conn.getView();
    if (view && running) conn.sendAim(target.x - view.me.x, target.y - view.me.y);

    // Offline, the loop is the simulation, so pausing it holds the arena still
    // behind the start card. Online, the server ticks regardless of us.
    if (running || conn.mode === "online") conn.update(dt);

    const fresh = conn.getView();
    if (fresh) {
      if (running) elapsed = (now - startedAt) / 1000;
      renderer.follow(camera, fresh, dt);
      syncCounter(fresh);
      ui.update(fresh, elapsed, now);

      if (running && wasAlive && !fresh.me.alive) {
        wasAlive = false;
        running = false;
        best = Math.max(best, fresh.me.orbs);
        ui.showDeath({
          orbs: fresh.me.orbs,
          peak: fresh.me.peak,
          eaten: fresh.me.eaten,
          elapsed,
          best
        });
      }

      renderer.draw(fresh, camera, th, settings);
      renderer.drawMinimap(fresh, th, settings);
      return;
    }
  }

  renderer.draw(null, camera, th, settings);
}

// Connect immediately so the arena is visible behind the start card.
conn = connect();
requestAnimationFrame(frame);
