Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz (4 cores), 3 rep(s) x 900 measured ticks after 300 warm-up, dt 0.05.

Current implementation (ms per room tick; total = stepWorld + one snapshot per player)

| Scenario | Players | Pellets | Cells | Total avg | p95 | p99 | Total excl. bot AI | p99 | Snapshots | Pellet grid rebuild | cellCombat | eatPellets | GC % | Heap MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Low population | 10 | 500 | 12 | 0.55 | 1.20 | 2.06 | 0.42 | 1.97 | 0.19 | 0.115 | 0.019 | 0.016 | 9.9 | 13.7 |
| Moderate population | 50 | 1500 | 108 | 2.12 | 3.69 | 5.10 | 1.77 | 4.34 | 1.18 | 0.270 | 0.033 | 0.050 | 3.2 | 22.5 |
| Full lobby | 100 | 3000 | 226 | 6.49 | 10.08 | 13.51 | 4.98 | 10.79 | 3.72 | 0.422 | 0.078 | 0.164 | 3.1 | 23.6 |
| Dense cluster | 100 | 3000 | 155 | 5.30 | 9.08 | 11.79 | 4.56 | 10.51 | 3.54 | 0.423 | 0.061 | 0.108 | 3.1 | 25.9 |
| Stress test | 150 | 5000 | 345 | 13.67 | 21.60 | 27.56 | 10.44 | 21.72 | 8.09 | 0.699 | 0.115 | 0.411 | 4.5 | 26.3 |
| Standard mode (live config) | 100 | 4100 | 238 | 6.58 | 9.88 | 13.11 | 5.41 | 10.82 | 3.99 | 0.473 | 0.083 | 0.181 | 3.1 | 24.3 |
| Very large cells | 100 | 3000 | 259 | 9.05 | 13.23 | 17.36 | 8.00 | 15.20 | 6.55 | 0.422 | 0.085 | 0.197 | 3.7 | 25.2 |
| Rapid split + merge | 100 | 3000 | 490 | 11.05 | 17.00 | 20.99 | 11.05 | 20.99 | 8.42 | 0.483 | 0.144 | 0.493 | 3.0 | 27.2 |
| Ejected-mass storm | 100 | 3000 | 180 | 6.54 | 9.84 | 12.94 | 6.54 | 12.94 | 5.07 | 0.398 | 0.064 | 0.264 | 3.0 | 24.7 |
| Spawn + consume churn | 100 | 3000 | 121 | 4.47 | 7.09 | 9.22 | 4.47 | 9.22 | 3.67 | 0.379 | 0.052 | 0.075 | 3.0 | 24.0 |

Broad / narrow phase per tick (counted build, current implementation)

| Scenario | eat: candidates | eat: narrow tests | eats | combat: pair-loop iterations | combat: sqrt tests | combat eats | virus tests | snapshot pellet candidates | snapshot cell tests | buckets visited |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Low population | 7 | 7 | 0.2 | 1 | 0.4 | 0.00 | 343 | 155 | 120 | 782 |
| Moderate population | 133 | 132 | 1.7 | 4 | 1.0 | 0.12 | 2101 | 2609 | 5385 | 4006 |
| Full lobby | 596 | 591 | 5.0 | 8 | 4.1 | 0.43 | 5185 | 10366 | 22622 | 7411 |
| Dense cluster | 437 | 426 | 6.0 | 13 | 3.5 | 0.33 | 3081 | 10534 | 14401 | 7731 |
| Stress test | 1743 | 1729 | 11.0 | 17 | 8.2 | 0.76 | 9373 | 26117 | 50235 | 11215 |
| Standard mode (live config) | 938 | 930 | 6.9 | 10 | 4.4 | 0.48 | 5765 | 15286 | 23689 | 7823 |
| Very large cells | 836 | 829 | 7.8 | 15 | 8.8 | 0.56 | 10220 | 24968 | 25918 | 21986 |
| Rapid split + merge | 3106 | 2230 | 17.5 | 9 | 7.4 | 1.85 | 17427 | 24030 | 47807 | 19318 |
| Ejected-mass storm | 1570 | 1157 | 10.8 | 4 | 3.3 | 0.56 | 4072 | 19298 | 17528 | 12232 |
| Spawn + consume churn | 313 | 312 | 3.7 | 5 | 5.0 | 1.06 | 1406 | 12536 | 12126 | 8787 |

Grid broad phase for cellCombat (counted build)

