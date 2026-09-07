// ---------------------------------------------------------------------------
// Rendering.
//
// Reads a "view" — the shape both connection adapters return — and draws it.
// It holds no game state and never mutates what it is given, so it does not
// care whether those numbers came from a local simulation or a socket.
// ---------------------------------------------------------------------------

import { WORLD, radiusOf, EJECT_KEEP, ORB_RADIUS } from "../shared/sim.js";

export const CAMERA_ZOOM = 1.5;   // 1 = original framing, 1.5 = 50% closer in

// How hard the camera chases the cell, as a rate per second. The old value of
// 7 gave a 143ms time constant: prediction made the cell move instantly and
// then the camera put the lag straight back, which is what a player actually
// perceives because they are watching the centre of the screen. 25 is a 40ms
// constant — still smooth, no longer sludge.
const CAMERA_FOLLOW = 25;
// Zoom stays gentle. It changes rarely and a snappy zoom is nauseating.
const CAMERA_ZOOM_RATE = 4;

export const THEMES = {
  light: {
    outside: "#f4f4f2",
    field: "#ffffff",
    edge: "rgba(0,0,0,.16)",
    grid: "rgba(0,0,0,.075)",
    membrane: "rgba(0,0,0,.24)",
    gloss: "rgba(255,255,255,.22)",
    nameFill: "#ffffff",
    nameEdge: "rgba(0,0,0,.34)",
    virusFill: "#6aa84f",
    virusEdge: "#47772f",
    player: "#7a56a8",
    stains: ["#3b6ea5", "#d1493f", "#7a56a8", "#d9779f", "#3f9377", "#d09030", "#5f8f57"]
  },
  dark: {
    outside: "#0d0d0e",
    field: "#1a1b1d",
    edge: "rgba(255,255,255,.14)",
    grid: "rgba(255,255,255,.065)",
    membrane: "rgba(0,0,0,.35)",
    gloss: "rgba(255,255,255,.18)",
    nameFill: "#f6f6f5",
    nameEdge: "rgba(0,0,0,.5)",
    virusFill: "#57a84c",
    virusEdge: "#356f2e",
    player: "#a884e0",
    stains: ["#5b95d6", "#e8695c", "#a884e0", "#ec8fb5", "#4fbf9a", "#e6b04e", "#82c07c"]
  }
};

