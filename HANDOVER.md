# Handover

Engulfs — an agar.io-style game with real-money wagering, at [engulfs.io](https://engulfs.io).

`README.md` is the reference: architecture, wire protocol, tuning, the full cheating
analysis. This file is the shorter thing you want first — what state it is in, what is
dangerous, and what will waste your afternoon.

**Current state.** Work sits on `claude/nice-keller-z8vfyf` at `1d57667`, **six commits
ahead of `64cf34e` and not merged to `main`**. No pull request has been opened. All
fourteen test suites green. Supabase migrations `002`–`006` applied.

That branch changes gameplay and the wire format. Read "What the open branch does"
before deploying it, particularly the protocol bump.

---

## Do not enable real money until these are fixed

Ranked by how much they cost you, worst first. `README.md` has a longer
"Before real money" checklist covering legal, KYC and responsible-gambling
obligations; these four are the code. **None of them is fixed on the open branch.**

### 1. Disconnecting refunds your stake

**The exploit works today.** Drop your connection when you are about to be eaten and
you get your money back.

Cells linger for six seconds after a socket drops, motionless and edible, which is
the right rule and looks like it works. The ledger disagrees:

- `settle()` finds the victim with `accountOfPlayer()` (`server/index.js:678`), which
  scans `room.clients` for a live connection.
- `cleanup()` has already removed that entry, so the victim resolves to `null` and
  settlement returns early at `server/index.js:696`. The killer is paid nothing.
- The linger sweep then refunds the stake unconditionally at `server/index.js:1295`.
  Its comment says "nobody beat them". Somebody did; nothing recorded it.

The fix is to settle a lingering player by `accountId` rather than by live connection,
and to clear the lingering entry when the body is eaten. `claimLingering()`
(`server/index.js:447`) already does the second half for rejoins and is the place to
start.

### 2. A bot eating you pays the house

`forfeit_pot()` fires whenever the killer cannot hold a stake, which includes every
bot in the arena. The operator profits when an NPC kills a paying customer.
`server/ledger.js` calls this out in its own comment as indefensible.

The fix is bot-free wagered rooms, which is a matchmaking change this codebase does
not have.

### 3. No detection of scripted play

A client that aims perfectly and never misjudges a split sends legitimate input.
Nothing looks for it. Once there is money on the table this is the rational way to
play, and there is no clawback if you find it after the fact.

### 4. No detection of collusion or multi-accounting

Two accounts, one feeds the other. There is no same-IP-in-one-room check, no
mass-transfer graph, no shared-device signal. Sign-up takes a username, a password
and a self-declared date of birth — no email verification, no phone, no identity
check.

The only friction is mechanical: ejecting spends 16 mass and delivers 13
(`shared/sim.js`), so feeding leaks about a fifth per throw. The player manual now
states plainly that coordinated feeding in a wagered round is collusion, which is
documentation, not enforcement.

---

## What the open branch does

Six commits, each verified in a real browser against a real server as well as by the
suite. In order:

| Commit | What it changes |
|---|---|
| `ee866bf` | Round starts place the field on an equally spaced ring; a 5-second countdown before the whistle |
| `dbadd95` | Fixes a death card appearing at the moment a round opened |
| `692e775` | Feeding a virus three blobs of ejected mass splits it |
| `5e1f284` | A generated player's manual, `docs/engulfs-field-manual.pdf` |
| `ac9a347` | Manual: a technique chapter |
| `1d57667` | Manual: a chapter on spawn position and orb/virus layout |

### Read this before deploying the branch

**`PROTOCOL_VERSION` went 7 → 8.** Viruses now carry a compact id and a feed count
alongside their position, 7 bytes up from 4. The version check is enforced, so every
browser tab open against the old build is refused on its next connect and shown
"out of date, reload". That is the designed behaviour, not a fault — but it means a
deploy disconnects everyone mid-round, and a round in progress is a round of real
stakes. Deploy between rounds, or accept that.

**`COUNTDOWN_SECONDS` is a new environment variable**, default 5. It is deliberately
*not* shortened in test mode: a round that starts without passing through
`PHASE_COUNTDOWN` is a different code path from the one that ships.

### Things about it that will surprise you

**A full lobby opens on the perimeter.** Equal spacing at 100 players asks for a
bigger circle than the arena holds, so the ring clamps to the widest one that fits —
radius 4260, exactly on the 140-unit wall padding, neighbours 268 apart. Everyone
starts with their back to a wall and the whole centre of the map empty. That is a
real consequence of the rule, it is intentional, and it changes the opening seconds
of a round. If you would rather trade exact equality for using the whole board, a
phyllotaxis spiral gives near-even *density* instead; `spawnRing()` in
`shared/sim.js` is the only thing to change.

**The virus population is no longer fixed.** Feeding adds viruses up to
`VIRUS_MAX_RATIO` (1.5) times the count the arena seeds — 135 in Standard. Eating a
virus now tops the population back up *only when it is below the seeded count*;
replacing unconditionally would have made every split permanent, so a long round
could only ever gain viruses. If you raise the ceiling, check the tick cost first.

**`round_start` is not proof that you are alive.** This caused a live bug and the
shape of it will recur. The newest snapshot a client holds when the whistle blows was
encoded during the count, when `toLobby` has despawned everyone — and from round two
onwards the server is *guaranteed* to send one, because re-staking makes `startRound`
await and a tick fits in the gap. The client used to take `round_start` as "we are
alive now", read that stale frame on its next animation frame as having just been
eaten, and throw up a death card carrying the previous round's figures. The client now
arms its death check only from a snapshot that actually shows it alive (`seenAlive` in
`client/main.js`). **Do not set that flag from an assumption.**

**The count is entered from inside `tickRoom`.** `beginRound` yields at the first
`await` in `startRound`, so the phase stays `PHASE_COUNTDOWN` across the awaits and
the tick keeps sending snapshots. The tick's countdown branch is guarded with
`!room.starting` for exactly that reason.

---

## Smaller open items

| Item | Where |
|---|---|
| Accounts created before the age gate have `date_of_birth` NULL and are not gated | `server/db/migrations/006_age_gate.sql` |
| End-of-round copy is hardcoded to ten minutes and top five; wrong under other config | `index.html:1042` (`roundBlurb`) |
| Two unreferenced images ship in the container, 868 KB | `assets/ChatGPT Image Sep 12…png`, `assets/image-1789204331359.png` |
| `mark.png` is 796 KB and only used by the icon build script, never at runtime | `assets/mark.png`, `scripts/icons.mjs` |
| `npm install && npm test` fails — see the `ws` trap below | `test/rooms.test.js`, `test/resume.test.js` |
| README's cheating table is stale in three places | see below |

The three stale README claims, all still stale:

| README says | Code does |
|---|---|
| `maxPayload` 128 bytes | 512 (`MAX_PAYLOAD`, raised when the join frame grew) |
| `MAX_CONN_PER_IP` default 3 | 8, in both the code and `render.yaml` |
| 30-second ping, two missed rounds | 10-second ping |

They are three one-line edits in `README.md` and nobody has made them. Note that the
**player manual does not have this problem** — it reads its numbers out of `shared/`
at build time, so it cannot drift.

---

## Running it

```
npm install
npm start                  # http://localhost:8080
npm run dev                # TEST_MODE=1: rounds start with one ready player
npm test                   # all fourteen suites
DATABASE_URL=… npm run test:db
python3 scripts/manual.py  # rebuild the player manual (needs: pip install reportlab)
```

Online play needs `?mode=online` **and** a signed-in account. The practice tier always
runs locally against bots and never touches the server — there is no practice room.

### The `ws` trap, which will cost you an hour

`test/rooms.test.js` and `test/resume.test.js` boot the real server against a **fake
`ws` package that they write into `node_modules/ws`**, and only when no real one is
installed. Two consequences:

- After `npm install`, both suites crash. Move `node_modules/ws` aside to run them.
- If a stub is ever left behind, the server starts fine and answers every WebSocket
  upgrade with `200` and the page itself. That looks exactly like a broken deployment
  and is not one.

It cannot reach production: the image runs `npm install --omit=dev` in a clean layer
and `node_modules/` is gitignored. Replacing the stub with a real client connection in
the harness is the proper fix and is not done.

In practice: `rm -rf node_modules && npm test`, and reinstall only when you need a real
`ws` to drive a browser against the server.

---

## Deploying

Render, from `main`. `render.yaml` carries the environment.

**Every servable top-level directory must be listed in the `Dockerfile`.** Forgetting
one does not fail the build: the page renders and only the missing files 404, which
reads like a broken link rather than a packaging fault. It shipped twice, once for
`assets/` and once for `legal/`. `test/docker.test.js` now fails if a directory is
missing or `index.html` references something that is not copied.

`docs/` is **not** served and is not in the copy list. The player manual lives there
and is not reachable from the site; if you want it downloadable, that is a
`Dockerfile` change and a link, and `test/docker.test.js` will then hold you to it.

**Unresolved: `render.yaml` says `runtime: node`, but the evidence says Docker.**
Editing the `Dockerfile` COPY list fixed live 404s twice, which a native-runtime
deploy would have ignored. Worth reconciling before someone re-syncs the blueprint
and quietly changes how the service builds.

Environment that matters:

| Variable | Why |
|---|---|
| `DATABASE_URL` | Unset means balances live in memory and vanish on every restart |
| `TRUST_PROXY=1` | Without it every player shares one address and the per-IP cap locks them out |
| `ALLOWED_ORIGINS` | Unset means **any** origin may open a socket. A page the server itself served is always allowed, so the list cannot lock the game out of its own hosts |
| `REAL_MONEY=1` | Deliberately a hard startup error until a real ramp exists |
| `TEST_MODE=1` | Never set in production: one ready player starts a round |
| `COUNTDOWN_SECONDS` | Length of the pre-round count, default 5 |

Diagnosing a refused connection: `/health` reports whether a socket from a given
origin would be accepted and which guard would refuse it. A rejected WebSocket
handshake reaches the browser as a bare close with no reason, so this endpoint is the
only way to tell an unreachable server from one that is turning you away. It also
reports each room's phase, which now includes `countdown`.

---

## Things worth knowing

**The client never decides anything.** Movement, eating, the leaderboard and every
balance are server-side. Never move a rule to the client for convenience; a modified
client decides differently.

**Money is integer micro-USDC**, never a float. It sits in exactly one of three places
— a player's balance, their escrow, or the house — and seven operations move it, only
two of which change the total. `server/db/schema.sql` enforces the invariant and
`test/wager.test.js` asserts it over randomised operations.

**Mass sets your rank, never your payout.** A top-five finish pays out your own escrow:
your stake plus whatever you took off players you ate. There is no shared pot. If you
were handed a diagram showing pooled stakes and mass-weighted shares, that is a
proposed model and is not what runs.

**Being eaten ends a player's wager, not their round.** `victim.stake` is cleared at
the moment of death, so a player who respawns and finishes in the places cashes out an
empty escrow — nothing. This is easy to mistake for a settlement bug when a user
reports it. It is not; it is the rule, and the manual says so.

**Verify against a browser, not just tests.** Live faults invisible to the suite and
obvious on the page in thirty seconds: password sign-up dropped the date of birth, the
practice tier was unplayable once signed in, the origin allowlist refused the server's
own pages, and — this session — a death card over a round that had only just opened,
and a countdown that opened on the previous count's final number.

---

## Map

| Path | What |
|---|---|
| `shared/` | Simulation, wire protocol, money primitives, modes. Imported by both ends |
| `server/index.js` | Connection handling, rooms, rounds, settlement |
| `server/ledger.js` | The in-memory ledger and the ramp interface |
| `server/db/` | Postgres backend, `schema.sql`, migrations |
| `client/` | `net.js` transport and prediction, `main.js` wiring, `ui.js`, `render.js` |
| `legal/` | Draft privacy policy and terms. **Drafts** — unreviewed |
| `docs/` | The generated player manual. Not served |
| `scripts/manual.py` | Builds the manual; reads every number out of `shared/` at build time. Re-run after changing any tuning constant |
| `test/` | Fourteen suites, plain Node, no framework |
