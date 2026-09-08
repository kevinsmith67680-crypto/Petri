// ---------------------------------------------------------------------------
// Network control. Run with:  node test/control.test.js
//
// Drives client/net.js against a stubbed socket fed by a real simulation, and
// asserts the obvious thing nothing else checked: that aiming moves your cell.
//
// This exists because "no control, frozen screen" turned out to be an
// exception thrown inside applySnapshot on every frame after the first. The
// handler swallowed nothing — it simply escaped into the socket event handler,
// where it killed the update and left the client rendering its very first
// snapshot for ever. Every other test passed throughout.
// ---------------------------------------------------------------------------

globalThis.performance = { now: () => Date.now() };

const sockets = [];
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 1; this.h = {}; this.sent = []; sockets.push(this); }
  addEventListener(t, fn) { (this.h[t] ||= []).push(fn); }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; }
  fire(t, ev) { for (const fn of this.h[t] || []) fn(ev); }
};

const { createWorld, addPlayer, stepWorld, setAim, queueAction, TICK_HZ } = await import("../shared/sim.js");
const { encodeSnapshot, createClientState } = await import("../shared/protocol.js");
const { MODES } = await import("../shared/modes.js");
const { createSocketConnection } = await import("../client/net.js");

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

// Anything the client logs as a dropped frame is a failure here: in this
// harness the server is real and the wire is lossless.
const dropped = [];
const warn = console.warn;
console.warn = (...a) => dropped.push(a.join(" "));

function harness(mode = MODES[0]) {
  sockets.length = 0;
  const world = createWorld(5, mode.world);
  const me = addPlayer(world, { id: "me", name: "Me" });
  me.cells[0].x = mode.world.size / 2;
  me.cells[0].y = mode.world.size / 2;
  const cs = createClientState(0);

  const conn = createSocketConnection({ url: "ws://x", name: "Me", stake: 1e6, token: "t" });
  const sock = sockets[0];
  sock.fire("open");
  sock.fire("message", { data: JSON.stringify({ type: "welcome", nid: me.nid, tickHz: TICK_HZ }) });

  // A real socket delivers exactly the bytes written, not the writer's whole
  // internal buffer — so the slice matters.
  const push = () => {
    const b = encodeSnapshot(world, me, cs, null);
    sock.fire("message", { data: b.slice().buffer });
  };
  return { world, me, conn, sock, push };
}

console.log("\n-- the client receives frames at all --");

const h = harness();
h.push();
let view = h.conn.getView();
check("a view exists after one snapshot", !!view);
check("it carries the arena size", view && view.world === 8800, String(view?.world));
check("nothing was dropped", dropped.length === 0, dropped[0] || "");

console.log("\n-- aiming moves the cell --");

const startX = view.me.x;
h.conn.sendAim(600, 0);
for (let f = 0; f < 120; f++) {
  h.conn.update(1 / 60);
  if (f % 3 === 0) {
    setAim(h.world, "me", 600, 0);
    stepWorld(h.world, 1 / TICK_HZ);
    h.push();
  }
}
view = h.conn.getView();
check("the cell moved toward the aim", view.me.x > startX + 300,
  `${Math.round(startX)} -> ${Math.round(view.me.x)}`);
check("it did not drift off-axis", Math.abs(view.me.y - 4400) < 60, String(Math.round(view.me.y)));
check("prediction tracks the server", Math.abs(view.me.x - h.world.players.get("me").cells[0].x) < 40,
  `${Math.abs(view.me.x - h.world.players.get("me").cells[0].x).toFixed(0)} units apart`);

console.log("\n-- reversing works too --");

const before = view.me.x;
h.conn.sendAim(-600, 0);
for (let f = 0; f < 120; f++) {
  h.conn.update(1 / 60);
  if (f % 3 === 0) {
    setAim(h.world, "me", -600, 0);
    stepWorld(h.world, 1 / TICK_HZ);
    h.push();
  }
}
view = h.conn.getView();
check("the cell came back", view.me.x < before - 200,
  `${Math.round(before)} -> ${Math.round(view.me.x)}`);

console.log("\n-- frames keep arriving over a long run --");