export function createRenderer(canvas, mapCanvas) {
  // Reused across frames so a busy renderer is not also an allocator. Eight
  // buckets: seven palette slots plus one for the player's own colour.
  const batch = Array.from({ length: 8 }, () => []);
  const bigOrbs = [];
  let lastMapDraw = 0;
  const ctx = canvas.getContext("2d", { alpha: false });
  const mapCtx = mapCanvas.getContext("2d");
  const state = { vw: 0, vh: 0, dpr: 1, mapSize: 132 };

  function resize() {
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.vw = window.innerWidth;
    state.vh = window.innerHeight;
    canvas.width = Math.round(state.vw * state.dpr);
    canvas.height = Math.round(state.vh * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    state.mapSize = mapCanvas.getBoundingClientRect().width || 132;
    mapCanvas.width = Math.round(state.mapSize * state.dpr);
    mapCanvas.height = Math.round(state.mapSize * state.dpr);
    mapCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  }

  const colorOf = (th, ci) => (ci < 0 ? th.player : th.stains[ci % th.stains.length]);

  function drawGrid(th, camera, size) {
    const step = 68;
    const left = camera.x - state.vw / 2 / camera.scale;
    const top = camera.y - state.vh / 2 / camera.scale;
    const right = camera.x + state.vw / 2 / camera.scale;
    const bottom = camera.y + state.vh / 2 / camera.scale;

    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1 / camera.scale;
    ctx.beginPath();
    for (let x = Math.max(0, Math.floor(left / step) * step); x <= Math.min(size, right); x += step) {
      ctx.moveTo(x, Math.max(0, top));
      ctx.lineTo(x, Math.min(size, bottom));
    }
    for (let y = Math.max(0, Math.floor(top / step) * step); y <= Math.min(size, bottom); y += step) {
      ctx.moveTo(Math.max(0, left), y);
      ctx.lineTo(Math.min(size, right), y);
    }
    ctx.stroke();
  }

  function drawCell(th, camera, c, mine, showNames) {
    const r = radiusOf(c.m);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(th, mine ? -1 : c.ci);
    ctx.fill();

    ctx.lineWidth = Math.max(1.2, r * 0.06);
    ctx.strokeStyle = th.membrane;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(c.x - r * 0.17, c.y - r * 0.19, r * 0.27, 0, Math.PI * 2);
    ctx.fillStyle = th.gloss;
    ctx.fill();

    if (c.s) {   // still on rejoin cooldown
      ctx.beginPath();
      ctx.arc(c.x, c.y, r * 0.64, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,.32)";
      ctx.lineWidth = Math.max(1, r * 0.045);
      ctx.stroke();
    }

    if (showNames && c.n && r * camera.scale > 22) {
      const size = Math.max(11, r * 0.4);
      ctx.font = `600 ${size}px Archivo, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = size * 0.18;
      ctx.strokeStyle = th.nameEdge;
      ctx.strokeText(c.n, c.x, c.y);
      ctx.fillStyle = th.nameFill;
      ctx.fillText(c.n, c.x, c.y);
    }
  }

  function drawVirus(th, v, time) {
    const r = radiusOf(110);
    const spikes = 18;
    const spin = time * 0.22;
    ctx.beginPath();
    for (let i = 0; i <= spikes * 2; i++) {
      const ang = (Math.PI * i) / spikes + spin;
      const rad = i % 2 === 0 ? r * 1.1 : r * 0.9;
      const x = v[0] + Math.cos(ang) * rad;
      const y = v[1] + Math.sin(ang) * rad;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = th.virusFill;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = th.virusEdge;
    ctx.stroke();
  }

  function draw(view, camera, th, settings) {
    ctx.fillStyle = th.outside;
    ctx.fillRect(0, 0, state.vw, state.vh);
    if (!view) return;

    ctx.save();
    ctx.translate(state.vw / 2, state.vh / 2);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-camera.x, -camera.y);

    // Arena size comes from the snapshot: rooms differ, and drawing the wrong
    // bounds would put the wall in the wrong place.
    const size = view.world || WORLD;
    ctx.fillStyle = th.field;
    ctx.fillRect(0, 0, size, size);
    if (settings.grid) drawGrid(th, camera, size);
    ctx.lineWidth = 2 / camera.scale;
    ctx.strokeStyle = th.edge;
    ctx.strokeRect(0, 0, size, size);

    // Plain orbs are batched into one path per colour. Drawn individually
    // they were 380 beginPath/fill pairs and 380 fillStyle changes a frame —
    // the single most expensive thing in the renderer, and every one of those
    // fills is a separate rasterisation pass.
    //
    // moveTo before each arc keeps the sub-paths from being joined by a line.
    const ejectR = radiusOf(EJECT_KEEP);
    const byColour = batch;
    for (const arr of byColour) arr.length = 0;

    for (const p of view.pellets) {
      if (p[3]) { bigOrbs.push(p); continue; }     // ejected mass is drawn below
      // Your own ejected mass uses the player colour; slot 7 stands in for it.
      byColour[p[4] ? 7 : (p[2] % 7)].push(p);
    }

    for (let ci = 0; ci < 8; ci++) {
      const group = byColour[ci];
      if (!group.length) continue;
      ctx.fillStyle = colorOf(th, ci === 7 ? -1 : ci);
      ctx.beginPath();
      for (const p of group) {
        ctx.moveTo(p[0] + ORB_RADIUS, p[1]);
        ctx.arc(p[0], p[1], ORB_RADIUS, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // Ejected mass is drawn like a small cell — membrane and gloss — so it
    // reads as projected mass rather than a big orb. There are only ever a
    // handful, so these stay individual.
    for (const p of bigOrbs) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], ejectR, 0, Math.PI * 2);
      ctx.fillStyle = colorOf(th, p[4] ? -1 : p[2]);
      ctx.fill();
      ctx.lineWidth = Math.max(1, ejectR * 0.09);
      ctx.strokeStyle = th.membrane;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p[0] - ejectR * 0.19, p[1] - ejectR * 0.21, ejectR * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = th.gloss;
      ctx.fill();
    }
    bigOrbs.length = 0;

    for (const v of view.viruses) drawVirus(th, v, view.time);

    // Smallest first, so a big cell reads as being on top of what it is about
    // to swallow.
    const cells = view.cells.slice().sort((a, b) => a.m - b.m);
    for (const c of cells) drawCell(th, camera, c, c.o === view.me.id, settings.names);

    ctx.restore();
  }

  // The minimap deliberately shows nothing but you — no orbs, no rivals.
  function drawMinimap(view, th, settings) {
    if (!settings.map) return;
    // It shows one dot on a 132px canvas. Redrawing it 60 times a second buys
    // nothing a player can see.
    const now = performance.now();
    if (now - lastMapDraw < 80) return;
    lastMapDraw = now;
    const s = state.mapSize;
    mapCtx.clearRect(0, 0, s, s);
    if (!view || !view.me.alive) return;

    const k = s / (view.world || WORLD);

    mapCtx.strokeStyle = th.grid;
    mapCtx.lineWidth = 1;
    mapCtx.beginPath();
    for (let i = 1; i < 4; i++) {
      const p = Math.round((s * i) / 4) + 0.5;
      mapCtx.moveTo(p, 0); mapCtx.lineTo(p, s);
      mapCtx.moveTo(0, p); mapCtx.lineTo(s, p);
    }
    mapCtx.stroke();

    mapCtx.fillStyle = th.player;
    for (const c of view.cells) {
      if (c.o !== view.me.id) continue;
      mapCtx.beginPath();
      mapCtx.arc(c.x * k, c.y * k, Math.max(2.2, radiusOf(c.m) * k), 0, Math.PI * 2);
      mapCtx.fill();
    }

    mapCtx.strokeStyle = th.player;
    mapCtx.globalAlpha = 0.4;
    mapCtx.lineWidth = 1;
    mapCtx.beginPath();
    mapCtx.arc(view.me.x * k, view.me.y * k, 8, 0, Math.PI * 2);
    mapCtx.stroke();
    mapCtx.globalAlpha = 1;
  }

  // Camera lives on the client: it is presentation, not simulation.
  function follow(camera, view, dt) {
    if (!view) return;
    const span = radiusOf(Math.max(view.me.mass, 1));
    const fit = Math.min(Math.max(Math.min(state.vw, state.vh) / 820, 0.62), 1.35);
    const target = Math.pow(Math.min(78 / span, 1), 0.42) * fit * CAMERA_ZOOM;
    // Exponential, solved exactly rather than as rate * dt. The linear form
    // drifts with frame rate — a 30fps client chased at a different speed
    // from a 144fps one, which is not something the player should feel.
    const followK = 1 - Math.exp(-CAMERA_FOLLOW * dt);
    const zoomK = 1 - Math.exp(-CAMERA_ZOOM_RATE * dt);
    camera.x += (view.me.x - camera.x) * followK;
    camera.y += (view.me.y - camera.y) * followK;
    camera.scale += (target - camera.scale) * zoomK;
  }

  function initialScale() {
    const fit = Math.min(Math.max(Math.min(state.vw, state.vh) / 820, 0.62), 1.35);
    return fit * CAMERA_ZOOM;
  }

  const screenToWorld = (camera, sx, sy) => ({
    x: camera.x + (sx - state.vw / 2) / camera.scale,
    y: camera.y + (sy - state.vh / 2) / camera.scale
  });

  resize();
  return { resize, draw, drawMinimap, follow, initialScale, screenToWorld, state };
}
