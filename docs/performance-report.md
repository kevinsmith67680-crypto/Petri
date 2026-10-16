# Engulf: collision, spatial index and snapshot work, final report

Branch `claude/nice-keller-z8vfyf`. It starts from the spatial partitioning
audit (`docs/spatial-partitioning-audit.md`, verdict FAIL at `d93f567`) and
runs through seven phases. Phases 1 and 2 fixed the two correctness
problems the audit found. Phases 3–5 made the server cheaper without
changing any outcome. Phase 6 measured the real server under load, and
Phase 7 checked the whole against what it started from.

**Verdict: safe to take to staging.** Each correctness fix is covered by a
test that failed before it. Each optimisation is shown, tick by tick and byte
by byte, to play the same game as the code it replaced. No rule, mass
calculation, score, ranking, payout, account, settlement, matchmaking or
client code was changed. The remaining issues below are pre-existing or
deliberate, and none blocks staging.

Every figure here was measured on one machine: Node 22.22, a 4-core Intel
Xeon at 2.8 GHz. Absolute numbers will differ elsewhere; the comparisons are
like for like.

## 1. Files modified

Game code. These are the only runtime files this branch changed:

| File | Phases | What |
|---|---|---|
| `shared/sim.js` | 1–4 | Moving pellets re-filed as they move (`gridMove`). Collisions tested along each step (swept tests in `eatPellets`, `cellCombat`, `eatViruses`, `feedViruses`). `cellCombat` finds its candidates with a cell grid. The pellet index is laid out flat. |
| `shared/protocol.js` | 5 | `snapshotFrame`: one frame per room per tick shared by every snapshot. Per-client pellet delta in typed-array hash tables. A reused writer. Same bytes. |
| `shared/codec.js` | 5 | `Writer.raw`, to copy pre-encoded records. |
| `server/index.js` | 5, 6 | One frame per room per tick. No snapshot for a socket more than `SEND_BACKLOG` behind. Tick timings recorded and reported on `/health`. |
| `server/tickstats.js` (new) | 6 | Rolling per-tick lateness, simulation, snapshot and byte figures, and GC counts. |

Untouched: everything in `client/`, `server/ledger.js`, `server/accounts.js`,
`server/awards.js`, `server/api.js`, `server/db/`, `server/matchmaker/`,
`shared/wager.js` and the wire format (`PROTOCOL_VERSION` is still 12).

Tests: `test/grid.test.js`, `test/sweep.test.js`, `test/combat.test.js`,
`test/pelletgrid.test.js`, `test/snapshot.test.js` and
`test/backlog.test.js` are new. `test/sim.test.js` and
`test/protocol.test.js` had one fixture each adjusted (section 4), and
`test/docker.test.js` exempts `bench/`. `package.json` runs them all.

Tooling and docs:

- `bench/spatial/`: the audit's harness, plus `pairs` and `mapgrid`
  variants, `snapshot-cost.mjs` and `combat-filing.mjs`;
- `bench/stress/` (new): load tests against the real server;
- `bench/validate/` (new): this tree against the baseline;
- `README.md`, `docs/spatial-partitioning-audit.md` and this report.

## 2. Bugs corrected

| # | Bug | Fix | Proof |
|---|---|---|---|
| B1 | Thrown mass was looked up in the pellet grid a tick behind, up to 57 units off at 20 Hz, so a cell could have a blob it was touching pass through it. | Phase 1: each pellet in flight is re-filed as it moves (`gridMove`); no second rebuild. | `test/grid.test.js` fails on the old code (53 of 320 throws pass through) and passes now. C3–C5 pass. |
| R1 | Collisions were tested only where each step ended, so fast things passed through targets. A small split half covers ~68 units a step at 20 Hz; a late tick (up to 250 ms) does the same to thrown mass, shot viruses and big pieces. 7% of kills and 2% of orb eats in a Standard round were being missed. | Phase 2: every collision is also tested along both bodies' straight steps, using the least favourable sizes of the tick; the 20 Hz tick and `dt` are unchanged. | `test/sweep.test.js` fails 23 checks on the old code and passes now. C10 and C11 pass. |
| B2 | The index pointed at the previous round after `resetArena`. | Fixed upstream in `adb6295`; verified. | C2a–c pass. |
| — | A client that stopped reading had every tick's snapshot queued for it without bound, each arriving later than the last. | Phase 5: no snapshot is encoded or sent to a socket more than 64 KiB behind until it drains. | `test/backlog.test.js` drives it through the real server. |

