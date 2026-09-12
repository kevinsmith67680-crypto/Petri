// ---------------------------------------------------------------------------
// The container image must contain everything the server can serve.
// Run with:  node test/docker.test.js
//
// This exists because the same bug shipped twice. The Dockerfile lists the
// directories to copy, and adding a new one to the repo without adding it here
// is silent: the build succeeds, the page renders, and only the files inside
// the forgotten directory 404. From the outside that looks like a broken link,
// not a packaging fault, so it survived a deploy both times — first assets/,
// which took out the logo and the favicon, then legal/, which took out the
// privacy policy and terms.
//
// Checking the Dockerfile text rather than building an image keeps this in the
// ordinary test run, with no Docker daemon needed.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
const copied = new Set(
  [...dockerfile.matchAll(/^COPY\s+(\S+)/gm)].map(m => m[1].replace(/\/$/, ""))
);

// Anything at the top level the static handler would serve. server/ is refused
// by the handler itself, and the rest are development files that never reach a
// browser, so none of them need to be in the image.
const NOT_SERVED = new Set([
  "server", "node_modules", ".git", ".github", "test", "scripts", "docs",
  "package.json", "package-lock.json", "Dockerfile", "render.yaml",
  "README.md", ".gitignore", ".env.example"
]);

const servableDirs = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter(e => e.isDirectory() && !e.name.startsWith(".") && !NOT_SERVED.has(e.name))
  .map(e => e.name);

console.log("\n-- every servable directory is copied into the image --");
check("found some directories to check", servableDirs.length > 0, servableDirs.join(", "));
for (const dir of servableDirs) {
  check(`Dockerfile copies ${dir}/`, copied.has(dir),
    copied.has(dir) ? "" : `add "COPY ${dir} ./${dir}" to the Dockerfile`);
}

// index.html is the entry point and is copied by name rather than as a folder.
check("Dockerfile copies index.html", copied.has("index.html"));

// Anything index.html references by relative path has to resolve inside the
// image too. A link added to a directory nobody copied is exactly the failure
// this file is here to catch.
console.log("\n-- what index.html links to actually exists --");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:href|src)="\.\/([^"#?]+)/g)]
  .map(m => m[1])
  .filter(r => !r.startsWith("http"));

for (const ref of [...new Set(refs)]) {
  const onDisk = fs.existsSync(path.join(ROOT, ref));
  const top = ref.split("/")[0];
  const inImage = copied.has(top) || copied.has(ref);
  check(`${ref} exists`, onDisk);
  check(`${ref} is in the image`, inImage,
    inImage ? "" : `"${top}" is not copied by the Dockerfile`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
