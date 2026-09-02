# Petri

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

1. Push to GitHub. `.github/workflows/pages.yml` publishes `index.html`, `client/` and `shared/` to Pages on every push to `main`. Enable Pages in the repo settings with "GitHub Actions" as the source.
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
| `BOTS` | 14 | Bots filling empty seats |
| `ALLOWED_ORIGINS` | *(unset)* | Comma-separated origin allowlist. Unset means allow anything — dev only |
| `MAX_CONN_PER_IP` | 3 | Connection cap per address |
| `TRUST_PROXY` | *(unset)* | Set to `1` behind Render, Fly, or any reverse proxy, so client IPs come from `X-Forwarded-For` |

`GET /health` returns player count and tick number, for uptime checks.

## Layout

```
shared/     sim.js         all game rules; runs in Node and the browser
            codec.js       binary reader/writer with bounds checks
            protocol.js    wire format, AOI culling, pellet delta scoping
server/     index.js       authoritative tick loop + static file serving
client/     main.js        entry point: transport choice, input, render loop
            config.js      SERVER_URL for statically-hosted clients
            local.js       offline connection (simulation in-tab)
            net.js         networked connection (WebSocket + interpolation)
            render.js      canvas drawing, themes, camera, minimap
            ui.js          HUD, settings, start/death cards
test/       sim.test.js       headless simulation checks
            protocol.test.js  codec, delta and scoping-rule checks
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

## Behaviour notes

- Your orb count is per life. Respawning starts a fresh run and resets it, along with peak mass and cells eaten.
- Offline mode steps at the render rate rather than a fixed 20Hz. There is nothing to interpolate against locally and variable `dt` looks smoother. The simulation is `dt`-scaled, so both modes play materially the same.
- Online mode renders roughly 100ms behind the server so there are always two snapshots to interpolate between. Lower it in `net.js` (`INTERP_MS`) for less latency at the cost of stutter when packets are late.
