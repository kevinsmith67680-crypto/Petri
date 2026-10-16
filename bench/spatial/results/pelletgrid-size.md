Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz (4 cores), 3 rep(s) x 900 measured ticks after 300 warm-up, dt 0.05.

Current implementation (ms per room tick; total = stepWorld + one snapshot per player)

| Scenario | Players | Pellets | Cells | Total avg | p95 | p99 | Total excl. bot AI | p99 | Snapshots | Pellet grid rebuild | cellCombat | eatPellets | GC % | Heap MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Full lobby | 100 | 3000 | 226 | 5.41 | 8.60 | 10.80 | 4.21 | 9.41 | 3.29 | 0.103 | 0.076 | 0.134 | 2.8 | 23.2 |
| Dense cluster | 100 | 3000 | 155 | 4.44 | 6.43 | 9.98 | 3.57 | 8.45 | 2.96 | 0.083 | 0.059 | 0.078 | 3.3 | 26.6 |
| Standard mode (live config) | 100 | 4100 | 238 | 6.90 | 11.00 | 14.57 | 5.40 | 12.74 | 4.16 | 0.160 | 0.093 | 0.194 | 3.0 | 24.1 |
| Very large cells | 100 | 3000 | 259 | 8.02 | 12.35 | 16.48 | 6.57 | 14.17 | 5.45 | 0.105 | 0.089 | 0.177 | 4.7 | 24.7 |
| Rapid split + merge | 100 | 3000 | 490 | 9.16 | 14.62 | 20.79 | 9.16 | 20.79 | 6.99 | 0.113 | 0.139 | 0.408 | 3.5 | 26.8 |
| Ejected-mass storm | 100 | 3000 | 180 | 5.50 | 9.07 | 11.65 | 5.50 | 11.65 | 4.36 | 0.089 | 0.063 | 0.220 | 3.2 | 25.6 |

Broad / narrow phase per tick (counted build, current implementation)

| Scenario | eat: candidates | eat: narrow tests | eats | combat: pair-loop iterations | combat: sqrt tests | combat eats | virus tests | snapshot pellet candidates | snapshot cell tests | buckets visited |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Full lobby | 596 | 591 | 5.0 | 8 | 4.1 | 0.43 | 5185 | 10366 | 22622 | 7216 |
| Dense cluster | 437 | 426 | 6.0 | 13 | 3.5 | 0.33 | 3081 | 10534 | 14401 | 7619 |
| Standard mode (live config) | 938 | 930 | 6.9 | 10 | 4.4 | 0.48 | 5765 | 15286 | 23689 | 7604 |
| Very large cells | 836 | 829 | 7.8 | 15 | 8.8 | 0.56 | 10220 | 24968 | 25918 | 15699 |
| Rapid split + merge | 3106 | 2230 | 17.5 | 9 | 7.4 | 1.85 | 17427 | 24030 | 47807 | 15549 |
| Ejected-mass storm | 1570 | 1157 | 10.8 | 4 | 3.3 | 0.56 | 4072 | 19298 | 17528 | 11617 |

Grid broad phase for cellCombat (counted build)

| Scenario | naive pair-loop iterations | grid: bucket entries visited | grid: candidate tests | sqrt tests (both) | eats (both) |
|---|---:|---:|---:|---:|---:|

Variants (ms per room tick, excluding bot AI; median of reps)

| Scenario | current avg / p99 | g110 avg / p99 | g165 avg / p99 | g330 avg / p99 | g440 avg / p99 | current combat | g110 combat | g165 combat | g330 combat | g440 combat | current grid | g110 grid | g165 grid | g330 grid | g440 grid |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Full lobby | 4.21 / 9.41 | 4.67 / 9.86 | 4.66 / 10.02 | 4.04 / 9.59 | 4.41 / 11.43 | 0.076 | 0.085 | 0.085 | 0.083 | 0.083 | 0.103 | 0.126 | 0.111 | 0.087 | 0.102 |
| Dense cluster | 3.57 / 8.45 | 4.16 / 13.35 | 4.01 / 9.61 | 4.15 / 13.29 | 4.11 / 10.51 | 0.059 | 0.066 | 0.064 | 0.072 | 0.072 | 0.083 | 0.106 | 0.091 | 0.088 | 0.087 |
| Standard mode (live config) | 5.40 / 12.74 | 5.67 / 12.57 | 5.10 / 11.04 | 4.52 / 10.20 | 4.70 / 10.19 | 0.093 | 0.087 | 0.083 | 0.083 | 0.084 | 0.160 | 0.181 | 0.144 | 0.125 | 0.109 |
| Very large cells | 6.57 / 14.17 | 7.08 / 14.17 | 7.69 / 15.33 | 6.38 / 12.28 | 6.68 / 13.64 | 0.089 | 0.082 | 0.092 | 0.085 | 0.089 | 0.105 | 0.112 | 0.126 | 0.096 | 0.105 |
| Rapid split + merge | 9.16 / 20.79 | 9.91 / 21.58 | 9.56 / 21.07 | 9.03 / 19.48 | 9.02 / 18.59 | 0.139 | 0.142 | 0.144 | 0.142 | 0.140 | 0.113 | 0.134 | 0.126 | 0.105 | 0.106 |
| Ejected-mass storm | 5.50 / 11.65 | 5.58 / 12.03 | 6.16 / 13.19 | 5.22 / 9.59 | 5.84 / 12.26 | 0.063 | 0.063 | 0.072 | 0.059 | 0.068 | 0.089 | 0.099 | 0.103 | 0.085 | 0.090 |

