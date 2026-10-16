// ---------------------------------------------------------------------------
// Snapshots against the world they describe. Run with:
//   node test/snapshot.test.js
//
// Every client's snapshot is decoded and applied to a model of what that
// client knows, exactly as client/net.js folds it in (pellets added and
// removed, names learnt, everything cleared on a keyframe), and that model is
// checked against the world by brute force: every cell, pellet and virus the
// view radius covers, and nothing else, with the right ids, positions, sizes,
// owners and flags. So a pellet sent twice, a removal for something never
// sent, something left on a client's screen after it has gone or a name
// missing for a visible cell all fail here, whatever the encoder does
// internally.
//
// The server shares one snapshotFrame per room per tick across every client;
// encodeSnapshot without one builds its own. Both must give the same bytes.
// ---------------------------------------------------------------------------

import {
  createWorld, addPlayer, fillBots, stepWorld, queueAction, setAim, planZone, resetArena,
  removePlayer, radiusOf, totalMass, centroid, leaderboard, PELLET_MASS, TICK_HZ
} from "../shared/sim.js";
import {
  encodeSnapshot, snapshotFrame, decodeSnapshot, createClientState, viewRadius,
  KEYFRAME_TICKS, BOARD_TICKS
} from "../shared/protocol.js";

let failures = 0;
function check(label, condition, detail = "") {
  const ok = !!condition;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const DT = 1 / TICK_HZ;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── a client, as client/net.js keeps it ─────────────────────────────────────

function makeClient(player, stagger) {
  return {
    player, eyeId: null,
    shared: createClientState(stagger),   // encoded with the room's frame
    alone: createClientState(stagger),    // encoded with a frame of its own
    pellets: new Map(), names: new Set(),
    snaps: 0, problems: []
  };
}

// Folds a snapshot in, noting anything a correct stream could not contain.
function apply(cl, snap) {
  const bad = m => { if (cl.problems.length < 5) cl.problems.push(`tick ${snap.tick}: ${m}`); };
  if (snap.keyframe) { cl.pellets.clear(); cl.names.clear(); }
  for (const n of snap.names) {
    if (cl.names.has(n.nid)) bad(`name ${n.nid} sent again`);
    cl.names.add(n.nid);
  }
  for (const p of snap.added) {
    if (cl.pellets.has(p.id)) bad(`pellet ${p.id} added twice`);
    cl.pellets.set(p.id, { ...p, sentAt: snap.tick });
  }
  for (const id of snap.removed) {
    if (!cl.pellets.has(id)) bad(`pellet ${id} removed but never added`);
    cl.pellets.delete(id);
  }
  for (const c of snap.cells) if (!cl.names.has(c.o)) bad(`cell ${c.i} shown with no name for owner ${c.o}`);
  cl.snaps++;
}

// What the client should be holding now, worked out from the world alone.
function verify(w, cl, snap, round) {
  const bad = m => { if (cl.problems.length < 5) cl.problems.push(`tick ${snap.tick}: ${m}`); };
  const eye = cl.eyeId ? w.players.get(cl.eyeId) : null;
  const view = eye && eye.alive && eye.cells.length ? eye : cl.player;
  const me = centroid(view), R = viewRadius(view);
  const inside = (x, y, pad) => (x - me.x) ** 2 + (y - me.y) ** 2 < (R + pad) ** 2;

  // Pellets: every live one strictly inside the view radius, nothing else.
  const want = new Map();
  for (const p of w.pellets) if (!p.dead && inside(p.x, p.y, 0)) want.set(p.id, p);
  if (want.size !== cl.pellets.size) bad(`holds ${cl.pellets.size} pellets, ${want.size} in view`);
  for (const [id, p] of want) {
    const got = cl.pellets.get(id);
    if (!got) { bad(`pellet ${id} in view but not held`); continue; }
    // Records are sent once, where the pellet was then; a still one is still
    // there, and a moving one carries the velocity it left with.
    if (!p.vx && !p.vy && !got.vx && !got.vy && (got.x !== Math.round(p.x) || got.y !== Math.round(p.y))) bad(`pellet ${id} at ${got.x},${got.y}, is at ${p.x},${p.y}`);
    // Flags as of the snapshot that carried it (whose mass is "mine" is the
    // viewer's at the time).
    if (got.sentAt === snap.tick && (got.ci !== p.ci || got.big !== p.mass > PELLET_MASS ||
        got.mine !== (p.owner === view.id) || got.vx !== Math.round(p.vx) || got.vy !== Math.round(p.vy))) bad(`pellet ${id} record`);
  }
  // Cells: every live cell whose body reaches into the view.
  const cells = [];
  for (const p of w.players.values()) {
    if (!p.alive) continue;
    for (const c of p.cells) if (inside(c.x, c.y, radiusOf(c.mass))) cells.push({ c, p });
  }
  if (cells.length !== snap.cells.length) bad(`${snap.cells.length} cells sent, ${cells.length} in view`);
  cells.forEach(({ c, p }, i) => {
    const s = snap.cells[i];
    if (!s || s.i !== c.id || s.x !== Math.round(c.x) || s.y !== Math.round(c.y) ||
        s.m !== Math.min(65535, Math.round(c.mass)) || s.o !== p.nid) { bad(`cell ${c.id} record`); return; }
    const mine = p.id === view.id;
    if (s.mine !== mine || s.s !== (mine && w.time < c.mergeAt ? 1 : 0)) bad(`cell ${c.id} flags`);
    if (mine && (s.vx !== Math.round(c.vx || 0) || s.vy !== Math.round(c.vy || 0))) bad(`cell ${c.id} motion`);
  });
  // Viruses: every one within the view radius plus 60.
  const vs = w.viruses.filter(v => inside(v.x, v.y, 60));
  if (vs.length !== snap.viruses.length || vs.some((v, i) => snap.viruses[i][3] !== v.vid ||
      snap.viruses[i][0] !== Math.round(v.x) || snap.viruses[i][2] !== v.fed)) bad("viruses");
  // The viewer's own figures.
  if (snap.me.alive !== !!view.alive || snap.me.mass !== Math.round(totalMass(view)) ||
      snap.me.orbs !== view.orbs || snap.me.x !== Math.round(me.x)) bad("me");
  if (snap.spectating !== (view !== cl.player)) bad("spectating flag");
  if (round && (snap.round.phase !== round.phase || snap.round.number !== round.number)) bad("round");
  if (snap.board) {
    const top = leaderboard(w);
    if (snap.board.length !== top.length || top.some((r, i) => snap.board[i].mass !== r.mass ||
        snap.board[i].you !== (r.id === cl.player.id))) bad("board");
  }
}

// Every client's snapshot for this tick, both ways; folded in, and checked
// against the world for the ones in `full`.
function sendAll(w, clients, round, full) {
  const frame = snapshotFrame(w);
  let differ = 0, bytes = 0;
  for (const cl of clients) {
    const eye = cl.eyeId ? w.players.get(cl.eyeId) : null;
    const a = encodeSnapshot(w, cl.player, cl.shared, round, eye, 1000, frame);
    const b = encodeSnapshot(w, cl.player, cl.alone, round, eye, 1000);
    if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) differ++;
    bytes += a.length;
    const snap = decodeSnapshot(a);
    apply(cl, snap);
    if (full(cl)) verify(w, cl, snap, round);
  }
  return { differ, bytes };
}

