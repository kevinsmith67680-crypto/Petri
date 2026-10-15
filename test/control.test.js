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
  close(code, reason) { this.readyState = 3; this.closeCode = code; this.closeReason = reason; }
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

// Every connection harness() opens, so they can be closed before the tests
// that count sockets. Left open, each one's stall watchdog fires 2.5 seconds
// after its last frame and it starts reconnecting — pushing sockets into the
// shared list in the middle of whichever test is running then.
const harnessed = [];

function harness(mode = MODES[0]) {
  sockets.length = 0;
  const world = createWorld(5, mode.world);
  const me = addPlayer(world, { id: "me", name: "Me" });
  me.cells[0].x = mode.world.size / 2;
  me.cells[0].y = mode.world.size / 2;
  const cs = createClientState(0);

  const conn = createSocketConnection({ getTicket: () => ({ url: "ws://x", ticket: "t" }) });
  harnessed.push(conn);
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

// From here on the tests count sockets and reconnections.
for (const c of harnessed) c.close();

console.log("\n-- over a real link --");

// Everything above runs with no latency at all, where a client that ignores
// the round trip and one that hides it look exactly alike. These run the real
// client against the real simulation over a modelled link — a round trip,
// jitter, and ordered delivery as over TCP — on a virtual clock.
{
  const { decodeClientMessage, MSG } = await import("../shared/protocol.js");
  const { totalMass } = await import("../shared/sim.js");
  const realNow = performance.now;

  function link({ rtt, jitter = 0, hz = 30, mass = 40, worldTime = 0, stallAt = null, arena = {} }) {
    let now = 0;
    performance.now = () => now;
    let seed = 9;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const extra = () => -Math.log(1 - rnd()) * jitter;

    sockets.length = 0;
    const world = createWorld(5, { ...MODES[0].world, ...arena });
    world.time = worldTime;
    const me = addPlayer(world, { id: "me", name: "Me" });
    me.cells[0].x = 4400; me.cells[0].y = 4400; me.cells[0].mass = mass;
    const cs = createClientState(0);
    const conn = createSocketConnection({ getTicket: () => ({ url: "ws://x", ticket: "t" }) });
    const sock = sockets[0];
    sock.fire("open");
    sock.fire("message", { data: JSON.stringify({ type: "welcome", nid: me.nid, tickHz: hz }) });

    const up = [], down = [], afterTick = [];
    let upAt = 0, downAt = 0, lastSent = -1, read = 0, tickAt = 0, nextTick = 0, nextFrame = 0;
    // `before` runs ahead of each client frame, as input does; `after` sees
    // what that frame drew.
    function run(ms, before, after) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(nextTick, nextFrame, up.length ? up[0].at : Infinity, down.length ? down[0].at : Infinity);
        if (up.length && up[0].at === now) {
          // As server/index.js does with every binary message.
          const msg = decodeClientMessage(up.shift().data);
          setAim(world, "me", msg.x, msg.y);
          me.inputSeq = msg.seq;
          me.inputAt = now;
          if (msg.type === MSG.ACTION) queueAction(world, "me", msg.action);
        } else if (down.length && down[0].at === now) {
          sock.fire("message", { data: down.shift().data });
        } else if (now === nextTick) {
          stepWorld(world, tickAt ? (now - tickAt) / 1000 : 1 / hz);
          tickAt = now;
          for (const fn of afterTick) fn();
          downAt = Math.max(downAt, now + rtt / 2 + extra());
          if (stallAt !== null && now >= stallAt && now < stallAt + 300) {
            downAt = Math.max(downAt, stallAt + 300 + rtt / 2);
          }
          down.push({ at: downAt, data: encodeSnapshot(world, me, cs, null, null, now).slice().buffer });
          nextTick += 1000 / hz;
        } else {
          before?.(now);
          conn.update(1 / 60);
          // Written in the same instant, so they leave and arrive together.
          for (; read < sock.sent.length; read++) {
            if (typeof sock.sent[read] === "string") continue;
            if (now !== lastSent) upAt = Math.max(upAt, now + rtt / 2 + extra());
            lastSent = now;
            up.push({ at: upAt, data: sock.sent[read] });
          }
          after?.(now, conn.getView());
          nextFrame += 1000 / 60;
        }
      }
    }
    const done = () => { conn.close(); performance.now = realNow; };
    return { world, me, conn, run, done, afterTick };
  }

  // Prediction used to correct onto the server's position advanced only by
  // the time since the packet arrived. That position already answered input
  // from a round trip earlier, so in steady motion the cell was pulled back
  // onto it: drawn a full round trip late, whatever prediction showed for a
  // moment after each twitch.
  {
    const L = link({ rtt: 200 });
    let drawn = null;
    L.run(3000, () => L.conn.sendAim(600, 0), (t, v) => { drawn = v; });
    const server = L.me.cells[0];
    const speed = Math.hypot(server.hx * server.sp, server.hy * server.sp);
    // The server is an uplink behind the player's input, so a cell drawn
    // where the input puts it is ahead of the server by about that much.
    const lead = drawn.me.x - server.x;
    check("over a 200ms link your cell is drawn ahead of the server, not behind it",
      lead > speed * 0.06 && lead < speed * 0.2,
      `${lead.toFixed(0)} units ahead at ${speed.toFixed(0)} units/s (an uplink is ${(speed * 0.1).toFixed(0)})`);
    L.done();
  }

  // A split showed a provisional piece at once, but the parent's mass was then
  // eased back toward the server's, which had not split yet — so for a round
  // trip the parent grew back to nearly full size beside its own half.
  {
    const L = link({ rtt: 200, mass: 400 });
    L.run(1000, () => L.conn.sendAim(600, 0));
    let split = false, maxRatio = 0, fewest = Infinity, handover = 0, prev = null;
    let serverMass = totalMass(L.me);
    L.afterTick.push(() => { serverMass = totalMass(L.me); });
    L.run(1000, () => {
      L.conn.sendAim(600, 0);
      if (!split) { L.conn.sendAction("split"); split = true; }
    }, (t, v) => {
      const mine = v.cells.filter(c => c.mine);
      maxRatio = Math.max(maxRatio, mine.reduce((s, c) => s + c.m, 0) / serverMass);
      fewest = Math.min(fewest, mine.length);
      // The moment the server's piece replaces the provisional one: it should
      // take over where the provisional one was drawn.
      const was = prev && prev.find(c => c.i < 0);
      const now = mine.find(c => c.i >= 0 && !(prev || []).some(p => p.i === c.i));
      if (was && now && !mine.some(c => c.i === was.i)) {
        handover = Math.max(handover, Math.hypot(now.x - was.x, now.y - was.y));
      }
      prev = mine;
    });
    check("a split is never drawn with more mass than the server holds",
      maxRatio < 1.05, `${(maxRatio * 100).toFixed(0)}% of the server's mass at most`);
    check("both halves stay on screen until the server confirms them", fewest === 2, `${fewest} at fewest`);
    check("the server's piece takes over where the provisional one was",
      handover > 0 && handover < 30, `${handover.toFixed(1)} units`);
    L.done();
  }

  // A split replayed from each snapshot used to re-decide which cells split
  // from that snapshot's masses. After a burst the pieces are all much of a
  // size, so an orb or two reordered them, and a provisional piece was handed
  // to a different parent between one replay and the next — and jumped across
  // the cluster to follow it.
  {
    // Nothing to eat, so the only mass that changes is the mass changed here.
    const L = link({ rtt: 200, arena: { pellets: 0, viruses: 0 } });
    // Ten pieces a unit apart in mass, with room for only six to split. The
    // sixth and seventh heaviest sit on opposite sides of the ring, so a piece
    // handed from one to the other has far to go.
    const slot = [6, 1, 2, 3, 4, 5, 0, 7, 8, 9];
    L.me.cells = [];
    for (let i = 0; i < 10; i++) {
      const a = (slot[i] / 10) * Math.PI * 2;
      L.me.cells.push({
        id: 9000 + i, x: 4400 + Math.cos(a) * 400, y: 4400 + Math.sin(a) * 400,
        mass: 45 - i, ci: 0, vx: 0, vy: 0, mergeAt: L.world.time + 100
      });
    }
    L.run(200, () => L.conn.sendAim(600, 0));
    // The seventh — left out at the keypress — eats its way past the sixth
    // while the split is on its way to the server.
    const seventh = L.me.cells.find(c => c.id === 9006);
    let pressed = false, worst = 0, prev = null;
    L.afterTick.push(() => { if (pressed) seventh.mass += 1.5; });
    L.run(400, () => {
      L.conn.sendAim(600, 0);
      if (!pressed) { L.conn.sendAction("split"); pressed = true; }
    }, (t, v) => {
      // Matched to the nearest unconfirmed piece of the frame before, not by
      // id: a piece that changed parents can come back under a new one.
      const pieces = v.cells.filter(c => c.mine && c.i < 0);
      if (prev && prev.length) {
        for (const c of pieces) {
          let near = Infinity;
          for (const p of prev) near = Math.min(near, Math.hypot(c.x - p.x, c.y - p.y));
          worst = Math.max(worst, near);
        }
      }
      prev = pieces;
    });
    check("an unconfirmed split piece stays with the cell it split from",
      worst > 0 && worst < 40, `${worst.toFixed(0)} units in one frame at worst`);
    L.done();
  }

  // Other players. The render clock used to be pinned to the latest-arriving
  // packet of the last second, so it stepped backwards whenever one came in
  // late, and everyone froze while waiting for a late packet. And it read
  // time as an f32, which a week into a room's life has 62ms steps — longer
  // than a tick.
  const circling = L => {
    const other = addPlayer(L.world, { id: "other", name: "Other" });
    const at = t => ({ x: 4400 + Math.cos(t * 1.2) * 400, y: 4400 + Math.sin(t * 1.2) * 400 });
    const place = () => {
      const p = at(L.world.time);
      other.cells[0].x = p.x; other.cells[0].y = p.y;
      other.cells[0].mass = totalMass(L.me);   // equal mass: nobody eats anybody
    };
    place();
    L.afterTick.push(place);
    let freezes = 0, backwards = 0, frames = 0, last = null, lastStep = null, lurch = 0;
    const watch = (t, v) => {
      const c = v.cells.find(x => x.o === other.nid);
      if (!c) { last = null; return; }
      if (last) {
        const step = { x: c.x - last.x, y: c.y - last.y };
        frames++;
        if (Math.hypot(step.x, step.y) < 0.05) freezes++;
        else if (lastStep && step.x * lastStep.x + step.y * lastStep.y < 0) backwards++;
        // The biggest change in movement from one frame to the next. The true
        // path is a smooth circle, eight units a frame, turning a fraction of
        // a unit per frame.
        if (lastStep) lurch = Math.max(lurch, Math.hypot(step.x - lastStep.x, step.y - lastStep.y));
        lastStep = step;
      }
      last = { x: c.x, y: c.y };
    };
    return { watch, result: () => ({ freezes, backwards, frames, lurch }) };
  };

  {
    const L = link({ rtt: 120, jitter: 8, worldTime: 7 * 24 * 3600 });
    const o = circling(L);
    L.run(1000);
    L.run(5000, null, o.watch);
    const r = o.result();
    check("a week into a room, other players never freeze under jitter",
      r.frames > 250 && r.freezes === 0, `${r.freezes} frozen of ${r.frames}`);
    check("and never step backwards", r.backwards === 0, `${r.backwards} backward steps`);
    check("or lurch", r.lurch < 3, `${r.lurch.toFixed(1)} units change of step at worst`);
    L.done();
  }

  // Over TCP one lost packet holds up everything behind it and then delivers
  // the lot at once. Counted packet by packet, one such hiccup tripled the
  // buffer — how far in the past everyone is drawn — for seconds after.
  {
    const L = link({ rtt: 100, jitter: 4, stallAt: 3000 });
    const o = circling(L);
    L.run(2900);
    const before = L.conn.stats().interpMs;
    L.run(1500);
    const after = L.conn.stats().interpMs;
    check("one stall does not leave everyone drawn further in the past",
      after < before * 1.3, `buffer ${before}ms before, ${after}ms a second after`);
    L.done();
  }
}

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
  const conn = createSocketConnection({ getTicket: () => ({ url: "ws://x", ticket: "t" }) });

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

  // Closing on purpose — swapping sockets to change stake, or signing out —
  // must not be reported as a disconnection. This fired the "connection lost"
  // card every time the client reconnected deliberately.
  const before = ended;
  conn.close();
  await new Promise(r => setTimeout(r, 50));
  check("a deliberate close is not reported as a disconnection",
    ended === before, `${ended - before} close events`);
  check("and it does not try to reconnect", sockets.length === 2, `${sockets.length} sockets`);
}

