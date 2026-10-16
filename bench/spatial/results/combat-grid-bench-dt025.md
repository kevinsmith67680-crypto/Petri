Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz (4 cores), 3 rep(s) x 900 measured ticks after 300 warm-up, dt 0.25.

Current implementation (ms per room tick; total = stepWorld + one snapshot per player)

| Scenario | Players | Pellets | Cells | Total avg | p95 | p99 | Total excl. bot AI | p99 | Snapshots | Pellet grid rebuild | cellCombat | eatPellets | GC % | Heap MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Full lobby | 100 | 3000 | 293 | 8.83 | 13.43 | 17.89 | 7.03 | 14.65 | 4.89 | 0.468 | 0.117 | 0.303 | 4.5 | 27.3 |
| Very large cells | 100 | 3000 | 277 | 9.00 | 13.28 | 18.85 | 7.53 | 16.20 | 5.60 | 0.388 | 0.100 | 0.267 | 3.4 | 29.4 |
| Rapid split + merge | 100 | 3000 | 260 | 7.73 | 12.58 | 17.20 | 7.73 | 17.20 | 5.75 | 0.427 | 0.095 | 0.385 | 3.1 | 29.2 |

Broad / narrow phase per tick (counted build, current implementation)

| Scenario | eat: candidates | eat: narrow tests | eats | combat: pair-loop iterations | combat: sqrt tests | combat eats | virus tests | snapshot pellet candidates | snapshot cell tests | buckets visited |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Full lobby | 1550 | 1487 | 33.8 | 24 | 13.9 | 3.56 | 10449 | 14759 | 29391 | 11318 |
| Very large cells | 1746 | 1680 | 38.9 | 23 | 14.7 | 3.50 | 11542 | 21835 | 28918 | 18023 |
| Rapid split + merge | 2476 | 2319 | 28.0 | 17 | 10.8 | 4.98 | 7188 | 17670 | 27472 | 16436 |

Grid broad phase for cellCombat (counted build)

| Scenario | naive pair-loop iterations | grid: bucket entries visited | grid: candidate tests | sqrt tests (both) | eats (both) |
|---|---:|---:|---:|---:|---:|
| Full lobby | 86342 | 2557 | 24 | 13.9 / 13.9 | 3.56 / 3.56 |
| Very large cells | 83278 | 2350 | 23 | 14.7 / 14.7 | 3.50 / 3.50 |
| Rapid split + merge | 74885 | 1909 | 17 | 10.8 / 10.8 | 4.98 / 4.98 |

Variants (ms per room tick, excluding bot AI; median of reps)

| Scenario | pairs avg / p99 | current avg / p99 | pairs combat | current combat | pairs grid | current grid |
|---|---:|---:|---:|---:|---:|---:|
| Full lobby | 9.52 / 17.52 | 7.03 / 14.65 | 1.670 | 0.117 | 0.581 | 0.468 |
| Very large cells | 10.56 / 19.79 | 7.53 / 16.20 | 1.443 | 0.100 | 0.506 | 0.388 |
| Rapid split + merge | 8.72 / 17.63 | 7.73 / 17.20 | 1.203 | 0.095 | 0.462 | 0.427 |

cellCombat alone (ms per tick, avg / p99 / max; median of reps)

| Scenario | Cells | pairs | current |
|---|---:|---:|---:|
| Full lobby | 293 | 1.670 / 3.193 / 6.888 | 0.117 / 0.262 / 2.839 |
| Very large cells | 277 | 1.443 / 2.753 / 3.820 | 0.100 / 0.207 / 1.093 |
| Rapid split + merge | 260 | 1.203 / 2.653 / 5.052 | 0.095 / 0.235 / 2.470 |
