Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz; 600 ticks after 200 warm-up, dt 0.05; encoder at dd03e01 against the working tree.

All of a tick's snapshots, ms (one per player)

| Scenario | Players | Before avg | p95 | p99 | After avg | p95 | p99 | Speed-up | Byte-identical | KiB a tick |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Low population | 10 | 0.20 | 0.47 | 1.29 | 0.30 | 0.64 | 4.45 | 0.67x | yes, all 6000 | 1.3 |
| Moderate population | 50 | 1.18 | 2.42 | 3.61 | 0.68 | 1.22 | 2.16 | 1.75x | yes, all 30000 | 11.1 |
| Full lobby | 100 | 3.36 | 5.65 | 7.24 | 1.78 | 2.78 | 3.60 | 1.89x | yes, all 60000 | 26.3 |
| Standard mode (live config) | 100 | 3.95 | 6.66 | 10.19 | 2.15 | 3.38 | 5.37 | 1.84x | yes, all 60000 | 27.6 |
| Rapid split + merge | 100 | 8.08 | 12.74 | 21.79 | 4.42 | 7.18 | 9.83 | 1.83x | yes, all 60000 | 73.0 |
| Ejected-mass storm | 100 | 5.77 | 9.26 | 11.37 | 3.15 | 4.59 | 6.56 | 1.83x | yes, all 60000 | 34.3 |
| Stress test | 150 | 7.86 | 12.89 | 15.39 | 4.11 | 6.70 | 8.06 | 1.91x | yes, all 90000 | 49.3 |

Where the bytes go (share of all snapshot bytes, sampled every 20th tick)

| Scenario | Header | Names | Cells | Pellets added | Pellets removed | Viruses | Leaderboard |
|---|---:|---:|---:|---:|---:|---:|---:|
| Low population | 38% | 2% | 37% | 3% | 2% | 13% | 6% |
| Moderate population | 22% | 1% | 58% | 5% | 2% | 8% | 4% |
| Full lobby | 19% | 1% | 61% | 6% | 2% | 7% | 3% |
| Standard mode (live config) | 18% | 1% | 58% | 8% | 2% | 9% | 3% |
| Rapid split + merge | 7% | 0% | 76% | 8% | 2% | 6% | 1% |
| Ejected-mass storm | 15% | 1% | 54% | 10% | 3% | 15% | 3% |
| Stress test | 15% | 1% | 64% | 9% | 2% | 7% | 3% |