{
  // A takeover must NOT be retried — it would fight the other tab.
  sockets.length = 0;
  const w2 = createWorld(12, MODES[0].world);
  const p2 = addPlayer(w2, { id: "me", name: "Me" });
  const conn2 = createSocketConnection({ getTicket: () => ({ url: "ws://x", ticket: "t" }) });
  let ended2 = 0, retried = 0;
  conn2.on("close", () => ended2++);
  conn2.on("reconnecting", () => retried++);
  sockets[0].fire("open");
  sockets[0].fire("message", { data: JSON.stringify({ type: "welcome", nid: p2.nid, tickHz: TICK_HZ }) });
  sockets[0].fire("close", { code: 4001 });
  await new Promise(r => setTimeout(r, 100));
  check("a takeover ends the session instead of retrying",
    ended2 === 1 && retried === 0, `close ${ended2}, reconnecting ${retried}`);
  conn2.close();
}

console.log("\n-- a refusal is not retried --");

// The client retried any close except a takeover, so a deliberate refusal —
// wrong stake, stale client, room full — was repeated through the whole
// backoff before the player was told. Refreshing the page hit this: the old
// socket was still registered, the connection cap rejected the new one, and
// the reload crawled through eight attempts.
for (const [code, label] of [[1008, "policy"], [1013, "room full"], [1002, "protocol fault"], [1000, "normal"]]) {
  sockets.length = 0;
  const c = createSocketConnection({ getTicket: () => ({ url: "ws://x", ticket: "t" }) });
  let retried = 0, done = 0;
  c.on("reconnecting", () => retried++);
  c.on("close", () => done++);
  sockets[0].fire("open");
  sockets[0].fire("close", { code });
  await new Promise(r => setTimeout(r, 60));
  check(`close ${code} (${label}) is final`, retried === 0 && done === 1,
    `retried ${retried}, closed ${done}`);
  c.close();
}

