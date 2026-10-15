Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz (4 cores), 3 rep(s) x 900 measured ticks after 300 warm-up, dt 0.05. Re-run: dense (3 x 300 after 300).

Current implementation (ms per room tick; total = stepWorld + one snapshot per player)

| Scenario | Players | Pellets | Cells | Total avg | p95 | p99 | Total excl. bot AI | p99 | Snapshots | Pellet grid rebuild | cellCombat | eatPellets | GC % | Heap MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Low population | 10 | 500 | 26 | 0.70 | 1.41 | 2.61 | 0.54 | 2.10 | 0.24 | 0.133 | 0.017 | 0.013 | 8.9 | 13.7 |
| Moderate population | 50 | 1500 | 114 | 3.18 | 5.34 | 7.11 | 2.56 | 5.51 | 1.46 | 0.356 | 0.314 | 0.046 | 3.0 | 21.8 |
| Full lobby | 100 | 3000 | 257 | 11.59 | 16.82 | 19.81 | 9.86 | 18.09 | 5.98 | 0.794 | 1.732 | 0.146 | 3.0 | 23.2 |
| Dense cluster | 100 | 3000 | 106 | 7.08 | 12.19 | 29.64 | 6.18 | 29.05 | 4.65 | 0.462 | 0.367 | 0.083 | 3.4 | 24.0 |
| Stress test | 150 | 5000 | 405 | 25.61 | 39.60 | 45.58 | 21.20 | 41.83 | 13.74 | 1.135 | 3.885 | 0.342 | 4.4 | 25.6 |
| Standard mode (live config) | 100 | 4100 | 268 | 13.02 | 19.34 | 24.86 | 11.26 | 21.28 | 6.86 | 0.976 | 1.771 | 0.172 | 2.6 | 23.6 |
| Very large cells | 100 | 3000 | 278 | 14.44 | 20.42 | 26.96 | 12.40 | 23.79 | 8.46 | 0.718 | 1.723 | 0.195 | 4.1 | 24.7 |
| Rapid split + merge | 100 | 3000 | 490 | 20.78 | 32.06 | 37.41 | 20.78 | 37.41 | 12.18 | 0.843 | 4.729 | 0.327 | 3.0 | 26.3 |
| Ejected-mass storm | 100 | 3000 | 196 | 9.72 | 14.45 | 16.91 | 9.72 | 16.91 | 7.02 | 0.522 | 0.947 | 0.155 | 3.1 | 24.9 |
| Spawn + consume churn | 100 | 3000 | 127 | 5.85 | 8.85 | 11.30 | 5.85 | 11.30 | 4.37 | 0.506 | 0.542 | 0.066 | 2.6 | 22.6 |

Broad / narrow phase per tick (counted build, current implementation)

| Scenario | eat: candidates | eat: narrow tests | eats | combat: pair-loop iterations | combat: sqrt tests | combat eats | virus tests | snapshot pellet candidates | snapshot cell tests | buckets visited |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Low population | 7 | 7 | 0.2 | 223 | 0.1 | 0.01 | 413 | 114 | 161 | 800 |
| Moderate population | 116 | 115 | 1.6 | 12418 | 1.6 | 0.20 | 2464 | 2417 | 5691 | 3844 |
| Full lobby | 439 | 435 | 4.7 | 55566 | 6.0 | 0.59 | 7402 | 10437 | 23739 | 7795 |
| Dense cluster | 592 | 568 | 11.4 | 11183 | 7.5 | 0.84 | 4541 | 11975 | 10590 | 7021 |
| Stress test | 1446 | 1432 | 13.1 | 162162 | 10.5 | 1.18 | 14598 | 30469 | 60708 | 12746 |
| Standard mode (live config) | 655 | 649 | 6.7 | 60879 | 6.2 | 0.70 | 8743 | 14682 | 24880 | 8280 |
| Very large cells | 728 | 722 | 7.5 | 76648 | 9.7 | 0.66 | 9160 | 20787 | 27774 | 23820 |
| Rapid split + merge | 2007 | 1131 | 20.6 | 237569 | 9.2 | 2.23 | 17646 | 30255 | 48770 | 24497 |
| Ejected-mass storm | 1155 | 593 | 12.3 | 38005 | 4.4 | 0.84 | 3384 | 18295 | 19716 | 13624 |
| Spawn + consume churn | 201 | 201 | 2.4 | 15745 | 5.5 | 1.22 | 1118 | 10303 | 12661 | 9607 |

Grid broad phase for cellCombat (counted build)

