Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz (4 cores), 3 rep(s) x 900 measured ticks after 300 warm-up, dt 0.25.

Current implementation (ms per room tick; total = stepWorld + one snapshot per player)

| Scenario | Players | Pellets | Cells | Total avg | p95 | p99 | Total excl. bot AI | p99 | Snapshots | Pellet grid rebuild | cellCombat | eatPellets | GC % | Heap MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Full lobby | 100 | 3000 | 293 | 7.67 | 12.21 | 14.93 | 5.93 | 12.65 | 4.29 | 0.107 | 0.114 | 0.236 | 4.6 | 27.2 |
| Rapid split + merge | 100 | 3000 | 260 | 6.70 | 10.88 | 17.72 | 6.70 | 17.72 | 5.16 | 0.099 | 0.094 | 0.327 | 3.3 | 27.5 |
| Ejected-mass storm | 100 | 3000 | 153 | 4.96 | 8.82 | 10.87 | 4.96 | 10.87 | 3.79 | 0.100 | 0.061 | 0.322 | 3.4 | 27.1 |

Broad / narrow phase per tick (counted build, current implementation)

| Scenario | eat: candidates | eat: narrow tests | eats | combat: pair-loop iterations | combat: sqrt tests | combat eats | virus tests | snapshot pellet candidates | snapshot cell tests | buckets visited |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Full lobby | 1550 | 1487 | 33.8 | 24 | 13.9 | 3.56 | 10449 | 14759 | 29391 | 10925 |
| Rapid split + merge | 2476 | 2319 | 28.0 | 17 | 10.8 | 4.98 | 7188 | 17670 | 27472 | 12560 |
| Ejected-mass storm | 2809 | 2525 | 32.7 | 6 | 4.6 | 1.88 | 5019 | 14033 | 16554 | 10099 |

Grid broad phase for cellCombat (counted build)

| Scenario | naive pair-loop iterations | grid: bucket entries visited | grid: candidate tests | sqrt tests (both) | eats (both) |
|---|---:|---:|---:|---:|---:|

Variants (ms per room tick, excluding bot AI; median of reps)

| Scenario | mapgrid avg / p99 | current avg / p99 | mapgrid combat | current combat | mapgrid grid | current grid |
|---|---:|---:|---:|---:|---:|---:|
| Full lobby | 7.07 / 14.90 | 5.93 / 12.65 | 0.117 | 0.114 | 0.470 | 0.107 |
| Rapid split + merge | 7.70 / 17.21 | 6.70 / 17.72 | 0.092 | 0.094 | 0.434 | 0.099 |
| Ejected-mass storm | 6.18 / 13.97 | 4.96 / 10.87 | 0.060 | 0.061 | 0.456 | 0.100 |

The pellet grid and what queries it (ms per tick, avg; median of reps)

| Scenario | mapgrid: rebuild / snapshots / eatPellets / bot AI | current: rebuild / snapshots / eatPellets / bot AI |
|---|---:|---:|
| Full lobby | 0.470 / 4.90 / 0.305 / 1.88 | 0.107 / 4.29 / 0.236 / 1.73 |
| Rapid split + merge | 0.434 / 5.75 / 0.380 / 0.00 | 0.099 / 5.16 / 0.327 / 0.00 |
| Ejected-mass storm | 0.456 / 4.52 / 0.408 / 0.00 | 0.100 / 3.79 / 0.322 / 0.00 |

cellCombat alone (ms per tick, avg / p99 / max; median of reps)

| Scenario | Cells | mapgrid | current |
|---|---:|---:|---:|
| Full lobby | 293 | 0.117 / 0.268 / 1.110 | 0.114 / 0.232 / 1.208 |
| Rapid split + merge | 260 | 0.092 / 0.197 / 1.137 | 0.094 / 0.205 / 1.067 |
| Ejected-mass storm | 153 | 0.060 / 0.136 / 0.408 | 0.061 / 0.169 / 1.119 |