// But a dropped link still recovers.
sockets.length = 0;
const drop = createSocketConnection({ getTicket: () => ({ url: "ws://x", ticket: "t" }) });
let dropRetries = 0;
drop.on("connecting", () => dropRetries++);
drop.on("reconnecting", () => dropRetries++);
sockets[0].fire("open");
sockets[0].fire("close", { code: 1006 });
await new Promise(r => setTimeout(r, 60));
check("close 1006 (dropped) still retries", dropRetries === 1, `${dropRetries}`);
drop.close();

console.log("\n-- a first connection is not a reconnection --");

// This is what put a "Reconnecting…" banner on screen every time the page was
// refreshed. A reload has never been connected to anything, so a retry on its
// first attempt was reported as a reconnection, and the banner announced the
// interruption of a game the player had not yet been in.
//
// Both cases still retry. They differ only in what they are called, which is
// the whole point: the caller shows a banner for one and not the other.
{
  sockets.length = 0;
  const w = createWorld(14, MODES[0].world);
  const p = addPlayer(w, { id: "me", name: "Me" });
  const cs = createClientState(0);
  const fresh = createSocketConnection({ getTicket: () => ({ url: "ws://x", ticket: "t" }) });
  const first = [], again = [];
  fresh.on("connecting", e => first.push(e));
  fresh.on("reconnecting", e => again.push(e));

  check("a brand new connection has never been live", fresh.everBeenLive() === false);

  // Three failures before the server ever says hello.
  for (let i = 0; i < 3; i++) {
    const sock = sockets[sockets.length - 1];
    sock.fire("open");
    sock.fire("close", { code: 1006 });
    await new Promise(r => setTimeout(r, 150));
  }
  check("failing to connect is reported as connecting", first.length === 3, `${first.length}`);
  check("and never as reconnecting", again.length === 0, `${again.length}`);
  check("it still counts the attempts", first[2].attempt === 3, `${first[2].attempt}`);
  check("and has still never been live", fresh.everBeenLive() === false);

  // Now the server answers.
  const live = sockets[sockets.length - 1];
  live.fire("open");
  live.fire("message", { data: JSON.stringify({ type: "welcome", nid: p.nid, tickHz: TICK_HZ }) });
  stepWorld(w, 1 / TICK_HZ);
  live.fire("message", { data: encodeSnapshot(w, p, cs, null).slice().buffer });
  check("the welcome makes it live", fresh.everBeenLive() === true);

  // From here a drop IS an interruption, and says so.
  live.fire("close", { code: 1006 });
  await new Promise(r => setTimeout(r, 60));
  check("a drop after that is reported as reconnecting", again.length === 1, `${again.length}`);
  check("and not as a first connection", first.length === 3, `${first.length}`);

  check("it has not given up", fresh.gaveUpTrying() === false);
  fresh.close();
}

