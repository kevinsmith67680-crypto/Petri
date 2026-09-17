# Handover

Engulfs — an agar.io-style game with real-money wagering, at [engulfs.io](https://engulfs.io).

`README.md` is the reference: architecture, wire protocol, tuning, the full cheating
analysis. This file is the shorter thing you want first — what state it is in, what is
dangerous, and what will waste your afternoon.

**Current state.** `main` at `632084e`. All fourteen test suites green. Supabase
migrations `002`–`006` applied. Nothing is in flight.

---

## Do not enable real money until these are fixed

Ranked by how much they cost you, worst first. `README.md` has a longer
"Before real money" checklist covering legal, KYC and responsible-gambling
obligations; these four are the code.

### 1. Disconnecting refunds your stake

**The exploit works today.** Drop your connection when you are about to be eaten and
you get your money back.

Cells linger for six seconds after a socket drops, motionless and edible, which is
the right rule and looks like it works. The ledger disagrees:

- `settle()` finds the victim with `accountOfPlayer()` (`server/index.js:659`), which
  scans `room.clients` for a live connection.
- `cleanup()` has already removed that entry, so the victim resolves to `null` and
  settlement returns early at `server/index.js:677`. The killer is paid nothing.
- The linger sweep then refunds the stake unconditionally at `server/index.js:1224`.
  Its comment says "nobody beat them". Somebody did; nothing recorded it.

The fix is to settle a lingering player by `accountId` rather than by live connection,
and to clear the lingering entry when the body is eaten. `claimLingering()` already
does the second half for rejoins and is the place to start.

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
(`shared/sim.js`), so feeding leaks about a fifth per throw.

---

## Smaller open items

| Item | Where |
|---|---|
| Accounts created before the age gate have `date_of_birth` NULL and are not gated | `server/db/migrations/006_age_gate.sql` |
| End-of-round copy is hardcoded to ten minutes and top five; wrong under other config | `index.html:1020` (`roundBlurb`) |
| Two unreferenced images ship in the container, 868 KB | `assets/ChatGPT Image Sep 12…png`, `assets/image-1789204331359.png` |
| `mark.png` is 796 KB and only used by the icon build script, never at runtime | `assets/mark.png`, `scripts/icons.mjs` |
| `npm install && npm test` fails — see the `ws` trap below | `test/rooms.test.js`, `test/resume.test.js` |
| README's cheating table is stale in three places | see below |

The three stale README claims:

| README says | Code does |
|---|---|
| `maxPayload` 128 bytes | 512 (`MAX_PAYLOAD`, raised when the join frame grew) |
| `MAX_CONN_PER_IP` default 3 | 8, in both the code and `render.yaml` |
| 30-second ping, two missed rounds | 10-second ping |

---

## Running it

```
npm install
npm start                  # http://localhost:8080
npm run dev                # TEST_MODE=1: rounds start with one ready player
npm test                   # all fourteen suites
DATABASE_URL=… npm run test:db
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

---

## Deploying

Render, from `main`. `render.yaml` carries the environment.

**Every servable top-level directory must be listed in the `Dockerfile`.** Forgetting
one does not fail the build: the page renders and only the missing files 404, which
reads like a broken link rather than a packaging fault. It shipped twice, once for
`assets/` and once for `legal/`. `test/docker.test.js` now fails if a directory is
missing or `index.html` references something that is not copied.

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

Diagnosing a refused connection: `/health` reports whether a socket from a given
origin would be accepted and which guard would refuse it. A rejected WebSocket
handshake reaches the browser as a bare close with no reason, so this endpoint is the
only way to tell an unreachable server from one that is turning you away.

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

**Verify against a browser, not just tests.** Three live faults this session were
invisible to the suite and obvious on the page in thirty seconds: password sign-up
dropped the date of birth, the practice tier was unplayable once signed in, and the
origin allowlist refused the server's own pages.

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
| `test/` | Fourteen suites, plain Node, no framework |
