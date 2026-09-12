// ---------------------------------------------------------------------------
// Regenerate the favicons and touch icon from the header logo.
//
//   npm start                       # in another shell; the script fetches over HTTP
//   npx playwright install chromium # once, if you have never run Playwright
//   node scripts/icons.mjs
//
// Playwright is not a project dependency — this runs by hand when the artwork
// changes, not in CI. Set CHROMIUM_PATH to use a browser you already have.
//
// The icons are CROPPED FROM assets/logo-light.png rather than drawn, so the
// tab and the header cannot drift apart. Locating the mark is the whole trick:
// there is no blank band between mark and wordmark — the lowest orb sits
// beside the tallest letters — so a fixed crop box would clip one or include
// the other. Instead the cut is the thinnest row between them, then walked up
// past any row that is predominantly dark, because the wordmark is near-black
// where the mark's lower edge is bright pink. Without that second step the
// tops of the letters show up as a smudge under the mark.
// ---------------------------------------------------------------------------

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = process.env.ORIGIN || "http://localhost:8080";
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

// One ground for every size, so the tab, the bookmark and the home screen are
// recognisably the same icon. Opaque rather than transparent: a tab is light
// in one theme and dark in the other, and a transparent mark that reads on one
// disappears into the other. iOS also renders a transparent touch icon black.
const GROUND = "#12101f";
const SIZES = [[16, "icon-16.png"], [32, "icon-32.png"], [180, "icon-180.png"]];

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const page = await browser.newPage();
await page.goto(ORIGIN);   // same-origin, or the canvas is tainted and unreadable

const shots = await page.evaluate(async ({ origin, ground, sizes }) => {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("could not load assets/logo-light.png"));
    i.src = `${origin}/assets/logo-light.png?v=${Date.now()}`;
  });

  const W = img.width, H = img.height;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;

  const ink = [];
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 100) n++;
    ink.push(n);
  }

  let top = 0;
  while (top < H && ink[top] === 0) top++;

  let bottom = Math.round(H * 0.6), fewest = Infinity;
  for (let y = Math.round(H * 0.4); y < Math.round(H * 0.8); y++) {
    if (ink[y] < fewest) { fewest = ink[y]; bottom = y; }
  }

  const rowMostlyDark = y => {
    let dark = 0, total = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] <= 100) continue;
      total++;
      if (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 70) dark++;
    }
    return total > 0 && dark / total > 0.6;
  };
  while (bottom > top && rowMostlyDark(bottom - 1)) bottom--;

  let left = W, right = -1;
  for (let y = top; y < bottom; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 24) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  const mw = right - left + 1, mh = bottom - top;
  if (mw < 1 || mh < 1) throw new Error("found no mark in the logo");

  const out = {};
  for (const [size, name] of sizes) {
    const o = document.createElement("canvas");
    o.width = o.height = size;
    const g = o.getContext("2d");
    g.fillStyle = ground;
    g.fillRect(0, 0, size, size);
    g.imageSmoothingQuality = "high";
    const box = size - size * 0.08 * 2;
    const s = Math.min(box / mw, box / mh);
    const dw = mw * s, dh = mh * s;
    g.drawImage(c, left, top, mw, mh, (size - dw) / 2, (size - dh) / 2, dw, dh);
    out[name] = o.toDataURL("image/png");
  }
  return { markBox: [mw, mh], out };
}, { origin: ORIGIN, ground: GROUND, sizes: SIZES });

for (const [, name] of SIZES) {
  const buf = Buffer.from(shots.out[name].split(",")[1], "base64");
  fs.writeFileSync(path.join(ASSETS, name), buf);
  console.log(`  ${name.padEnd(14)} ${(buf.length / 1024).toFixed(1)}KB`);
}
console.log(`  mark cropped from the logo at ${shots.markBox.join("x")}`);

await browser.close();