console.log("\n-- giving up is distinct from being refused --");

// The menu says "could not reach the game server" off the back of this, and
// must not say it when the server answered and declined. A refusal has its own
// message; an exhausted retry has none.
{
  sockets.length = 0;
  const refused = createSocketConnection({ getTicket: () => ({ url: "ws://x", ticket: "t" }) });
  sockets[0].fire("open");
  sockets[0].fire("close", { code: 1008 });
  await new Promise(r => setTimeout(r, 60));
  check("a refusal is not giving up", refused.gaveUpTrying() === false);
  refused.close();

  sockets.length = 0;
  const unreachable = createSocketConnection({ getTicket: () => ({ url: "ws://x", ticket: "t" }) });
  let tries = 0, gone = 0;
  unreachable.on("connecting", () => tries++);
  unreachable.on("close", () => gone++);

  // This walks the real backoff to its end, which takes about seven seconds of
  // wall clock. Faking the schedule would test the fake, and the thing being
  // pinned is what happens at the far end of the real one.
  const deadline = Date.now() + 15000;
  let handled = 0;
  while (Date.now() < deadline && !gone) {
    if (sockets.length > handled) {
      const sock = sockets[handled++];
      sock.fire("open");
      sock.fire("close", { code: 1006 });
    }
    await new Promise(r => setTimeout(r, 25));
  }
  check("it ran the attempts out", tries === 8, `${tries} attempts`);
  check("then reported the connection closed", gone === 1, `${gone}`);
  check("and says it gave up rather than being refused",
    unreachable.gaveUpTrying() === true);
  unreachable.close();
  await new Promise(r => setTimeout(r, 50));
}