function report(label, clients, extra) {
  const problems = clients.flatMap(c => c.problems.map(p => `${c.player.id} ${p}`));
  check(label, !problems.length, problems.length ? problems.slice(0, 3).join("; ") : extra);
}

console.log("\nA full Standard room, every client, every tick");
{
  const w = createWorld(31, { size: 8800, pellets: 4100, viruses: 90, botLevel: "hard" });
  const humans = [];
  for (let i = 0; i < 6; i++) humans.push(addPlayer(w, { id: `h${i}`, name: `Human ${i}` }));
  fillBots(w, 100);
  const r = rng(31);
  for (const p of w.players.values()) p.cells[0].mass = 20 + Math.pow(r(), 2) * 1500;
  // Every player gets snapshots, as every client would; the humans throw and
  // split, so their own mass and pieces are in their views.
  const clients = [...w.players.values()].map((p, i) => makeClient(p, i));
  planZone(w, w.time + 25);
  const round = { phase: 1, remaining: 25, number: 3 };
  let differ = 0, bytes = 0, ticks = 0, deaths = 0;
  for (let t = 0; t < 320; t++) {
    for (const h of humans) {
      if (!h.alive) { queueAction(w, h.id, "respawn"); continue; }
      setAim(w, h.id, (r() - 0.5) * 900, (r() - 0.5) * 900);
      if (t % 4 === 0) queueAction(w, h.id, "eject");
      if (t % 30 === 7) queueAction(w, h.id, "split");
    }
    for (const e of stepWorld(w, DT)) if (e.t === "death") deaths++;
    round.remaining = Math.max(0, 25 - w.time);
    // A dead human watches the biggest bot, as the server's spectate does.
    for (const cl of clients) {
      if (!cl.player.bot) cl.eyeId = cl.player.alive ? null : [...w.players.values()].find(p => p.bot && p.alive)?.id ?? null;
    }
    const got = sendAll(w, clients, round, cl => !cl.player.bot || t % 8 === cl.player.nid % 8);
    differ += got.differ; bytes += got.bytes; ticks++;
  }
  check("the room's shared frame gives the same bytes as encoding alone", differ === 0, `${differ} differed of ${ticks * clients.length}`);
  report("every client holds exactly what is in its view, every tick", clients,
    `${clients.length} clients x ${ticks} ticks, ${deaths} deaths, ${(bytes / ticks / 1024).toFixed(0)} KiB a tick`);
  check("keyframes and boards came round", ticks > KEYFRAME_TICKS * 3 && ticks > BOARD_TICKS);
}

