Swept collision cost. `run-one.mjs`, median of 3 seeds x 900 ticks after 300 warm-up, dt 0.05, ms per room tick.
`before` is 93148bf (SPATIAL_REV=93148bf); `swept` is the working tree. Both play the same seeds, but the games diverge once the sweep catches something the old test missed, so whole-tick figures differ by more than the code does. `sweep-combat-cost.txt` compares cellCombat on identical frozen states.

| Scenario | Build | Tick avg excl. AI | p99 | Sim avg excl. AI | eatPellets | cellCombat |
|---|---|---:|---:|---:|---:|---:|
| Standard mode (live config) | before | 7.70 | 16.84 | 2.92 | 0.137 | 1.113 |
| Standard mode (live config) | swept | 7.57 | 17.03 | 2.78 | 0.209 | 1.094 |
| Full lobby | before | 6.34 | 13.42 | 2.54 | 0.111 | 0.985 |
| Full lobby | swept | 6.42 | 15.06 | 2.41 | 0.165 | 1.048 |
| Stress test | before | 14.06 | 28.31 | 5.29 | 0.258 | 2.505 |
| Stress test | swept | 14.15 | 28.48 | 5.13 | 0.398 | 2.406 |
| Very large cells | before | 9.14 | 19.58 | 2.79 | 0.126 | 1.052 |
| Very large cells | swept | 9.38 | 18.06 | 2.67 | 0.220 | 1.109 |
| Rapid split + merge | before | 15.08 | 31.36 | 6.97 | 0.236 | 3.538 |
| Rapid split + merge | swept | 14.75 | 36.70 | 6.48 | 0.490 | 3.756 |
| Ejected-mass storm | before | 7.64 | 16.35 | 2.19 | 0.140 | 0.727 |
| Ejected-mass storm | swept | 8.11 | 15.84 | 2.40 | 0.281 | 0.741 |
