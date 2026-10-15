Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz (4 cores), 3 rep(s) x 900 measured ticks after 300 warm-up, dt 0.05. Re-run: dense (3 x 300 after 300).

Current implementation (ms per room tick; total = stepWorld + one snapshot per player)

| Scenario | Players | Pellets | Cells | Total avg | p95 | p99 | Total excl. bot AI | p99 | Snapshots | Pellet grid rebuild | cellCombat | eatPellets | GC % | Heap MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|

Broad / narrow phase per tick (counted build, current implementation)

| Scenario | eat: candidates | eat: narrow tests | eats | combat: pair-loop iterations | combat: sqrt tests | combat eats | virus tests | snapshot pellet candidates | snapshot cell tests | buckets visited |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|

Grid broad phase for cellCombat (counted build)

| Scenario | naive pair-loop iterations | grid: bucket entries visited | grid: candidate tests | sqrt tests (both) | eats (both) |
|---|---:|---:|---:|---:|---:|

Variants (ms per room tick, excluding bot AI; median of reps)

| Scenario | all avg / p99 | all-g110 avg / p99 | all-g440 avg / p99 | all combat | all-g110 combat | all-g440 combat | all grid | all-g110 grid | all-g440 grid |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dense | 5.19 / 23.76 | 5.28 / 37.90 | 5.67 / 29.52 | 0.084 | 0.090 | 0.100 | 0.150 | 0.185 | 0.160 |
| standard | 7.07 / 13.83 | 6.67 / 17.25 | 7.51 / 17.61 | 0.136 | 0.126 | 0.142 | 0.329 | 0.333 | 0.314 |
| giants | 8.41 / 16.60 | 9.86 / 18.24 | 9.24 / 19.26 | 0.139 | 0.142 | 0.135 | 0.272 | 0.309 | 0.266 |
| splits | 13.07 / 28.63 | 13.85 / 27.00 | 12.88 / 23.29 | 0.206 | 0.203 | 0.201 | 0.255 | 0.318 | 0.245 |