console.log("\n-- a connection that has gone quiet is not waited out --");

// The reconnect used to start only when the browser fired "close", and for the
// failures players actually hit — a Wi-Fi handover, a tower switch, a laptop
// waking, a proxy dropping an idle socket — the browser does not fire that
// until its own TCP timeout, tens of seconds later. The socket reads OPEN the
// whole time, so the game simply froze. Detection, not reconnection, was most
// of the wait.
//
// The deadlines are passed in here so the test does not spend the real 2.5s.
{
  sockets.length = 0;
  const w = createWorld(13, MODES[0].world);
  const p = addPlayer(w, { id: "me", name: "Me" });
  const cs = createClientState(0);
  const conn = createSocketConnection({
    getTicket: () => ({ url: "ws://x", ticket: "t" }),
    stallMs: 400, joinStallMs: 400
  });

  let retried = 0, ended = 0;
  conn.on("reconnecting", () => retried++);
  conn.on("close", () => ended++);

  sockets[0].fire("open");
  sockets[0].fire("message", { data: JSON.stringify({ type: "welcome", nid: p.nid, tickHz: TICK_HZ }) });
  stepWorld(w, 1 / TICK_HZ);
  sockets[0].fire("message", { data: encodeSnapshot(w, p, cs, null).slice().buffer });
  check("connected and receiving", !!conn.getView());

  // Traffic stops here. The socket goes on reporting OPEN and fires nothing,
  // which is exactly what a dead link looks like from JavaScript.
  await new Promise(r => setTimeout(r, 300));
  check("a gap shorter than the deadline is left alone",
    retried === 0 && sockets.length === 1, `retries ${retried}, sockets ${sockets.length}`);

  await new Promise(r => setTimeout(r, 500));
  check("but silence past it is treated as a disconnection, with no close event",
    retried === 1, `${retried} retries`);
  check("a replacement socket is opened", sockets.length === 2, `${sockets.length} sockets`);
  check("and the stale one is closed with a retryable code",
    sockets[0].closeCode === 4002, String(sockets[0].closeCode));

  // The abandoned socket says goodbye late, as a browser's does. Acting on it
  // would tear down the healthy connection that replaced it.
  sockets[0].fire("close", { code: 1006 });
  await new Promise(r => setTimeout(r, 60));
  check("its late close does not disturb the replacement",
    retried === 1 && ended === 0 && sockets.length === 2,
    `retries ${retried}, closes ${ended}, sockets ${sockets.length}`);

  // And the replacement recovers normally.
  sockets[1].fire("open");
  sockets[1].fire("message", { data: JSON.stringify({ type: "welcome", nid: p.nid, tickHz: TICK_HZ }) });
  check("the replacement re-joins", sockets[1].sent.some(m => String(m).includes("join")));

  conn.close();
}

