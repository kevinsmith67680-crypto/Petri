# CellRush

An agar.io-style game split into a shared simulation, an authoritative server, and a thin client.

## Running it locally

```bash
npm install     # only dependency is ws
npm start       # http://localhost:8080
npm test        # headless simulation checks, no dependencies needed
```

Then open:

- `http://localhost:8080/` — offline. The simulation runs in your browser tab.
- `http://localhost:8080/?mode=online` — connects to the server over WebSocket. Open it in several tabs to play against yourself.
- `http://localhost:8080/?mode=online&name=Ada` — set your display name.

The client uses ES modules, so it needs to be served over HTTP. Opening `index.html` from the filesystem will fail on module imports — `npm start` serves the static files as well as running the game server.

## Putting it on the web

**The important constraint: GitHub Pages cannot run the multiplayer server.** Pages is static hosting. It will serve `index.html`, `client/` and `shared/` perfectly, so the offline game works — but `server/index.js` is a long-running Node process holding open WebSockets, and there is nowhere for it to run. The same applies to Netlify, Vercel's static hosting, and Cloudflare Pages.

So you have two shapes to choose from.

### Option A — everything on one host (simplest)

Deploy the whole repo to something that runs Node continuously. The server already serves the client, so one URL gives you both modes.

`render.yaml` in this repo is ready to commit; point Render at the repository and it will pick it up. Be aware of what the free plan does: a free web service **spins down after 15 minutes without inbound traffic**, and since February 2026 that window is kept alive by WebSocket messages from existing connections as well as HTTP requests. It spins back up on the next request or new WebSocket connection, taking **about a minute**, during which connecting browsers see a loading page. Anyone connected when it sleeps gets disconnected. The filesystem is ephemeral, which does not matter here since the world lives in memory. The instance is 512 MB RAM and 0.1 CPU.

That is fine for showing people. For anything you care about, the paid tier removes spin-down.

There is also a `Dockerfile`, so Fly.io, Railway, or any VPS work the same way. On a VPS put Caddy or nginx in front for TLS.

### Option B — client on GitHub Pages, server elsewhere

Useful if you want the offline game on a free static URL and only pay for the multiplayer box.

