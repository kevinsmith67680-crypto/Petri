# Spatial partitioning and collision detection audit

Audited at `d93f567` on `claude/nice-keller-z8vfyf`. No game code was changed.
The benchmarks and correctness checks behind every figure here are in
[`bench/spatial/`](../bench/spatial/README.md), and their raw output is in
`bench/spatial/results/`. File and line references are to `d93f567`. The
branch moved on during the audit; what still holds at the head is in the next
section.

## Update: B1 fixed

`stepWorld` now re-files each pellet in flight as it moves, before anyone eats
(`gridMove` in `shared/sim.js`). A pellet's bucket is the one its position was
in before this tick's move, because nothing moves pellets between the
end-of-tick rebuild and the advance loop. So the fix adds no new field and no
second rebuild, and costs one key comparison per moving pellet. Only pellets
that cross a bucket line are touched: 0 a tick in the live Standard config,
9.7 of 169 in flight in an ejected-mass storm, and 12.7 of 195 in split play.

- **Brute force agrees:** with the fixed code, every brute-force check in
  `bench/spatial/correctness.mjs` that concerns the index passes. C3, C4 (0
  skipped eats in every scenario, at 50 ms and 250 ms ticks) and C5 (tick for
  tick against the reference simulation) all pass, and C1, C2 and C6–C9 still
  do (`results/correctness-b1-fix.txt`). C10 and C11 still fail; they are R1,
  the narrow-phase stepping, which this does not touch.
- **New project test:** `test/grid.test.js` is now part of `npm test`. It
  covers blobs crossing bucket lines in five directions, a field of still
  cells under fire checked eat-for-eat against a brute-force scan, real
  ejected mass, a still board, spawning, consumption and `resetArena`. It
  fails on the pre-fix code (53 of 320 throws pass through; the field
  diverges at tick 14) and passes on the fix.
- **B2 stays fixed:** the `resetArena` checks pass on both.
- **Cost (`results/b1-fix-perf.md`):** within run-to-run noise. Sim time moves
  −0.08 to +0.31 ms and the end-of-tick rebuild is unchanged. Rebuilding the
  whole grid after pellets move, as C-1 below first proposed, would add
  0.48–0.58 ms a tick.

## Update: R1 fixed

