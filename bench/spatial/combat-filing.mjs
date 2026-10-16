// ---------------------------------------------------------------------------
// How much of cellCombat is filing the cells, against searching them.
//
//   node bench/spatial/combat-filing.mjs [--ticks 600]
//
// cellCombat rebuilds its cell grid every tick, at the moment it is used,
// rather than keeping one up to date as cells move, split, merge and die.
// Nearly every cell moves every tick, so a kept grid would re-file most of
// them anyway. This measures what the rebuild costs on the working tree, so
// that choice rests on a number.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// build.mjs reads the revision when it is imported, so set it first.
process.env.SPATIAL_REV = "working";
const { buildVariant } = await import("./build.mjs");
const { setupScenario, SCENARIOS } = await import("./scenarios.mjs");

const argv = process.argv.slice(2);
const TICKS = argv.includes("--ticks") ? Number(argv[argv.indexOf("--ticks") + 1]) : 600;
const WARM = 300;

// The current build, plus a timer around the filing and a count of the
// bucket entries it makes.
const { dir } = buildVariant({ tag: "filing" });
const file = path.join(dir, "sim.js");
let src = fs.readFileSync(file, "utf8");
const patch = (a, b) => {
  if (src.split(a).length !== 2) throw new Error(`combat-filing: anchor ${JSON.stringify(a)}`);
  src = src.replace(a, b);
};
patch("  fileCells(world, ents);\n",
  "  { const __tf = __S.now(); fileCells(world, ents); __S.filing += __S.now() - __tf; }\n");
patch("  for (let k = 0; k < nb; k++) start[k + 1] += start[k];\n",
  "  __S.filed += filed; __S.filedCells += total;\n  for (let k = 0; k < nb; k++) start[k + 1] += start[k];\n");
fs.writeFileSync(file, src);
const sim = await import(pathToFileURL(file).href);
const zero = () => { sim.__S.filing = 0; sim.__S.filed = 0; sim.__S.filedCells = 0; };
zero();

console.log("| Scenario | Cells | cellCombat ms | of which filing ms | filing share | bucket entries per cell |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const key of ["full", "standard", "splits", "giants", "stress", "eject"]) {
  const { world, driver } = setupScenario(sim, key, 1);
  for (let t = 0; t < WARM; t++) { driver.step(world); sim.stepWorld(world, 0.05); }
  zero();
  const c0 = sim.__S.t.combat;
  for (let t = 0; t < TICKS; t++) {
    driver.step(world);
    sim.stepWorld(world, 0.05);
  }
  const combat = sim.__S.t.combat - c0;
  const cells = sim.__S.filedCells;
  console.log(`| ${SCENARIOS[key].label} | ${(cells / TICKS).toFixed(0)} | ${(combat / TICKS).toFixed(3)} | ` +
    `${(sim.__S.filing / TICKS).toFixed(3)} | ${(100 * sim.__S.filing / combat).toFixed(0)}% | ${(sim.__S.filed / cells).toFixed(2)} |`);
}
