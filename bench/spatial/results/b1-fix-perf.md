B1 fix cost. `run-one.mjs`, median of 3 seeds x 900 ticks after 300 warm-up, dt 0.05, ms per room tick.
`before` and `full rebuild` are built from 2badc11 (SPATIAL_REV=2badc11, variants current and fresh); `this fix` from the working tree.

| Scenario | Build | Tick avg excl. AI | p99 | Sim avg excl. AI | End-of-tick rebuild | Extra rebuild |
|---|---|---:|---:|---:|---:|---:|
| Standard mode (live config) | before | 7.79 | 16.21 | 2.82 | 0.668 | 0.000 |
| Standard mode (live config) | this fix (gridMove) | 7.61 | 15.41 | 2.89 | 0.638 | 0.000 |
| Standard mode (live config) | full rebuild after moving | 8.28 | 15.99 | 3.52 | 0.665 | 0.582 |
| Ejected-mass storm | before | 8.66 | 16.84 | 2.59 | 0.539 | 0.000 |
| Ejected-mass storm | this fix (gridMove) | 9.01 | 16.14 | 2.51 | 0.496 | 0.000 |
| Ejected-mass storm | full rebuild after moving | 9.37 | 19.35 | 3.22 | 0.586 | 0.480 |
| Rapid split + merge | before | 17.02 | 32.45 | 7.34 | 0.848 | 0.000 |
| Rapid split + merge | this fix (gridMove) | 17.60 | 33.84 | 7.65 | 0.868 | 0.000 |
| Rapid split + merge | full rebuild after moving | 17.98 | 35.17 | 8.21 | 0.870 | 0.528 |

Pellets re-filed per tick (counted build): Standard 0.0 of 0.2 moving; ejected-mass storm 9.7 of 168.8; rapid split + merge 12.7 of 194.8.

Measured on the fix as first written; the only later change routes `gridInsert` through the same `keyOf` helper, with identical behaviour.