## 3. Optimisations implemented

**Phase 3, `cellCombat` grid.** It tested every cell of every player against
every cell of every other: 50,000–230,000 pairs a tick in a full lobby. Now
cells are filed in a 256-unit grid by the path their centre took this tick,
and each attacker searches its own path widened by its radius. That is
complete for the swept test and for cells of any size, with duplicates kept
once. The order of bites (join order, victims from the back, a fresh search
after a bite) is the all-pairs loop's exactly. The grid is rebuilt each tick
where it is used (0.02–0.04 ms), so it cannot go stale.

**Phase 4, flat pellet grid.** One array of pellets sorted by bucket plus an
offset table, instead of a Map of bucket arrays, built by a stable counting
sort. The index still changes between rebuilds: `sowOrbs` files each orb
as placed, and thrown mass moves. So a pellet that leaves a bucket leaves a
hole, and one that arrives joins that bucket's arrivals. Every bucket hands
out exactly what the Map did, in the same order. Queries clamp at both
ends. Buckets stay 220 units (section 5).

**Phase 5, snapshots.**

- `snapshotFrame` works out once per room per tick what every client
  shares: cell positions, reaches and records, viruses, zone, leaderboard.
- Each client's pellet delta uses a small open-addressed hash table in
  typed arrays, and skips the removal pass when nothing left its view.
- One writer serves every snapshot.
- Bytes are unchanged.
- A backed-up socket is skipped before encoding (section 2).

**Phase 6, instrumentation.** `/health?window=N` reports the last N ticks'
lateness, simulation, snapshot and total time (avg, p50, p95, p99, max),
bytes per second, collections, RSS and heap. It cost a few clock reads per
room per tick.

## 4. Tests added

| Test | Checks | Fails on |
|---|---|---|
| `test/grid.test.js` | Thrown mass crossing bucket lines in five directions; a field of still cells under fire, eat for eat against brute force; a still board; spawning, consumption, `resetArena`. | The pre-B1 code. |
| `test/sweep.test.js` | Split halves at 20 Hz; every collision type at ticks of 50–250 ms; each rule (eat ratio, owner cooldown, receding mass, pop mass, join order); one consumption per thing; a crowded arena against a sampled brute force. | The pre-R1 code (23 checks). |
| `test/combat.test.js` | The cell grid against a plain all-pairs reference: giants across 15 buckets, a 900-unit step, crossing paths, walls, a victim in four buckets, every priority rule; 3,000 random states bite for bite; whole games (100-player lobby, heavy splitting at 50–250 ms ticks, giants) tick for tick. | Each of 9 deliberate breakages. |
| `test/pelletgrid.test.js` | The flat grid against the Map version, bucket by bucket in order: creation, sowing, ejected mass, eating, `resetArena`, pellets past every wall, an arena grown after layout, 6,000 random operations, two whole games with snapshots byte for byte. | Each of 9 deliberate breakages. |
| `test/snapshot.test.js` | Every client's decoded snapshots against the world by brute force (cells, pellets, viruses, names, figures, board) through deaths, spectating, leavers, a new round and missed ticks; the shared frame against encoding alone. | — |
| `test/backlog.test.js` | A backed-up socket gets nothing, others carry on, the stream resumes consistently. | — |

Two existing fixtures relied on R1's tunnelling and were adjusted to keep
their intent:

- a bot-timing check in `test/sim.test.js`: normal bots now eat at tick 7,
  not 12, because the split half no longer passes through the prey;
- a virus fixture in `test/protocol.test.js` that sat under a cell and was
  bound to pop.

`npm test`: 1,342 checks, all passing.

The correctness suite (`bench/spatial/correctness.mjs`) against this tree:
65 passed, 0 failed (`bench/spatial/results/correctness-final.txt`). The 21
skipped are the audit's `csr` and `gcombat` prototypes, superseded by what
shipped, which refuse to build. Its C9 check read the per-client `Set` the
old encoder kept and threw against the new one. It now reads either form, and
passes: 40,000 snapshots, no pellet missing or extra.

The baseline lockstep (section 6) passes too.

## 5. Before and after

### Per phase (simulation harness, `bench/spatial/`)

Median of three runs, ms per room tick, excluding bot AI (the live arena
runs none). Each pair is the same game played by both versions.

| Change | Scenario | Before | After |
|---|---|---:|---:|
| Phase 3, `cellCombat` | Standard (100) | 1.054 | 0.083 |
| | Heavy splitting (100) | 3.449 | 0.144 |
| | Stress (150) | 2.315 | 0.115 |
| Phase 3, whole tick | Standard | 6.95 (p99 14.41) | 5.41 (p99 10.82) |
| | Heavy splitting | 14.82 (p99 34.13) | 11.05 (p99 20.99) |
| Phase 4, pellet rebuild | Standard | 0.525 | 0.151 |
| Phase 4, whole tick | Standard | 5.98 (p99 12.41) | 5.26 (p99 11.75) |
| | Full lobby (100) | 4.87 (p99 10.83) | 3.96 (p99 8.79) |
| | Ejected-mass storm | 7.27 (p99 15.16) | 5.45 (p99 10.89) |
| Phase 5, all of a tick's snapshots | Standard (100) | 3.95 (p99 10.19) | 2.15 (p99 5.37) |
| | Heavy splitting (100) | 8.08 (p99 21.79) | 4.42 (p99 9.83) |
| | Stress (150) | 7.86 (p99 15.39) | 4.11 (p99 8.06) |
| Phase 5, GC time per 1,000 ticks | Standard | 210 ms | 117 ms |
| | Heavy splitting | 375 ms | 148 ms |

Phase 1 and 2 costs:

- B1's re-filing is within run-to-run noise; a second rebuild would have
  cost 0.48–0.58 ms.
- R1's swept tests cost 0.05–0.25 ms a tick in `eatPellets`, and 1–11% of
  `cellCombat` on identical frozen states, before Phase 3 made `cellCombat`
  12–24× cheaper.
- Only at 10 players are Phases 3 and 5 slower: `cellCombat` by 7 µs and
  snapshots by 0.1 ms a tick.

Bucket size (Phase 4):

- 330 was faster than 220 in five scenarios of six (Standard 5.40 →
  4.52 ms) but slower on the dense cluster (3.57 → 4.15 ms, p99 8.45 →
  13.29), with most differences within noise.
- 110, 165 and 440 were not better anywhere.
- So 220 was kept.

Sources:

- `bench/spatial/results/combat-grid-bench.md`;
- `bench/spatial/results/pelletgrid-bench.md` and `pelletgrid-size.md`;
- `bench/spatial/results/snapshot-cost.md` and `snapshot-gc-*.md`;
- the audit's update sections.

### Under load (Phase 6, the real server and real clients)

`bench/stress/run.mjs` (method in `bench/stress/README.md`) boots the game
server in `TEST_MODE` with no bots. Every player is a real WebSocket client
that signs up, matches, joins, readies and plays: steering at 30 Hz,
splitting and throwing as its scenario says, and decoding every snapshot.

- **Before** is `a44cad8` (main before Phases 3–5) and **after** is this
  tree.