// The bug froze the view after the first snapshot, so the tell is that the
// view stops changing while the server keeps moving.
const seen = new Set();
for (let f = 0; f < 600; f++) {
  h.conn.sendAim(Math.sin(f / 40) * 600, Math.cos(f / 40) * 600);
  h.conn.update(1 / 60);
  if (f % 3 === 0) {
    setAim(h.world, "me", Math.sin(f / 40) * 600, Math.cos(f / 40) * 600);
    stepWorld(h.world, 1 / TICK_HZ);
    h.push();
  }
  if (f % 30 === 0) seen.add(Math.round(h.conn.getView().me.x));
}
check("the view kept updating for 10 simulated seconds", seen.size > 10,
  `${seen.size} distinct positions`);
check("no frame was dropped across the whole run", dropped.length === 0,
  dropped.slice(0, 2).join(" | "));

console.log("\n-- the smaller arena works the same --");

const hs = harness(MODES[1]);
hs.push();
const v2 = hs.conn.getView();
check("high stakes reports its own arena", v2 && v2.world === 6200, String(v2?.world));
hs.conn.sendAim(500, 0);
for (let f = 0; f < 90; f++) {
  hs.conn.update(1 / 60);
  if (f % 3 === 0) { setAim(hs.world, "me", 500, 0); stepWorld(hs.world, 1 / TICK_HZ); hs.push(); }
}
check("and the cell still responds there",
  hs.conn.getView().me.x > 3100 + 200, String(Math.round(hs.conn.getView().me.x)));

console.log("\n-- split and eject respond on the next frame --");

// Before local prediction of these, the piece and the blob appeared a full
// round trip after the key went down. That was most of "the moves feel
// unnatural": the physics were fine, the response was late.
const sp = harness();
sp.me.cells[0].mass = 200;
sp.push();
sp.conn.sendAim(600, 0);
for (let f = 0; f < 6; f++) { sp.conn.update(1 / 60); if (f % 3 === 2) { stepWorld(sp.world, 1 / TICK_HZ); sp.push(); } }

const mine = () => sp.conn.getView().cells.filter(c => c.mine);
const beforeSplit = mine().length;
sp.conn.sendAction("split");
sp.conn.update(1 / 60);
check("a split shows a second cell on the very next frame",
  mine().length === beforeSplit + 1, `${beforeSplit} -> ${mine().length}`);
check("the provisional piece is flagged as ours", mine().every(c => c.mine));

// Server catches up two ticks later, as a real one would.
for (let f = 0; f < 6; f++) sp.conn.update(1 / 60);
queueAction(sp.world, "me", "split");
stepWorld(sp.world, 1 / TICK_HZ);
sp.push();
sp.conn.update(1 / 60);
const confirmed = mine();
check("the server's cells replace the ghost", confirmed.length === 2 && confirmed.every(c => c.i >= 0),
  `${confirmed.length} cells, ids ${confirmed.map(c => c.i).join(",")}`);
const xs = confirmed.map(c => c.x).sort((a, b) => a - b);
check("the two pieces have separated", xs[1] - xs[0] > 20,
  `${xs.map(x => Math.round(x)).join(" and ")}`);

const blobs = () => sp.conn.getView().pellets.filter(p => p[3] && p[4]).length;
const beforeEject = blobs();
sp.conn.sendAction("eject");
sp.conn.update(1 / 60);
check("an eject shows the blob on the very next frame", blobs() > beforeEject,
  `${beforeEject} -> ${blobs()}`);

// An unconfirmed ghost must not live for ever if the server never agrees.
for (let f = 0; f < 40; f++) sp.conn.update(1 / 60);
check("unconfirmed ghosts expire", blobs() === 0, `${blobs()} left after 0.66s`);

console.log("\n-- diagnostics --");

const stats = h.conn.stats();
check("stats() is callable and shaped for the overlay",
  typeof stats === "object" && "ping" in stats && "hz" in stats && "budgetMs" in stats,
  JSON.stringify(stats));
check("it reports the server's tick rate", stats.hz === TICK_HZ, String(stats.hz));

console.warn = warn;
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
