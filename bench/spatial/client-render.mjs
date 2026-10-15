// ---------------------------------------------------------------------------
// Canvas cost of drawing every orb vs only the on-screen ones, in headless
// Chromium via Playwright. Indicative only: headless raster is software and
// differs from a player's GPU.
//
//   node bench/spatial/client-render.mjs      (needs `playwright` resolvable)
// ---------------------------------------------------------------------------

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./build.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); }
catch { ({ chromium } = require(path.join(process.env.NODE_PATH || "/opt/node-tools/node_modules", "playwright"))); }

const types = { ".js": "text/javascript", ".html": "text/html" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/bench.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><canvas id=c></canvas><canvas id=m width=132 height=132></canvas>`);
    return;
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://127.0.0.1:${port}/bench.html`);
const out = await page.evaluate(async () => {
  const { createRenderer, THEMES } = await import("/client/render.js");
  const { createWorld } = await import("/shared/sim.js");
  const r = createRenderer(document.getElementById("c"), document.getElementById("m"));
  const w = createWorld(7);
  const me = { id: "me", ci: 0, mass: 60, x: 4400, y: 4400 };
  const camera = { x: 4400, y: 4400, scale: r.initialScale() };
  const all = w.pellets.map(p => [p.x, p.y, p.ci, 0, 0]);
  const hw = 1920 / 2 / camera.scale + 6, hh = 1080 / 2 / camera.scale + 6;
  const culled = all.filter(p => Math.abs(p[0] - me.x) < hw && Math.abs(p[1] - me.y) < hh);
  const cells = [{ i: 1, x: 4400, y: 4400, m: 60, o: "me", ci: 0, n: "me", s: 0 }];
  const viruses = w.viruses.map(v => [v.x, v.y, 0, v.vid]);
  const settings = { grid: true, names: true, map: false };
  const ctx = document.getElementById("c").getContext("2d");
  const time = pellets => {
    const view = { time: 0, world: 8800, cells, pellets, viruses, me };
    for (let i = 0; i < 30; i++) r.draw(view, camera, THEMES.light, settings);
    ctx.getImageData(0, 0, 1, 1);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) { r.draw(view, camera, THEMES.light, settings); ctx.getImageData(0, 0, 1, 1); }
    return (performance.now() - t0) / 200;
  };
  return { allPellets: all.length, onScreen: culled.length, msAll: time(all), msCulled: time(culled) };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
