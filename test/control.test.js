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

const { createWorld, addPlayer, stepWorld, setAim, queueAction, advanceCell, radiusOf, TICK_HZ } =
  await import("../shared/sim.js");
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

// The real thing: throw mass with a live server and watch it continuously.
// The server grants a thrown blob immunity from its owner; a client that does
// not know that eats its own blob, the server refuses, and it vanishes and
// reappears about a second later.
const ej = harness();
ej.me.cells[0].mass = 200;
ej.me.cells[0].x = 4400; ej.me.cells[0].y = 4400;
stepWorld(ej.world, 1 / TICK_HZ);
ej.push();
ej.conn.sendAim(600, 0);
for (let f = 0; f < 6; f++) { ej.conn.update(1 / 60); if (f % 3 === 2) { stepWorld(ej.world, 1 / TICK_HZ); ej.push(); } }

const ownBlobs = () => ej.conn.getView().pellets.filter(p => p[3] && p[4]).length;
ej.conn.sendAction("eject");
queueAction(ej.world, "me", "eject");

// A blink is present -> absent -> present. Being eaten later is absent and
// staying absent, which is correct and must not count.
let sawBlob = false, blinks = 0, wasAbsent = false, absentFrames = 0;
for (let f = 0; f < 150; f++) {          // 2.5 seconds
  ej.conn.update(1 / 60);
  if (f % 3 === 0) { setAim(ej.world, "me", 600, 0); stepWorld(ej.world, 1 / TICK_HZ); ej.push(); }
  const present = ownBlobs() > 0;
  if (present) {
    if (wasAbsent && sawBlob) blinks++;
    sawBlob = true;
    wasAbsent = false;
  } else if (sawBlob) {
    wasAbsent = true;
    absentFrames++;
  }
}
check("the thrown blob appears", sawBlob);

// A moving pellet is transmitted once, with its velocity, and never re-sent.
// The client must carry it forward itself. That loop went missing in an edit
// and every blob sat frozen at its launch point while the server moved it —
// which then put it behind the cell, where the eat test swallowed it.
const mv = harness();
mv.me.cells[0].mass = 200;
mv.me.cells[0].x = 4400; mv.me.cells[0].y = 4400;
stepWorld(mv.world, 1 / TICK_HZ);
mv.push();
setAim(mv.world, "me", 600, 0);
queueAction(mv.world, "me", "eject");
stepWorld(mv.world, 1 / TICK_HZ);
mv.push();

const clientBlob = () => mv.conn.getView().pellets.find(p => p[3]);
const startedAt = clientBlob() ? clientBlob()[0] : null;
check("the client has the blob", startedAt !== null);
for (let f = 0; f < 18; f++) mv.conn.update(1 / 60);   // 0.3s, no new snapshots
const movedTo = clientBlob() ? clientBlob()[0] : null;
check("and carries it forward without being re-told",
  movedTo !== null && movedTo - startedAt > 80,
  movedTo === null ? "blob gone" : `${Math.round(startedAt)} -> ${Math.round(movedTo)}`);

// Advance the server the same 0.3 seconds and compare like with like.
for (let i = 0; i < 6; i++) stepWorld(mv.world, 1 / TICK_HZ);
const serverBlob = mv.world.pellets.find(p => p.owner === "me");
check("client and server agree on where it is",
  serverBlob && Math.abs(movedTo - serverBlob.x) < 25,
  serverBlob ? `client ${Math.round(movedTo)}, server ${Math.round(serverBlob.x)}` : "no server blob");
check("and never blinks out and back", blinks === 0,
  `${blinks} blink(s), ${absentFrames} absent frames total`);

console.log("\n-- orbs vanish when you eat them --");

// The client did not predict orb eating, so an eaten orb sat inside the cell
// for a round trip plus the interpolation buffer — and far longer if the
// clock offset had gone stale.
const ea = harness();
ea.me.cells[0].mass = 60;
ea.me.cells[0].x = 4400; ea.me.cells[0].y = 4400;
const orb = ea.world.pellets[0];
orb.x = 4520; orb.y = 4400;
stepWorld(ea.world, 1 / TICK_HZ);       // rebuild the grid around it
ea.push();

const orbVisible = () =>
  ea.conn.getView().pellets.some(p => Math.abs(p[0] - 4520) < 2 && Math.abs(p[1] - 4400) < 2);
check("the orb is visible before we reach it", orbVisible());