console.log("\nRounds ending, players leaving, spectating");
{
  const w = createWorld(32, { size: 4000, pellets: 1500, viruses: 20, botLevel: "hard" });
  const a = addPlayer(w, { id: "a", name: "A" });
  const b = addPlayer(w, { id: "b", name: "B" });
  fillBots(w, 30);
  const clients = [makeClient(a, 0), makeClient(b, 37)];
  const round = { phase: 1, remaining: 60, number: 1 };
  for (let t = 0; t < 360; t++) {
    if (t === 60) { a.alive = false; a.cells = []; clients[0].eyeId = "b"; }   // watching b
    if (t === 120) { b.alive = false; b.cells = []; }                          // b gone: a's view falls back
    if (t === 150) { queueAction(w, "a", "respawn"); queueAction(w, "b", "respawn"); clients[0].eyeId = null; }
    if (t === 200) for (const id of [...w.players.keys()].filter(id => id.startsWith("bot:")).slice(0, 10)) removePlayer(w, id);
    if (t === 260) { resetArena(w); round.number++; }
    stepWorld(w, DT);
    sendAll(w, clients, round, () => true);
  }
  report("through a death, spectating, a respawn, leavers and a new round", clients,
    `${clients[0].snaps + clients[1].snaps} snapshots`);
}

console.log("\nA client that misses ticks");
{
  // The server sends nothing to a client too far behind, and does not encode
  // for it either, so its delta state still matches what it was last sent.
  const w = createWorld(33, { size: 6000, pellets: 2000, viruses: 30, botLevel: "hard" });
  const me = addPlayer(w, { id: "me", name: "Me" });
  fillBots(w, 40);
  const cl = makeClient(me, 5);
  let skipped = 0;
  for (let t = 0; t < 400; t++) {
    setAim(w, "me", Math.cos(t / 40) * 600, Math.sin(t / 40) * 600);
    stepWorld(w, DT);
    if (t % 50 >= 20 && t % 50 < 45) { skipped++; continue; }   // 25 ticks in every 50 held back
    sendAll(w, [cl], null, () => true);
  }
  report("held back for long stretches, it still ends each one holding exactly its view", [cl],
    `${skipped} ticks held back, ${cl.snaps} sent`);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exitCode = failures ? 1 : 0;
