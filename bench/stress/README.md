# Load tests: the real server, real WebSocket clients

`run.mjs` boots a copy of the game server and connects clients to it the way
the browser does: sign up, take a ticket from `/api/match`, open a WebSocket,
join with the ticket, ready up. Once the round is live, every client steers
on a random walk at 30 Hz, splits and throws mass as its scenario says, and
decodes every snapshot it receives, keeping the pellet set a real client
keeps.

```sh
node bench/stress/run.mjs                                   # every scenario, this tree
node bench/stress/run.mjs --scenarios p100,splits --seconds 60
node bench/stress/run.mjs --rev a44cad8 --out before.json   # a revision's server, for before/after
```

The server runs in `TEST_MODE`: in-memory accounts, test credits, and no
bots (`BOTS=0`), so every player is a socket. Rounds are an hour long, so a
run measures one round in steady play. Nobody respawns during a round, so
the number still alive is reported with each result. The clients run in
this process and the server in its own, so the server's figures are its own
work.

`ws` must be the real package, not the stub the server tests write into
`node_modules`. The harness uses `$STRESS_WS_DIR/node_modules/ws`, or the
project's own if it is real, or installs one into a temp directory.

## Scenarios

| Key | What |
|---|---|
| `p10`, `p50`, `p100` | 10, 50 and 100 players in one Standard room (4,100 orbs). |
| `splits` | 100 players, each splitting about every 0.75 s and throwing mass every 1.5 s. |
| `p150` | 150 players in one room (`LOBBY_MAX=150`): the stress case. |
| `rooms` | Two rooms at once: 100 in Standard and 50 in High stakes. |
| `eject` | 100 players throwing mass about every 0.3 s. |
| `stalls` | 100 players; the server process is stopped for 50–250 ms every 2 s (SIGSTOP, then SIGCONT), the way a long GC pause or a descheduled VM looks from outside. |
| `network` | 100 players through a TCP proxy adding 80 ± 30 ms each way and 1% loss. The container has no netem, so the proxy holds each chunk for the latency plus or minus the jitter, in order, and a lost one for a 200 ms retransmission timeout, delaying what follows it, as TCP does. |

## What is measured

Over a fixed window after a warm-up:

- **Server**, from `/health?window=N` (`server/tickstats.js`):
  - `late`: how long after its scheduled moment each tick started. Stalls,
    GC pauses and a busy event loop show here and nowhere else.
  - `sim`: stepping every room's world.
  - `snap`: encoding and sending every client's snapshot, sends included.
  - `total`: the whole tick.
  - Snapshot bytes per second, and collections (count and time).
  - RSS and heap, sampled every two seconds.
  - CPU time, from `/proc`.
- **Clients**:
  - bytes received;
  - the gap between snapshots as each client saw it;
  - ticks it never got a snapshot for;
  - protocol errors: any snapshot that added a pellet the client already
    had, or removed one it never had.

`--rev <git rev>` runs that revision's server with the same `tickstats`
hooks patched in. The clients are always this tree's, which is fine while
the wire format is unchanged.

Results are in `results/`. They depend on the machine, and on the other
work running on it.