The pellet grid and what queries it (ms per tick, avg; median of reps)

| Scenario | current: rebuild / snapshots / eatPellets / bot AI | g110: rebuild / snapshots / eatPellets / bot AI | g165: rebuild / snapshots / eatPellets / bot AI | g330: rebuild / snapshots / eatPellets / bot AI | g440: rebuild / snapshots / eatPellets / bot AI |
|---|---:|---:|---:|---:|---:|
| Full lobby | 0.103 / 3.29 / 0.134 / 1.05 | 0.126 / 3.71 / 0.120 / 1.12 | 0.111 / 3.64 / 0.134 / 1.13 | 0.087 / 3.13 / 0.169 / 1.04 | 0.102 / 3.34 / 0.256 / 1.12 |
| Dense cluster | 0.083 / 2.96 / 0.078 / 0.93 | 0.106 / 3.40 / 0.082 / 0.95 | 0.091 / 3.27 / 0.082 / 0.94 | 0.088 / 3.34 / 0.110 / 0.91 | 0.087 / 3.37 / 0.133 / 0.87 |
| Standard mode (live config) | 0.160 / 4.16 / 0.194 / 1.27 | 0.181 / 4.42 / 0.143 / 1.22 | 0.144 / 3.96 / 0.142 / 1.14 | 0.125 / 3.45 / 0.208 / 1.13 | 0.109 / 3.56 / 0.285 / 1.12 |
| Very large cells | 0.105 / 5.45 / 0.177 / 1.44 | 0.112 / 6.04 / 0.135 / 1.03 | 0.126 / 6.50 / 0.170 / 1.60 | 0.096 / 5.23 / 0.216 / 1.08 | 0.105 / 5.32 / 0.304 / 1.54 |
| Rapid split + merge | 0.113 / 6.99 / 0.408 / 0.00 | 0.134 / 7.77 / 0.359 / 0.00 | 0.126 / 7.37 / 0.378 / 0.00 | 0.105 / 6.80 / 0.532 / 0.00 | 0.106 / 6.61 / 0.708 / 0.00 |
| Ejected-mass storm | 0.089 / 4.36 / 0.220 / 0.00 | 0.099 / 4.51 / 0.193 / 0.00 | 0.103 / 4.90 / 0.230 / 0.00 | 0.085 / 4.07 / 0.278 / 0.00 | 0.090 / 4.46 / 0.380 / 0.00 |

cellCombat alone (ms per tick, avg / p99 / max; median of reps)

| Scenario | Cells | current | g110 | g165 | g330 | g440 |
|---|---:|---:|---:|---:|---:|---:|
| Full lobby | 226 | 0.076 / 0.220 / 1.058 | 0.085 / 0.226 / 1.606 | 0.085 / 0.204 / 0.776 | 0.083 / 0.207 / 2.473 | 0.083 / 0.212 / 0.981 |
| Dense cluster | 155 | 0.059 / 0.128 / 0.201 | 0.066 / 0.148 / 0.867 | 0.064 / 0.159 / 2.867 | 0.072 / 0.159 / 0.756 | 0.072 / 0.177 / 0.471 |
| Standard mode (live config) | 238 | 0.093 / 0.411 / 0.937 | 0.087 / 0.274 / 1.007 | 0.083 / 0.387 / 0.733 | 0.083 / 0.262 / 0.604 | 0.084 / 0.244 / 1.537 |
| Very large cells | 259 | 0.089 / 0.184 / 0.651 | 0.082 / 0.181 / 0.301 | 0.092 / 0.184 / 1.432 | 0.085 / 0.177 / 0.555 | 0.089 / 0.205 / 0.384 |
| Rapid split + merge | 490 | 0.139 / 0.320 / 0.751 | 0.142 / 0.353 / 1.333 | 0.144 / 0.366 / 0.596 | 0.142 / 0.338 / 1.627 | 0.140 / 0.339 / 0.907 |
| Ejected-mass storm | 180 | 0.063 / 0.201 / 1.070 | 0.063 / 0.207 / 0.374 | 0.072 / 0.202 / 0.580 | 0.059 / 0.179 / 0.255 | 0.068 / 0.226 / 0.723 |