ea.conn.sendAim(600, 0);
let hiddenWhileTouching = false, everTouched = false;
for (let f = 0; f < 120; f++) {
  ea.conn.update(1 / 60);
  // A live server ticks too; without it the correction drags prediction back
  // and the cell never arrives.
  if (f % 3 === 0) { setAim(ea.world, "me", 600, 0); stepWorld(ea.world, 1 / TICK_HZ); ea.push(); }
  const cell = ea.conn.getView().cells.find(c => c.mine);
  const touching = cell && Math.abs(cell.x - 4520) < radiusOf(cell.m);
  if (touching) {
    everTouched = true;
    if (!orbVisible()) { hiddenWhileTouching = true; }
    break;
  }
}
check("the cell reached the orb", everTouched);
check("it disappears the moment the cell covers it", hiddenWhileTouching);

console.log("\n-- the render clock does not go stale --");

// An all-time minimum offset is sticky: one early fast packet, or a drifting
// server clock, pinned renderTime seconds in the past — and every removal and
// every other player rendered seconds late with it.
const ck = harness();
ck.push();
const firstView = ck.conn.getView();
check("a view exists", !!firstView);
// Simulate the server clock running ahead of ours for a while.
for (let i = 0; i < 40; i++) { stepWorld(ck.world, 1 / TICK_HZ); ck.push(); ck.conn.update(1 / 60); }
const late = ck.conn.getView();
check("the view is still tracking the newest snapshot",
  Math.abs(late.time - ck.world.time) < 0.5,
  `view ${late.time.toFixed(2)}s vs world ${ck.world.time.toFixed(2)}s`);

console.log("\n-- steering is smooth, not instant --");

// "Too sharp" was a cell that reversed direction in one frame. Heading now
// eases, so a hard reversal takes a beat.
const st = { x: 0, y: 0, mass: 20, vx: 0, vy: 0 };
for (let i = 0; i < 60; i++) advanceCell(st, st.x + 600, st.y, 1 / 60, 8800);
const goingRight = st.hx;
advanceCell(st, st.x - 600, st.y, 1 / 60, 8800);
check("one frame of opposite input does not flip the heading",
  st.hx > 0.5, `heading ${st.hx.toFixed(2)} (was ${goingRight.toFixed(2)})`);
let t = 0;
while (st.hx > -0.95 && t < 1) { advanceCell(st, st.x - 600, st.y, 1 / 60, 8800); t += 1 / 60; }
check("but a reversal completes in about a third of a second",
  t > 0.15 && t < 0.5, `${(t * 1000).toFixed(0)} ms`);

console.log("\n-- a dropped connection recovers --");

// There was no reconnection logic at all: one blip and the session was over
// with "the connection to the server was lost". Retrying is safe because the
// server evicts an account's older connection and reuses its escrow, so
// re-joining cannot stake twice.
{
  sockets.length = 0;
  const w = createWorld(11, MODES[0].world);
  const p = addPlayer(w, { id: "me", name: "Me" });
  const cs = createClientState(0);
  const conn = createSocketConnection({ url: "ws://x", name: "Me", stake: 1e6, token: "t" });

  let reconnecting = 0, recovered = 0, ended = 0;
  conn.on("reconnecting", () => reconnecting++);
  conn.on("reconnected", () => recovered++);
  conn.on("close", () => ended++);

  const bring = sock => {
    sock.fire("open");
    sock.fire("message", { data: JSON.stringify({ type: "welcome", nid: p.nid, tickHz: TICK_HZ }) });
    stepWorld(w, 1 / TICK_HZ);
    sock.fire("message", { data: encodeSnapshot(w, p, cs, null).slice().buffer });
  };

  bring(sockets[0]);
  check("connected and receiving", !!conn.getView());

  // The link drops unexpectedly.
  sockets[0].fire("close", { code: 1006 });
  check("it reports reconnecting rather than ending", reconnecting === 1 && ended === 0,
    `reconnecting ${reconnecting}, close ${ended}`);

  await new Promise(r => setTimeout(r, 400));
  check("a fresh socket is opened", sockets.length === 2, `${sockets.length} sockets`);

  bring(sockets[1]);
  check("and it re-joins on connect",
    sockets[1].sent.some(m => String(m).includes("join")),
    sockets[1].sent.length ? String(sockets[1].sent[0]).slice(0, 40) : "sent nothing");
  check("the welcome clears the reconnecting state", recovered === 1, `${recovered}`);
  check("and the view is live again", !!conn.getView());

  // A takeover must NOT be retried — it would fight the other tab.
  sockets[1].fire("close", { code: 4001 });
  check("a takeover ends the session instead of retrying",
    ended === 1 && reconnecting === 1, `close ${ended}, reconnecting ${reconnecting}`);
}

console.log("\n-- diagnostics --");

const stats = h.conn.stats();
check("stats() is callable and shaped for the overlay",
  typeof stats === "object" && "ping" in stats && "hz" in stats && "budgetMs" in stats,
  JSON.stringify(stats));
check("it reports the server's tick rate", stats.hz === TICK_HZ, String(stats.hz));

console.warn = warn;
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