| Scenario | naive pair-loop iterations | grid: bucket entries visited | grid: candidate tests | sqrt tests (both) | eats (both) |
|---|---:|---:|---:|---:|---:|
| Low population | 129 | 24 | 1 | 0.4 / 0.4 | 0.00 / 0.00 |
| Moderate population | 11175 | 467 | 4 | 1.0 / 1.0 | 0.12 / 0.12 |
| Full lobby | 50695 | 1080 | 8 | 4.1 / 4.1 | 0.43 / 0.43 |
| Dense cluster | 21292 | 595 | 13 | 3.5 / 3.5 | 0.33 / 0.33 |
| Stress test | 111472 | 1646 | 17 | 8.2 / 8.2 | 0.76 / 0.76 |
| Standard mode (live config) | 55306 | 1159 | 10 | 4.4 / 4.4 | 0.48 / 0.48 |
| Very large cells | 65642 | 1237 | 15 | 8.8 / 8.8 | 0.56 / 0.56 |
| Rapid split + merge | 230213 | 2934 | 9 | 7.4 / 7.4 | 1.85 / 1.85 |
| Ejected-mass storm | 30435 | 648 | 4 | 3.3 / 3.3 | 0.56 / 0.56 |
| Spawn + consume churn | 14520 | 337 | 5 | 5.0 / 5.0 | 1.06 / 1.06 |

Variants (ms per room tick, excluding bot AI; median of reps)

| Scenario | pairs avg / p99 | current avg / p99 | pairs combat | current combat | pairs grid | current grid |
|---|---:|---:|---:|---:|---:|---:|
| Low population | 0.34 / 1.38 | 0.42 / 1.97 | 0.012 | 0.019 | 0.090 | 0.115 |
| Moderate population | 2.06 / 4.52 | 1.77 / 4.34 | 0.225 | 0.033 | 0.300 | 0.270 |
| Full lobby | 6.00 / 11.17 | 4.98 / 10.79 | 0.966 | 0.078 | 0.456 | 0.422 |
| Dense cluster | 4.93 / 11.09 | 4.56 / 10.51 | 0.513 | 0.061 | 0.426 | 0.423 |
| Stress test | 13.42 / 24.85 | 10.44 / 21.72 | 2.315 | 0.115 | 0.755 | 0.699 |
| Standard mode (live config) | 6.95 / 14.41 | 5.41 / 10.82 | 1.054 | 0.083 | 0.523 | 0.473 |
| Very large cells | 8.84 / 16.28 | 8.00 / 15.20 | 1.102 | 0.085 | 0.452 | 0.422 |
| Rapid split + merge | 14.82 / 34.13 | 11.05 / 20.99 | 3.449 | 0.144 | 0.582 | 0.483 |
| Ejected-mass storm | 7.63 / 15.03 | 6.54 / 12.94 | 0.706 | 0.064 | 0.435 | 0.398 |
| Spawn + consume churn | 5.32 / 9.88 | 4.47 / 9.22 | 0.412 | 0.052 | 0.419 | 0.379 |

cellCombat alone (ms per tick, avg / p99 / max; median of reps)

| Scenario | Cells | pairs | current |
|---|---:|---:|---:|
| Low population | 12 | 0.012 / 0.089 / 0.500 | 0.019 / 0.096 / 0.359 |
| Moderate population | 108 | 0.225 / 0.480 / 1.534 | 0.033 / 0.100 / 0.296 |
| Full lobby | 226 | 0.966 / 1.799 / 3.748 | 0.078 / 0.214 / 1.270 |
| Dense cluster | 155 | 0.513 / 1.299 / 4.875 | 0.061 / 0.153 / 0.436 |
| Stress test | 345 | 2.315 / 4.469 / 6.507 | 0.115 / 0.266 / 1.690 |
| Standard mode (live config) | 238 | 1.054 / 2.142 / 4.100 | 0.083 / 0.253 / 0.941 |
| Very large cells | 259 | 1.102 / 2.272 / 2.779 | 0.085 / 0.200 / 1.084 |
| Rapid split + merge | 490 | 3.449 / 7.214 / 16.175 | 0.144 / 0.323 / 1.610 |
| Ejected-mass storm | 180 | 0.706 / 1.811 / 3.452 | 0.064 / 0.225 / 0.804 |
| Spawn + consume churn | 121 | 0.412 / 0.898 / 2.229 | 0.052 / 0.129 / 0.205 |