1. Push to GitHub. Copy `docs/pages-workflow.yml.example` to `.github/workflows/pages.yml` — it is shipped outside `.github/` because a classic access token cannot push workflow files unless it also carries the `workflow` scope, and the push fails outright if it does. Add that scope first. Then enable Pages in the repo settings with "GitHub Actions" as the source.
2. Deploy the server separately (Option A's host).
3. Set `SERVER_URL` in `client/config.js` to the server's address, e.g. `wss://petri.onrender.com`, and push again.

Two things will bite you here:

- **It must be `wss://`, not `ws://`.** GitHub Pages is HTTPS-only, and a browser blocks a plaintext WebSocket from a secure page as mixed content. The client detects this case and tells you rather than failing silently.
- **Set `ALLOWED_ORIGINS`** on the server to your Pages origin (`https://yourname.github.io`), or anyone can point their own client at your server.

You can also test without editing config, using `?mode=online&server=wss://your-host`.

### Server environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 8080 | Listen port |
| `BOTS` | 0 | Bots in the live arena. Off: signed-in play is PvP only |
| `ROUND_SECONDS` | 600 | Length of a live round |
| `INTERMISSION_SECONDS` | 15 | Gap between rounds |
| `LOBBY_MIN` | 100 | Ready players needed to start. **Set to 2 for testing** |
| `LOBBY_MAX` | 150 | Hard connection cap |
| `ALLOWED_ORIGINS` | *(unset)* | Comma-separated origin allowlist. Unset means allow anything — dev only |
| `MAX_CONN_PER_IP` | 3 | Connection cap per address |
| `TRUST_PROXY` | *(unset)* | Set to `1` behind Render, Fly, or any reverse proxy, so client IPs come from `X-Forwarded-For` |
| `REAL_MONEY` | *(unset)* | `1` demands a real payment ramp. Startup **fails** unless one is implemented — see the wagering section |
| `DATA_FILE` | *(unset)* | JSON file for the memory backend. Ignored when `DATABASE_URL` is set |
| `DATABASE_URL` | *(unset)* | Supabase/Postgres connection string. Use the session pooler on port 5432 |
| `GOOGLE_CLIENT_ID` | *(unset)* | OAuth client id. Unset hides the Google button entirely |
| `RAKE_BPS` | `0` | House cut on winnings, basis points |

`GET /health` returns player count and tick number, for uptime checks.

## Layout

```
shared/     sim.js         all game rules; runs in Node and the browser
            codec.js       binary reader/writer with bounds checks
            protocol.js    wire format, AOI culling, pellet delta scoping
            wager.js       integer money primitives and stake tiers
server/     index.js       authoritative tick loop + static file serving
            ledger.js      in-memory ledger + ramp placeholder
            accounts.js    signup, login, sessions, display names
            api.js         HTTP routes for the account endpoints
            store.js       JSON file persistence for the memory backend
            db/schema.sql  Postgres schema + atomic settlement functions
            db/pg.js       Supabase/Postgres backend
            db/memory.js   in-memory backend, same interface
            db/migrations/ schema changes for databases already deployed
assets/     logo.png       brand mark, light backgrounds
            logo-dark.png  dark-theme variant, dark pixels lifted
            mark.png       the C alone, no wordmark
            icon-32/180    favicon and touch icon

client/     main.js        entry point: transport choice, input, render loop
            account.js     /api client and session token storage
            config.js      SERVER_URL for statically-hosted clients
            local.js       offline connection (simulation in-tab)
            net.js         networked connection (WebSocket + interpolation)
            render.js      canvas drawing, themes, camera, minimap
            ui.js          HUD, settings, start/death cards
test/       sim.test.js       headless simulation checks
            protocol.test.js  codec, delta and scoping-rule checks
            wager.test.js     ledger conservation and ramp interlock
            accounts.test.js  hashing, sessions, name rules, throttling
            backend.test.js   same contract run against memory and Postgres
index.html  markup and CSS
```

## The three rules that make this work

`shared/sim.js` must never touch:

1. **The DOM or canvas.** Rendering reads a view; it never reaches into the world.
2. **`performance.now()` or `Date.now()`.** All timers use `world.time`, a float advanced by `dt`. This is why split cooldowns survive the trip to a server.
3. **`Math.random()`.** Randomness comes from `world.rng`, a seeded mulberry32. A match is reproducible from its seed plus its inputs, and tests are deterministic.

`npm test` fails immediately if a browser dependency creeps back in, because it imports the simulation into bare Node.

## How the two modes share a client

Both connection adapters expose the same interface:

```js
conn.sendAim(dx, dy)     // aim offset from your own centroid, in world units
conn.sendAction("split") // or "eject", or "respawn"
conn.update(dt)
conn.getView()           // -> { time, cells, pellets, viruses, me, board }
conn.on("event", fn)
```

`main.js` picks one on line ~40 and never mentions the difference again. Offline play is now just a server that happens to live in the same process.

Aim is sent as an **offset from your own centroid**, not a screen coordinate and not an absolute world point. Screen coordinates would be meaningless to a server that doesn't know your zoom level or window size; the offset means the same thing to everyone.

## Cheating: what is closed, and what isn't

The architecture does the heavy lifting. Clients send only an aim vector and discrete actions; movement, eating, splitting, virus pops, orb counts and the leaderboard are all decided server-side. That closes an entire category of cheat **by construction rather than by validation** — a client that cannot move itself cannot speed hack, teleport, or edit its own mass, no matter what you do to the JavaScript in front of you.

The corollary is worth internalising: **never move a rule back to the client for convenience.** Anything the client decides, a modified client decides differently.

### Closed in this repo

| Attack | Mitigation |
|---|---|
| Speed hack, teleport, mass editing | Client sends inputs only; the server simulates |
| Seeing the whole map | Area-of-interest culling in `protocol.js` — a player physically cannot be sent what is outside their view radius |
| Message flooding | Token buckets: 80 messages/sec, 12 actions/sec, then the socket is closed |
| Oversized payloads | `maxPayload` of 128 bytes; an aim frame is 5 |
| Malformed binary frames | Every read is bounds-checked; counts validated before allocating; decode failure closes the socket |
| `NaN`/`Infinity` injection into physics | Aim values are checked with `Number.isFinite` and magnitude-capped in `setAim` |
| Multi-boxing, connection floods | `MAX_CONN_PER_IP`, default 3 |
| Third-party clients pointed at your server | `ALLOWED_ORIGINS` allowlist. WebSockets are **not** covered by the browser same-origin policy, so this has to be checked explicitly — it is not automatic |
| Combat logging (disconnecting to escape a fight) | Cells linger for 6 seconds after you drop, motionless and edible |
| Name injection into other players' screens | Control characters stripped server-side, HTML escaped in `ui.js` |
| Zombie connections holding slots | 30-second ping, terminated after two missed rounds |

**Binary encoding is not a security feature.** The decoder ships in `client/net.js`, so anyone writing a modified client reads it and gets a parser for free. It raises the bar for someone poking at frames in DevTools and provides no protection against anyone actually trying. It is bandwidth work that happens to also let `maxPayload` drop from 512 to 128 bytes, rejecting floods earlier.

### Not closed, and largely not closable

**Aimbotting and scripted play.** A modified client can aim perfectly, react in 0ms, and never misjudge a split. Nothing in the architecture prevents this, because the input is legitimate — it is just better than a human's. This is a detection problem: look for inhumanly consistent reaction times, aim vectors with no jitter, or play that continues flawlessly for hours. Detection is statistical and always somewhat unfair, which is why most games in this genre tolerate a degree of it.

**Coordinated feeding.** Two real players can agree that one ejects mass for the other. The per-IP cap makes it harder to do alone, but two people on two connections are indistinguishable from teamwork, which is a legitimate strategy.

If it ever matters enough, the standard next step is accounts — a login requirement makes bans stick to a person rather than an IP address, and gives you a history to run detection against. That is a much larger change than anything here.

### Before you expose it publicly

- Set `ALLOWED_ORIGINS`. The default of allowing any origin is deliberately dev-only.
- Set `TRUST_PROXY=1` if you are behind a proxy, or every player will appear to share one IP and the per-IP cap will lock out all but three of them.
- Serve over TLS. Not only for the obvious reasons — an HTTPS page cannot open a `ws://` socket at all.

## Wire protocol

Gameplay travels as binary frames; control messages (join, welcome) stay as JSON text because they are rare and easier to debug. An aim message is **5 bytes**.

Pellets are sent as **deltas against a server-held known-set**, not re-sent every tick. Measured with 100 players at a realistic mass spread (20 to 2,000):

| | JSON, full snapshots | Binary + deltas |
|---|---|---|
| Avg snapshot | 3,951 B | **509 B** |
| Total egress | 7.5 MB/s (60 Mbit/s) | **0.97 MB/s (7.7 Mbit/s)** |
| Per player | 79 KB/s | **10.2 KB/s** |
| Monthly, 4h/day | 3,243 GB | **418 GB** |
| Monthly, 24/7 | 19,456 GB | **2,507 GB** |

A 7.8x reduction. Keyframes account for 4% of traffic. Encoding costs slightly more CPU than JSON (4.0 ms/tick vs 4.2 ms — effectively unchanged) because the win is in bytes, not cycles.

At $0.15/GB past a 5 GB allowance, 4h/day of 100 players is roughly $62/month of egress rather than $486.

### Scoping rules

Deltas replace per-tick recomputation with per-client remembered state, which is exactly where information leaks get introduced. Two rules in `encodeSnapshot` prevent that, and `test/protocol.test.js` asserts both:

1. **The known set is replaced by the current in-view set every tick, never merely added to.** A pellet that leaves your view is dropped immediately, so driving a wide circle cannot accumulate a map. The test drives a full 60-second circuit of the arena and asserts zero retained pellets outside the view radius.

2. **Removals are derived from `known - inView`, never from eat events.** A pellet eaten outside your view was never in your known set, so it generates no message at all. And "eaten while I watched" and "scrolled out of my view" travel as the same removal record, so they cannot be told apart. The test parks an observer in one corner, has a player feed in the opposite corner, and asserts the observer receives zero adds and zero removals. Out-of-view player names are withheld too.

The known-set lives on the server. The client never tells us what it already has, so it cannot lie about it to widen its own view.

### Decoding

`shared/codec.js` bounds-checks every read. Counts are validated against the bytes actually remaining via `expect()` **before** anything is allocated, so a frame claiming 65,535 records in 8 bytes is rejected rather than allocating. Trailing bytes are rejected too. The test suite fuzzes 4,000 random frames and asserts none parse into a valid command.

The server treats any decode failure as "close the socket", since a client that cannot speak the protocol has nothing useful to say.

### Remaining bandwidth work

- Cells are still sent in full each tick. They move constantly so there is less to win, but quantising positions relative to the view origin would save a few bytes each.
- The 100-player figures assume one world. Past roughly one CPU core you shard into rooms and processes; a single-threaded game loop cannot use a bigger instance.
- Client-side prediction of your own cells, so movement does not wait a round trip. `moveCells` is pure, so it can be re-run locally against unacknowledged input.
- WebTransport instead of WebSocket, with WebSocket as fallback. It reached Baseline in March 2026, and its unreliable datagrams suit positional updates you would discard on arrival anyway. Keyframes already exist, which is what makes lossy transport survivable.

## Accounts

Players can create an account, sign in, and change the display name shown on their cell and in the leaderboard.

**The shared arena requires an account.** Guests play the same simulation locally in their own browser tab, against bots only — they never join the multiplayer world. The client routes them there automatically, and `server/index.js` rejects any join without a valid session, so a modified client cannot slip in either.

Three reasons it works this way. A balance has to belong to a person; a guest "account" would belong to whoever opens the next socket. Every player in the arena being attributable is the prerequisite for stats and for bans meaning anything. And guests cost the server nothing at all — no socket, no snapshots, no bandwidth — which matters given the egress numbers above.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/signup` | Create an account, returns a session token |
| POST | `/api/login` | Sign in, returns a session token |
| POST | `/api/logout` | Destroy the current session |
| GET | `/api/me` | Current account plus balance |
| POST | `/api/name` | Change display name |

Auth is on HTTP rather than the WebSocket because it happens before the socket exists, and a password exchange has no business sharing a path with the 20Hz gameplay loop. The join message then carries the session token, and the server resolves identity from that alone — **the display name on your cell comes from the account, never from the join payload**, so a modified client cannot impersonate anyone.

### What it gets right

- **Async scrypt, always.** `scryptSync` takes around 100ms and this process runs the game loop on the same thread, so a synchronous hash would drop two ticks per login. Every password operation yields.
- **Per-user salts**, with the KDF parameters recorded in the hash string so they can be raised later without invalidating existing passwords.
- **`timingSafeEqual`** for hash comparison. A plain `===` leaks how much of the hash matched.
- **Session tokens are stored hashed.** The raw 256-bit token goes to the client once and never to disk, so a leaked store does not hand over live sessions.
- **Uniform login errors.** "Incorrect username or password" for both a missing account and a wrong password, and a dummy hash is computed for missing accounts so response timing does not reveal which usernames exist.
- **Throttling on both username and IP**, backing off geometrically to a five-minute cap, so neither spraying one password across many accounts nor hammering one account gets far.
- **Name rules that resist impersonation**: 3–16 characters from a conservative set, case-insensitive uniqueness, a reserved list, and a 60-second cooldown between changes.

### What it is not

This is credible scaffolding, **not audited authentication**. Before it guards anything of value, replace it with a managed identity provider or have it reviewed by someone who does this professionally.

Two specific weaknesses worth naming:

**The session token lives in `localStorage`**, which means any XSS on the page can read it. An HttpOnly cookie would not be readable, but the WebSocket join needs to carry the token in its payload, and cookies would add CSRF handling for no gain there. It is a deliberate trade-off, not an oversight — but revisit it rather than inherit it if real funds are ever involved.

**`FileStore` is a JSON file, not a database.** It has no transactions, so concurrent writes to related records can interleave. It exists so accounts survive a process restart in development.

### Sign in with Google

Set `GOOGLE_CLIENT_ID` and a Google button appears above the password form. Unset, the button is hidden and the Google Identity Services script is never even fetched.

**Setup.** Google Cloud console → APIs & Services → Credentials → Create OAuth client ID → Web application. Add your origin (`http://localhost:8080` for local, your Render URL for production) to **Authorised JavaScript origins**. No redirect URI and **no client secret** are needed: this uses the ID-token flow, where Google hands the browser a signed token and the server verifies it. The client id is public — it appears in the page of every site that uses one — so the client fetches it from `GET /api/config` rather than duplicating it in `client/config.js`.

**The security-critical part is the signature check.** A Google ID token is a JWT, and its middle segment is plain JSON containing a user id — trivially decoded, trivially rewritten. A server that reads that payload without verifying the signature will log an attacker in as anyone they name. `server/google.js` verifies, in order: the RS256 signature against Google's published keys, the issuer, that `aud` is *our* client id so a token minted for another site is refused, expiry with a minute of skew, and `email_verified`.

`test/google.test.js` runs all of this offline against a locally generated keypair, so the forgery cases are actually exercised. The one that matters most: decode a valid token, change `sub` to another user, re-encode, keep the original signature. It is rejected. Also covered are `alg: none`, symmetric algorithms, wrong-key signatures, wrong audience, wrong issuer, expiry, unverified emails, seven kinds of malformed input, and 500 random tokens — none accepted.

**Accounts are never linked by email.** It is tempting to match a Google email to an existing account and merge them, and it is a known takeover route: anyone who obtains a matching Google address inherits that account. A Google sign-in creates its own account keyed by Google's immutable `sub` claim. No email is stored at all.

Federated accounts have no password, so `password` is now nullable, with a check constraint that every account has either a password or a `google_sub`. Login refuses a null hash rather than treating it as a match, and password-less accounts take the same dummy-hash path as missing ones so they are timing-indistinguishable.

Display names come from the Google profile, sanitised to the same rules as any other name and suffixed when they collide — "Ada", then "Ada 2".

**Requires migration 005.** Run `server/db/migrations/005_google_sign_in.sql` before deploying.

### Persistence

Set `DATA_FILE` to enable it, e.g. `DATA_FILE=./data/petri.json npm start`. Writes are debounced every 2 seconds and go through a temp file plus `rename`, which is atomic on POSIX, so a crash mid-write leaves the previous file intact rather than a truncated one. Unset, everything is in memory and lost on restart.

**On Render the filesystem is ephemeral.** `DATA_FILE` survives a process restart but not a deploy — every push wipes every account. Move to Postgres before anyone has anything to lose. `server/store.js` is the seam: implement the same five methods against a real database and nothing else changes.

## Storage: Supabase / Postgres

Accounts **and balances** persist to Postgres when `DATABASE_URL` is set. Unset, everything runs in memory as before.

### Setting it up

1. Create a Supabase project.
2. Open the SQL Editor and run `server/db/schema.sql` once.
3. `npm install pg` (it is an optional dependency, only needed for this path).
4. Set `DATABASE_URL` — see the connection warning below.
5. Start the server. It logs `storage: postgres` and probes the schema before claiming to be up, so a misconfiguration fails immediately rather than at the first signup.

### The connection string will catch you out

Supabase's **direct** connection (`db.<ref>.supabase.co`) resolves to **IPv6 only**, and Render is IPv4. A direct string fails with `ENETUNREACH` or "Address family not supported by protocol". Use the Shared Pooler (Supavisor), which is IPv4 on every tier:

| Mode | Port | Use it? |
|---|---|---|
| Session | **5432** | **Yes.** Behaves like a direct connection, supports prepared statements. Correct for a long-lived server |
| Transaction | 6543 | No. For serverless and autoscaling deployments |

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Dashboard → Connect → Session pooler. `.env.example` has the shape.

### Why a `petri` schema rather than `public`

Supabase exposes every table in `public` through PostgREST, meaning **anyone holding your anon key can query them over HTTP**. Password hashes and balances must never be reachable that way. The schema puts everything in `petri`, which PostgREST does not expose unless you explicitly add it to the exposed-schemas list — don't. RLS is enabled with no policies as a second layer, so even if the schema were exposed, no anon request could read a row. The server connects as `postgres`, which bypasses RLS; that is correct, because the server is the trusted party here exactly as it is for movement.

### Settlement is atomic now

This is the real reason for a database rather than a JSON file. Every money operation is a Postgres function that moves the money **and** writes its audit row in a single statement:

| Function | Does |
|---|---|
| `petri.lock_stake` | balance → escrow |
| `petri.claim_pot` | loser's escrow → winner's escrow |
| `petri.cash_out` | escrow → balance, less rake |
| `petri.forfeit_pot` / `petri.refund_pot` | escrow → house / balance |

"Credit the winner, then crash before debiting the loser" is not a state this can reach. `claim_pot` locks both rows in account-id order so two players eating each other in the same tick cannot deadlock. `balances` carries `check (balance >= 0)` and `check (escrow >= 0)`, which makes "no account goes negative" a guarantee of the database rather than a property of the application code — an overdraft raises a constraint violation instead of silently succeeding.

`petri.money_total` is a view comparing money held against deposits minus withdrawals. Query it, or wire it to a monitor.

### Spectating

Absorbed players get a **Spectate** button on the death card alongside Play again. The spectator bar at the bottom lets you cycle through living players with ‹ ›, or leave and return to the death card.

**This could not be a camera change on the client.** Area-of-interest culling keys off the viewer's own position, and a dead player has no cells — a spectator with no viewpoint is sent an empty arena. `encodeSnapshot` therefore takes an `eye`: whose position the culling is centred on. Normally that is the player themselves; when spectating it is the player being watched, and the entire `me` block describes the target, since their mass and rank are what a spectator wants to see.

The scoping rules survive intact. **A spectator inherits the target's view radius, not a free view of the arena** — the tests assert that no cell and no pellet outside the target's own radius reaches them. Spectating is also refused while alive, which would otherwise be a second camera on the board.

Loose ends handled: the watched player can be eaten at any moment, so targets are re-checked every tick and the view cycles on automatically. Respawning, a new round, and returning to the lobby all end spectating.

**One thing to think about.** Mid-round respawning is still allowed, so a player can die, watch the leader, and rejoin. Spawn points are random, so the intel is of limited use — but if that bothers you, the fix is to make death final for the round and spectating the only option after it.

### The mass readout

During a live round the top-left corner shows what your mass is "worth" at **0.005 USDC per mass point**, alongside what you currently have staked. It is hidden in practice mode, where no money is involved.

**This is a scoreboard figure, not a claim on funds.** Nothing in `server/ledger.js` reads it, and no settlement path touches it.

| | at 0.005/point |
|---|---|
| Spawning (mass 20) | 0.10 USDC |
| One orb (3.375 mass) | 0.015 USDC |
| Mid-game (mass 500) | 2.50 USDC |
| Large player (mass 2,000) | 10.00 USDC |
| Round leader (mass 6,000) | 30.00 USDC |

The rate gives the readout a natural break-even: **mass 200 is worth exactly a 1.00 USDC stake**, so a player spawns showing less than they put in and has to grow to get back to level. That reads well.

It still is not a payout rate, though it is far closer than it was. A full 100-player round with an average mass of 400 shows 200 USDC of notional value against 100 USDC staked — 2×, down from 200× at the original 0.5 rate. Above an average mass of 200 the arena still displays more value than exists, so settling against it would over-pay.

Payouts stay bounded by what was actually staked — your pot, settled on death, cash-out, or surviving to the whistle. The server logs the rate at startup and warns if `REAL_MONEY` is on.

If you want mass to genuinely determine payouts, the rate has to be **derived from the pot rather than fixed**: your share of the round's real prize pool, proportional to your mass. That keeps total payouts equal to total stakes by construction. `MICRO_PER_MASS` in `shared/wager.js` adjusts the display; making it real is a different and larger change.

### Ejecting mass

Pressing W throws a blob forward at the cost of a little mass. Three things were wrong with it:

**The blob rendered as an ordinary orb.** `EJECT_KEEP` was exactly 10, and both the wire encoder and the offline adapter flagged a pellet as large with `p.mass > 10` — strictly greater. So ejected mass failed its own threshold and drew at orb size. The comparison is now against `PELLET_MASS` rather than a literal that happened to equal the thing it was testing.

**The owner ate it back instantly.** Blobs spawned at `radius + 6`, inside the cell's own eating reach, so most of the mass came straight back — a mass-200 cell ejecting ended up at 197 instead of 184. Blobs now spawn clear of that reach, and carry a 0.4-second immunity from their owner specifically. Anyone else can take them immediately.

**Collision ignored the blob's size.** `eatPellets` only used the eater's radius, so you could visibly overlap a 14-unit blob without picking it up. `pelletRadius` is now a single exported function used by both the collision check and the renderer, so the size you see and the size you can eat cannot drift apart.

**The blob never moved on screen.** Pellets are sent once when they enter view and never re-sent — correct for static orbs, silently wrong for a thrown one. The blob was transmitted at its launch point and sat there. Pellets now carry velocity when they have any, and the client extrapolates using `advancePellet`, the same function the server runs. Static orbs carry no velocity and cost exactly the bytes they always did.

**The motion had to be integrated exactly.** Doing it the naive way — move by `v * dt`, then decay `v` — makes the distance travelled depend on the step size, so a client at 60fps and a server at 20Hz disagreed by 146 units over a third of a second, ten times the blob's own radius. Solving the decay integral in closed form makes the result identical at any frame rate: 313.6 units at both 20 and 60fps, and 0.3 units of drift against the server after a full second.

**It launched detached.** Blobs spawned clear of the cell's eating radius, so they appeared in mid-air. Owner immunity means that gap is unnecessary, so they now emerge from the membrane and are thrown at 760 units/second, coasting to a stop over about a third of a second.

**Your own mass was the wrong colour.** Your cells are always drawn in the player colour rather than their palette slot, but ejected blobs used the slot — so your own mass came out looking like somebody else's. Blobs now carry an ownership flag and are drawn to match.

Ejecting costs 16 mass and yields a 13-mass blob at radius 14.4, against an orb's fixed 6 — a 2.4× size difference, and a net 3-mass loss so it can't be used to print mass. Blobs are drawn with a membrane and gloss like small cells rather than as flat dots, which is what they behave like.

### Diagnosing lag

Turn on **Performance overlay** in settings. Bottom right you get four numbers, and they separate three completely different causes that all feel identical in play:

| Reading | Means | If it's bad |
|---|---|---|
| `fps` | how fast your machine draws | under 45, it's the client — lower the bot count or close tabs |
| `ping` | round trip to the server | over 120ms, it's the network — see the region note below |
| `x / y ms tick` | what a tick costs the server against its budget | over ~60% of budget, the instance is starved — lower `BOTS` or move up a plan |
| `Hz server` | the tick rate actually in use | |

`GET /health` reports the same tick figures without needing a browser.

**Check your Render region first.** If the service is in Oregon and you are in Europe, the round trip is 150ms or more before any code runs, and no amount of netcode fixes that. Render picks a region at creation and it cannot be changed afterwards — you would create a new service in the nearer one. This is the single most common cause of a deployed game feeling worse than the same build locally.

### Latency fixes applied

**Nagle's algorithm was on.** Node enables it by default on TCP sockets: small writes are buffered waiting for more data to accumulate, which is exactly wrong for a stream of 5-byte aim packets and can hold one for tens of milliseconds. Every socket now sets `setNoDelay(true)`.

**Compression is explicitly off.** Snapshots are already compact binary; negotiating permessage-deflate would spend CPU and add framing latency on every frame for almost no saving.

**The tick no longer drifts.** `setInterval` compounds error — an overrunning tick pushes the next one late, and the effective rate quietly falls below the nominal one, which players feel as lag even though nothing in the netcode changed. Ticks are now scheduled against an absolute timeline, with a resync if the server falls more than 500ms behind. Measured at 30Hz over six seconds: 29.7 ticks/second actual.

**The tick rate is configurable.** `TICK_HZ=30` roughly halves world-update latency and makes other players visibly smoother, at 1.5× the CPU and bandwidth. Raise it only once the overlay shows the tick has headroom. The client reads the real rate from the server and adapts its interpolation buffer, so the two cannot disagree.

### Responsiveness

Without prediction, every movement waits for a full round trip and is then rendered in the past. Measured against a 80ms RTT connection, that was roughly **230ms from input to pixel** — well past the ~120ms where controls start feeling sluggish, and worse if Render's region is far from the player.

**Your own cells are now predicted locally.** `advanceCell` is exported from `shared/sim.js` and the client runs *exactly that function* against your current aim every frame, so your cell moves the instant you do. There is deliberately only one copy of the movement maths: if the client and server versions ever diverged, prediction would drift and every correction would become a visible twitch.

The server still decides everything. Prediction only removes the wait before you see your own input; if the server disagrees, the server wins.

**Reconciliation is age-compensated.** A snapshot describes where you were when it was sent, not where you are. Correcting straight onto it would drag your cell backwards by the flight time and undo the prediction entirely. So the server position is first replayed forward by the packet's age, and the correction targets that. In a 20-second test at 120ms RTT with the aim changing constantly, this halved the steady-state error from 28 world units to 13 — under half a cell radius, which is invisible.

Errors beyond 220 units snap rather than slide. That size of gap is not a wrong guess but stale state — a split, a virus pop, a respawn — and sliding across the arena to catch up would look far worse than a jump.

Also changed: aim now sends at 30Hz rather than 20 (5 bytes a message, so ~50 B/s for up to half a tick less lag), and the interpolation buffer for *other* players dropped from 2 ticks to 1.5. **The camera follows the predicted centroid**, which matters more than it sounds — a camera lagging your input makes everything else feel sluggish too.

Prediction is disabled while spectating, where `mine` marks somebody else's cells and predicting them from your aim would send them wandering off.

### Is it the netcode or the server?

A server that cannot hold its tick feels identical to bad netcode from the player's side. `GET /health` now reports:

```json
"tick": { "hz": 20, "budgetMs": 50, "avgMs": 1.51, "worstMs": 57.78, "overruns": 1 }
```

`avgMs` well under `budgetMs` means the server is fine and any remaining lag is network. `avgMs` approaching or exceeding the budget, or `overruns` climbing steadily, means the instance is starved — on Render's free 0.1 CPU that happens quickly with bots in the arena. Lower `BOTS` or move up an instance size.

### Lobby and arena size

The live arena is **8,800 × 8,800** with 4,100 orbs and 90 spores — scaled from the original 3,400 to keep the same per-player density (~770k units² each) at 100 players. `WORLD` must stay under 65,535 because positions travel as u16.

A round starts only once **`LOBBY_MIN` players have marked themselves ready** (default 100), and the server refuses connections past **`LOBBY_MAX`** (default 150) with a "server full" close. The cycle is lobby → 10-minute round → 15s standings → lobby, with everyone un-readied each time so the next round needs a fresh show of hands. Players who connect mid-round wait in the lobby rather than dropping into a game in progress.

**Set `LOBBY_MIN=2` while testing.** At 100, nothing starts until a hundred real people are in the lobby simultaneously — which on a new game is never. This is the single most likely way to end up staring at a screen that never does anything.

**Performance.** Scaling the arena 6.7× made `eatPellets` and the area-of-interest query scan 4,100 orbs per cell per client per tick, so pellets now go through a uniform spatial grid. Measured at 100 players with a realistic mass spread:

| | Before grid | After grid |
|---|---|---|
| Simulation | 6.27 ms/tick | **3.84 ms** |
| Snapshot encoding | 7.77 ms/tick | **6.53 ms** |
| Total | 14.04 ms (28%) | **10.37 ms (21%)** |

Egress actually fell to 0.43 MB/s, because a bigger arena spreads players out and puts fewer cells in each view.

The grid is rebuilt at the **end** of each tick, not the start. Pellets are created mid-tick (ejected mass, respawns) and ejected ones drift between buckets, so an index built at the start is already stale by the time snapshots are encoded — which showed up as orbs flickering in and out of view, and as the scoping test reporting phantom adds.

**Hardware.** At 100 players this needs roughly 13 ms/tick on one core. Render's free instance (0.1 CPU) fails outright at 260% of the tick budget; Starter (0.5 CPU) runs at 52%, which works but is tight; Standard (1 CPU, $25/mo) sits at 26% and is the realistic floor for a full lobby. Remember a single world is single-threaded, so a bigger instance buys headroom, not parallelism.

### Live rounds

The shared arena is **player versus player with no bots**, running in **ten-minute rounds**.

| | Guest | Signed in |
|---|---|---|
| Where it runs | Locally, in the browser tab | Shared server arena |
| Opponents | Bots | Real players only |
| Rounds | None, play indefinitely | 10 minutes, then 15s intermission |
| Wagering | No | Yes |

When the timer expires everyone still alive is ranked by mass, their run is recorded with outcome `survived`, and **any pot they are carrying is paid out**. Surviving to the whistle has to be a way to realise a wager — otherwise a timed round would silently swallow every stake on the board. Then the arena resets: fresh orbs, fresh spores, everyone respawned at starting mass, and the next round begins.

The clock sits top centre: a large countdown, the round number, and the **wall-clock time the round finishes** ("ends 16:10"). The finish time is formatted to the minute and stays fixed for the whole round, because `now` and `remaining` move together — verified across a full ten minutes, one distinct value. The countdown turns red and pulses in the last 30 seconds, which is the only motion in the HUD so it reads as urgency rather than decoration.

Round timing runs off `world.time`, the same clock the simulation uses, so a slow tick stretches the round rather than desynchronising it from play. The phase flips synchronously before settlement is dispatched, so the end-of-round payout cannot fire twice.

Tune with `ROUND_SECONDS` and `INTERMISSION_SECONDS`. Setting `BOTS` to a number pads the live arena, which is useful for testing an empty server but is off by default.

**Requires migration 004.** The `survived` outcome is new and the original check constraint rejects it, so run `server/db/migrations/004_survived_outcome.sql` before deploying or every end-of-round write fails.

### Match history and career stats

Every life is recorded as a row in `petri.matches` — one per life, not per session, so dying and pressing Play again starts a new match. Career totals are folded into `petri.player_stats` in the same statement, so a crash cannot log a match but leave the streak un-updated.

Per match: duration, finishing position, players in the arena, orbs absorbed, players eaten, peak mass, outcome, who killed you, stake and payout.

Career: matches, wins, total time played, lifetime orbs and players eaten, best peak mass, best finish, 1st places, current and longest streak, total staked and won.

**What counts as a win.** Agar.io has no win condition, so one had to be chosen rather than discovered. A match is won if you **finished in the top 5**, or you **cashed out a wagered run for more than you staked**. It is a generated column, so the rule lives in one place and old rows cannot disagree with new ones.

If `rebuild_stats()` fails with `ERROR: 42702 column reference "n" is ambiguous`, you have the first schema version; `migrations/002_win_top5.sql` now redefines the function before calling it, so re-running it fixes itself. `migrations/003_fix_rebuild_stats.sql` applies the same fix on its own.

Changing the threshold means dropping and re-adding the column — Postgres cannot alter a generated expression in place. `server/db/migrations/002_win_top5.sql` does that, and follows it with `select petri.rebuild_stats();` because stored `won` values recompute on re-add but the streak columns do not.

One caveat: **top 5 only means something when the arena holds more than 5.** With the default 14 bots it does, but if you run `BOTS=3` every finish is a win. Add `and players_in_arena > 5` to the expression if you ever run small arenas.

`first_places` is still tracked separately, so finishing 1st remains distinguishable from merely placing.

**Finishing position is captured before the fatal bite.** A player whose cells are eaten has zero mass by the time the death is detected, so standings are refreshed each tick *before* combat resolves. Reading the rank afterwards would record everyone as finishing last.

The streak rule exists twice — as SQL and as `MemoryRepo.isWin` — and `test/backend.test.js` asserts both against the same expectations. That is the only thing keeping them equal.

New endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/stats` | Career totals plus the last 10 matches (needs a session) |
| GET | `/api/board?kind=mass\|streak\|orbs` | Public all-time boards, display names only |

The menu shows career totals under your account when signed in, and the death card now reports your finishing position.

### The repository seam

`server/db/pg.js` and `server/db/memory.js` implement the same surface, and `test/backend.test.js` runs **the same assertions against both**. That is what stops them drifting: it is very easy to fix a bug in one and leave the other wrong.

```bash
npm test                                  # memory backend
DATABASE_URL=postgres://... npm run test:db   # same suite against Supabase
```

Point it at a scratch project — it creates and deletes accounts.

The memory backend scans every account on each signup, which is fine for the handful a local run creates and quadratic misery at scale. The Postgres one uses unique indexes on `lower(username)` and a generated `display_name_key` column, so uniqueness is enforced by the database rather than by an application check that can race two simultaneous signups.

### What changed in the server

`Accounts` now takes a repository rather than a store, and its methods are async. That made the WebSocket join handler async too, which introduced a race worth knowing about: a second `join` frame arriving mid-`await` would create two players for one socket. There is a `meta.joining` guard for it.

Settlement is fired from the tick without being awaited — **the game loop must never wait on the database**. Events are copied first because `stepWorld` reuses its array next tick, and stakes are cleared before the await so a second death event cannot settle the same pot twice.

## Branding

The logo sits in the pregame menu header, with a favicon and touch icon generated from the mark.

**Two image files rather than a CSS filter.** The wordmark is near-black and the mark is violet; no single filter lifts one without wrecking the other. `logo-dark.png` lifts only the dark pixels toward the theme's text colour, on a smooth cosine ramp — a hard threshold left a visible seam where it cut through the gradient in the C.

The server's MIME map needed `.png` adding. Without it images were served as `application/octet-stream`, which browsers will render in an `<img>` but will not accept as a favicon.

**Two things to settle.** The internal package, folder and repo are still `petri` — only the user-facing name changed. Renaming those is a repo-wide operation and I have left it alone. And the tagline reads "EAT · GROW · CASH OUT", but cashing out was removed: there is no voluntary exit, only being paid for a top-5 finish. "EAT · GROW · GET PAID" would match the game as built.

## Test mode

Playing the live PvP mode normally needs 100 signed-in strangers. `TEST_MODE=1` makes it playable alone:

```bash
npm run dev          # test mode, 60 bots, 2-minute rounds
npm run dev:solo     # 100 bots at full density, 1-minute rounds
```

Then open **`http://localhost:8080/?mode=online`** — the `?mode=online` matters. Without it you are a guest playing locally against bots, with no server and therefore no accounts; the sign-in panel is replaced by a note saying so. Create an account, mark yourself ready, and the round starts immediately.

| | Normal | Test mode |
|---|---|---|
| `LOBBY_MIN` | 100 ready | **1 ready** |
| `BOTS` | 0 | **60**, and a fixed count rather than "seats humans left" |
| `ROUND_SECONDS` | 600 | **120** |
| `INTERMISSION_SECONDS` | 15 | **8** |

Every one of these is still an override, so `TEST_MODE=1 ROUND_SECONDS=30 BOTS=100 npm start` works.

**Money still moves — but only demo credits.** MockRamp grants 5.00 on signup and there is no ramp behind it. That is deliberate: staking, having a pot claimed by a killer, forfeiting outside the places, and being paid for a top-5 finish are precisely the paths worth exercising, and they are worthless to test if money never moves. Watch a balance change across a round and you have tested the settlement path end to end.

**`TEST_MODE=1` and `REAL_MONEY=1` refuse to start together.** Test mode drops the lobby to one player and fills the arena with bots; easy plus real funds is how money goes missing. The server throws rather than picking one.

A banner across the top of the screen says test mode is on, and the HUD shifts down to clear it. It is deliberately hard to miss — mistaking test mode for production is the failure worth preventing.

### What it does not cover

Bots do not aimbot, collude, or exploit, so this tests mechanics rather than adversaries. Bots also hold no account, so a bot killing you forfeits your pot to the house rather than transferring it — testing a real player-to-player claim needs a second browser and a second account, which works fine at `LOBBY_MIN=1` since the round is already running when the second player readies.

## Wagering (demo only)

The pregame menu is two cards under a shared header. The left explains the rules — orb value, the size ratio needed to eat someone, the spore threshold, controls, the round length, and who gets paid. The right holds sign-in, the balance, and the stake choice, subtitled "Live rounds, top 5 get paid".

They are separate cards rather than two columns of one card because `align-items: start` then lets each keep its natural height. Two boxes ending at different points reads as deliberate; one box with a short right column reads as broken. Below 780px they stack, and the overlay scrolls.

It offers a Practice run or a 1.00 USDC wager, shows a balance, and has a **Connect wallet** button that is a deliberate placeholder. No payment ramp is connected, no value moves, and balances are demo credits with no cash value.

### How it is built

Money is an **integer count of micro-USDC** (1 USDC = 1,000,000 units), matching USDC's on-chain 6 decimals. There are no floats anywhere near a balance. `shared/wager.js` holds the primitives; the client formats amounts with the same code the server settles them with.

The **ledger is server-authoritative**, exactly like movement. The client holds no balance, is never asked what it thinks it has, and cannot spend what the server has not credited. What the menu displays is a read-only echo of `server/ledger.js`.

Value moves only in response to simulation events:

| Event | Effect |
|---|---|
| Join a wagered run | Stake moves from balance into escrow |
| Eat another staked player | Their whole pot moves to your escrow |
| Cash out while alive | Escrow moves to balance, less rake (currently 0) |
| Die to a staked player | Your pot is already theirs |
| Die to a bot | Pot is forfeited to the house — see the flaw below |
| Disconnect and stay uneaten | Pot is refunded after the 6-second linger window |

**The invariant is conservation**: `Ledger.total()` changes only through `deposit()` and `withdraw()`. Every other operation moves value sideways. `test/wager.test.js` fuzzes 20,000 randomised operations and asserts the total never drifts and no account goes negative, because a settlement bug that mints or destroys money is not something you want to discover from a user.

`GET /health` reports `ledgerTotal` so you can watch this in production.

### The safety interlock

`REAL_MONEY=1` **refuses to start** unless a real `Ramp` implementation exists. It does not silently fall back to play money. Turning this on is a deliberate code change, not a config toggle.

### Known flaws, deliberately left visible

**Wagered players share a world with bots.** If a bot eats you, your stake is forfeited to the house, which means the operator profits when a machine kills a paying player. That is indefensible in a real product. The fix is separate bot-free rooms for wagered play, which is a matchmaking change this codebase does not have.

**The ledger is an in-memory Map.** Every balance is lost on restart, and Render restarts services routinely. This needs a real database with real transactions before it holds anything.

**An account is `demo:<ip>`.** That is not identity. Two people behind one router share an account; one person with a phone has two.

### Before real money

Nothing here is production-ready for handling funds. At minimum, all of these need to be true first:

1. **Legal clearance.** Real-money wagering on game outcomes is regulated in most jurisdictions, and skill-based does not reliably exempt you. Whether you need a licence depends on where you and your players are. This needs a gaming-regulation lawyer, not a search engine.
2. ~~**Identity and accounts**~~ — scaffolded, see the Accounts section. Still needs a security review before it counts as done.
3. ~~**A real database** with transactional settlement and an immutable audit trail~~ — done via Supabase, see the Storage section. The Postgres path is **written but untested against a live database**; run `npm run test:db` before trusting it.
4. **Age and jurisdiction gating**, plus whatever KYC and AML obligations follow from (1).
5. **Bot detection with teeth.** This is the one that decides whether the product survives. Aimbotting is unpreventable by architecture, and once there is money on the table a scripted client is simply the rational way to play. Without detection and clawback, the game gets drained.
6. **Bot-free wagered rooms**, so no staked player can lose to an NPC.
7. **Responsible-gambling controls**: deposit limits, self-exclusion, session limits, and visible odds. These are legal requirements in many places and the right thing to do everywhere.
8. **A security audit** of the settlement path by someone who was not involved in writing it.

## Behaviour notes

- Your orb count is per life. Respawning starts a fresh run and resets it, along with peak mass and cells eaten.
- Offline mode steps at the render rate rather than a fixed 20Hz. There is nothing to interpolate against locally and variable `dt` looks smoother. The simulation is `dt`-scaled, so both modes play materially the same.
- Online mode renders roughly 100ms behind the server so there are always two snapshots to interpolate between. Lower it in `net.js` (`INTERP_MS`) for less latency at the cost of stutter when packets are late.
