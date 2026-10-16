Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz (4 cores), 3 rep(s) x 900 measured ticks after 300 warm-up, dt 0.05.

Current implementation (ms per room tick; total = stepWorld + one snapshot per player)

| Scenario | Players | Pellets | Cells | Total avg | p95 | p99 | Total excl. bot AI | p99 | Snapshots | Pellet grid rebuild | cellCombat | eatPellets | GC % | Heap MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Low population | 10 | 500 | 12 | 0.45 | 1.01 | 2.09 | 0.31 | 1.35 | 0.18 | 0.021 | 0.023 | 0.014 | 12.7 | 9.8 |
| Moderate population | 50 | 1500 | 108 | 1.75 | 3.55 | 4.87 | 1.40 | 4.32 | 1.05 | 0.047 | 0.033 | 0.043 | 4.5 | 21.8 |
| Full lobby | 100 | 3000 | 226 | 5.08 | 8.50 | 10.61 | 3.96 | 8.79 | 3.09 | 0.093 | 0.080 | 0.132 | 3.3 | 23.7 |
| Dense cluster | 100 | 3000 | 155 | 4.59 | 7.81 | 11.76 | 3.79 | 9.99 | 3.11 | 0.085 | 0.065 | 0.084 | 2.8 | 26.6 |
| Stress test | 150 | 5000 | 345 | 11.45 | 17.01 | 22.10 | 8.44 | 16.87 | 6.70 | 0.194 | 0.112 | 0.319 | 5.3 | 26.9 |
| Standard mode (live config) | 100 | 4100 | 238 | 6.76 | 10.67 | 14.99 | 5.26 | 11.75 | 4.07 | 0.151 | 0.094 | 0.182 | 3.1 | 25.0 |
| Very large cells | 100 | 3000 | 259 | 7.65 | 12.07 | 16.52 | 6.25 | 13.95 | 5.21 | 0.091 | 0.083 | 0.162 | 4.5 | 24.9 |
| Rapid split + merge | 100 | 3000 | 490 | 9.18 | 16.16 | 21.90 | 9.18 | 21.90 | 7.04 | 0.112 | 0.146 | 0.401 | 3.2 | 26.9 |
| Ejected-mass storm | 100 | 3000 | 180 | 5.45 | 8.66 | 10.89 | 5.45 | 10.89 | 4.28 | 0.087 | 0.061 | 0.215 | 3.0 | 25.6 |
| Spawn + consume churn | 100 | 3000 | 121 | 3.71 | 5.66 | 7.08 | 3.71 | 7.08 | 3.22 | 0.074 | 0.051 | 0.069 | 3.2 | 23.9 |

Broad / narrow phase per tick (counted build, current implementation)

| Scenario | eat: candidates | eat: narrow tests | eats | combat: pair-loop iterations | combat: sqrt tests | combat eats | virus tests | snapshot pellet candidates | snapshot cell tests | buckets visited |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Low population | 7 | 7 | 0.2 | 1 | 0.4 | 0.00 | 343 | 155 | 120 | 763 |
| Moderate population | 133 | 132 | 1.7 | 4 | 1.0 | 0.12 | 2101 | 2609 | 5385 | 3829 |
| Full lobby | 596 | 591 | 5.0 | 8 | 4.1 | 0.43 | 5185 | 10366 | 22622 | 7216 |
| Dense cluster | 437 | 426 | 6.0 | 13 | 3.5 | 0.33 | 3081 | 10534 | 14401 | 7619 |
| Stress test | 1743 | 1729 | 11.0 | 17 | 8.2 | 0.76 | 9373 | 26117 | 50235 | 10851 |
| Standard mode (live config) | 938 | 930 | 6.9 | 10 | 4.4 | 0.48 | 5765 | 15286 | 23689 | 7604 |
| Very large cells | 836 | 829 | 7.8 | 15 | 8.8 | 0.56 | 10220 | 24968 | 25918 | 15699 |
| Rapid split + merge | 3106 | 2230 | 17.5 | 9 | 7.4 | 1.85 | 17427 | 24030 | 47807 | 15549 |
| Ejected-mass storm | 1570 | 1157 | 10.8 | 4 | 3.3 | 0.56 | 4072 | 19298 | 17528 | 11617 |
| Spawn + consume churn | 313 | 312 | 3.7 | 5 | 5.0 | 1.06 | 1406 | 12536 | 12126 | 8289 |

Grid broad phase for cellCombat (counted build)

| Scenario | naive pair-loop iterations | grid: bucket entries visited | grid: candidate tests | sqrt tests (both) | eats (both) |
|---|---:|---:|---:|---:|---:|

Variants (ms per room tick, excluding bot AI; median of reps)