- Each scenario measures 40 s after 10 s of play.
- Server figures come from `/health?window=800` (`server/tickstats.js`,
  patched into the baseline the same way).
- Full tables are in `bench/stress/results/comparison.md`.

Server, ms per tick across all rooms, average / p99, before → after:

| Scenario | Simulation | Snapshots (encode and send) | Whole tick |
|---|---:|---:|---:|
| 10 players | 1.52 / 3.13 → 0.58 / 2.00 | 0.98 / 2.45 → 0.71 / 2.02 | 2.57 / 4.89 → 1.34 / 3.36 |
| 50 players | 1.70 / 3.92 → 0.83 / 2.04 | 3.66 / 8.26 → 2.36 / 5.63 | 5.43 / 12.66 → 3.25 / 7.03 |
| 100 players | 1.76 / 3.60 → 0.90 / 2.50 | 5.77 / 12.66 → 3.74 / 10.23 | 7.60 / 15.86 → 4.70 / 11.56 |
| 100 players, heavy splitting | 2.67 / 4.97 → 1.46 / 3.45 | 6.54 / 13.35 → 4.43 / 9.72 | 9.28 / 17.79 → 5.96 / 12.70 |
| 150 players | 2.51 / 6.06 → 0.99 / 2.48 | 9.67 / 21.33 → 5.76 / 14.61 | 12.26 / 25.33 → 6.83 / 16.23 |
| Two rooms at once, 100 + 50 | 2.12 / 4.62 → 1.13 / 3.25 | 9.19 / 18.72 → 6.04 / 13.62 | 11.38 / 22.15 → 7.25 / 15.79 |
| 100 players, heavy ejected mass | 1.86 / 3.83 → 1.09 / 3.22 | 5.88 / 12.97 → 3.87 / 9.62 | 7.82 / 16.09 → 5.02 / 11.29 |
| 100 players, 50–250 ms stalls every 2 s | 2.83 / 6.09 → 1.18 / 3.22 | 7.05 / 14.09 → 4.60 / 12.44 | 9.95 / 18.52 → 5.85 / 14.46 |
| 100 players, 80 ± 30 ms latency, 1% loss | 2.73 / 6.98 → 1.23 / 4.05 | 5.90 / 13.91 → 4.00 / 10.40 | 8.70 / 18.80 → 5.28 / 12.90 |

Scheduling and resources, before → after:

| Scenario | Tick start late, ms p99 / max | Server CPU % | RSS MB, peak | Heap MB, peak | Collections / GC ms in 40 s |
|---|---:|---:|---:|---:|---:|
| 10 players | 2 / 23 → 2 / 5 | 7.6 → 5.2 | 180 → 173 | 25 → 19 | 38 / 41 → 23 / 19 |
| 50 players | 2 / 3 → 2 / 9 | 15.0 → 10.6 | 196 → 180 | 25 → 21 | 82 / 93 → 69 / 64 |
| 100 players | 2 / 16 → 2 / 4 | 20.5 → 14.5 | 201 → 197 | 29 → 31 | 119 / 137 → 68 / 59 |
| 100 players, heavy splitting | 2 / 3 → 2 / 4 | 24.4 → 16.9 | 224 → 199 | 39 → 31 | 134 / 186 → 65 / 64 |
| 150 players | 2 / 5 → 2 / 3 | 30.9 → 19.3 | 246 → 203 | 55 → 31 | 168 / 247 → 65 / 70 |
| Two rooms at once | 2 / 5 → 2 / 6 | 30.5 → 20.9 | 203 → 199 | 31 → 29 | 166 / 208 → 69 / 81 |
| Heavy ejected mass | 2 / 5 → 2 / 13 | 20.4 → 13.6 | 201 → 197 | 31 → 28 | 118 / 137 → 54 / 55 |
| Stalls | 166 / 231 → 163 / 239 | 24.8 → 15.3 | 201 → 202 | 32 → 29 | 133 / 378 → 73 / 71 |
| Latency and loss | 2 / 149 → 1 / 6 | 24.4 → 18.7 | 203 → 200 | 31 → 30 | 129 / 153 → 74 / 72 |