Collisions are now tested along each step as well as at its end ("swept
collision" in `shared/sim.js`). That covers eating orbs and thrown mass,
eating cells, popping on viruses (a cell crossing one, or a shot virus
crossing a cell) and feeding viruses.

- **Two stages, adding only.** Each test is made at the end of the tick
  exactly as before. Then, only if that fails and something moved, it is made
  along both entities' straight steps, which is how the sim already integrates
  motion, so nothing is approximated. A pair that did not move gets
  bit-identical results.
- **Rules unchanged.** The eat ratio, the 0.55 overlap, the owner cooldown,
  the receding rule, pop mass, feeding only in flight, one pop per player per
  tick, and the order players and cells are processed in are all as before.
- **No reaching back.** Swept thresholds use the least favourable size each
  side had during the tick: the eater's smallest, the prey's largest, the
  popping cell's smallest. A cell that grew past a threshold only at the end
  of the tick cannot claim what it passed while below it.
- **Broad phase covers the step.**
  - The eat query covers each cell's whole step, padded by the furthest any
    pellet moved that tick (0 when nothing was thrown).
  - The combat reject covers the pair's relative path, behind a band filter
    (twice the longest step any cell took) so far-apart pairs are still
    rejected on end positions alone.
  - Virus and feed tests reject on path boxes.
- **`dt` unchanged.** The tick stays at 20 Hz, stepped by measured time capped
  at 250 ms. Collisions no longer depend on the step length, and sub-stepping a
  late tick would only have made it later.
- **How much it matters at 20 Hz** (`results/r1-swept-share.txt`): caught only
  along the way were 7.0% of kills and 1.9% of orb eats in the live Standard
  config, 6.7% / 6.0% in split play, and 8.3% / 6.6% in an ejected-mass storm.
- **Verified:**
  - `test/sweep.test.js`, now in `npm test`, fails 23 checks on the pre-change
    code and passes on this.
  - In `bench/spatial/correctness.mjs` C10 and C11 now pass, with nothing
    failing (`results/correctness-r1-fix.txt`).
  - `test/grid.test.js`'s brute-force predictor applies the full swept rule
    and still agrees eat-for-eat.
- **Cost** (`results/r1-sweep-perf.md`, `results/sweep-combat-cost.txt`):
  - Tick and sim averages are within noise in all six scenarios.
  - `eatPellets` is 0.05–0.25 ms a tick more.
  - On identical frozen split-heavy states, `cellCombat` is 1–11% more.
  - Whole-game p99s differ by more than that in split play, because the games
    diverge once the sweep catches what the old test missed.
- **Not changed:**
  - Client prediction of the player's own orb eats still tests end points.
    At 60 fps its steps are small, and the server stays authoritative.
  - A pre-existing glitch: pushing a player's own pieces apart happens after
    the wall clamp, which can leave one a few units past the wall.
  - The H-1 grid prototype tests end points only. A swept version must insert
    cells where they end and query each attacker's whole step plus the band.
    (Since shipped, filing each cell by its path instead: see "Update: H-1
    shipped".)

## Update: H-1 shipped

`cellCombat` now finds its candidate pairs with a uniform grid instead of
testing every cell of every player against every cell of every other ("cell
combat" in `shared/sim.js`).

- **Built where it is used.**
  - The grid is rebuilt at the start of combat, after the tick's moves,
    splits, merges, pops and zone losses. It uses 256-unit buckets,
    counting-sorted into typed arrays that are reused between ticks. It
    cannot go stale, and nothing else has to keep it up to date.
  - A cell eaten during combat is marked and never tested again.
  - Filing costs 0.02–0.04 ms a tick, 34–42% of the new `cellCombat`
    (`results/combat-filing.txt`). A grid kept up to date would save less than
    that, since nearly every cell moves every tick.
- **Complete for the swept test, at any size.** A bite needs the victim's
  centre within the attacker's radius at the end of the tick or along the way.
  So each cell is filed in every bucket its centre's path covers this tick
  (1.06–1.09 entries per cell). Each attacker cell searches its own path
  widened by its radius. A giant attacker searches more buckets; a giant
  victim is still filed by its centre.
- **No duplicates.** A victim filed in several buckets is kept once per
  search, by a per-search stamp.
- **Same order, same numbers.** These are the prototype's rules:
  - attackers and victims in join order;
  - attacker cells in order, victim cells from the back;
  - the mass test live and the reach fixed per victim player;
  - a fresh search after a bite.

  Candidates are not filtered by mass, as warned under H-1.
- **Verified:**
  - **`test/combat.test.js`, now in `npm test`.** It checks the grid against
    a plain all-pairs reference with no early rejects:
    - hand-built cases: giants across 15 buckets, a 900-unit step, crossing
      paths, walls, a victim filed in four buckets, join order, victim order,
      growth reaching a later player, an eaten attacker;
    - 3,000 random frozen states, bite for bite (348,115 bites);
    - three whole games, tick for tick: a 100-player hard-bot lobby, 60
      players splitting at tick lengths of 50–250 ms, and giants.

    Nine deliberate breakages of the grid each fail it.
  - **`bench/spatial/correctness.mjs`.** Run against `pairs` (the all-pairs
    loop from `a44cad8`, verbatim), the grid plays identically for 1,200
    ticks in six scenarios, and for 600 at 250 ms ticks in three. C7 passes
    on both. Nothing fails (`results/correctness-combat-grid.txt`).
- **Measured** (`results/combat-grid-bench.md`, `-dt025.md`; median of 3 runs,
  ms per room tick excluding bot AI; the games are identical, so the
  comparison is like for like):

  | Scenario | `cellCombat` all pairs → grid | Tick avg | Tick p99 |
  |---|---:|---:|---:|
  | Low population (10) | 0.012 → 0.019 | 0.34 → 0.42 | 1.38 → 1.97 |
  | Full lobby (100) | 0.966 → 0.078 | 6.00 → 4.98 | 11.17 → 10.79 |
  | Standard mode (live config) | 1.054 → 0.083 | 6.95 → 5.41 | 14.41 → 10.82 |
  | Stress test (150) | 2.315 → 0.115 | 13.42 → 10.44 | 24.85 → 21.72 |
  | Very large cells | 1.102 → 0.085 | 8.84 → 8.00 | 16.28 → 15.20 |
  | Rapid split + merge | 3.449 → 0.144 | 14.82 → 11.05 | 34.13 → 20.99 |
  | Full lobby, 250 ms ticks | 1.670 → 0.117 | 9.52 → 7.03 | 17.52 → 14.65 |
  | Rapid split + merge, 250 ms ticks | 1.203 → 0.095 | 8.72 → 7.73 | 17.63 → 17.20 |

  - Worst single `cellCombat` call in split play: 16.2 → 1.6 ms.
  - Candidate tests fall from 50,695–230,213 pair-loop iterations to 8–17.
    Hit tests and eats are identical in every scenario.
  - With 10 players the grid costs 7 µs more a tick, which does not matter.
  - Tick differences beyond `cellCombat`'s own are run-to-run noise.
- **Not changed:** any rule, the 20 Hz tick, and the pellet grid.
  `underCell`'s linear scan in `sowOrbs` could use a cell grid too, but it
  runs after combat, when this one no longer matches the cells.

## Update: H-2 shipped

The pellet index is now laid out flat ("pellet spatial index" in
`shared/sim.js`). It is one array of pellets sorted by bucket plus an offset
table, filled by a stable counting sort into arrays kept from tick to tick.
Queries clamp the bucket range at both ends of the arena (L2).

- **What the prototype could not do.** Since the audit the index changes
  between rebuilds in two ways:
  - `sowOrbs` files each orb the moment it places it, so the next dart keeps
    its distance (`adb6295`);
  - `stepWorld` re-files thrown mass as it moves (`93148bf`).

  A flat layout cannot grow a bucket in place, so the shipped version handles
  both differently:
  - a pellet that leaves a bucket leaves a hole;
  - one that arrives joins that bucket's list of arrivals, visited after the
    rest;
  - the next rebuild lays everything out flat again.
- **Membership and order exactly as the Map's.** Every bucket hands out what
  the Map's array held, in the same order: by `world.pellets` as of the
  rebuild, then by arrival. Eat order, the orbs a snapshot lists and a bot's
  choice on a tie all follow that order.
- **Edges.**
  - A pellet a whole bucket below zero is filed nowhere. No query ever
    looked there, so the Map's bucket for it was never visited either.
  - A pellet past the far wall widens the grid instead of being clamped into
    an edge bucket, which the audit's prototype did.
  - Creation, sowing, eating, sweeping, `resetArena` and an arena grown after
    layout all keep membership exact.
- **Verified:**
  - **`test/pelletgrid.test.js`, now in `npm test`.** It puts a copy of
    `sim.js` with the Map grid restored through the same steps as the
    current one, comparing what every bucket hands out, in order:
    - creation, sowing, a rebuild, ejected mass, eating, `resetArena`;
    - pellets past every wall, and an arena grown after layout;
    - 6,000 random inserts, moves, deaths and rebuilds;
    - two whole games (a 100-bot Standard room, and a crowd throwing mass
      under a closing zone with a reset), with snapshots compared byte for
      byte.

    Nine deliberate breakages each fail it.
  - **`bench/spatial/correctness.mjs`.** Run against `mapgrid` (the Map put
    back), the flat grid plays identically for 1,200 ticks in six scenarios,
    and for 600 at 250 ms ticks in four. C1 (grid query superset) and C8
    (walls and bucket corners) pass on both. 65 passed, 0 failed
    (`results/correctness-pellet-grid.txt`).
- **Measured** (`results/pelletgrid-bench.md`, `-dt025.md`,
  `pelletgrid-query-bounds.txt`). Median of three runs, ms per room tick
  excluding bot AI. The games are identical, so this is like for like:

  | Scenario | Tick avg, Map → flat | p99 | Rebuild | Snapshots |
  |---|---:|---:|---:|---:|
  | Low population (10) | 0.38 → 0.31 | 1.78 → 1.35 | 0.103 → 0.021 | 0.17 → 0.18 |
  | Full lobby (100) | 4.87 → 3.96 | 10.83 → 8.79 | 0.420 → 0.093 | 3.65 → 3.09 |
  | Standard mode (live config) | 5.98 → 5.26 | 12.41 → 11.75 | 0.525 → 0.151 | 4.44 → 4.07 |
  | Stress test (150) | 9.82 → 8.44 | 20.99 → 16.87 | 0.579 → 0.194 | 7.71 → 6.70 |
  | Very large cells | 7.99 → 6.25 | 14.46 → 13.95 | 0.411 → 0.091 | 6.49 → 5.21 |
  | Rapid split + merge | 10.16 → 9.18 | 22.97 → 21.90 | 0.439 → 0.112 | 7.66 → 7.04 |
  | Ejected-mass storm | 7.27 → 5.45 | 15.16 → 10.89 | 0.422 → 0.087 | 5.57 → 4.28 |
  | Full lobby, 250 ms ticks | 7.07 → 5.93 | 14.90 → 12.65 | 0.470 → 0.107 | 4.90 → 4.29 |
  | Ejected-mass storm, 250 ms ticks | 6.18 → 4.96 | 13.97 → 10.87 | 0.456 → 0.100 | 4.52 → 3.79 |

  - A single query is never slower.
  - For a giant's view reaching past the arena it is 1.5–4.8× faster,
    because buckets past the wall are no longer looked up.
- **Bucket size** (`results/pelletgrid-size.md`, same method):
  - 110, 165 and 440 were not better than 220 anywhere.
  - 330 was faster in five scenarios of six (Standard 5.40 → 4.52 ms) but
    slower on the dense cluster (3.57 → 4.15 ms, p99 8.45 → 13.29), and most
    differences were within noise.
  - A different size also changes the visiting order, so those games are not
    identical to each other.

  **220 is kept.**

## Status at the branch head (`a8319cc`)

Thirteen commits landed while the audit ran: Poisson-disc orb sowing, a
closing zone, a hold on the starting ring, and input changes. Unpatched
modules at both revisions were re-checked with `bench/spatial/head-check.mjs`
(`results/head-check.txt`).

| | `d93f567` (audited) | `a8319cc` (head) |
|---|---|---|
| `eatPellets`, `cellCombat`, `forEachPelletNear`, `eatViruses`, `feedViruses` | — | byte-identical |
| **B1**: moving pellets skipped | reproduces | **still reproduces**: a blob 15 units into a 26.5-unit reach is not eaten |
| **B2**: index after `resetArena` | 400 stale entries, ghost orbs | **fixed** by `adb6295`, which empties the index and re-sows it inside `resetArena` (`sim.js:1595-1596` at head) |
| Standard config, unpatched, bot AI included, median of 3 runs | 11.3 ms (p99 22.3) | 10.5 ms (p99 18.8): same picture, within noise |
| Snapshot spatial logic (`encodeSnapshot`) | — | unchanged; fields added only |
| Practice-mode culling (M-2) | absent | still absent (`local.js:65`, `render.js:269`) |
| `dt` clamp (R1) | 250 ms | unchanged (`server/index.js:2123`) |

What that changes below:

- **C-1 still applies unchanged.** At the head, the end-of-tick rebuild is at
  `sim.js:1566` and the advance loop at `1461`.
- **C-2 is no longer needed.**
- **H-2 needs one adaptation.** `sowOrbs` (`sim.js:445` at head) adds each new
  orb to the grid as it places it (`gridInsert`), so the next dart can keep
  its distance. A CSR layout is fixed between rebuilds, so it would need a
  small overflow list that queries also scan and that is folded in once it
  grows. This variant was not prototyped against the head. *(Since shipped,
  with per-bucket arrival lists and holes: see "Update: H-2 shipped".)*
- **New linear scan at the head (Low).** `underCell` (`sim.js:479`) tests every
  cell in the arena for every dart `sowOrbs` throws, and the zone can push
  that to 60 darts per orb. H-1's cell grid would serve it as well. Not
  measured separately.

The verdict is unchanged: B1 is still present at the head, and it fails the
critical requirement on its own.

## Verdict: FAIL

The structure is right and should be kept. Pellets go through a uniform grid,
and its query maths is correct: the grid returned every pellet in the query
box in 9,000 randomized queries, including bucket edges and arena corners.
Very large cells are handled, and nothing is ever consumed twice.

The failure is about **when** the index is read. It is read at two moments when
it does not describe the world, and both times the game skips a collision its
own rules require:

1. **Moving pellets are looked up where they were last tick.** The grid is
   rebuilt at the end of a tick, then pellets move at the start of the next one,
   and then everyone eats. A thrown blob can therefore sit inside a cell's reach
   while indexed in a bucket the cell's query does not visit. It is skipped, and
   it can pass straight through the cell and never be eaten.
2. **A new round eats from the previous round's index.** `resetArena` replaces
   every pellet but leaves the grid alone. The first `eatPellets` pass of the
   round runs against the old orbs: players can eat orbs that no longer exist
   and cannot eat the ones that do. When the round starts inside the tick (the
   first round of a room), the first live snapshot is built from the old index
   too.

Each fix is one line, and both are measured below. Performance is inside the
budget for a 100-player lobby. The largest avoidable cost is `cellCombat`'s
all-pairs loop once players split, and a grid broad phase that plays
bit-identically to it removes most of that cost.

---

## 1. Current implementation

Only pellets have a spatial index. Every other collision and proximity query
is a linear or all-pairs scan.

| System | Method | Where |
|---|---|---|
| Pellet index (orbs and ejected mass) | **Uniform grid.** 220-unit buckets in a `Map<int, Pellet[]>`, key `gx * 100003 + gy`. Rebuilt in full once per tick, at the **end** of the tick. Buckets are emptied and reused, never deleted. | `shared/sim.js:242-287` (`buildPelletGrid`, `forEachPelletNear`), rebuild at `sim.js:1323` |
| Player ↔ pellet | Grid query over the box `r + ORB_RADIUS*3` (r + 18), then an exact circle test, `r + 0.6 × pelletRadius`. Eaten pellets are flagged `dead` and swept once at the end of the tick. | `eatPellets`, `sim.js:698-724`; sweep `sim.js:1313-1317` |
| Player ↔ player | **All pairs.** Every ordered pair of live players, then every cell of A against every cell of B. Mass test, then an axis reject, then `Math.hypot`. | `cellCombat`, `sim.js:792-819` |
| A player's own cells (push and merge) | All pairs within one player: at most 16 cells, so at most 120 pairs. Restarts after each merge. | `resolveOwnCells`, `sim.js:588-617` |
| Cell ↔ virus | Linear scan of every virus for each cell above 126.5 mass, `Math.hypot` on each, with no reject first. | `eatViruses`, `sim.js:770-790` |
| Ejected mass ↔ virus | Linear scan of every pellet (velocity test first), then every virus for each moving owned pellet. | `feedViruses`, `sim.js:732-756` |
| Bot perception (test mode and practice only) | Linear scan of every cell in the arena per bot. Orbs come from grid queries of 300, 700 or 1,500, or 500 for hard bots grazing. | `driveBot`, `sim.js:1119-1149`, `1194-1202`; `grazeTarget`, `sim.js:1040-1049` |
| Server area of interest | Pellets: a grid query of R = max(760, 9r), exact centre test. Cells: linear scan of **every cell** per client. Viruses: `filter` over every virus per client. | `encodeSnapshot`, `shared/protocol.js:179-213` |
| Client, online | No index. It draws what the server sent (≤ R). Prediction tests the known pellets linearly, about 100–300 of them. | `client/net.js:580-603`, `client/render.js:230` |
| Client, practice | No index and **no culling**: all 4,100 orbs are converted and drawn every frame. | `client/local.js:65`, `client/render.js:230` |

There is no quadtree and no spatial hash besides the pellet grid.

### Tick order

`stepWorld` (`sim.js:1224-1326`), then the server's `tickRoom`
(`server/index.js:2011-2072`):

1. `advancePellet` on every pellet, `advanceVirus` on every virus (`sim.js:1229-1230`)
2. `feedViruses` (`1233`)
3. Per player, in join order: respawn, or bot AI → split/eject (which create cells and pellets) → `moveCells` → `resolveOwnCells` → **`eatPellets` (grid)** → `eatViruses` (`1235-1270`)
4. Standings, every fourth tick (`1275-1289`)
5. `cellCombat` (`1291`)
6. Deaths (`1293-1310`)
7. Sweep eaten pellets and top up (`1313-1317`)
8. **`buildPelletGrid`** (`1323`)
9. Server: round phase changes. `startRound` → `resetArena` can run here synchronously (`server/index.js:1557`). Then one `encodeSnapshot` per client (`2069`).

The grid read in step 3 was built in step 8 of the **previous** tick, before
step 1 moved anything. The comment at `sim.js:1319-1322` explains why the
rebuild moved to the end: snapshots need an index that includes pellets
created mid-tick. That reason is sound, but it moved the staleness from the
snapshot to the collision pass instead of removing it.

---

## 2. Correctness assessment

**Partially correct.** The query is correct; the timing of the index is not.

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Grid cell sizing | **OK** | 40 × 40 = 1,600 buckets on the 8,800 arena, 2.6 orbs each at 4,100 orbs (High stakes: 29 × 29, 2.4 each). An eat query spans 1–2 buckets per axis for a mass-20 cell and 8–9 for a radius-800 cell; a snapshot query spans 7–8. See the bucket-size sweep in §6. |
| 2 | Entity registration | **OK** | Every pellet in `world.pellets` is in the grid after each rebuild (C1, C9). Mass ejected during a tick joins at the end of that tick, so it cannot be eaten until the next tick, by anyone. That is a one-tick latency, applied equally to all players, and is not counted as a defect (see §4, "by design"). Cells and viruses are not indexed. |
| 3 | Entity movement | **FAIL** | Moving pellets are queried at last tick's position. Bug **B1**. |
| 4 | Large entities | **OK** | The query box grows with the radius. A radius-800 cell eats 360/360 orbs just inside its reach and 0/360 just outside, and 24/24 prey inside its eat radius with 0/24 outside (C7a, C7b). |
| 5 | Neighbouring regions | **OK, given a current index** | The box covers every bucket overlapping `[x ± (r + 18)]`: 9,000 random queries, 0 missing, 0 duplicates (C1); corners and bucket corners pass (C8). The fixed 18-unit pad quietly depends on `EJECT_KEEP` (finding L1). |
| 6 | Entity removal | **Partially** | Eaten pellets are flagged and skipped in the same tick, then swept before the rebuild. After 1,200 ticks and up to 29,559 eats, nothing was left behind (C6c). **`resetArena` removes every pellet without touching the index** (bug **B2**). |
| 7 | Split and merge | **OK** | Cells are not indexed. New split and burst pieces join that tick's combat because combat is brute force. Any future cell index must be built after splits, as the prototype here is. |
| 8 | Duplicate detection / double consumption | **OK** | A stacked chain of eats takes each victim once (C6a). An orb under two cells is eaten once (C6b). No pellet was eaten twice and no cell id was duplicated over 3,621–29,559 eats (C6c). Each unordered player pair is visited twice, once per direction (§3). |
| 9 | Stale references | **FAIL** | After `resetArena`, 400 of 400 index entries pointed at removed pellets (C2a), and one was eaten (C2c). Bug **B2**. |
| 10 | Dynamic sizes | **OK** | Reach is recomputed from current mass every tick. Growth within a tick only makes the test stricter: `r` is fixed for the rest of a query, and `ra` for the rest of a victim group. The extra reach is picked up next tick, and the game never over-eats. |
| 11 | High density | **OK** | 3,000 orbs and 100 players packed into 2.5% of the arena put up to 83 orbs in one bucket. The tick averaged 6.2 ms with a p99 of 29 ms, set by the first ticks: inside budget, no pathology. Orb piles do not last in this game (843 of 3,000 left after 10 ticks, 35 after 100), because refills land uniformly. |
| 12 | Tick consistency | **FAIL** | B1 and B2. Everything else is ordered consistently: snapshots are built from an index rebuilt after all mutation, and 40,000 snapshots matched a brute-force view query exactly (C9). |
| 13 | Coordinate boundaries | **OK** | Pellets are clamped to `[6, size - 6]`, query lower bounds are clamped at 0, and keys are unique for 0 ≤ gx, gy < 100,003. Corner orbs are eaten (C8). Upper bounds are not clamped, so large queries near the far walls look up buckets that do not exist (L2, cost only). |
| 14 | Grid filters, rules decide | **OK** | Every caller runs its own exact test (`sim.js:711-715`, `protocol.js:200`). With a current index the game matches a brute-force simulation tick for tick (C5, `fresh`). |

**Critical requirement, "never miss a valid collision": not met.** The cause
is not a neighbouring region or a cell spanning several regions; the grid
handles both correctly. The cause is that a moving pellet is indexed in the
region it occupied one tick earlier.

---

## 3. Performance assessment

The server holds a full lobby comfortably at 20 Hz. On one 2.8 GHz Xeon core,
the live Standard configuration (100 players, 4,100 orbs) costs **11.3 ms
average and 21.3 ms p99** of its 50 ms budget, bot AI excluded. That agrees
with the README's ~10–13 ms. 150 players and 5,000 orbs cost 21.2 ms average
and 41.8 ms p99. That still fits at 20 Hz but not at 30 Hz.

### Where a tick goes (Standard config, current code)

| Phase | ms / tick | Share | Complexity | Work per tick (measured) |
|---|---:|---:|---|---|
| Snapshots, 100 clients (`encodeSnapshot`) | 6.86 | 61% | O(clients × (ΣC + orbs in view)) | 14,682 pellet candidates, 60% of them in view; 24,880 cell visibility tests |
| `cellCombat` | 1.77 | 16% | **O(P² + (ΣC)²)** | **60,879** pair-loop iterations → 6.2 sqrt tests → 0.7 eats |
| Pellet grid rebuild | 0.98 | 9% | O(N + buckets) | 4,100 inserts into a `Map` of 1,600 arrays |
| `eatPellets` | 0.17 | 2% | O(ΣC × k), k ≈ 2.4 | 655 candidates → 649 circle tests → 6.7 eats |
| Everything else (movement, own cells, viruses, sweep) | ~1.5 | 13% | | 8,743 `Math.hypot` cell↔virus tests; ~600 own-cell pairs |
| Bot AI (test mode only; excluded above) | 1.79 | | O(P × ΣC) | every bot scans every cell |

In every scenario with 50 or more players, GC is 2.6–4.4% of the tick, all
minor collections, with the heap peaking at 22–27 MB. Allocation is not a
problem at this scale.

### Findings

1. **`cellCombat` is the only all-pairs loop, and it grows with the square of
   the cell count.** At 268 cells it runs 60,879 iterations for 6 real distance
   tests; at 490 cells (split play) it runs 237,569 iterations, which is 4.7 ms,
   or 23% of the tick. Each unordered player pair is walked twice, once per
   direction. The mass test rejects half the iterations and the axis test most
   of the rest, so each iteration is cheap, but there are a lot of them.
2. **The pellet grid itself is cheap to query but costly to rebuild.** The
   rebuild is 0.98 ms for 4,100 orbs, about 240 ns per orb, where the comment
   at `sim.js:248-250` expects "a fraction of a millisecond". Every tick it
   empties up to 1,600 arrays and refills them one push at a time through
   `Map.get`. A flat counting-sort layout rebuilds the same index,
   in the same order, in 0.26 ms, and its queries are faster too (§6).
3. **The grid is doing its job everywhere it is used.** A full scan in
   `eatPellets` would be 268 × 4,100 ≈ 1.1 M tests per tick against 649, and
   one in the snapshots would be 410,000 against 14,682.
4. **A giant's snapshot query is not bounded by the arena.** View radius is
   `9 × r` (`protocol.js:133`), and the query clamps the low bucket index but
   not the high one (`sim.js:277-279`). A mass-95,000 cell near a wall makes
   7,744 `Map` lookups for an arena with 1,600 buckets, 555 µs per query,
   against 1,681 lookups and 100 µs clamped (`results/query-bounds.txt`).
5. **Snapshots are most of the tick, but not because of the index.** 60–77%
   of the pellets the grid hands `encodeSnapshot` really are in view (60% on
   Standard). A circular view can fill at most 79% of its bounding box, so the
   grid is close to the geometric limit. The cost
   is per-client bookkeeping: a new `Set` of in-view ids per client per tick,
   `Set` lookups for every in-view orb, and a visibility test of every cell in
   the arena per client. That code enforces the protocol's anti-scouting rules
   (`protocol.js:7-21`), so it is outside this audit (see M3).
6. **Repeated sqrt.** `eatViruses` calls `Math.hypot` on every virus for every
   cell above 126.5 mass with no reject first (8,743 calls per tick).
   `radiusOf` (a sqrt) is recomputed for every cell per client in snapshots.
   Both are small next to the items above.
7. **No duplicate searches of note.** Split pieces of one player re-query
   overlapping boxes, but candidates per cell query average 2.4.
8. **Client and server do not both run collisions**, apart from deliberate
   prediction of the player's own orb eats (`net.js:580-603`). That loop only
   scans the 100–300 orbs the client knows about.

---

## 4. Bugs and glitches

### Confirmed bugs

**B1. Moving pellets are skipped by `eatPellets`.** `shared/sim.js:1229` moves
pellets, `1267` queries the grid built at `1323` on the previous tick. The
eat query pads the cell radius by 18 units (`sim.js:701`), but a thrown blob
moves 57 units in its first 50 ms tick and 177 units in a 250 ms tick. Once its
indexed bucket falls outside the query box it is not a candidate.

- *Reproduction (C3):* a blob indexed at x = 430 moves to x = 465, 15 units from
  a stationary cell whose reach is 26.5, and it is approaching. It is not eaten.
  Next tick it is past the centre and receding, so it is never eaten; it comes
  to rest at x = 575.
- *In play (C4, 400 ticks against a full scan at every query):* 6 skipped eats
  in an ejected-mass storm and 14 in rapid split play at 20 Hz; 75 in the
  storm at 250 ms ticks. The `fresh` variant skips 0 in every scenario.
- *Lockstep (C5):* the current game diverges from a brute-force reference
  simulation at tick 7 (storm) and tick 40 (splits). The `fresh` variant
  matches for all 1,200 and 400 ticks. Bot-only and churn rounds, which throw
  little mass, do not diverge in 1,200 ticks.
- *Who it hits:* feeding a rival or ally, mass thrown at small cells, and
  anyone standing near a virus that is being fed. It never affects stationary
  orbs.

**B2. `resetArena` leaves the previous round's index.** `sim.js:1331-1347`
refills `world.pellets` but not `world.grid`; it is called from `startRound`
(`server/index.js:1557`).

- *Reproduction (C2):* after a reset the index held 400 old pellets and none of
  the 400 new ones. A player standing where an old orb used to be ate it
  (`orbs` +1, mass +3.375). That is mass and orb count with nothing behind
  them, in a game that pays out on mass.
- *Snapshot:* when no re-stake is pending, which is the first round of a room
  because stakes are locked at join (`server/index.js:1839`), `startRound`
  reaches `resetArena` before its first `await`. That happens inside
  `tickRoom` after `stepWorld` and before the snapshot loop, so the round's
  first snapshot is encoded from the old index. In C2b it sent 12 orbs that do
  not exist and 0 of the 7 that do. The next tick corrects it, so players see
  the old orbs for one tick.
- *Every round:* even when `resetArena` runs between ticks (rounds two onward),
  the first `eatPellets` pass of the round reads the old index, because the
  next rebuild only happens at the end of that tick.

### Confirmed risk: discrete collision steps

**R1.** Collision is tested only at tick boundaries, and nothing tests the
path between them. Two cases are confirmed.

**At the normal 20 Hz tick, small split pieces skip small prey.** A split half
launches at `780 + 40·√m` u/s (`sim.js:93`). For a small half, one 50 ms step
is longer than its eat window on small prey. A mass-60 half covers ~68 units
in its first step, and its eat window on mass-20 prey is 42 units wide.

- *Measured:* a mass-120 cell splitting at still mass-20 prey 105–115 or
  165–170 units ahead has its launched half step straight over the prey (C11).
  The parent walks onto it 4–7 ticks later; moving prey would get away.
- *Size limit:* only halves below roughly 80 mass (on mass-20 prey) to 300 mass
  (on prey just under the eat ratio) are affected. Larger pieces have wider
  windows than their step.

**A late tick makes it general.** The server steps by the measured interval,
clamped at 250 ms (`server/index.js:2077`). One late tick (a GC pause, a slow
settle, a busy neighbour room) moves everything up to 5× further in one step:

| Per-step travel | 50 ms tick | 250 ms tick | Hit window it must not jump |
|---|---:|---:|---:|
| Ejected blob (1,304 u/s) | 57 | 177 | 113 (virus feed diameter) |
| Split half, mass 500 (1,674 u/s) | 76 | 264 | 159 (eat diameter on mass-20 prey) |
| Shot virus (820 u/s) | 39 | 165 | 90 (smallest poppable cell) |

C10 reproduces it: a feed into a virus 110 units ahead and a split onto prey
180 units ahead both land at 50 ms and both miss at 250 ms. The split piece
ends up 177 units past its prey. At 50 ms each of these steps is shorter than
its window, so only glancing contacts can be stepped over. Neither case is a
spatial-index defect; they are listed because the brief asks about collision
detection as a whole.

### Potential risks (not observed as failures)

- **Join-order bias.** Players are processed in `Map` insertion order. An
  earlier player gets contested orbs (`eatPellets` runs per player as each one
  moves) and the first bite in eat chains (`cellCombat`). This is deterministic,
  so it is not a desync, but it is an ordering rule. It is a gameplay rule and
  should not be changed in passing: **any replacement broad phase must preserve
  it exactly**, which is why the prototype in §5 reproduces the original
  iteration order.
- **Pad coupling (L1).** `ORB_RADIUS * 3` (18) only covers
  `0.6 × pelletRadius` while `EJECT_KEEP` ≤ 56. Raise ejected mass past that
  and blobs at the edge of reach start being missed even with a current index.
- **Bot stale reference.** `followUp.owner` can name a player removed mid-round.
  `removePlayer` does not clear `alive`, so the bot chases cells that no longer
  exist for up to 0.15 s, then splits at nothing (`sim.js:1002-1011`). Test
  mode and practice only.
- **Bot "nearest orb"** is the nearest among the buckets visited, not the true
  nearest beyond the reach radius (`sim.js:1195-1202`), so it depends on
  bucket alignment. Bots only, and it changes if `GRID` changes.
- **Client prediction reach** uses `ORB_RADIUS * 0.6` for every pellet
  (`client/net.js:583`) while the server uses `pelletRadius(p) * 0.6`, so the
  client predicts thrown-blob eats about 5 units late. Visual only; the
  server stays authoritative.

### By design (documented, not a defect)

- Mass ejected during a tick is not collidable until the next tick, for every
  player: C4 counts 97–239 such cases over 400 ticks in the throw-heavy
  scenarios. Allowing it would add
  more join-order dependence, not less.
- Growth during a tick is applied to collisions on the next tick (item 10).

---

## 5. Recommended improvements

Every prototype below is in `bench/spatial/build.mjs` as a text patch on a
copy of `sim.js`, so each one can be read as a diff. "Bit-identical" means the
lockstep test in `correctness.mjs` (section E) hashed the full world state
every tick for 1,200 ticks in six scenarios and found no difference.

### Critical: correctness

**C-1. Rebuild the pellet index after pellets move, before anyone eats.**
*Done, without the second rebuild: moving pellets are re-filed individually.
See "Update: B1 fixed" at the top.* This fixes B1. Add one call after the advance loops in `stepWorld`, before
`feedViruses` at `sim.js:1233`:

```js
for (const p of world.pellets) advancePellet(p, dt, world.size);
for (const v of world.viruses) advanceVirus(v, dt, world.size);
buildPelletGrid(world);          // index pellets where they are now
feedViruses(world);
```

Keep the end-of-tick rebuild (`sim.js:1323`); snapshots still need it.

- *Proof:* C3 passes, C4 reports 0 skipped eats in every scenario at 50 ms and
  at 250 ms, and the game matches the brute-force reference simulation for
  every tick (C5).
- *Cost:* +0.15 to +0.96 ms per tick with today's `Map` grid (+0.57 ms on
  Standard). With C-1 and H-2 together, both rebuilds cost 0.32 ms, which is
  less than today's single rebuild.
- *Effect on play:* outcomes change only where today's code skips an eat the
  rules require. No rule, speed or mass changes.

**C-2. Rebuild the index in `resetArena`.** This fixes B2. Call
`buildPelletGrid(world)` at the end of `resetArena` (`sim.js:1346`), after the
pellets are refilled. C2a, C2b and C2c then pass. The cost is one rebuild per
round.

### High: meaningful, measured optimisation

**H-1. Give `cellCombat` a uniform-grid broad phase.** *Done, with each cell
filed by its path this tick for the swept test. See "Update: H-1 shipped" at
the top.* Insert every live cell
by its **centre** into 256-unit buckets at the start of `cellCombat`. Each
attacker cell then queries the box of half-size `ra` around itself.

- *Why centre-only insertion is complete:* a victim can only be eaten when its
  centre is inside the attacker (`d < ra − 0.55 rb < ra`). So no cell needs
  inserting into several buckets, however large either cell is; a big attacker
  simply spans more buckets in its query.
- *Measured:* 1.77 → 0.14 ms on Standard (13×), 4.73 → 0.21 ms in split play
  (22×), 3.89 → 0.21 ms at 150 players (19×). p99 on Standard drops from 21.3
  to 18.6 ms with this change alone. It is slower only when there are very
  few cells (10 players: 0.017 → 0.062 ms), which is negligible in absolute
  terms.
- *It must keep the original iteration order*, because eat chains depend on it
  (§4, join-order bias). That means attackers in join order, victims in join
  order, attacker cells in order, victim cells from the back; the radius
  frozen per victim group and the mass test live; and a re-query whenever an
  attacker cell grows. The prototype does all of this and is bit-identical.
- *Warning, learned the hard way:* the first version also pre-filtered
  candidates by mass. That is **not** exact, because a cell that grows
  mid-group can eat a victim it was too small for when the group began. It
  diverged on the 50-player scenario. Keep a lockstep test like section E next
  to whatever ships.

**H-2. Store the pellet grid as a flat CSR array, and clamp both ends of the
query.** *Done, with arrival lists for what is filed between rebuilds. See
"Update: H-2 shipped" at the top.* One stable counting sort per rebuild into a reused
`Int32Array` offset table and one pellet array (prototype: `CSR_GRID` in
`build.mjs`). It keeps the same bucket visit order and the same order within a
bucket, so it is bit-identical.

- *Measured:* rebuild 0.98 → 0.26 ms on Standard. The whole tick drops from
  11.3 to 8.6 ms, because snapshot and eat queries get cheaper too (snapshots
  6.86 → 5.36 ms).
- *Giant cells:* query cost falls by up to 5.6×, from clamping the high bound
  (L2 is included in this change).
- It makes C-1 essentially free.

### Medium: smaller or less certain benefit

**M-1. Let fast pieces collide along their path.** *Done with the swept
test; the step length and tick rate are unchanged. See "Update: R1 fixed" at
the top.* This addresses R1, in two parts.

- **Bound the step.** `server/index.js:2077` lets one `stepWorld` cover up to
  250 ms. Either split a long interval into sub-steps of at most `1 / TICK_HZ`,
  or clamp `dt` lower.
  - Sub-steps keep game speed. They cost one extra sim pass per sub-step, only
    on late ticks: about 4–5 ms each on Standard, snapshots excluded,
    estimated from the phase timings, not measured.
  - Clamping instead slows the game during a stall.
- **Swept test for launched pieces.** Cells still carrying split or burst
  velocity (`c.vx || c.vy`) number a handful per tick. Test them against prey
  along the segment they moved this tick, not only at its end. The same applies
  to thrown blobs against viruses in `feedViruses`. This closes the 20 Hz case,
  which sub-stepping does not.

Both change outcomes: some engulfs and feeds that miss today would land. That
makes this a gameplay decision as much as a correctness fix, so it is ranked
Medium and left to you.

**M-2. Cull orbs to the screen in practice mode.** `client/local.js:65` hands
the renderer all 4,100 orbs every frame, of which 31 (0.76%) are on a 1080p
screen (`bench/spatial/client-view.mjs`). In headless Chromium, drawing a frame
with all of them takes 9.4 ms against 5.2 ms with only the visible ones
(`client-render.mjs`, median of 3 runs; software raster, so indicative only).
A box test against the camera before `render.js:230`, or in `getView`,
removes it. Online play is
unaffected, because the server already culls to the view radius.

**M-3. Snapshot bookkeeping (not prototyped).** This is the largest remaining
cost (55–75% of the tick with 50 or more players), but it is per-client delta state, not spatial
indexing. For example, a per-client "last seen tick" stamp could replace a new
`Set` per client per tick. It lives in the code that enforces the protocol's
scoping rules, so it should be its own change with its own tests. It was
deliberately left alone here.

### Low: optional refinements

| Id | Change | Where |
|---|---|---|
| L1 | Derive the eat query pad from the largest pellet radius (`0.6 × pelletRadius` of `EJECT_KEEP`), or assert `EJECT_KEEP ≤ 56`, so a tuning change cannot silently open a gap. | `sim.js:701` |
| L2 | Clamp `x1`/`y1` to the last bucket. Part of H-2; two lines on its own. | `sim.js:277-279` |
| L3 | Axis reject (or squared compare) before `Math.hypot` in `eatViruses`. | `sim.js:776` |
| L4 | Compact pellets in place instead of `filter` every tick; drop the `[...].filter` copy in `cellCombat`. GC is ~3% of the tick, so the gain is small. | `sim.js:1314`, `793` |
| L5 | Bots: drop `followUp` when its owner leaves `world.players`; have the nearest-orb search accept a find only within the reach it asked for. Test mode and practice only. | `sim.js:1004`, `1195-1202` |
| L6 | Client prediction: use `pelletRadius` for thrown blobs, as the server does. | `client/net.js:583` |

### Keep as is

- **A uniform grid for pellets.** Orbs spawn uniformly (`spawnPoint`), and a
  dense pile does not last: 3,000 orbs packed into 2.5% of the arena were down
  to 843 after 10 ticks and 35 after 100. Large cells are handled by the query
  extent. A quadtree would add rebuild cost and pointer chasing for a
  distribution that is already uniform.
- **Full rebuild every tick, plus dead-flag-and-sweep.** With CSR a rebuild is
  0.11–0.26 ms at 3,000–4,100 orbs (0.45 ms at 5,000). Incremental maintenance would save less than that and bring
  back the class of stale-index bugs the comment at `sim.js:248-250` set out to
  remove.
- **No separate index for static and moving pellets.** Considered and not
  recommended; it was not prototyped. Few orbs move at any time, so the only
  gain would be skipping one rebuild, and C-1 + H-2 already make that cheaper
  than today's single rebuild. It would add a second structure every query
  must merge.
- **Linear scans over viruses** (90–135 entities), and the all-pairs own-cell
  loop (≤ 120 pairs).

### Grid sizing strategy

- **Pellets: keep 220-unit buckets.** A mass-20 cell's eat query spans 1–2
  buckets per axis; a radius-800 cell's spans 8–9 (≤ 81 buckets); a snapshot
  spans 7–8. Large and small cells both work because the query box grows with
  the radius, never the bucket. The sweep in §6 compares 110 and 440. Note that
  `GRID` is not behaviour-neutral for bots, whose nearest-orb choice depends on
  bucket alignment.
- **Cells (H-1): 256-unit buckets, centre insertion.** A radius-800 attacker
  queries at most 8 × 8 buckets and a small cell 1–4. Victims never need
  multi-bucket insertion, for the reason given in H-1.

---

## 6. Benchmark comparison

Measured on one core of an Intel Xeon @ 2.80 GHz, Node 22.22.0. Each figure
is the median of 3 runs of 900 measured ticks after 300 warm-up ticks, dt =
0.05, each run in a fresh process (`bench/spatial/bench.mjs`; raw data in
`results/bench.json`). The dense cluster is transient, so it is measured from
its first tick, 300 ticks per run, with the JIT warmed on a throwaway world.
Bots drive the `bots` scenarios, and their AI time is subtracted from the
"excl. bot AI" columns, because the live arena is human-only. The last three
scenarios use scripted human inputs.

**Noise.** Tick averages vary by about ±1 ms run to run at 10–20 ms. For
example, the snapshot phase, whose code is identical in `current`, `fresh` and
`gcombat`, differs by up to 1.1 ms between them. The component timers (grid,
combat) are the precise numbers; use them to judge a single change.

### 6.1 Current implementation

**Current code**, ms per room tick. A tick is `stepWorld` plus one `encodeSnapshot` per player.

| Scenario | Players | Orbs | Cells (avg) | Avg | p95 | p99 | Avg excl. bot AI | p99 excl. bot AI | Snapshots | `cellCombat` | Grid rebuild | `eatPellets` | GC % | Peak heap MB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Low population | 10 | 500 | 26 | 0.70 | 1.41 | 2.61 | **0.54** | **2.10** | 0.24 | 0.017 | 0.133 | 0.013 | 8.9 | 13.7 |
| Moderate population | 50 | 1,500 | 114 | 3.18 | 5.34 | 7.11 | **2.56** | **5.51** | 1.46 | 0.314 | 0.356 | 0.046 | 3.0 | 21.8 |
| Full lobby | 100 | 3,000 | 257 | 11.59 | 16.82 | 19.81 | **9.86** | **18.09** | 5.98 | 1.732 | 0.794 | 0.146 | 3.0 | 23.2 |
| Dense cluster | 100 | 3,000 | 106 | 7.08 | 12.19 | 29.64 | **6.18** | **29.05** | 4.65 | 0.367 | 0.462 | 0.083 | 3.4 | 24.0 |
| Stress test | 150 | 5,000 | 405 | 25.61 | 39.60 | 45.58 | **21.20** | **41.83** | 13.74 | 3.885 | 1.135 | 0.342 | 4.4 | 25.6 |
| Standard mode (live config) | 100 | 4,100 | 268 | 13.02 | 19.34 | 24.86 | **11.26** | **21.28** | 6.86 | 1.771 | 0.976 | 0.172 | 2.6 | 23.6 |
| Very large cells | 100 | 3,000 | 278 | 14.44 | 20.42 | 26.96 | **12.40** | **23.79** | 8.46 | 1.723 | 0.718 | 0.195 | 4.1 | 24.7 |
| Rapid split + merge | 100 | 3,000 | 490 | 20.78 | 32.06 | 37.41 | **20.78** | **37.41** | 12.18 | 4.729 | 0.843 | 0.327 | 3.0 | 26.3 |
| Ejected-mass storm | 100 | 3,000 | 196 | 9.72 | 14.45 | 16.91 | **9.72** | **16.91** | 7.02 | 0.947 | 0.522 | 0.155 | 3.1 | 24.9 |
| Spawn + consume churn | 100 | 3,000 | 127 | 5.85 | 8.85 | 11.30 | **5.85** | **11.30** | 4.37 | 0.542 | 0.506 | 0.066 | 2.6 | 22.6 |

### 6.2 Collision candidates

**Broad and narrow phase per tick** (counted build, current code)

| Scenario | Eat: grid candidates | Eat: circle tests | Orbs eaten | Combat: pair-loop iterations | Combat: sqrt tests | Cells eaten | Cell↔virus `hypot` | Snapshot: pellet candidates | Snapshot: cell tests | Grid buckets visited |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Low population | 7 | 7 | 0.2 | 223 | 0.1 | 0.01 | 413 | 114 | 161 | 800 |
| Moderate population | 116 | 115 | 1.6 | 12,418 | 1.6 | 0.20 | 2,464 | 2,417 | 5,691 | 3,844 |
| Full lobby | 439 | 435 | 4.7 | 55,566 | 6.0 | 0.59 | 7,402 | 10,437 | 23,739 | 7,795 |
| Dense cluster | 592 | 568 | 11.4 | 11,183 | 7.5 | 0.84 | 4,541 | 11,975 | 10,590 | 7,021 |
| Stress test | 1,446 | 1,432 | 13.1 | 162,162 | 10.5 | 1.18 | 14,598 | 30,469 | 60,708 | 12,746 |
| Standard mode (live config) | 655 | 649 | 6.7 | 60,879 | 6.2 | 0.70 | 8,743 | 14,682 | 24,880 | 8,280 |
| Very large cells | 728 | 722 | 7.5 | 76,648 | 9.7 | 0.66 | 9,160 | 20,787 | 27,774 | 23,820 |
| Rapid split + merge | 2,007 | 1,131 | 20.6 | 237,569 | 9.2 | 2.23 | 17,646 | 30,255 | 48,770 | 24,497 |
| Ejected-mass storm | 1,155 | 593 | 12.3 | 38,005 | 4.4 | 0.84 | 3,384 | 18,295 | 19,716 | 13,624 |
| Spawn + consume churn | 201 | 201 | 2.4 | 15,745 | 5.5 | 1.22 | 1,118 | 10,303 | 12,661 | 9,607 |

### 6.3 `cellCombat` broad phase

**`cellCombat`: all pairs vs grid broad phase** (counted builds; identical sqrt tests and eats, as they must be)

| Scenario | All pairs: iterations | Grid: bucket entries visited | Grid: candidate tests | Sqrt tests | Cells eaten | Time, all pairs → grid (ms) |
|---|---:|---:|---:|---:|---:|---:|
| Low population | 223 | 37 | 0 | 0.1 | 0.01 | 0.017 → 0.062 |
| Moderate population | 12,418 | 478 | 3 | 1.6 | 0.20 | 0.314 → 0.062 |
| Full lobby | 55,566 | 1,035 | 11 | 6.0 | 0.59 | 1.732 → 0.138 |
| Dense cluster | 11,183 | 397 | 15 | 7.5 | 0.84 | 0.367 → 0.109 |
| Stress test | 162,162 | 1,839 | 17 | 10.5 | 1.18 | 3.885 → 0.207 |
| Standard mode (live config) | 60,879 | 1,099 | 12 | 6.2 | 0.70 | 1.771 → 0.141 |
| Very large cells | 76,648 | 1,264 | 14 | 9.7 | 0.66 | 1.723 → 0.138 |
| Rapid split + merge | 237,569 | 2,610 | 10 | 9.2 | 2.23 | 4.729 → 0.213 |
| Ejected-mass storm | 38,005 | 771 | 5 | 4.4 | 0.84 | 0.947 → 0.106 |
| Spawn + consume churn | 15,745 | 265 | 6 | 5.5 | 1.22 | 0.542 → 0.099 |

### 6.4 Proposed changes

**Variants**, ms per room tick excluding bot AI, avg / p99 (median of 3 reps). `all` = fresh + csr + gcombat.

| Scenario | current | fresh (C-1, C-2) | csr (H-2) | gcombat (H-1) | all | all vs current |
|---|---:|---:|---:|---:|---:|---:|
| Low population | 0.54 / 2.10 | 0.75 / 2.33 | 0.38 / 1.65 | 0.61 / 2.42 | 0.52 / 2.45 | -4% avg, +17% p99 |
| Moderate population | 2.56 / 5.51 | 2.70 / 6.70 | 2.29 / 5.28 | 2.16 / 5.27 | 1.99 / 5.11 | -22% avg, -7% p99 |
| Full lobby | 9.86 / 18.09 | 9.69 / 17.72 | 7.61 / 17.14 | 7.71 / 13.58 | 6.80 / 14.96 | -31% avg, -17% p99 |
| Dense cluster | 6.18 / 29.05 | 7.13 / 29.31 | 6.23 / 40.16 | 6.77 / 28.90 | 5.77 / 30.94 | -7% avg, +7% p99 |
| Stress test | 21.20 / 41.83 | 24.01 / 42.94 | 18.98 / 39.10 | 18.71 / 36.32 | 16.36 / 34.06 | -23% avg, -19% p99 |
| Standard mode (live config) | 11.26 / 21.28 | 10.84 / 23.10 | 8.58 / 17.76 | 9.30 / 18.58 | 6.92 / 12.81 | -39% avg, -40% p99 |
| Very large cells | 12.40 / 23.79 | 13.43 / 27.77 | 10.67 / 20.49 | 11.23 / 22.60 | 9.38 / 19.35 | -24% avg, -19% p99 |
| Rapid split + merge | 20.78 / 37.41 | 19.70 / 36.89 | 15.97 / 35.84 | 16.04 / 29.79 | 12.80 / 23.90 | -38% avg, -36% p99 |
| Ejected-mass storm | 9.72 / 16.91 | 10.13 / 19.20 | 8.19 / 16.41 | 9.93 / 19.18 | 7.19 / 13.41 | -26% avg, -21% p99 |
| Spawn + consume churn | 5.85 / 11.30 | 6.46 / 12.77 | 5.09 / 9.92 | 5.78 / 12.20 | 4.70 / 9.04 | -20% avg, -20% p99 |

**Component timers**, ms per tick: pellet-grid rebuilds (both rebuilds for `fresh` and `all`) and `cellCombat`.

| Scenario | Grid: current | fresh | csr | all | Combat: current | gcombat | all |
|---|---:|---:|---:|---:|---:|---:|---:|
| Low population | 0.133 | 0.278 | 0.022 | 0.045 | 0.017 | 0.062 | 0.054 |
| Moderate population | 0.356 | 0.636 | 0.069 | 0.096 | 0.314 | 0.062 | 0.073 |
| Full lobby | 0.794 | 1.270 | 0.207 | 0.272 | 1.732 | 0.138 | 0.141 |
| Dense cluster | 0.462 | 0.876 | 0.114 | 0.166 | 0.367 | 0.109 | 0.099 |
| Stress test | 1.135 | 2.093 | 0.446 | 0.644 | 3.885 | 0.207 | 0.217 |
| Standard mode (live config) | 0.976 | 1.541 | 0.263 | 0.321 | 1.771 | 0.141 | 0.130 |
| Very large cells | 0.718 | 1.260 | 0.219 | 0.317 | 1.723 | 0.138 | 0.153 |
| Rapid split + merge | 0.843 | 1.309 | 0.235 | 0.255 | 4.729 | 0.213 | 0.195 |
| Ejected-mass storm | 0.522 | 1.114 | 0.162 | 0.205 | 0.947 | 0.106 | 0.096 |
| Spawn + consume churn | 0.506 | 0.961 | 0.114 | 0.190 | 0.542 | 0.099 | 0.095 |

Reading the variant table:

- **The two fixes on their own (`fresh`) cost the extra rebuild:** +0.15 to
  +0.96 ms per tick on the `Map` grid. Tick averages for `fresh` move by more
  than that in both directions, which is noise.
- **CSR (`csr`)** cuts the rebuild 2.5–6×. On the 100-player scenarios it
  takes 0.8–4.8 ms off the tick, because queries get faster as well (dense:
  no change).
- **The grid broad phase (`gcombat`)** turns `cellCombat` from 0.3–4.7 ms into
  0.06–0.21 ms wherever there are more than ~100 cells.
- **All three together (`all`)** fix both bugs and make the live config 39%
  cheaper on average and 40% at p99: 11.3 → 6.9 ms, and 21.3 → 12.8 ms.
- **Small or noisy rows:** the low-population and dense rows move within
  noise. Dense p99 is set by its first ticks, when ~1,000 orbs are eaten at once
  and every client is sent the whole cluster.

### 6.5 Bucket size

The recommended layout (`all`) at 110, 220 and 440-unit buckets, ms per tick,
median of 3 runs (`results/bench-gridsize.json`). Changing the bucket size
changes the order in which pellets are visited, and with it bot targeting, so
these runs are not bit-identical to each other.

| Scenario | Bucket | Avg excl. AI | p99 | Snapshots | Grid rebuilds | eatPellets | Bot AI |
|---|---:|---:|---:|---:|---:|---:|---:|
| Dense cluster | 110 | 5.28 | 37.90 | 4.36 | 0.185 | 0.057 | 0.89 |
| Dense cluster | 220 | 5.19 | 23.76 | 4.07 | 0.150 | 0.062 | 0.88 |
| Dense cluster | 440 | 5.67 | 29.52 | 4.64 | 0.160 | 0.101 | 0.97 |
| Standard mode (live config) | 110 | 6.67 | 17.25 | 4.94 | 0.333 | 0.082 | 1.47 |
| Standard mode (live config) | 220 | 7.07 | 13.83 | 5.17 | 0.329 | 0.108 | 1.57 |
| Standard mode (live config) | 440 | 7.51 | 17.61 | 5.57 | 0.314 | 0.201 | 1.70 |
| Very large cells | 110 | 9.86 | 18.24 | 7.82 | 0.309 | 0.108 | 1.57 |
| Very large cells | 220 | 8.41 | 16.60 | 6.65 | 0.272 | 0.121 | 1.49 |
| Very large cells | 440 | 9.24 | 19.26 | 7.17 | 0.266 | 0.182 | 1.47 |
| Rapid split + merge | 110 | 13.85 | 27.00 | 11.03 | 0.318 | 0.168 | 0.00 |
| Rapid split + merge | 220 | 13.07 | 28.63 | 10.20 | 0.255 | 0.216 | 0.00 |
| Rapid split + merge | 440 | 12.88 | 23.29 | 9.98 | 0.245 | 0.340 | 0.00 |

Smaller buckets make `eatPellets` cheaper (0.08 / 0.11 / 0.20 ms on Standard),
but that phase is tiny. Snapshots, which dominate, show no consistent winner:
110 is best on Standard, 220 on giants and dense, 440 on splits. Every
difference is within run-to-run noise. **Keep 220.**

### 6.6 Very large cells and the query bound

`bench/spatial/query-bounds.mjs`: one `forEachPelletNear` call at a snapshot
radius of `max(760, 9r)`, 4,100 orbs.

| Cell mass | View radius | Position | `Map` grid: bucket lookups | µs | CSR, clamped: lookups | µs |
|---:|---:|---|---:|---:|---:|---:|
| 100 | 760 | centre | 64 | 5.3 | 64 | 6.6 |
| 20,000 | 5,091 | near far corner | 2,209 | 148.9 | 729 | 43.8 |
| 40,000 | 7,200 | near far corner | 4,489 | 274.9 | 1,369 | 133.7 |
| 95,000 | 11,096 | near far corner | 7,744 | 555.5 | 1,681 | 99.5 |

At normal sizes the two layouts cost the same. The giants scenario reached
radius 1,235 (mass ~95,000), so this does happen in play.

### 6.7 Client (practice mode)

| | All orbs (today) | Only on-screen orbs |
|---|---:|---:|
| Orbs handed to the renderer per frame (`client-view.mjs`, 1080p) | 4,100 | 31 (0.76%) |
| `getView()` per frame, Node | 0.19 ms | not measured |
| `draw()` per frame, headless Chromium, software raster (`client-render.mjs`, median of 3 runs) | 9.4 ms | 5.2 ms |

### 6.8 Correctness checks

`bench/spatial/correctness.mjs`, full run: 61 checks, 50 pass and 11 fail. All
11 failures are on the current code and are reproductions of B1, B2 and R1.
Raw output: `results/correctness.txt`.

| Check | What it verifies | current | proposed |
|---|---|---|---|
| C1 | Grid query returns every pellet in the box, once: 9,000 random queries, bucket lines, corners | PASS | PASS (csr) |
| C2a–c | After `resetArena`: index matches the world, first snapshot is right, no ghost orb is eaten | **FAIL** (400 stale entries; 12 ghost orbs sent, 0 of 7 real; 1 ghost eaten) | PASS (fresh) |
| C3 | A blob entering a cell's reach is eaten that tick | **FAIL** (passes through, never eaten) | PASS (fresh) |
| C4 | Shadow full scan at every `eatPellets` query, 400 ticks | **FAIL** in storm (6) and splits (14) at 50 ms, storm at 250 ms (75); PASS in bot and churn rounds | PASS, 0 everywhere (fresh) |
| C5 | Lockstep against a brute-force reference simulation | **FAIL** in storm (tick 7) and splits (tick 40); PASS bots and churn, 1,200 ticks | PASS, all (fresh) |
| C6a–c | No double consumption: stacked chains, shared orb, 1,200-tick runs with up to 29,559 eats | PASS | — |
| C7a–b | Radius-800 cell vs orbs and prey across its whole body | PASS | PASS (gcombat) |
| C8 | Corners, walls, bucket corners | PASS | PASS (csr) |
| C9 | 40,000 snapshots match a brute-force view query exactly | PASS | — |
| C10 | A feed and a split-engulf that land at 20 Hz still land on a 250 ms tick | **FAIL** (both miss) | not addressed (M-1) |
| C11 | A split half that passes over smaller prey at 20 Hz eats it | **FAIL** (skipped at 105–115 and 165–170 units) | not addressed (M-1) |
| E | `csr`, `gcombat` and `all` play bit-identically to what they replace, 1,200 ticks × 6 scenarios | — | PASS, all 18 |

---

## 7. Final verdict

**FAIL.** The implementation has confirmed correctness problems that need
changes: valid collisions are missed (B1), and the index points at the
previous round (B2). That fails the brief's critical requirement. At the
branch head B2 has since been fixed upstream, but B1 remains, and it is enough
on its own for this verdict.

The verdict is about *when* the index is used, not *what* the index is:

- **Keep the uniform pellet grid.** Its geometry is right for this game. It
  handles cells of any size, survives dense piles, and narrows collision and
  view queries by 28–1,700× over a full scan.
- **The structure is never wrong when it is current:** with C-1 and C-2 it
  matches a brute-force reference simulation tick for tick, and it passes
  every index check here (C1–C9). C10 and C11 are narrow-phase stepping,
  which needs M-1.
- **Capacity:** a 100-player lobby fits today, at 11.3 ms average and 21.3 ms
  p99 of a 50 ms tick on this machine. With H-1 and H-2 as well, it measures
  6.9 ms average and 12.8 ms p99, and plays bit-identically.

Order of work:

1. **C-1, plus C-2 if working from `d93f567`:** one-line fixes, with no
   gameplay change beyond eating what the rules already say is eaten.
2. **H-2 (CSR layout):** pays for C-1 and more. At the head it also needs the
   overflow list for `sowOrbs`.
3. **H-1:** only with its lockstep test alongside.

The rest is optional.

---

## Appendix: method and limits

- **Machine:** one core of an Intel Xeon @ 2.80 GHz (4-core VM, 16 GB),
  Node 22.22.0, Linux. Absolute numbers will differ on Render; the README's
  own estimate is roughly 2× slower per core on the 0.5-CPU Starter plan.
  Ratios between variants should carry over.
- **What a tick includes:** `stepWorld` plus one `encodeSnapshot` per player,
  which is what `tickRoom` does. It does not include `ws.send`, settlement,
  database calls or a second room in the same process.
- **Players:** bots, hard level, starting from a mid-round mass spread (median
  ~70, tail to ~3,000), stand in for humans in the `bots` scenarios; their AI
  is timed separately and excluded. Split, storm and churn scenarios use
  scripted inputs. Respawns use the game's own start mass. An earlier version
  of the harness topped respawns up to fixture mass, and one cell grew past the
  arena; those runs were discarded.
- **Instrumentation:** every variant, including `current`, carries the same
  phase timers, about 20–40 µs per tick. Counters and the brute-force shadow
  check run only in the `counted` builds, never in timed runs.
- **Not measured:**
  - production hardware;
  - more than one room per process;
  - real network I/O;
  - real human input distributions;
  - rounds longer than 60 s of simulated time;
  - GPU rendering in a real browser (the canvas figures are headless software
    raster);
  - the cost of M-1's sub-steps during an actual stall;
  - client prediction accuracy.
- **Reproducing:** see [`bench/spatial/README.md`](../bench/spatial/README.md).
  Every run is seeded, and every result in this document came from the
  commands listed there.
