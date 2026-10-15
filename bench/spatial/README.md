# Spatial partitioning audit: benchmarks and correctness checks

Supporting material for [`docs/spatial-partitioning-audit.md`](../../docs/spatial-partitioning-audit.md).
Nothing here changes the game. Every run builds patched **copies** of
`shared/sim.js`, `shared/protocol.js` and `shared/codec.js` in a temp directory
(`$SPATIAL_BUILD_DIR`, default `$TMPDIR/petri-spatial-builds`) and imports
those. Each patch is anchored on an exact snippet of the current source, so if
`sim.js` changes underneath them the build throws instead of quietly measuring
something else.

| File | What it does |
|---|---|
| `build.mjs` | Builds the variants: `current` (instrumentation hooks only), `fresh` (index rebuilt after pellets move and after `resetArena`), `csr` (flat counting-sort pellet grid), `gcombat` (uniform-grid broad phase for `cellCombat`, same iteration order as the original), `all` (all three), plus `all-g110` / `all-g440` for a bucket-size sweep. Any variant can also be built `counted`, which adds broad/narrow-phase counters, a brute-force shadow check inside `eatPellets`, and a brute-force reference mode. |
| `scenarios.mjs` | The seeded scenarios from the brief, plus the live Standard config, very large cells, rapid split + merge, an ejected-mass storm and spawn/consume churn. |
| `correctness.mjs` | Deterministic checks against brute-force references, and lockstep tests showing each alternative plays bit-identically to what it replaces. |
| `run-one.mjs` | One timed run of one scenario on one variant, in a fresh process. A tick is `stepWorld` plus one `encodeSnapshot` per player, the same work as `tickRoom` in `server/index.js`. |
| `bench.mjs` | Runs every scenario on every variant, takes medians across repetitions, and prints the tables used in the report. |
| `client-view.mjs`, `client-render.mjs` | Practice-mode view building (Node) and canvas draw cost (headless Chromium via Playwright). |
| `query-bounds.mjs` | Cost of a single grid query against its radius, showing what the unclamped upper bound costs for very large cells. |
| `results/` | Output from the runs quoted in the report. These numbers depend on the machine. |

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
```

`correctness.mjs` exits non-zero when any check fails. On the current code the
expected failures are:

- C2: the index after `resetArena`;
- C3, C4 and C5: moving-pellet staleness;
- C10 and C11: discrete collision steps, on a 250 ms tick and for small split
  pieces at 20 Hz.

Every other check passes, and the `fresh` variant passes C2 to C5.

Timings include the instrumentation hooks that every variant shares: two
`performance.now()` calls around each timed region, about 20–40 µs per tick.
Bot AI is timed on its own and taken out of the "excl. bot AI" figures, because
the live arena is human-only and runs no AI.
