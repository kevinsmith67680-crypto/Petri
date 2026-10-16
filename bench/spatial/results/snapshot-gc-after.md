Node v22.22.0, Intel(R) Xeon(R) Processor @ 2.80GHz; 1000 ticks after 200 warm-up, dt 0.05; encoder at dd03e01 against the working tree.

Garbage left by the new encoder alone

| Scenario | Players | avg ms | p99 ms | GCs per 1,000 ticks | GC ms per 1,000 ticks |
|---|---:|---:|---:|---:|---:|
| Low population | 10 | 0.26 | 3.96 | 146 | 159.6 |
| Full lobby | 100 | 1.61 | 3.07 | 163 | 158.2 |
| Standard mode (live config) | 100 | 2.04 | 5.79 | 107 | 117.2 |
| Rapid split + merge | 100 | 4.00 | 7.81 | 120 | 147.6 |
| Stress test | 150 | 4.56 | 9.97 | 153 | 200.7 |