| Scenario | mapgrid avg / p99 | current avg / p99 | mapgrid combat | current combat | mapgrid grid | current grid |
|---|---:|---:|---:|---:|---:|---:|
| Low population | 0.38 / 1.78 | 0.31 / 1.35 | 0.021 | 0.023 | 0.103 | 0.021 |
| Moderate population | 1.92 / 4.57 | 1.40 / 4.32 | 0.036 | 0.033 | 0.303 | 0.047 |
| Full lobby | 4.87 / 10.83 | 3.96 / 8.79 | 0.076 | 0.080 | 0.420 | 0.093 |
| Dense cluster | 4.40 / 10.41 | 3.79 / 9.99 | 0.064 | 0.065 | 0.407 | 0.085 |
| Stress test | 9.82 / 20.99 | 8.44 / 16.87 | 0.110 | 0.112 | 0.579 | 0.194 |
| Standard mode (live config) | 5.98 / 12.41 | 5.26 / 11.75 | 0.091 | 0.094 | 0.525 | 0.151 |
| Very large cells | 7.99 / 14.46 | 6.25 / 13.95 | 0.093 | 0.083 | 0.411 | 0.091 |
| Rapid split + merge | 10.16 / 22.97 | 9.18 / 21.90 | 0.138 | 0.146 | 0.439 | 0.112 |
| Ejected-mass storm | 7.27 / 15.16 | 5.45 / 10.89 | 0.067 | 0.061 | 0.422 | 0.087 |
| Spawn + consume churn | 4.67 / 10.35 | 3.71 / 7.08 | 0.053 | 0.051 | 0.398 | 0.074 |

The pellet grid and what queries it (ms per tick, avg; median of reps)

| Scenario | mapgrid: rebuild / snapshots / eatPellets / bot AI | current: rebuild / snapshots / eatPellets / bot AI |
|---|---:|---:|
| Low population | 0.103 / 0.17 / 0.011 / 0.10 | 0.021 / 0.18 / 0.014 / 0.12 |
| Moderate population | 0.303 / 1.28 / 0.059 / 0.38 | 0.047 / 1.05 / 0.043 / 0.35 |
| Full lobby | 0.420 / 3.65 / 0.160 / 1.14 | 0.093 / 3.09 / 0.132 / 1.13 |
| Dense cluster | 0.407 / 3.41 / 0.103 / 0.77 | 0.085 / 3.11 / 0.084 / 0.77 |
| Stress test | 0.579 / 7.71 / 0.402 / 3.08 | 0.194 / 6.70 / 0.319 / 3.01 |
| Standard mode (live config) | 0.525 / 4.44 / 0.198 / 1.35 | 0.151 / 4.07 / 0.182 / 1.30 |
| Very large cells | 0.411 / 6.49 / 0.208 / 1.25 | 0.091 / 5.21 / 0.162 / 1.38 |
| Rapid split + merge | 0.439 / 7.66 / 0.456 / 0.00 | 0.112 / 7.04 / 0.401 / 0.00 |
| Ejected-mass storm | 0.422 / 5.57 / 0.276 / 0.00 | 0.087 / 4.28 / 0.215 / 0.00 |
| Spawn + consume churn | 0.398 / 3.83 / 0.086 / 0.00 | 0.074 / 3.22 / 0.069 / 0.00 |

cellCombat alone (ms per tick, avg / p99 / max; median of reps)

| Scenario | Cells | mapgrid | current |
|---|---:|---:|---:|
| Low population | 12 | 0.021 / 0.097 / 0.704 | 0.023 / 0.143 / 0.465 |
| Moderate population | 108 | 0.036 / 0.125 / 0.592 | 0.033 / 0.093 / 0.706 |
| Full lobby | 226 | 0.076 / 0.207 / 1.223 | 0.080 / 0.201 / 0.890 |
| Dense cluster | 155 | 0.064 / 0.184 / 1.275 | 0.065 / 0.169 / 1.442 |
| Stress test | 345 | 0.110 / 0.244 / 1.370 | 0.112 / 0.248 / 1.560 |
| Standard mode (live config) | 238 | 0.091 / 0.297 / 1.041 | 0.094 / 0.387 / 0.894 |
| Very large cells | 259 | 0.093 / 0.206 / 0.917 | 0.083 / 0.195 / 0.305 |
| Rapid split + merge | 490 | 0.138 / 0.386 / 1.181 | 0.146 / 0.400 / 1.312 |
| Ejected-mass storm | 180 | 0.067 / 0.215 / 0.702 | 0.061 / 0.229 / 0.417 |
| Spawn + consume churn | 121 | 0.053 / 0.123 / 0.503 | 0.051 / 0.134 / 0.564 |
