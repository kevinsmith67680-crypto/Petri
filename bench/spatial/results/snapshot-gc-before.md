Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz; 1000 ticks after 200 warm-up, dt 0.05; encoder at dd03e01 against the working tree.

Garbage left by the old encoder alone

| Scenario | Players | avg ms | p99 ms | GCs per 1,000 ticks | GC ms per 1,000 ticks |
|---|---:|---:|---:|---:|---:|
| Low population | 10 | 0.24 | 3.88 | 124 | 158.2 |
| Full lobby | 100 | 3.06 | 7.11 | 203 | 228.3 |
| Standard mode (live config) | 100 | 3.42 | 6.98 | 208 | 210.4 |
| Rapid split + merge | 100 | 6.85 | 16.40 | 300 | 374.7 |
| Stress test | 150 | 7.82 | 14.86 | 335 | 425.1 |
