# Spatial partitioning audit: benchmarks and correctness checks

Supporting material for [`docs/spatial-partitioning-audit.md`](../../docs/spatial-partitioning-audit.md).
Nothing here changes the game. Every run builds patched **copies** of
`shared/sim.js`, `shared/protocol.js` and `shared/codec.js` in a temp directory
(`$SPATIAL_BUILD_DIR`, default `$TMPDIR/petri-spatial-builds`) and imports
those.

The copies are read from git at the audited revision, `d93f567`, not from the
working tree. Each patch is anchored on an exact snippet of that source, and
the branch has since changed `sim.js` enough that the anchors no longer match
the head. `SPATIAL_REV=<rev>` selects another revision and
`SPATIAL_REV=working` the working tree; a build throws, rather than quietly
measuring something else, if an anchor is missing.

`head-check.mjs` needs no patches. It reruns the B1/B2 reproductions and a
Standard-config timing against unpatched modules at any revision, so it keeps
working as the code moves.

| File | What it does |
|---|---|
| `build.mjs` | Builds the variants: `current` (instrumentation hooks only), `fresh` (index rebuilt after pellets move and after `resetArena`), `csr` (flat counting-sort pellet grid), `gcombat` (uniform-grid broad phase for `cellCombat`, same iteration order as the original: the prototype for what now ships), `pairs` (the reverse, for revisions that ship the grid: `cellCombat` put back to the all-pairs loop, verbatim from `a44cad8`), `all` (fresh + csr + gcombat), plus `all-g110` / `all-g440` for a bucket-size sweep. Any variant can also be built `counted`, which adds broad/narrow-phase counters, a brute-force shadow check inside `eatPellets`, and a brute-force reference mode. |
| `scenarios.mjs` | The seeded scenarios from the brief, plus the live Standard config, very large cells, rapid split + merge, an ejected-mass storm and spawn/consume churn. |
| `correctness.mjs` | Deterministic checks against brute-force references, and lockstep tests showing each alternative plays bit-identically to what it replaces. |
| `run-one.mjs` | One timed run of one scenario on one variant, in a fresh process. A tick is `stepWorld` plus one `encodeSnapshot` per player, the same work as `tickRoom` in `server/index.js`. |
| `bench.mjs` | Runs every scenario on every variant, takes medians across repetitions, and prints the tables used in the report. |
| `client-view.mjs`, `client-render.mjs` | Practice-mode view building (Node) and canvas draw cost (headless Chromium via Playwright). These two use the working-tree client; the report's figures were taken at `d93f567`. |
| `head-check.mjs` | B1/B2 reproductions and a Standard-config timing on unpatched modules: the working tree, or `--rev <rev>`. |
| `combat-filing.mjs` | How much of `cellCombat` goes on rebuilding its cell grid each tick, on the working tree. |
| `sweep-combat-cost.mjs` | `cellCombat`'s pair loop with and without the swept test, on identical frozen states. Whole games diverge once the sweep catches something, so they cannot compare it fairly. |
| `query-bounds.mjs` | Cost of a single grid query against its radius, showing what the unclamped upper bound costs for very large cells. |
| `results/` | Output from the runs quoted in the report. `b1-fix-perf.*` and `correctness-b1-fix.*` cover the B1 fix; `r1-*`, `sweep-combat-cost.txt` and `correctness-r1-fix.*` cover R1; `combat-grid-*` and `correctness-combat-grid.*` cover the `cellCombat` grid (H-1). These numbers depend on the machine. |

## Run

```sh
node bench/spatial/correctness.mjs                 # ~25 min; --quick for ~6 min
node bench/spatial/bench.mjs --out bench/spatial/results/bench.json   # ~45 min
node bench/spatial/bench.mjs --quick               # 1 rep, 200 ticks
node --expose-gc bench/spatial/run-one.mjs full current --ticks 900
node --expose-gc bench/spatial/run-one.mjs splits gcombat --counted
node --expose-gc bench/spatial/client-view.mjs
node bench/spatial/client-render.mjs               # needs playwright
node bench/spatial/query-bounds.mjs
node --expose-gc bench/spatial/head-check.mjs       # or --rev d93f567
node bench/spatial/sweep-combat-cost.mjs
node bench/spatial/combat-filing.mjs
# the shipped grid against the all-pairs loop it replaced
SPATIAL_REV=working node bench/spatial/bench.mjs --variants pairs,current --scenarios full,standard,splits
```

`correctness.mjs` exits non-zero when any check fails, and prints the
revision it ran against.

- **At `d93f567`, the audited revision (the default):** the expected failures
  are C2 (the index after `resetArena`), C3/C4/C5 (moving-pellet staleness,
  B1) and C10/C11 (discrete collision steps). The `fresh` variant passes C2 to
  C5.
- **On the working tree (`SPATIAL_REV=working`), with B1, B2 and R1 fixed and
  the `cellCombat` grid shipped:** nothing fails. The `csr` and `gcombat`
  checks are skipped. `csr` predates incremental `gridInsert`, and
  `gcombat` is superseded by the grid that shipped; both refuse to build
  rather than measure a different game. `pairs` builds instead, and the E
  checks play it against `current` tick for tick.

Results are in `results/correctness.txt` (d93f567),
`results/correctness-b1-fix.txt`, `results/correctness-r1-fix.txt` and
`results/correctness-combat-grid.txt`.

The `counted` build replaces `eatPellets` with an instrumented copy. For
revisions with the swept tests it mirrors production line for line, and the
E check "the instrumented build plays identically to the plain one" fails if
it ever drifts.

Timings include the instrumentation hooks that every variant shares: two
`performance.now()` calls around each timed region, about 20–40 µs per tick.
Bot AI is timed on its own and taken out of the "excl. bot AI" figures, because
the live arena is human-only and runs no AI.