What the clients saw:

- 20 snapshots a second each in every scenario, both builds.
- No tick missed.
- No pellet added twice or removed unsent.
- Bandwidth of 2.3–4.2 KiB/s per client, the same on both builds within the
  differences between the games. The wire format is unchanged, but clients
  playing in real time do not replay the same game twice.

Gaps between snapshots, p50 / p99 / max:

| Scenario | Before | After |
|---|---|---|
| No stalls or added latency | 50 / 53–60 / 60–78 ms | 50 / 53–56 / 59–76 ms |
| Stalls | 50 / 201 / 277 ms | 50 / 197 / 288 ms |
| Latency and loss | 49 / 223 / 387 ms | 49 / 199 / 306 ms |

Reading these:

- **The whole tick is 36–48% cheaper on average and 22–44% at p99 in
  every scenario.** At 150 players, before, the p99 was half the 50 ms
  budget; it is now a third.
- **Scheduling and execution are measured apart.**
  - Outside the stall scenario, ticks start within 2 ms of schedule at
    p99 on both builds.
  - Under stalls, the lateness is the stalls' own (injected: 18 a run,
    157 ms average, 240 ms worst) on both builds, while the ticks
    themselves run as usual. The server recovers without falling behind.
  - The measured `dt` is capped at 250 ms, so the game clock stays
    consistent.
- **Sending is now most of the snapshot phase.** In the real server, at 100
  players, it is 3.74 ms a tick. Encoding alone for 100 players measures
  about 2 ms in the harness, on a different game, so very roughly half is
  `ws.send`: one syscall per client per tick, which encoding cannot
  shrink.
- **Outliers.**
  - Single-tick maxima are noisy, which is why p99 is the comparison:
    16.8 ms after against 7.9 ms before at 10 players, and 27.3 against
    21.6 ms at 100. In every scenario but the stalls, no collection lasted
    longer than 13 ms.
  - The baseline's network rerun had one 130 ms tick that collection does
    not explain (its longest GC was 8 ms). It did not recur in the other
    runs.
- **Network scenario.** It is from a rerun. The first runs went through a
  proxy that could reorder chunks less than a millisecond apart, which
  showed up as 96 and 39 protocol errors. It was fixed in the proxy, and
  the rerun had none on either build.

## 6. Final validation (Phase 7)

| Requirement | Evidence |
|---|---|
| No missed valid collisions | B1 and R1 fixed, with tests that fail before. `grid.test` and `sweep.test` check against brute force. Correctness checks C3–C5 (no eligible pellet skipped, tick for tick against a full-scan reference), C7 (giants), C10 and C11 (long and normal ticks) pass. |
| No duplicate consumption | C6 passes. `sweep.test` duplicates: one orb crossed by two cells, mass fed to a virus not also eaten, one cell crossing two prey. The `combat.test` victim in four buckets is eaten once. The stress clients saw no pellet added twice or removed unsent. |
| Mass conservation unchanged | `bench/validate/against-baseline.mjs`: the baseline and this tree hold identical masses for every cell, pellet and virus at every tick in five scenarios (results below). No NaN or negative mass at any tick. |
| No orphaned index entries | Every tick of the baseline lockstep, the flat grid holds exactly the live pellets, each once. `pelletgrid.test` compares every bucket with the Map version through 6,000 random operations. Correctness checks C1, C2 and C8 pass. |
| No outdated entities in snapshots | `snapshot.test` checks every client against the world by brute force every tick: nothing left after it has gone, nothing missing, nothing sent twice. The snapshots are byte-identical to the baseline's (504,000 of them). |
| Scoring, rankings, payouts unchanged | Orbs eaten, cells eaten, peak mass, rank and field are identical to the baseline at every tick. They are what `server/awards.js` and settlement read, and neither changed. |
| Splitting and merging unchanged | Identical cell sets, positions, velocities and merge timers every tick in heavy splitting at 50–250 ms ticks. The existing sim tests pass. |
| All existing and new tests pass | `npm test`: 1,342 passing. The correctness suite against this tree: 65 passed, 0 failed. |

