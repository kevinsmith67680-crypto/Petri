// ---------------------------------------------------------------------------
// Regenerate the favicons and touch icon from the brand mark.
//
//   npm start                       # in another shell; the script fetches over HTTP
//   npx playwright install chromium # once, if you have never run Playwright
//   node scripts/icons.mjs
//
// Playwright is not a project dependency — this runs by hand when the artwork
// changes, not in CI. Set CHROMIUM_PATH to use a browser you already have.
//
// Source is assets/mark.png: the mark on its own, with transparency. An
// earlier version of this script cropped the mark out of the full logo, which
// meant finding the boundary between mark and wordmark — they overlap
// vertically, so it took a thinnest-row search plus a walk past the dark tops
// of the letters. None of that is needed now that the mark exists as its own
// file, and none of it can go subtly wrong any more.
// ---------------------------------------------------------------------------

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = process.env.ORIGIN || "http://localhost:8080";
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

// One ground at every size, so the tab, the bookmark and the home screen are
// recognisably the same icon. Opaque rather than transparent: a transparent
// mark takes whatever sits behind it, and iOS renders a transparent touch icon
// black. White because the mark is a saturated violet-to-magenta that holds
// against it in both light and dark browser chrome.
const GROUND = "#ffffff";
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
    i.onerror = () => reject(new Error("could not load assets/mark.png"));
    i.src = `${origin}/assets/mark.png?v=${Date.now()}`;
  });

  const W = img.width, H = img.height;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;

  // Trim the transparent margin, or the mark renders smaller than its box and
  // the icon looks timid next to every other favicon in the tab strip.
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const mw = maxX - minX + 1, mh = maxY - minY + 1;
  if (mw < 1 || mh < 1) throw new Error("mark.png appears to be fully transparent");

  const out = {};
  for (const [size, name] of sizes) {
    const o = document.createElement("canvas");
    o.width = o.height = size;
    const g = o.getContext("2d");
    g.fillStyle = ground;
    g.fillRect(0, 0, size, size);
    g.imageSmoothingQuality = "high";
    const box = size - size * 0.06 * 2;
    const s = Math.min(box / mw, box / mh);
    const dw = mw * s, dh = mh * s;
    g.drawImage(c, minX, minY, mw, mh, (size - dw) / 2, (size - dh) / 2, dw, dh);
    out[name] = o.toDataURL("image/png");
  }
  return { source: [W, H], trimmed: [mw, mh], out };
}, { origin: ORIGIN, ground: GROUND, sizes: SIZES });

for (const [, name] of SIZES) {
  const buf = Buffer.from(shots.out[name].split(",")[1], "base64");
  fs.writeFileSync(path.join(ASSETS, name), buf);
  console.log(`  ${name.padEnd(14)} ${(buf.length / 1024).toFixed(1)}KB`);
}
console.log(`  mark.png ${shots.source.join("x")}, trimmed to ${shots.trimmed.join("x")}`);

await browser.close();