console.log("\n-- every connection attempt asks the matchmaker first --");

// The harness connection at the top of this file is never closed, and once
// its frames stop its watchdog reconnects in the background. Each case below
// uses its own address and counts only its own sockets.
const socketsTo = url => sockets.filter(x => x.url === url);

// The server believes nothing a join says about the player except the signed
// ticket in it, and a ticket is spent on use and lives for seconds. So every
// attempt, reconnects included, has to start by asking for a new one.
{
  const w = createWorld(21, MODES[0].world);
  const p = addPlayer(w, { id: "me", name: "Me" });
  let asked = 0;
  const conn = createSocketConnection({
    getTicket: async () => ({ url: `ws://game-${++asked}`, ticket: `ticket-${asked}` })
  });
  check("nothing is opened before the matchmaker answers", socketsTo("ws://game-1").length === 0);
  await new Promise(r => setTimeout(r, 0));
  const first = socketsTo("ws://game-1")[0];
  check("then the socket goes where the matchmaker said", !!first);
  first.fire("open");
  const join = JSON.parse(first.sent[0]);
  check("and the join presents that ticket", join.type === "join" && join.ticket === "ticket-1",
    first.sent[0]);
  check("with nothing else about the player in it",
    !("token" in join) && !("stake" in join) && !("name" in join), Object.keys(join).join(","));
  first.fire("message", { data: JSON.stringify({ type: "welcome", nid: p.nid, tickHz: TICK_HZ }) });

  first.fire("close", { code: 1006 });
  await new Promise(r => setTimeout(r, 50));
  check("a reconnect asks again rather than reusing the ticket", asked === 2, `${asked} asks`);
  const second = socketsTo("ws://game-2")[0];
  second.fire("open");
  check("and presents the new one", JSON.parse(second.sent[0]).ticket === "ticket-2",
    second.sent[0]);
  conn.close();
}