| Scenario | naive pair-loop iterations | grid: bucket entries visited | grid: candidate tests | sqrt tests (both) | eats (both) |
|---|---:|---:|---:|---:|---:|
| Low population | 223 | 37 | 0 | 0.1 / 0.1 | 0.01 / 0.01 |
| Moderate population | 12418 | 478 | 3 | 1.6 / 1.6 | 0.20 / 0.20 |
| Full lobby | 55566 | 1035 | 11 | 6.0 / 6.0 | 0.59 / 0.59 |
| Dense cluster | 11183 | 397 | 15 | 7.5 / 7.5 | 0.84 / 0.84 |
| Stress test | 162162 | 1839 | 17 | 10.5 / 10.5 | 1.18 / 1.18 |
| Standard mode (live config) | 60879 | 1099 | 13 | 6.2 / 6.2 | 0.70 / 0.70 |
| Very large cells | 76648 | 1264 | 14 | 9.7 / 9.7 | 0.66 / 0.66 |
| Rapid split + merge | 237569 | 2610 | 10 | 9.2 / 9.2 | 2.23 / 2.23 |
| Ejected-mass storm | 38005 | 771 | 5 | 4.4 / 4.4 | 0.84 / 0.84 |
| Spawn + consume churn | 15745 | 265 | 6 | 5.5 / 5.5 | 1.22 / 1.22 |

Variants (ms per room tick, excluding bot AI; median of reps)

| Scenario | current avg / p99 | fresh avg / p99 | csr avg / p99 | gcombat avg / p99 | all avg / p99 | current combat | fresh combat | csr combat | gcombat combat | all combat | current grid | fresh grid | csr grid | gcombat grid | all grid |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Low population | 0.54 / 2.10 | 0.75 / 2.33 | 0.38 / 1.65 | 0.61 / 2.42 | 0.52 / 2.45 | 0.017 | 0.019 | 0.014 | 0.062 | 0.054 | 0.133 | 0.278 | 0.022 | 0.159 | 0.045 |
| Moderate population | 2.56 / 5.51 | 2.70 / 6.70 | 2.29 / 5.28 | 2.16 / 5.27 | 1.99 / 5.11 | 0.314 | 0.294 | 0.314 | 0.062 | 0.073 | 0.356 | 0.636 | 0.069 | 0.316 | 0.096 |
| Full lobby | 9.86 / 18.09 | 9.69 / 17.72 | 7.61 / 17.14 | 7.71 / 13.58 | 6.80 / 14.96 | 1.732 | 1.589 | 1.538 | 0.138 | 0.141 | 0.794 | 1.270 | 0.207 | 0.663 | 0.272 |
| Dense cluster | 6.18 / 29.05 | 7.13 / 29.31 | 6.23 / 40.16 | 6.77 / 28.90 | 5.77 / 30.94 | 0.367 | 0.373 | 0.438 | 0.109 | 0.099 | 0.462 | 0.876 | 0.114 | 0.491 | 0.166 |
| Stress test | 21.20 / 41.83 | 24.01 / 42.94 | 18.98 / 39.10 | 18.71 / 36.32 | 16.36 / 34.06 | 3.885 | 4.189 | 3.931 | 0.207 | 0.217 | 1.135 | 2.093 | 0.446 | 1.081 | 0.644 |
| Standard mode (live config) | 11.26 / 21.28 | 10.84 / 23.10 | 8.58 / 17.76 | 9.30 / 18.58 | 6.92 / 12.81 | 1.771 | 1.606 | 1.604 | 0.141 | 0.130 | 0.976 | 1.541 | 0.263 | 0.805 | 0.321 |
| Very large cells | 12.40 / 23.79 | 13.43 / 27.77 | 10.67 / 20.49 | 11.23 / 22.60 | 9.38 / 19.35 | 1.723 | 1.622 | 1.760 | 0.138 | 0.153 | 0.718 | 1.260 | 0.219 | 0.618 | 0.317 |
| Rapid split + merge | 20.78 / 37.41 | 19.70 / 36.89 | 15.97 / 35.84 | 16.04 / 29.79 | 12.80 / 23.90 | 4.729 | 4.237 | 4.217 | 0.213 | 0.195 | 0.843 | 1.309 | 0.235 | 0.670 | 0.255 |
| Ejected-mass storm | 9.72 / 16.91 | 10.13 / 19.20 | 8.19 / 16.41 | 9.93 / 19.18 | 7.19 / 13.41 | 0.947 | 0.862 | 0.997 | 0.106 | 0.096 | 0.522 | 1.114 | 0.162 | 0.554 | 0.205 |
| Spawn + consume churn | 5.85 / 11.30 | 6.46 / 12.77 | 5.09 / 9.92 | 5.78 / 12.20 | 4.70 / 9.04 | 0.542 | 0.520 | 0.571 | 0.099 | 0.095 | 0.506 | 0.961 | 0.114 | 0.538 | 0.190 |