Baseline lockstep (`bench/validate/results/against-baseline.md`): `a44cad8`
(main before Phases 3–5) against this tree, 1,200 ticks a scenario.

| Scenario | Same state every tick | Same snapshot bytes | Index exact every tick | Orbs eaten | Bites | Pops | Deaths | Mass in cells, start → end | In pellets, start → end |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| Standard arena, 100 hard bots | yes | yes, 120,000 | yes | 11060 | 1040 | 132 | 83 | 48,448 → 65,452 | 8,200 → 8,200 |
| 60 players splitting and throwing, ticks 50-250 ms | yes | yes, 72,000 | yes | 173171 | 22847 | 534 | 19520 | 61,904 → 682,096 | 1,200 → 1,211 |
| Thrown mass in a crowd, closing zone, a new round halfway | yes | yes, 60,000 | yes | 3392 | 147 | 4 | 110 | 22,225 → 1,181 | 3,000 → 4,001 |
| Giants among 60 hard bots | yes | yes, 72,000 | yes | 16149 | 815 | 203 | 135 | 202,605 → 189,699 | 4,070 → 4,070 |
| 150 hard bots | yes | yes, 180,000 | yes | 12467 | 554 | 54 | 120 | 4,684 → 29,898 | 10,000 → 10,000 |

## 7. Remaining known issues

None of these is new. None changes an outcome a player could notice, beyond
what is described.

- **Cells past the wall (pre-existing).** `resolveOwnCells` pushes a
  player's own pieces apart after the wall clamp, which can leave one a few
  units past the wall. It is cosmetic; the crowded-arena test allows for it.
- **Client prediction checks end points only.** The client still predicts
  its own orb eats at end points. At 60 fps its steps are short, and the
  server stays authoritative, so at worst a predicted eat is corrected.
- **Cells made mid-tick.** A piece split off during a tick has no earlier
  position, so the swept test treats it as present for the whole tick from
  where it appeared.
- **`underCell` scan.** `sowOrbs` tests every dart against every cell
  linearly. It is not measured as significant, but it grows with cells ×
  replacements.
- **Bandwidth.** Cells (54–76% of snapshot bytes) and viruses (6–15%) are
  re-sent every tick. Delta-coding them might save a third of the bandwidth,
  but it changes the wire format and the client, and bandwidth (3–15 KiB/s
  per client) is not the limit. Evaluated, not done.
- **Bucket size.** 330 may be better than 220 for the Standard config. The
  evidence was mixed and the dense case regressed, so 220 stays. It would
  need a longer run with the Phase 5 encoder in place to settle.
- **Sending dominates the snapshot phase.** In the real server most of the
  snapshot phase is `ws.send`, one syscall per client per tick, which
  encoding cannot shrink (section 5).
- **Network emulation is approximate.** The container has no netem, so
  latency, jitter and loss come from a TCP proxy in the test process.
  Pauses come from SIGSTOP and SIGCONT. Both are reasonable stand-ins, not
  the real thing.

## 8. Is it safe for staging?

Yes.

- The correctness fixes change outcomes only where the old code was wrong:
  eats and kills it missed.
- Everything after them is shown to play the same game, tick for tick and
  byte for byte, as what it replaced.
- The wire format is unchanged, so deployed clients keep working.
- The new `/health` fields are additive.

Suggested staging checks:

- watch `/health` `tick.window` (late and total p99) and `snapshotsHeld`
  under real traffic;
- run `bench/stress/run.mjs` against the staging host's build.
