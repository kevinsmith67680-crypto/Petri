// ---------------------------------------------------------------------------
// Practice mode (client/local.js) view cost, measured in Node.
//
//   node --expose-gc bench/spatial/client-view.mjs
//
// The practice tab runs the whole simulation and hands the renderer every
// orb in the arena each frame. This measures getView() and counts how many of
// those orbs fall inside a 1920x1080 screen at the camera scale render.js
// would use. Canvas drawing itself needs a browser and is not measured here.
// ---------------------------------------------------------------------------

import { performance } from "node:perf_hooks";
import { createLocalConnection } from "../../client/local.js";
import { MODES } from "../../shared/modes.js";
import { radiusOf } from "../../shared/sim.js";

const conn = createLocalConnection({ name: "me", seed: 7, world: MODES[0].world, bots: 14 });
const FRAMES = 1200;
const VW = 1920, VH = 1080, CAMERA_ZOOM = 1.5;

for (let i = 0; i < 300; i++) { conn.update(1 / 60); conn.getView(); }
globalThis.gc?.();

let viewMs = 0, stepMs = 0, sent = 0, onScreen = 0, frames = 0;
for (let i = 0; i < FRAMES; i++) {
  const t0 = performance.now();
  conn.update(1 / 60);
  const t1 = performance.now();
  const v = conn.getView();
  const t2 = performance.now();
  stepMs += t1 - t0; viewMs += t2 - t1;
  // The camera scale render.js converges on (follow()).
  const span = radiusOf(Math.max(v.me.mass, 1));
  const fit = Math.min(Math.max(Math.min(VW, VH) / 820, 0.62), 1.35);
  const scale = Math.pow(Math.min(78 / span, 1), 0.42) * fit * CAMERA_ZOOM;
  const hw = VW / 2 / scale + 6, hh = VH / 2 / scale + 6;
  sent += v.pellets.length;
  for (const p of v.pellets) if (Math.abs(p[0] - v.me.x) < hw && Math.abs(p[1] - v.me.y) < hh) onScreen++;
  frames++;
}

console.log(JSON.stringify({
  frames,
  stepMsPerFrame: stepMs / frames,
  getViewMsPerFrame: viewMs / frames,
  pelletsHandedToRendererPerFrame: sent / frames,
  pelletsOnScreenPerFrame: onScreen / frames,
  pctOnScreen: (100 * onScreen) / sent
}, null, 2));