{
  // An expired or already-spent ticket (4003), or a seat still held by the
  // server the player was on (4004), is not an answer: ask again.
  let asked = 0, ended = 0;
  const conn = createSocketConnection({ getTicket: () => ({ url: "ws://t4003", ticket: `t${++asked}` }) });
  conn.on("close", () => ended++);
  socketsTo("ws://t4003")[0].fire("open");
  socketsTo("ws://t4003")[0].fire("close", { code: 4003 });
  await new Promise(r => setTimeout(r, 50));
  check("a rejected ticket sends it back to the matchmaker", asked === 2 && ended === 0,
    `${asked} asks, ${ended} closes`);
  socketsTo("ws://t4003")[1].fire("open");
  socketsTo("ws://t4003")[1].fire("close", { code: 4004 });
  await new Promise(r => setTimeout(r, 200));
  check("and so does a seat held elsewhere", asked === 3 && ended === 0,
    `${asked} asks, ${ended} closes`);
  conn.close();
}

{
  // A refusal the player can act on is final, and reads exactly like the
  // server refusing: an account_error with the reason, then a close.
  const said = [];
  let closed = null, asked = 0;
  const refusal = code => Object.assign(new Error(`refused: ${code}`), { code });
  const conn = createSocketConnection({ getTicket: async () => { asked++; throw refusal("full"); } });
  conn.on("account", m => said.push(m));
  conn.on("close", ev => { closed = ev; });
  await new Promise(r => setTimeout(r, 200));
  check("a full mode is reported as the server would",
    said[0]?.type === "account_error" && said[0]?.code === "full", JSON.stringify(said[0] || {}));
  check("with the room-full close code", closed?.code === 1013, JSON.stringify(closed));
  check("and it is not asked again", asked === 1, `${asked} asks`);
  conn.close();

  // One that is not the player's to fix — the matchmaker was unreachable,
  // or busy — is retried like a dropped connection.
  let asks = 0, retrying = 0, ended = 0;
  const flaky = createSocketConnection({
    getTicket: async () => {
      if (++asks === 1) throw refusal("unavailable");
      return { url: "ws://flaky", ticket: "t" };
    }
  });
  flaky.on("connecting", () => retrying++);
  flaky.on("close", () => ended++);
  await new Promise(r => setTimeout(r, 50));
  check("an unreachable matchmaker is retried", retrying === 1 && ended === 0 && asks === 2,
    `${retrying} retries, ${ended} closes, ${asks} asks`);
  check("and the second answer is used", socketsTo("ws://flaky").length === 1,
    `${socketsTo("ws://flaky").length} sockets`);
  flaky.close();

  // Closing while the matchmaker is still answering must not open a socket
  // afterwards: the player has gone back to the menu.
  let answer;
  const slow = createSocketConnection({ getTicket: () => new Promise(r => { answer = r; }) });
  slow.close();
  answer({ url: "ws://slow", ticket: "t" });
  await new Promise(r => setTimeout(r, 20));
  check("an answer that arrives after closing opens nothing", socketsTo("ws://slow").length === 0,
    `${socketsTo("ws://slow").length} sockets`);
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
