#!/usr/bin/env python3
"""
Builds docs/engulfs-field-manual.pdf — the player's manual for Engulfs.

Every number in here is read from the simulation rather than typed in, so the
manual cannot quietly drift away from the game. Run it after changing any
tuning constant:

    python3 scripts/manual.py

Requires reportlab (pip install reportlab).
"""

import json
import re
import subprocess
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.graphics.shapes import Drawing, Circle, String, Line, Polygon, Rect, PolyLine
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether, NextPageTemplate,
)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "engulfs-field-manual.pdf"

# ── the game's own palette, from client/render.js and index.html ────────────

INK = colors.HexColor("#111111")
MUTED = colors.HexColor("#6f6f6d")
ACCENT = colors.HexColor("#7a56a8")
ACCENT_SOFT = colors.HexColor("#efe9f7")
VIRUS = colors.HexColor("#6aa84f")
VIRUS_EDGE = colors.HexColor("#47772f")
DANGER = colors.HexColor("#d1493f")
RULE = colors.HexColor("#d9d9d6")
PAPER = colors.HexColor("#faf9f7")
STAINS = ["#3b6ea5", "#d1493f", "#7a56a8", "#d9779f", "#3f9377", "#d09030", "#5f8f57"]


# ── facts, read out of the simulation ───────────────────────────────────────

def read_constants():
    """Pull the live tuning values out of shared/ via node, so the manual and
    the game cannot disagree."""
    script = """
    import * as S from './shared/sim.js';
    const { createWorld, addPlayer, spawnRing } = S;
    import { MODES } from './shared/modes.js';
    import * as W from './shared/wager.js';
    const names = ['WORLD','PELLETS','VIRUSES','START_MASS','PELLET_MASS','EJECT_MASS',
      'EJECT_KEEP','VIRUS_MASS','VIRUS_EAT_RATIO','VIRUS_PIECES','MAX_CELLS','EAT_RATIO',
      'EAT_BONUS','MERGE_DELAY','DECAY_ABOVE','BASE_SPEED','EJECT_SPEED',
      'EJECT_OWNER_COOLDOWN','VIRUS_FEED_HITS','VIRUS_SPLIT_SPEED','VIRUS_MAX_RATIO',
      'SPAWN_GAP','TICK_HZ'];
    const out = {};
    for (const n of names) out[n] = S[n];
    out.MODES = MODES;
    out.MICRO_PER_MASS = W.MICRO_PER_MASS;
    out.UNIT = W.UNIT;
    const speed = m => S.BASE_SPEED * Math.pow(m, -0.24) * 60;
    out.speed = {};
    for (const m of [20, 50, 100, 200, 400, 800, 1600])
      out.speed[m] = { r: S.radiusOf(m), v: speed(m),
                       merge: (11 + (m / 2) * 0.022) * S.MERGE_DELAY };

    // How far a split actually throws you, and how long you stay in pieces.
    // CELL_FRICTION is private to sim.js, so the decay is rebuilt from the
    // same 0.935 per 1/60s it is defined with.
    const LN = -Math.log(Math.pow(0.935, 60));
    out.split = {};
    for (const m of [60, 100, 200, 400, 800, 1600]) {
      const half = m / 2;
      const launch = S.splitLaunchSpeed(half);
      out.split[m] = {
        half, launch, travel: launch / LN,
        reach: S.radiusOf(m) * 0.4 + launch / LN + S.radiusOf(half),
        merge: (11 + half * 0.022) * S.MERGE_DELAY,
        boost: launch / speed(m),
      };
    }

    // Every cell you are big enough to eat is faster than you. This is the
    // table that proves it.
    out.pursuit = [];
    for (const ratio of [S.EAT_RATIO, 1.3, 2, 4, 8]) {
      const you = 400, prey = you / ratio;
      out.pursuit.push({ ratio, prey, theirs: speed(prey), yours: speed(you),
                         edge: (speed(prey) / speed(you) - 1) * 100 });
    }
    // The board: measured, not asserted. A real seeded arena is built and its
    // orb and virus layout is sampled, so the map in the manual is a map of a
    // world the server could actually deal.
    const nn = pts => {
      const G = 400, b = new Map(), key = (a, c) => a * 100003 + c;
      pts.forEach((q, i) => {
        const k = key((q.x / G) | 0, (q.y / G) | 0);
        if (!b.has(k)) b.set(k, []);
        b.get(k).push(i);
      });
      const out = [];
      pts.forEach((q, i) => {
        let best = Infinity;
        const gx = (q.x / G) | 0, gy = (q.y / G) | 0;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
          for (const j of b.get(key(gx + dx, gy + dy)) || []) {
            if (j === i) continue;
            const d = Math.hypot(pts[j].x - q.x, pts[j].y - q.y);
            if (d < best) best = d;
          }
        if (best < Infinity) out.push(best);
      });
      return out.sort((a, c) => a - c);
    };
    const med = a => a[(a.length / 2) | 0];

    out.board = {};
    for (const m of MODES) {
      const w = createWorld(42, { size: m.world.size, pellets: m.world.pellets,
                                  viruses: m.world.viruses });
      const Sz = m.world.size, N = 10, cells = new Array(N * N).fill(0);
      for (const q of w.pellets)
        cells[Math.min(N - 1, (q.y / Sz * N) | 0) * N + Math.min(N - 1, (q.x / Sz * N) | 0)]++;

      const ring = createWorld(1, { size: Sz, pellets: 0, viruses: 0 });
      const ps = [];
      for (let i = 0; i < m.lobbyMin; i++)
        ps.push(addPlayer(ring, { id: 'p' + i, name: 'P' + i }));
      spawnRing(ring, ps);
      const c = Sz / 2;
      const rr = Math.hypot(ps[0].cells[0].x - c, ps[0].cells[0].y - c);

      out.board[m.id] = {
        size: Sz,
        orbGap: med(nn(w.pellets)),
        virusGap: med(nn(w.viruses)),
        virusMin: nn(w.viruses)[0],
        areaPerOrb: Sz * Sz / w.pellets.length,
        areaPerVirus: Sz * Sz / w.viruses.length,
        richest: Math.max(...cells),
        emptiest: Math.min(...cells),
        ringRadius: rr,
        ringGap: Math.hypot(ps[0].cells[0].x - ps[1].cells[0].x,
                            ps[0].cells[0].y - ps[1].cells[0].y),
        wallClear: Sz / 2 - rr,
        // A thinned sample for drawing. Every 9th orb keeps the clumping
        // visible without putting 4,100 circles in a PDF.
        orbs: w.pellets.filter((_, i) => i % 9 === 0).map(q => [Math.round(q.x), Math.round(q.y)]),
        vir: w.viruses.map(q => [Math.round(q.x), Math.round(q.y)]),
      };
    }
    out.spawnPad = 140;

    // View radius has a floor, so it does NOT grow with mass until you are
    // already large. Solved rather than assumed.
    const { viewRadius } = await import('./shared/protocol.js');
    const fake = m => ({ cells: [{ mass: m }], alive: true });
    out.viewFloor = viewRadius(fake(1));
    let lo = 1, hi = 20000;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (viewRadius(fake(mid)) > out.viewFloor) hi = mid; else lo = mid;
    }
    out.viewGrowsAbove = hi;
    console.log(JSON.stringify(out));
    """
    raw = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(raw)


def read_timings():
    """Round, intermission and countdown lengths, from the server's defaults."""
    src = (ROOT / "server" / "index.js").read_text()
    out = {}
    for key, pattern in (
        ("countdown", r'envInt\("COUNTDOWN_SECONDS", (\d+)\)'),
        ("intermission", r'envInt\("INTERMISSION_SECONDS", TEST_MODE \? \d+ : (\d+)\)'),
        ("linger", r'envInt\("LINGER_SEC", (\d+)\)'),
    ):
        m = re.search(pattern, src)
        out[key] = int(m.group(1)) if m else None
    return out


K = read_constants()
T = read_timings()
STD = next(m for m in K["MODES"] if m["id"] == "standard")
HIGH = next(m for m in K["MODES"] if m["id"] == "highstakes")

EAT_PCT = (K["EAT_RATIO"] - 1) * 100                    # 9.8
POP_MASS = K["VIRUS_MASS"] * K["VIRUS_EAT_RATIO"]       # 126.5
EJECT_LOSS = (K["EJECT_MASS"] - K["EJECT_KEEP"]) / K["EJECT_MASS"] * 100
MASS_PER_USDC = K["UNIT"] / K["MICRO_PER_MASS"]         # 200
ORBS_TO_100 = -(-(100 - K["START_MASS"]) // K["PELLET_MASS"])


def radius_of(mass):
    return mass ** 0.5 * 4 * 2      # diameter, which is what a player perceives


def money(units):
    return f"{units / K['UNIT']:.2f}"


def mmss(sec):
    return f"{sec // 60}:{sec % 60:02d}"


# ── styles ──────────────────────────────────────────────────────────────────

def style(name, **kw):
    base = dict(name=name, fontName="Helvetica", fontSize=9.5, leading=14,
                textColor=INK, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(**base)


S_BODY = style("body", spaceAfter=7)
S_LEAD = style("lead", fontSize=11.5, leading=17, textColor=colors.HexColor("#333331"),
               spaceAfter=10)
S_H1 = style("h1", fontName="Helvetica-Bold", fontSize=21, leading=25,
             textColor=INK, spaceAfter=3, spaceBefore=0)
S_H2 = style("h2", fontName="Helvetica-Bold", fontSize=12.5, leading=16,
             textColor=INK, spaceBefore=13, spaceAfter=4)
S_H3 = style("h3", fontName="Helvetica-Bold", fontSize=10, leading=13,
             textColor=ACCENT, spaceBefore=9, spaceAfter=3)
S_KICKER = style("kicker", fontName="Helvetica-Bold", fontSize=8, leading=11,
                 textColor=ACCENT, spaceAfter=2)
S_NOTE = style("note", fontSize=9, leading=13, textColor=colors.HexColor("#3a3a38"))
S_CAPTION = style("caption", fontSize=8, leading=11, textColor=MUTED, spaceBefore=2,
                  spaceAfter=8)
S_CELL = style("cell", fontSize=8.8, leading=12)
S_CELLB = style("cellb", fontSize=8.8, leading=12, fontName="Helvetica-Bold")
S_TH = style("th", fontSize=7.5, leading=10, fontName="Helvetica-Bold",
             textColor=MUTED)
S_COVER_T = style("coverT", fontName="Helvetica-Bold", fontSize=42, leading=46,
                  textColor=INK)
S_COVER_S = style("coverS", fontSize=13, leading=19, textColor=MUTED)
S_SKILLNUM = style("sn", fontName="Helvetica-Bold", fontSize=20, leading=22,
                   textColor=colors.white, alignment=TA_CENTER)


def P(text, s=S_BODY):
    return Paragraph(text, s)


def bullets(items, s=S_BODY):
    rows = [[Paragraph("&bull;", s), Paragraph(t, s)] for t in items]
    t = Table(rows, colWidths=[5 * mm, None])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return t


def datatable(header, rows, widths, align_right=()):
    data = [[Paragraph(h.upper(), S_TH) for h in header]]
    for r in rows:
        data.append([c if isinstance(c, Paragraph) else Paragraph(str(c), S_CELL)
                     for c in r])
    t = Table(data, colWidths=widths, repeatRows=1)
    cmds = [
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, RULE),
        ("LINEBELOW", (0, 1), (-1, -2), 0.3, colors.HexColor("#ecebe8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    for c in align_right:
        cmds.append(("ALIGN", (c, 0), (c, -1), "RIGHT"))
        cmds.append(("RIGHTPADDING", (c, 0), (c, -1), 0))
    t.setStyle(TableStyle(cmds))
    return t


def callout(title, body, tone=ACCENT, fill=ACCENT_SOFT):
    inner = [P(title, style("ct", fontName="Helvetica-Bold", fontSize=9,
                            leading=12, textColor=tone, spaceAfter=3)),
             P(body, style("cb", fontSize=9, leading=13))]
    t = Table([[inner]], colWidths=[None])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, tone),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return t


def two_col(left, right, gap=6 * mm, ratio=0.5):
    w = CONTENT_W
    lw = (w - gap) * ratio
    t = Table([[left, "", right]], colWidths=[lw, gap, w - gap - lw])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


# ── diagrams ────────────────────────────────────────────────────────────────

def cell_shape(d, x, y, r, fill, label=None, label_size=7, edge=True):
    d.add(Circle(x, y, r, fillColor=colors.HexColor(fill),
                 strokeColor=colors.Color(0, 0, 0, 0.22) if edge else None,
                 strokeWidth=1))
    if label:
        d.add(String(x, y - label_size * 0.35, label, fontName="Helvetica-Bold",
                     fontSize=label_size, fillColor=colors.white,
                     textAnchor="middle"))


def virus_shape(d, x, y, r, spikes=14):
    pts = []
    import math
    for i in range(spikes * 2):
        ang = math.pi * i / spikes
        rad = r * 1.12 if i % 2 == 0 else r * 0.88
        pts += [x + math.cos(ang) * rad, y + math.sin(ang) * rad]
    d.add(Polygon(pts, fillColor=VIRUS, strokeColor=VIRUS_EDGE, strokeWidth=1))


def arrow(d, x1, y1, x2, y2, col=MUTED, w=0.9, head=4):
    import math
    d.add(Line(x1, y1, x2, y2, strokeColor=col, strokeWidth=w))
    ang = math.atan2(y2 - y1, x2 - x1)
    for s in (2.6, -2.6):
        d.add(Line(x2, y2,
                   x2 - math.cos(ang - s / 4) * head,
                   y2 - math.sin(ang - s / 4) * head,
                   strokeColor=col, strokeWidth=w))


def dia_eat_rule():
    """Who can eat whom: the 9.8% line."""
    d = Drawing(CONTENT_W, 116)
    y = 62
    cell_shape(d, 52, y, 30, STAINS[0], "100")
    d.add(String(52, 16, "a rival of mass 100", fontName="Helvetica", fontSize=7.5,
                 fillColor=MUTED, textAnchor="middle"))

    cell_shape(d, 160, y, 29, "#9a9a97", "109")
    d.add(String(160, 16, "you at 109 - too small", fontName="Helvetica", fontSize=7.5,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(160, 100, "cannot eat", fontName="Helvetica-Bold", fontSize=7.5,
                 fillColor=DANGER, textAnchor="middle"))

    cell_shape(d, 285, y, 33, STAINS[2], "110")
    d.add(String(285, 16, "you at 110 - eats it", fontName="Helvetica", fontSize=7.5,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(285, 100, "eats, and gains 132", fontName="Helvetica-Bold",
                 fontSize=7.5, fillColor=VIRUS_EDGE, textAnchor="middle"))
    arrow(d, 320, y, 366, y, ACCENT, 1.2, 5)
    d.add(String(430, y - 3, f"{K['EAT_BONUS']}x their mass", fontName="Helvetica-Bold",
                 fontSize=8, fillColor=ACCENT, textAnchor="middle"))
    d.add(String(430, y - 15, "is what you collect", fontName="Helvetica", fontSize=7.5,
                 fillColor=MUTED, textAnchor="middle"))
    return d


def dia_timeline():
    d = Drawing(CONTENT_W, 74)
    w = CONTENT_W
    segs = [
        ("Lobby", "until the room fills", 0.20, colors.HexColor("#e6e5e1")),
        (f"Count {T['countdown']}s", "everyone ready", 0.10, ACCENT),
        (f"Round {STD['roundSeconds'] // 60} min", "the only part that pays", 0.52, colors.HexColor("#2f2f2d")),
        (f"Standings {T['intermission']}s", "opt in for the next", 0.18, colors.HexColor("#b9b7b1")),
    ]
    x = 0
    for label, sub, frac, col in segs:
        sw = w * frac
        d.add(Rect(x, 30, sw - 2, 22, fillColor=col, strokeColor=None))
        light = col in (ACCENT, colors.HexColor("#2f2f2d"))
        d.add(String(x + sw / 2 - 1, 38, label, fontName="Helvetica-Bold", fontSize=8,
                     fillColor=colors.white if light else INK, textAnchor="middle"))
        d.add(String(x + sw / 2 - 1, 19, sub, fontName="Helvetica", fontSize=7,
                     fillColor=MUTED, textAnchor="middle"))
        x += sw
    d.add(String(0, 60, "ONE CYCLE", fontName="Helvetica-Bold", fontSize=7.5,
                 fillColor=MUTED))
    d.add(Line(0, 56, w, 56, strokeColor=RULE, strokeWidth=0.6))
    return d


def dia_ring():
    """Everyone opens the same distance apart."""
    import math
    d = Drawing(CONTENT_W * 0.42, 132)
    cx, cy, R = CONTENT_W * 0.21, 66, 46
    d.add(Rect(cx - 60, cy - 60, 120, 120, fillColor=colors.HexColor("#ffffff"),
               strokeColor=RULE, strokeWidth=0.8))
    d.add(Circle(cx, cy, R, fillColor=None, strokeColor=colors.HexColor("#e2ddef"),
                 strokeWidth=0.8, strokeDashArray=[2, 2]))
    n = 10
    for i in range(n):
        a = math.pi / 2 + i * 2 * math.pi / n
        col = STAINS[2] if i == 0 else "#b9b7b1"
        cell_shape(d, cx + math.cos(a) * R, cy + math.sin(a) * R, 5.5, col, edge=False)
    d.add(String(cx, cy - 3, "equal gaps", fontName="Helvetica", fontSize=7,
                 fillColor=MUTED, textAnchor="middle"))
    return d


def dia_virus_feed():
    """Three blobs in, one virus out."""
    d = Drawing(CONTENT_W, 128)
    y = 74
    cell_shape(d, 26, y, 17, STAINS[2])
    d.add(String(26, 40, "you", fontName="Helvetica", fontSize=7, fillColor=MUTED,
                 textAnchor="middle"))

    for i, x in enumerate((62, 84, 106)):
        d.add(Circle(x, y, 5, fillColor=colors.HexColor(STAINS[2]), strokeColor=None))
    arrow(d, 118, y, 140, y, MUTED, 0.9, 4)
    d.add(String(84, 40, f"{K['VIRUS_FEED_HITS']} blobs of ejected mass",
                 fontName="Helvetica", fontSize=7, fillColor=MUTED, textAnchor="middle"))

    virus_shape(d, 168, y, 22)
    d.add(String(168, 40, "it swells, then splits", fontName="Helvetica", fontSize=7,
                 fillColor=MUTED, textAnchor="middle"))

    arrow(d, 196, y, 232, y, ACCENT, 1.2, 5)
    virus_shape(d, 258, y, 20)
    virus_shape(d, 330, y, 20)
    arrow(d, 282, y, 306, y, VIRUS_EDGE, 1.1, 5)
    d.add(String(294, 40, "the new one is shot along", fontName="Helvetica", fontSize=7,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(294, 30, "the line your mass came in on",
                 fontName="Helvetica", fontSize=7, fillColor=MUTED, textAnchor="middle"))

    d.add(String(400, y + 12, "about", fontName="Helvetica", fontSize=7.5,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(400, y - 2, "450", fontName="Helvetica-Bold", fontSize=15,
                 fillColor=ACCENT, textAnchor="middle"))
    d.add(String(400, y - 14, "units out", fontName="Helvetica", fontSize=7.5,
                 fillColor=MUTED, textAnchor="middle"))
    return d


def dia_speed_curve():
    d = Drawing(CONTENT_W * 0.52, 128)
    w, h = CONTENT_W * 0.52, 128
    x0, y0, pw, ph = 26, 26, w - 46, h - 52
    d.add(Line(x0, y0, x0 + pw, y0, strokeColor=RULE, strokeWidth=0.8))
    d.add(Line(x0, y0, x0, y0 + ph, strokeColor=RULE, strokeWidth=0.8))

    pts = []
    masses = sorted(int(m) for m in K["speed"])
    vmax = K["speed"][str(masses[0])]["v"]
    import math
    lo, hi = math.log(masses[0]), math.log(masses[-1])
    for m in masses:
        fx = x0 + pw * (math.log(m) - lo) / (hi - lo)
        fy = y0 + ph * (K["speed"][str(m)]["v"] / vmax) * 0.94
        pts += [fx, fy]
    d.add(PolyLine(pts, strokeColor=ACCENT, strokeWidth=1.8))
    for i in range(0, len(pts), 2):
        d.add(Circle(pts[i], pts[i + 1], 2.2, fillColor=ACCENT, strokeColor=None))

    for m in (masses[0], 200, masses[-1]):
        fx = x0 + pw * (math.log(m) - lo) / (hi - lo)
        d.add(String(fx, y0 - 10, str(m), fontName="Helvetica", fontSize=7,
                     fillColor=MUTED, textAnchor="middle"))
    d.add(String(x0 + pw / 2, y0 - 21, "mass", fontName="Helvetica", fontSize=7.5,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(x0 - 4, y0 + ph - 4, "fast", fontName="Helvetica", fontSize=7,
                 fillColor=MUTED, textAnchor="end"))
    d.add(String(x0 - 4, y0 + 2, "slow", fontName="Helvetica", fontSize=7,
                 fillColor=MUTED, textAnchor="end"))
    d.add(String(x0, h - 12, "SPEED FALLS AS YOU GROW", fontName="Helvetica-Bold",
                 fontSize=7.5, fillColor=MUTED))
    return d


def dia_intercept():
    """Why chasing never works, and what does."""
    d = Drawing(CONTENT_W, 150)
    box_w = CONTENT_W / 2 - 8
    for i, (title, ok) in enumerate((("CHASING", False), ("CUTTING THE ANGLE", True))):
        ox = i * (box_w + 16)
        d.add(Rect(ox, 16, box_w, 112, fillColor=colors.HexColor("#fbfbfa"),
                   strokeColor=RULE, strokeWidth=0.7))
        d.add(String(ox + 8, 132, title, fontName="Helvetica-Bold", fontSize=7.5,
                     fillColor=VIRUS_EDGE if ok else DANGER))
        # Prey runs left to right along the top.
        d.add(Line(ox + 24, 100, ox + box_w - 26, 100, strokeColor=colors.HexColor("#c9c7c2"),
                   strokeWidth=0.8, strokeDashArray=[3, 3]))
        cell_shape(d, ox + 24, 100, 7, "#9a9a97")
        cell_shape(d, ox + box_w - 26, 100, 7, "#9a9a97")
        d.add(String(ox + box_w / 2, 110, "prey, and faster than you",
                     fontName="Helvetica", fontSize=6.5, fillColor=MUTED,
                     textAnchor="middle"))
        cell_shape(d, ox + 30, 44, 13, STAINS[2])
        if ok:
            arrow(d, ox + 44, 50, ox + box_w - 34, 90, ACCENT, 1.3, 5)
            d.add(String(ox + box_w / 2 + 6, 34, "aim where it will be",
                         fontName="Helvetica-Bold", fontSize=7, fillColor=VIRUS_EDGE,
                         textAnchor="middle"))
        else:
            arrow(d, ox + 44, 50, ox + 96, 88, DANGER, 1.3, 5)
            d.add(String(ox + box_w / 2 + 10, 34, "aim where it is - it is gone",
                         fontName="Helvetica-Bold", fontSize=7, fillColor=DANGER,
                         textAnchor="middle"))
    return d


def dia_split_reach():
    """The arc a split buys, and the two halves it leaves behind."""
    import math
    d = Drawing(CONTENT_W, 150)
    cx, cy = 74, 82
    d.add(Circle(cx, cy, 52, fillColor=None, strokeColor=colors.HexColor("#ded6ee"),
                 strokeWidth=0.9, strokeDashArray=[3, 3]))
    cell_shape(d, cx, cy, 22, STAINS[2], "you")
    d.add(String(cx, 14, "reach of one split", fontName="Helvetica", fontSize=7,
                 fillColor=MUTED, textAnchor="middle"))

    arrow(d, 140, 82, 176, 82, MUTED, 1, 4)
    d.add(String(158, 90, "split", fontName="Helvetica-Bold", fontSize=7,
                 fillColor=MUTED, textAnchor="middle"))

    cell_shape(d, 208, 82, 15.5, STAINS[2])
    cell_shape(d, 268, 82, 15.5, STAINS[2])
    d.add(String(238, 52, "two halves, apart for 20-50s",
                 fontName="Helvetica", fontSize=7, fillColor=MUTED, textAnchor="middle"))
    d.add(String(238, 42, "and each eatable by things you outweighed",
                 fontName="Helvetica", fontSize=7, fillColor=MUTED, textAnchor="middle"))

    cell_shape(d, 356, 82, 19, "#9a9a97")
    d.add(String(356, 52, "this could not touch you", fontName="Helvetica", fontSize=7,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(356, 42, "a second ago", fontName="Helvetica", fontSize=7,
                 fillColor=MUTED, textAnchor="middle"))
    d.add(String(356, 112, "now it eats both", fontName="Helvetica-Bold", fontSize=7.5,
                 fillColor=DANGER, textAnchor="middle"))
    return d


def dia_board(mode="standard", side=None, ring=True):
    """A real seeded arena, drawn to scale: orbs, viruses and the opening ring."""
    import math
    b = K["board"][mode]
    side = side or CONTENT_W * 0.46
    d = Drawing(side, side + 14)
    sc = side / b["size"]
    d.add(Rect(0, 0, side, side, fillColor=colors.HexColor("#ffffff"),
               strokeColor=RULE, strokeWidth=0.8))
    pad = K["spawnPad"] * sc
    d.add(Rect(pad, pad, side - 2 * pad, side - 2 * pad, fillColor=None,
               strokeColor=colors.HexColor("#eceae5"), strokeWidth=0.5,
               strokeDashArray=[2, 3]))

    for x, y in b["orbs"]:
        d.add(Circle(x * sc, y * sc, 0.85, fillColor=colors.HexColor("#b4afc8"),
                     strokeColor=None))
    for x, y in b["vir"]:
        d.add(Circle(x * sc, y * sc, 2.1, fillColor=VIRUS, strokeColor=None))

    if ring:
        r = b["ringRadius"] * sc
        c = side / 2
        d.add(Circle(c, c, r, fillColor=None, strokeColor=ACCENT, strokeWidth=0.8,
                     strokeDashArray=[2, 2]))
        # The real count, not a decorative sample: this is what a full lobby
        # standing on the ring actually looks like.
        n = STD["lobbyMin"] if mode == "standard" else HIGH["lobbyMin"]
        for i in range(n):
            a = i * 2 * math.pi / n
            d.add(Circle(c + math.cos(a) * r, c + math.sin(a) * r, 1.5,
                         fillColor=ACCENT, strokeColor=None))
    d.add(String(0, side + 5, "ONE REAL ARENA, TO SCALE", fontName="Helvetica-Bold",
                 fontSize=7, fillColor=MUTED))
    return d


def legend_row(colour, label, r=3):
    d = Drawing(9, 9)
    d.add(Circle(4, 3.5, r, fillColor=colour, strokeColor=None))
    t = Table([[d, Paragraph(label, S_CELL)]], colWidths=[6 * mm, None])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))
    return t


def technique(title, framing):
    head = [P(title, style("tt", fontName="Helvetica-Bold", fontSize=13, leading=16,
                           spaceBefore=0, spaceAfter=2)),
            P(framing, style("tf", fontSize=9, leading=12.5, textColor=ACCENT,
                             spaceAfter=5))]
    t = Table([[head]], colWidths=[None])
    t.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 1.6, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def tell(text):
    t = Table([[Paragraph("<b>The tell you got it wrong.</b> " + text, S_NOTE)]],
              colWidths=[None])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f1f0ec")),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def skill_header(num, title, tag):
    badge = Table([[Paragraph(str(num), S_SKILLNUM)]], colWidths=[11 * mm],
                  rowHeights=[11 * mm])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), ACCENT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    txt = [P(tag.upper(), S_KICKER),
           P(title, style("st", fontName="Helvetica-Bold", fontSize=14, leading=17))]
    t = Table([[badge, "", txt]], colWidths=[11 * mm, 4 * mm, None])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def drill(text):
    t = Table([[Paragraph("<b>Drill.</b> " + text, S_NOTE)]], colWidths=[None])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f1f0ec")),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


# ── page furniture ──────────────────────────────────────────────────────────

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

_section = {"name": ""}


def on_cover(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    # A scatter of cells, the way a board looks a minute in.
    import random
    rng = random.Random(7)
    for i in range(30):
        x = rng.uniform(0, PAGE_W)
        y = rng.uniform(0, PAGE_H * 0.42)
        r = rng.uniform(4, 30)
        canvas.setFillColor(colors.HexColor(STAINS[i % len(STAINS)]))
        canvas.setFillAlpha(0.13)
        canvas.circle(x, y, r, stroke=0, fill=1)
    canvas.setFillAlpha(1)
    canvas.setStrokeColor(ACCENT)
    canvas.setLineWidth(3)
    canvas.line(MARGIN, PAGE_H - 46 * mm, MARGIN + 26 * mm, PAGE_H - 46 * mm)
    canvas.restoreState()


def on_page(canvas, doc):
    """Page start: background only."""
    canvas.saveState()
    canvas.setFillColor(colors.white)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    canvas.restoreState()


def on_page_end(canvas, doc):
    """Page end, not page start. A section's Mark flowable draws with the rest
    of the page, so a header written at the start of the page would carry the
    PREVIOUS section's name all the way through."""
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.6)
    canvas.line(MARGIN, PAGE_H - MARGIN + 6 * mm, PAGE_W - MARGIN, PAGE_H - MARGIN + 6 * mm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, PAGE_H - MARGIN + 8.5 * mm, "ENGULFS  /  FIELD MANUAL")
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - MARGIN + 8.5 * mm,
                           _section["name"].upper())
    canvas.setFont("Helvetica-Bold", 8)
    canvas.setFillColor(INK)
    canvas.drawCentredString(PAGE_W / 2, MARGIN - 9 * mm, str(doc.page))
    canvas.restoreState()


class Mark(Spacer):
    """Sets the running header for the pages that follow."""

    def __init__(self, name):
        super().__init__(0, 0)
        self.name = name

    def draw(self):
        _section["name"] = self.name


def build():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(
        str(OUT), pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=MARGIN,
        title="Engulfs - Field Manual",
        author="Engulfs",
        subject="How to play, and the skills a round is won with",
    )
    frame = Frame(MARGIN, MARGIN, CONTENT_W, PAGE_H - 2 * MARGIN, id="body",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[frame], onPage=on_cover),
        PageTemplate(id="body", frames=[frame], onPage=on_page,
                     onPageEnd=on_page_end),
    ])
    doc.build(story())
    return OUT


# ── the manual itself ───────────────────────────────────────────────────────

def story():
    s = []

    # ---- cover -------------------------------------------------------------
    s.append(Spacer(1, 42 * mm))
    s.append(P("FIELD MANUAL", style("ck", fontName="Helvetica-Bold", fontSize=9,
                                     leading=12, textColor=ACCENT, spaceAfter=8)))
    s.append(P("Engulfs", S_COVER_T))
    s.append(Spacer(1, 4 * mm))
    s.append(P("How to play, the eight skills a round is<br/>won with, and the "
               "technique behind them.", S_COVER_S))
    s.append(Spacer(1, 70 * mm))
    s.append(datatable(
        ["", ""],
        [["Arena", f"{STD['world']['size']:,} x {STD['world']['size']:,} units, "
                   f"{STD['world']['pellets']:,} orbs, {STD['world']['viruses']} viruses"],
         ["Round", f"{STD['roundSeconds'] // 60} minutes, top {STD['paidPositions']} are paid"],
         ["Field", f"{STD['lobbyMin']} players in Standard, {HIGH['lobbyMin']} in High stakes"],
         ["Stake", f"{money(STD['stake'])} or {money(HIGH['stake'])} USDC, or play free in Practice"]],
        [26 * mm, None]))
    s.append(Spacer(1, 10 * mm))
    s.append(P("Every figure in this manual is read straight from the simulation "
               "the server runs. Where a number appears, that is the number in force.",
               style("fine", fontSize=7.5, leading=11, textColor=MUTED)))

    s.append(NextPageTemplate("body"))
    s.append(PageBreak())

    # ---- the game in ninety seconds ---------------------------------------
    s.append(Mark("The game"))
    s.append(P("The game in ninety seconds", S_H1))
    s.append(P("You are a cell. You eat orbs to grow, you eat players smaller than "
               "you, and players larger than you eat you. The round runs for "
               f"{STD['roundSeconds'] // 60} minutes. When the whistle goes, everyone still "
               f"alive is ranked by mass and the top {STD['paidPositions']} are paid.", S_LEAD))

    s.append(P("How a round runs", S_H2))
    s.append(dia_timeline())
    s.append(P(f"Readiness carries over, so a full lobby rolls straight from the "
               f"standings into the next count.", S_CAPTION))

    s.append(two_col(
        [P("You start on a ring", S_H3),
         P("Every player opens on one circle at equal spacing: the same distance "
           "to either neighbour, the same distance to the centre, the same distance "
           "to the wall. Nobody is handed a corner to themselves and nobody opens "
           f"inside somebody's mouth. In a full Standard lobby that gap is about "
           f"{int(2 * (STD['world']['size'] / 2 - 140) * __import__('math').sin(__import__('math').pi / STD['lobbyMin']))} units.", S_BODY),
         P("The ring is turned by a fresh angle every round, so there is no "
           "memorised opening to learn.", S_BODY)],
        dia_ring(), ratio=0.58))

    s.append(P("Three things end your round", S_H2))
    s.append(bullets([
        "<b>You are eaten.</b> Everything you were carrying goes to whoever ate you.",
        f"<b>You touch a virus while over {POP_MASS:.0f} mass.</b> You burst into "
        f"{K['VIRUS_PIECES']} pieces and become food for everyone nearby.",
        "<b>The clock runs out.</b> The only ending that pays.",
    ]))

    s.append(Spacer(1, 4))
    s.append(callout(
        "The one rule that decides everything else",
        f"You can eat another cell only when you are at least <b>{EAT_PCT:.1f}% bigger</b> "
        f"than it. Not a little bigger - {EAT_PCT:.1f}%. Against a rival of mass 100 you "
        f"need {100 * K['EAT_RATIO']:.1f}. Everything in this manual is downstream of that "
        "number: who you chase, who you run from, and how close you dare sit."))

    s.append(Spacer(1, 6 * mm))
    s.append(P("What is in here", S_H2))
    s.append(two_col(
        datatable(["", ""],
                  [["Controls", "Four inputs, and the HUD"],
                   ["The rules", "Eating, speed, decay"],
                   ["The board", "Spawns, orbs and virus layout"],
                   ["Splitting", "What it buys and what it costs"],
                   ["Ejecting", "The only thing worth spending on"],
                   ["Viruses", "Cover, mine, and weapon"]],
                  [24 * mm, None]),
        datatable(["", ""],
                  [["The wager", "What is at stake, and when"],
                   ["Eight skills", "The habits a round is won with"],
                   ["Technique", "How the work is actually done"],
                   ["Playbook", "A shape for ten minutes"],
                   ["Reference", "Every number on one page"]],
                  [24 * mm, None])))

    s.append(PageBreak())

    # ---- controls ----------------------------------------------------------
    s.append(Mark("Controls"))
    s.append(P("Controls", S_H1))
    s.append(P("Four inputs. The difficulty is entirely in when you use them.", S_LEAD))

    s.append(datatable(
        ["Action", "Keyboard", "Touch", "What it does"],
        [["Move", "Mouse", "Drag", "Your cells steer toward the pointer. There is no "
                                   "stop button - you are always moving."],
         ["Split", "Space", "Split", "Every cell splits in half and the new halves are "
                                     f"launched forward. Up to {K['MAX_CELLS']} cells."],
         ["Eject", "W", "Feed", f"Throws {K['EJECT_KEEP']} mass out of the front of each "
                                f"cell, at a cost of {K['EJECT_MASS']}."],
         ["Spectate", "-", "Arrows", "Once you are dead, watch anyone still alive."]],
        [20 * mm, 20 * mm, 16 * mm, None]))

    s.append(P("What the screen is telling you", S_H2))
    s.append(datatable(
        ["Readout", "Why you care"],
        [["Clock, top centre",
          "Time left. It turns red for the last 30 seconds, which is the only "
          "moment placing matters more than growing."],
         ["Rank, top left",
          f"Your position and the size of the field. Above {STD['paidPositions']} is "
          "the whole game."],
         ["Leaderboard, top right",
          f"The top ten, with a line ruled under {STD['paidPositions']}th. That line is "
          "the pay boundary - watch who is sitting on it."],
         ["At risk / mass value",
          f"What you are carrying, and what your mass is nominally worth "
          f"({MASS_PER_USDC:.0f} mass reads as {money(K['UNIT'])} USDC). Shown in "
          "wagered rounds only."],
         ["Minimap, bottom left",
          "Where you are in the arena. Mostly it tells you how close you are to "
          "a wall, which is where players get cornered."]],
        [34 * mm, None]))

    s.append(P("What you are actually looking at", S_H2))
    s.append(P("Your own cell is predicted locally, so it answers the mouse "
               "immediately and does not wait for the server. Everyone else is drawn "
               "from what the server last sent, which on a slow connection is a "
               "fraction of a second in the past.", S_BODY))
    s.append(P("The practical consequence: <b>other players are always slightly "
               "further along than they look</b>. On a contested chase, aim where a "
               "target is going rather than where it is drawn. This is also why a "
               "fight that felt unfair sometimes was - not because anything is "
               "broken, but because you were both acting on slightly different "
               "pictures.", S_BODY))

    s.append(P("Practice first", S_H2))
    s.append(P("The Practice tier runs entirely in your own browser against bots. "
               "There is no server, no lobby and no money. Every mechanic in this "
               "manual behaves identically there, so it is the right place to learn "
               "the timing of a split and the feel of feeding a virus - and, because "
               "nothing is predicted over a network, the right place to learn what a "
               "clean read looks like.", S_BODY))

    s.append(PageBreak())

    # ---- the three laws ----------------------------------------------------
    s.append(Mark("The rules"))
    s.append(P("The rules that never change", S_H1))
    s.append(P("Three mechanics shape every decision you make. Learn the numbers "
               "and most of the game becomes arithmetic you can do at a glance.", S_LEAD))

    s.append(P(f"1. The {EAT_PCT:.1f}% rule", S_H2))
    s.append(dia_eat_rule())
    s.append(P(f"Eating pays a bonus: you collect {K['EAT_BONUS']}x the mass you "
               "swallowed, so players are worth far more than orbs. An orb is "
               f"{K['PELLET_MASS']} mass, and it takes about {int(ORBS_TO_100)} of them "
               f"to go from your opening {K['START_MASS']} to 100.", S_CAPTION))

    s.append(P("2. Mass costs speed", S_H2))
    s.append(two_col(
        [P("Speed falls as mass<super>-0.24</super>. Doubling your mass costs you "
           "about 15% of your top speed, and it never stops costing. The biggest "
           "cell on the board is also the one that cannot catch anything and "
           "cannot run away.", S_BODY),
         P("This is why the leader is not safe. It is why a mid-sized player can "
           "farm the edges of a fight and arrive at the whistle in the places, "
           "while the monster that ate everyone gets cornered at minute nine.", S_BODY)],
        dia_speed_curve(), ratio=0.46))

    s.append(datatable(
        ["Mass", "Radius", "Speed", "vs. start", "Rejoin after a split"],
        [[str(m), f"{K['speed'][str(m)]['r']:.0f}", f"{K['speed'][str(m)]['v']:.0f}",
          f"{K['speed'][str(m)]['v'] / K['speed'][str(20)]['v'] * 100:.0f}%",
          f"{K['speed'][str(m)]['merge']:.0f}s"]
         for m in (20, 100, 200, 400, 800, 1600)],
        [20 * mm, 20 * mm, 20 * mm, 24 * mm, None], align_right=(1, 2, 3)))

    s.append(P("3. Size above a point is a leak", S_H2))
    s.append(P(f"Any cell over <b>{K['DECAY_ABOVE']}</b> mass shrinks continuously, at "
               "about 0.22% a second. At 400 that is under a mass a second and barely "
               "noticeable. At 1,600 you are losing more than three a second, and "
               "standing still is going backwards. Big players have to keep eating "
               "purely to stand still.", S_BODY))

    s.append(PageBreak())

    # ---- the board ---------------------------------------------------------
    s.append(Mark("The board"))
    s.append(P("The board", S_H1))
    s.append(P("Where you start, and where everything else is. None of it is "
               "decorative - the layout decides what your first two minutes can "
               "possibly look like.", S_LEAD))

    STDB = K["board"]["standard"]
    HIB = K["board"]["highstakes"]

    s.append(two_col(
        [P("Spawn position", S_H2),
         P("At the start of a round the whole field is dealt onto <b>one ring at "
           "equal angular spacing</b>. Every player gets an identical opening: the "
           "same distance to either neighbour, the same distance to the centre, the "
           "same distance to the wall. Nobody is handed a quiet corner and nobody "
           "opens inside somebody's mouth.", S_BODY),
         P(f"The ring wants to seat everyone {K['SPAWN_GAP']:.0f} units apart, but a full "
           "lobby asks for a bigger circle than the arena holds, so it clamps to the "
           "widest ring that fits. At a full Standard lobby that means a radius of "
           f"<b>{STDB['ringRadius']:.0f}</b>, neighbours <b>{STDB['ringGap']:.0f} units</b> "
           "apart, and the ring sitting exactly on the wall padding.", S_BODY)],
        [dia_board("standard"),
         legend_row(colors.HexColor("#b4afc8"), "orbs (one in nine drawn)", 1.6),
         legend_row(VIRUS, "viruses, all 90 of them", 2.4),
         legend_row(ACCENT, f"the {STD['lobbyMin']} opening positions", 2.0)],
        ratio=0.52))

    s.append(callout(
        "So a full lobby opens on the perimeter",
        f"With {STD['lobbyMin']} players the ring is pinned {K['spawnPad']} units off "
        "the wall and the entire middle of the arena is empty. Everyone starts with "
        "their back to a wall and open board in front of them. The first thing worth "
        "doing is moving inward - the centre is the only part of the map nobody is "
        "standing in, and it is where the orbs are untouched."))

    s.append(datatable(
        ["At a full lobby", "Standard", "High stakes"],
        [["Players on the ring", str(STD["lobbyMin"]), str(HIGH["lobbyMin"])],
         ["Ring radius", f"{STDB['ringRadius']:.0f}", f"{HIB['ringRadius']:.0f}"],
         ["Gap to each neighbour", f"{STDB['ringGap']:.0f}",
          f"{HIB['ringGap']:.0f}"],
         ["Clear of the wall", f"{STDB['wallClear']:.0f}", f"{HIB['wallClear']:.0f}"]],
        [50 * mm, None, None]))

    s.append(P("Two details worth knowing. The ring is <b>turned by a fresh angle "
               "every round</b>, so there is no memorised opening. And a "
               "<b>mid-round respawn is not on the ring</b> - it is a uniformly random "
               "point anywhere in the arena, which is deliberate: a ring position is "
               "an opening, and handing one to somebody who died at minute eight "
               "would be a reward for dying.", S_BODY))

    s.append(PageBreak())

    s.append(P("How the orbs are spread", S_H2))
    s.append(P("<b>Uniformly at random - which is not the same as evenly.</b> This is "
               "the most useful thing on the page. Random placement clumps: it leaves "
               "rich patches and bare stretches, and both are real rather than "
               "imagined.", S_BODY))

    s.append(two_col(
        [datatable(
            ["Orbs", "Standard", "High stakes"],
            [["Orbs in play", f"{STD['world']['pellets']:,}", f"{HIGH['world']['pellets']:,}"],
             ["Board area each", f"{STDB['areaPerOrb']:,.0f}", f"{HIB['areaPerOrb']:,.0f}"],
             ["Typical gap between them", f"{STDB['orbGap']:.0f} units",
              f"{HIB['orbGap']:.0f} units"],
             ["Richest hundredth of the board",
              f"{STDB['richest']} orbs", f"{HIB['richest']} orbs"],
             ["Emptiest hundredth",
              f"{STDB['emptiest']} orbs", f"{HIB['emptiest']} orbs"]],
            [36 * mm, None, None])],
        [P("What that ratio means", S_H3),
         P(f"The busiest hundredth of a Standard board carries "
           f"<b>{STDB['richest'] / STDB['emptiest']:.1f} times</b> what the emptiest "
           "does. Finding a rich patch is worth real time early on, and the difference "
           "between a good first two minutes and a mediocre one is mostly whether you "
           "swept one.", S_BODY),
         P("Both modes are tuned to the same density - about "
           f"{STDB['areaPerOrb']:,.0f} units of board per orb - so a smaller arena is "
           "not a poorer one.", S_BODY)],
        ratio=0.52))

    s.append(P("Orbs are replaced the moment they are eaten, so the arena never runs "
               "down: the count is held at "
               f"{STD['world']['pellets']:,} all round. But <b>the replacement appears "
               "at a fresh random point, not where the old one was</b>. Farming a "
               "patch really does exhaust it, and the mass you took reappears "
               "somewhere else entirely - usually somewhere you are not.", S_BODY))
    s.append(P("Ejected mass lands in the same pool. A blob somebody threw is an orb "
               "like any other once it comes to rest, worth several times a natural "
               "one, and free to anyone who reaches it first.", S_BODY))

    s.append(P("How the viruses are spread", S_H2))
    s.append(P("Also uniformly at random, and also clumpy - which matters far more "
               "for viruses, because the gaps are wide enough to plan around and the "
               "clusters are dangerous.", S_BODY))

    s.append(datatable(
        ["Viruses", "Standard", "High stakes"],
        [["In the arena at the start", str(STD["world"]["viruses"]), str(HIGH["world"]["viruses"])],
         ["Board area each", f"{STDB['areaPerVirus']:,.0f}", f"{HIB['areaPerVirus']:,.0f}"],
         ["Typical gap to the nearest other",
          f"{STDB['virusGap']:.0f} units", f"{HIB['virusGap']:.0f} units"],
         ["Closest pair on a sample board",
          f"{STDB['virusMin']:.0f} units apart", f"{HIB['virusMin']:.0f} units apart"],
         ["Ceiling once players start feeding them",
          f"{STD['world']['viruses'] * K['VIRUS_MAX_RATIO']:.0f}",
          f"{HIGH['world']['viruses'] * K['VIRUS_MAX_RATIO']:.0f}"]],
        [56 * mm, None, None]))

    s.append(bullets([
        f"A virus is {radius_of(K['VIRUS_MASS']):.0f} units across the middle, and a "
        f"typical one sits about {STDB['virusGap']:.0f} units from its nearest "
        "neighbour - so most of the board is open, and you can usually plan a route "
        "that never comes near one.",
        f"But pairs happen. The closest two on the sample board above are "
        f"{STDB['virusMin']:.0f} units apart, barely more than their own diameters. "
        f"A gap like that is a death corridor if you are over {POP_MASS:.0f} mass, and "
        "a fortress if you are under it.",
        "The population is not fixed once play starts: feeding splits viruses and "
        "adds new ones, up to the ceiling. By the endgame there are more viruses "
        "than there were at the whistle, and they are wherever players wanted them.",
    ]))

    s.append(PageBreak())

    # ---- the two actions ---------------------------------------------------
    s.append(Mark("Splitting and ejecting"))
    s.append(P("Splitting", S_H1))
    s.append(P("Split and every cell you own halves and fires forward. It is the "
               "only way to close distance on something faster than you, and it is "
               "the most common way players die.", S_LEAD))

    s.append(two_col(
        [P("What it buys", S_H3),
         P("Reach. A launched half travels a few hundred units instantly, which is "
           "how you catch a cell that would otherwise outrun you. It also doubles "
           "your cell count, up to a ceiling of "
           f"{K['MAX_CELLS']}.", S_BODY)],
        [P("What it costs", S_H3),
         P("Everything. Each half is half your mass, so each is eatable by things "
           "that could not touch you a second ago. And the pieces cannot rejoin "
           "for a cooldown that grows with their size - <b>20 seconds</b> at small "
           "sizes, <b>50 at mass 1,600</b>. You are at your most vulnerable for "
           "exactly as long as you are at your biggest.", S_BODY)]))

    s.append(Spacer(1, 3))
    s.append(callout(
        "The question to ask before every split",
        "Not 'can I reach it' but 'what eats the halves'. Look at the board behind "
        "your target first. If anything near it is bigger than half of you, the "
        "split is a donation.", DANGER, colors.HexColor("#fbeceb")))

    s.append(P("Ejecting", S_H1))
    s.append(P(f"Eject throws a blob forward. It costs {K['EJECT_MASS']} and delivers "
               f"{K['EJECT_KEEP']}, so about <b>{EJECT_LOSS:.0f}% is lost every throw</b>. "
               "You cannot pick your own mass back up for "
               f"{K['EJECT_OWNER_COOLDOWN']} seconds, which means recovering it is a "
               "decision - turning round and going back - rather than an accident.", S_BODY))
    s.append(P("There is exactly one thing worth spending that mass on, and it is "
               "on the next page.", S_BODY))

    s.append(PageBreak())

    # ---- viruses -----------------------------------------------------------
    s.append(Mark("Viruses"))
    s.append(P("Viruses: the hazard, and the weapon", S_H1))
    s.append(P(f"The green spiked circles. There are {STD['world']['viruses']} of them "
               "in a Standard arena, and they behave completely differently "
               "depending on how big you are.", S_LEAD))

    s.append(datatable(
        ["If you are...", "A virus is..."],
        [[Paragraph(f"<b>under {POP_MASS:.0f} mass</b>", S_CELL),
          "Cover. You pass straight over it, and anything big enough to eat you "
          "cannot follow you in. Sitting on a virus is the single best defensive "
          "move a small cell has."],
         [Paragraph(f"<b>over {POP_MASS:.0f} mass</b>", S_CELL),
          f"A mine. Touch one and you burst into {K['VIRUS_PIECES']} pieces, scattered "
          "and unable to rejoin for a long cooldown, in front of everyone who was "
          "chasing you. This is how most large players actually die."]],
        [30 * mm, None]))

    s.append(P("Feeding a virus", S_H2))
    s.append(P(f"Shoot ejected mass into a virus and it swells visibly. The "
               f"<b>{K['VIRUS_FEED_HITS']}rd hit splits it</b>: a new virus is launched "
               "along exactly the line your mass came in on, and coasts about 450 "
               "units before settling.", S_BODY))
    s.append(dia_virus_feed())

    s.append(P("This is the only aimed weapon in the game. You are not throwing the "
               "virus at someone so much as choosing where you stand while you feed "
               "it - the line from you, through the virus, is where the new one goes. "
               "Used properly it puts a mine in the path of a player far too big for "
               "you to fight, or cuts off the open water a leader was running for.", S_BODY))

    s.append(Spacer(1, 3))
    s.append(two_col(
        [P("What it costs you", S_H3),
         P(f"Three throws is {K['VIRUS_FEED_HITS'] * K['EJECT_MASS']} mass off your own "
           "total, gone. Feeding is a pure sink: the virus keeps it, you get nothing "
           "back. What you buy is position.", S_BODY)],
        [P("Two things that will catch you out", S_H3),
         P("Only mass <i>still in flight</i> feeds a virus - a blob that runs out of "
           "travel short of it has missed. And if you are over "
           f"{POP_MASS:.0f} mass, walking close enough to aim comfortably is how you "
           "burst yourself. Feed from range, or feed while small.", S_BODY)]))

    s.append(PageBreak())

    # ---- money -------------------------------------------------------------
    s.append(Mark("The wager"))
    s.append(P("What is actually at stake", S_H1))
    s.append(P("Skip this page if you are playing Practice - nothing below applies. "
               "In a wagered round the money is server-side and moves only in "
               "response to things that happen in the arena.", S_LEAD))

    s.append(datatable(
        ["When this happens", "Your money does this"],
        [["You join a wagered round", "Your stake moves out of your balance and into "
                                      "escrow - your pot. You cannot spend it while the round runs."],
         ["You eat a staked player", "Their entire pot moves into yours. This is the only "
                                     "way a pot grows."],
         ["You are eaten by a staked player", "Your whole pot becomes theirs."],
         [f"You finish in the top {STD['paidPositions']}, alive",
          "Your pot is paid into your balance: your stake plus everything you took "
          "off the players you ate."],
         [f"You finish alive but outside the top {STD['paidPositions']}",
          "Your pot is forfeited. Surviving is necessary; it is not sufficient."],
         ["You disconnect and are not eaten",
          f"Your body stays in the arena for {T['linger'] or 6} seconds. Survive that "
          "window unclaimed and your stake is refunded."]],
        [46 * mm, None]))

    s.append(Spacer(1, 4))
    s.append(callout(
        "Death ends your wager, even if you play on",
        "You can respawn and keep playing after being eaten, and you should - "
        "position is still worth having. But your pot left with your killer. "
        f"Finishing in the top {STD['paidPositions']} after dying once pays out an empty "
        "escrow, which is nothing. <b>Your wager is decided the moment you are "
        "eaten, not at the whistle.</b>", DANGER, colors.HexColor("#fbeceb")))

    s.append(P("What this means for how you play", S_H2))
    s.append(bullets([
        "<b>Mass sets your rank, not your payout.</b> The figure the HUD shows "
        "against your mass is a readout, not a promise. What you are actually paid "
        "is your own escrow - stake plus claimed pots.",
        "<b>Eating a big staked player is worth more than any amount of farming.</b> "
        "Orbs move you up the leaderboard. Players move your money.",
        f"<b>A large pot makes you a target.</b> Late in a round the player who has "
        "eaten three staked rivals is carrying four stakes, and everybody can see "
        "how big they are.",
    ]))

    s.append(PageBreak())

    # ---- the skills --------------------------------------------------------
    s.append(Mark("The eight skills"))
    s.append(P("The eight skills", S_H1))
    s.append(P("Rounds are not won by reflexes. They are won by eight separate "
               "habits, each of which can be practised on its own. In rough order "
               "of how much a beginner gains from fixing it.", S_LEAD))

    skills = [
        (1, "Threat arithmetic", "Survival",
         [f"At any moment you should know, without thinking, which cells on your "
          f"screen can eat you and which you can eat. The line is {EAT_PCT:.1f}%: "
          f"anything over {K['EAT_RATIO']:.3f} times your mass is lethal, anything under "
          f"{1 / K['EAT_RATIO']:.3f} times is food.",
          "Beginners read size roughly and get it wrong at the margin, which is "
          "exactly where rounds are decided. The margin is narrow on purpose - a "
          "cell 5% bigger than you is not a threat, and a cell 10% bigger is."],
         "In Practice, park next to bots of similar size and read their mass off "
         "the leaderboard before you commit. Get used to the visual difference a "
         "10% mass gap makes - it is smaller than you expect, because radius grows "
         "with the square root of mass."),

        (2, "Split discipline", "Survival",
         ["The commonest way to lose a round you were winning. A split halves "
          "every cell you own and locks the pieces apart for 20 to 50 seconds.",
          "Good players split when the target is certain and the surrounding board "
          "is empty. Bad players split at anything that looks catchable, and spend "
          "the next 30 seconds as eight easy meals."],
         "Play a whole Practice round without splitting once. You will finish "
         "smaller but you will learn how much of the board you can hold without it. "
         "Then add splits back one at a time, only when nothing bigger than half "
         "your mass is within a screen."),

        (3, "Virus literacy", "Both",
         [f"Know where every virus near you is, and which side of {POP_MASS:.0f} mass "
          "you are on. Under it they are your best cover - a big chaser physically "
          "cannot follow you onto one. Over it they are the thing most likely to "
          "kill you.",
          "The advanced half is offensive: feeding one takes "
          f"{K['VIRUS_FEED_HITS']} throws and lets you place a new virus roughly 450 "
          "units away along a line you choose."],
         "Grow past the threshold in Practice and deliberately run a bot chase near "
         "viruses until you can feel the danger radius. Then spend a round doing "
         "nothing but feeding viruses, to learn the range and lead of a throw."),

        (4, "Orb economy", "Growth",
         [f"Orbs are {K['PELLET_MASS']} mass each and there are {STD['world']['pellets']:,} "
          "of them. Early on, they are the whole game: you need roughly "
          f"{int(ORBS_TO_100)} to reach 100 from your opening {K['START_MASS']}.",
          "The skill is pathing - sweeping through dense clusters in straight lines "
          "rather than chasing individual orbs, and doing it in the quiet parts of "
          "the arena while the aggressive players trade early deaths."],
         "Time yourself from spawn to mass 100 in Practice. A good line beats a "
         "greedy one; compare a straight sweep against darting at whatever is "
         "nearest."),
    ]

    for num, title, tag, paras, dr in skills:
        block = [skill_header(num, title, tag)]
        for t in paras:
            block.append(P(t))
        block.append(drill(dr))
        block.append(Spacer(1, 7))
        s.append(KeepTogether(block))

    s.append(PageBreak())

    skills2 = [
        (5, "Speed awareness", "Both",
         [f"Every mass you gain makes you slower, on a curve that never flattens. "
          "By mass 400 you are at roughly half your opening speed; by 1,600, a third.",
          "Two consequences people miss. You cannot catch anyone much smaller than "
          "you without splitting, so growth past a point converts into pure "
          "vulnerability. And when you are the biggest thing on the board, running "
          "away has stopped being an option - you have to fight or use viruses."],
         "Grow to 800 in Practice and try to catch a starting-size bot. You cannot. "
         "Learn that before a real round teaches you."),

        (6, "Map and wall sense", "Survival",
         ["The arena is square and the walls do not push back. A cell pinned "
          "against one has lost half its escape directions, and experienced players "
          "herd others into corners deliberately.",
          "Keep the middle of the board available to you. The minimap exists for "
          "exactly one question: how much room is behind me?"],
         "Watch your minimap dot rather than the arena for thirty seconds in "
         "Practice. Notice how often you drift into an edge without deciding to."),

        (7, "Clock management", "Winning",
         [f"The round is {STD['roundSeconds'] // 60} minutes and only the last moment "
          f"of it counts. Rank at minute four is worth nothing; rank at {mmss(0)} is "
          "worth everything.",
          f"Early round, take risks - a death at minute two costs you a stake you "
          "can re-enter with next round. Late round, with a place in hand, every "
          "fight you do not need is a fight that can only cost you. The last 30 "
          "seconds are for defending a position, not improving it."],
         f"In the final minute, find the line under {STD['paidPositions']}th on the "
         "leaderboard and play only against the players either side of it. "
         "Everything else on the board is irrelevant to you."),

        (8, "Pot awareness", "Winning",
         ["Only in wagered rounds, and it is what separates a good player from a "
          "profitable one. Your payout is your escrow, and your escrow grows only "
          "by eating other staked players.",
          "So a round spent farming orbs to a safe fourth place returns your stake "
          "and little else. A round in which you took two staked players and "
          "finished fifth pays three stakes. Rank decides whether you are paid; "
          "kills decide how much."],
         "After each wagered round, ask which of your fights changed your escrow "
         "and which merely changed your rank. Most players find they spent the "
         "round on the second kind."),
    ]

    for num, title, tag, paras, dr in skills2:
        block = [skill_header(num, title, tag)]
        for t in paras:
            block.append(P(t))
        block.append(drill(dr))
        block.append(Spacer(1, 7))
        s.append(KeepTogether(block))

    s.append(PageBreak())

    # ---- technique ---------------------------------------------------------
    s.append(Mark("Technique"))
    s.append(P("Technique", S_H1))
    s.append(P("The skills chapter is what to work on. This is how the work is "
               "actually done - eight techniques, and the numbers each one turns on.",
               S_LEAD))

    s.append(technique("Movement and positioning",
                       "Avoiding larger cells while creating angles on smaller players."))
    s.append(P("Start from the fact that makes every chase futile: <b>every cell you "
               "are big enough to eat is faster than you are</b>. Speed falls with "
               "mass, so being able to eat something guarantees it can outrun you. "
               "Even the marginal target - the one only "
               f"{EAT_PCT:.1f}% smaller - has the legs on you.", S_BODY))

    s.append(datatable(
        ["You are mass 400 and they are", "Their speed", "Yours", "Their advantage"],
        [[f"{r['prey']:.0f}" + ("  (the biggest you can eat, just)" if i == 0 else ""),
          f"{r['theirs']:.0f}", f"{r['yours']:.0f}", f"{r['edge']:.1f}% faster"]
         for i, r in enumerate(K["pursuit"])],
        [58 * mm, 22 * mm, 18 * mm, None], align_right=(1, 2)))

    s.append(P("So pursuit is not a tactic, it is a way of losing ground slowly. "
               "What works is geometry: take the inside line, aim at where the target "
               "must go rather than where it is, and push it toward something that "
               "limits its options - a wall, a virus, or a bigger player.", S_BODY))
    s.append(dia_intercept())

    s.append(P("Against larger cells the same geometry runs backwards. Keep two "
               "escape directions open at all times; the moment you have one, you are "
               "being herded. Open water behind you is worth more than orbs in front "
               "of you.", S_BODY))
    s.append(tell("You spent ten seconds behind the same player and never closed the "
                  "gap. That was never going to work - you needed an angle, a wall, "
                  "or a split, from the first second."))

    s.append(PageBreak())

    s.append(technique("Split timing and accuracy",
                       "Judging whether a split will reach and consume another player "
                       "without leaving you vulnerable."))
    s.append(P("The split is the only thing that closes distance, because the launch "
               f"is roughly <b>{K['split']['400']['boost']:.1f} times your cruising "
               "speed</b>. It is also a timer on your own vulnerability. Both halves "
               "of the decision are in one table.", S_BODY))

    s.append(datatable(
        ["Your mass", "Each half", "Reach from your centre", "You stay in pieces for"],
        [[m, f"{K['split'][m]['half']:.0f}", f"about {K['split'][m]['reach']:.0f} units",
          f"{K['split'][m]['merge']:.0f}s"]
         for m in ("60", "100", "200", "400", "800", "1600")],
        [22 * mm, 22 * mm, 42 * mm, None], align_right=(0, 1)))

    s.append(P("Three questions, in order", S_H3))
    s.append(bullets([
        "<b>Will it reach?</b> Read the table, not your instinct. At mass 200 you "
        f"throw about {K['split']['200']['reach']:.0f} units; at 800, about "
        f"{K['split']['800']['reach']:.0f}. Anything beyond that is a donation.",
        "<b>Will the half be big enough?</b> The piece that arrives is half your "
        f"mass, and it still needs to be {K['EAT_RATIO']}x the target. Halving 200 "
        "gives you 100, which eats nothing above 91.",
        "<b>What eats the halves?</b> The question people skip. Look behind the "
        "target before you commit, not after.",
    ]))
    s.append(dia_split_reach())
    s.append(tell("You landed the split, ate the target, and were eaten yourself "
                  "before the pieces rejoined. The split worked and the decision "
                  "did not."))

    s.append(PageBreak())

    s.append(technique("Mass management",
                       "Deciding when to split, merge, feed, or preserve mass."))
    s.append(P("You have four things you can do with mass, and each is a trade you "
               "should be able to price.", S_BODY))
    s.append(datatable(
        ["Do this", "You pay", "You get"],
        [["Split", f"Half your size per cell, and {K['split']['400']['merge']:.0f}s "
                   "apart at mass 400", "Reach, and a second mouth"],
         ["Merge", "Nothing, but you cannot hurry it", "Back to one fast, safe body"],
         ["Feed a virus", f"{K['EJECT_MASS']} mass a throw, "
                          f"{EJECT_LOSS:.0f}% of it lost outright",
          "A hazard placed where you choose"],
         ["Preserve", f"Nothing below {K['DECAY_ABOVE']} mass; above it you leak "
                      "0.22% a second", "Speed, and the ability to run"]],
        [26 * mm, 52 * mm, None]))
    s.append(P("The non-obvious one is <b>preserve</b>. Because speed falls with mass "
               f"and everything above {K['DECAY_ABOVE']} decays, there is a size past "
               "which extra mass makes you worse at everything except eating people "
               "who cannot escape. Growing beyond it is a decision, not a reward - "
               "take it when you intend to hunt, not because the orbs were there.", S_BODY))
    s.append(callout(
        "Mass in pieces is not mass",
        "Sixteen cells of 50 is not a 800-mass player. It is sixteen 50-mass players "
        "who happen to share a name, each of which can be eaten separately, and none "
        f"of which can rejoin for {K['split']['800']['merge']:.0f} seconds. Count your "
        "effective size as your <i>largest cell</i>, not your total."))

    s.append(technique("Risk assessment",
                       "Deciding when a target is worth pursuing versus when to retreat."))
    s.append(P("Price the attempt before you start it. A pursuit costs time, position "
               "and usually a split; what it returns is "
               f"{K['EAT_BONUS']}x the target's mass, plus - in a wagered round - "
               "their entire pot.", S_BODY))
    s.append(bullets([
        "<b>Worth it:</b> a staked player carrying pots, cornered, with nothing "
        "bigger than half your mass within a screen.",
        "<b>Not worth it:</b> anything in open water that can see you coming. It is "
        "faster than you and the chase is free for it.",
        "<b>Never:</b> a target sitting on or beside a virus while you are over "
        f"{POP_MASS:.0f} mass. That is the trap, and good players set it deliberately.",
    ]))

    s.append(PageBreak())

    s.append(technique("Map awareness",
                       "Tracking nearby threats, viruses, escape routes and crowded areas."))
    s.append(P("Four things to keep a running count of, in this order of urgency: "
               "<b>what can eat me</b>, <b>where the viruses are</b>, <b>which way is "
               "open</b>, and <b>where the crowd is</b>.", S_BODY))
    s.append(P("The crowd matters more than beginners expect. A fight between two "
               "large players generates fragments, ejected mass and burst cells - a "
               "burst player scatters into "
               f"{K['VIRUS_PIECES']} pieces - and the profit is in arriving after it, "
               "not during. Equally, a quiet quadrant is where you grow unmolested "
               "for the first two minutes.", S_BODY))
    s.append(P(f"How far you can see is not a matter of opinion. Everyone is shown "
               f"the same <b>{K['viewFloor']:.0f} units</b> in every direction, and "
               f"that does not change until you pass about "
               f"<b>{K['viewGrowsAbove']:.0f} mass</b> - past which your view finally "
               "starts growing with your size.", S_BODY))
    s.append(P("Two things follow. For most of a round every player on the board has "
               "exactly your horizon, so anything you cannot see cannot see you "
               "either. And the handful of players large enough to have outgrown the "
               "floor are the only ones with an information advantage - which is part "
               "of why a leader is hard to ambush.", S_BODY))
    s.append(tell("You died to something you never saw. Nine times in ten that is a "
                  "wall at your back, not bad luck."))

    s.append(technique("Prediction",
                       "Anticipating opponents' movement and split attacks."))
    s.append(P("Two things to read.", S_BODY))
    s.append(P("<b>Movement.</b> Everyone else is drawn from the last thing the server "
               "sent, so on a slow connection you are seeing them a fraction of a "
               "second in the past. Lead your targets. This cuts the other way too: "
               "your own cell is predicted locally and is exactly where you think it "
               "is, which is why your escapes work better than your chases.", S_BODY))
    s.append(P("<b>Split attacks.</b> A player about to split lines up first - they "
               "stop cutting corners and start travelling straight at you. The "
               f"warning is short and the reach is long ({K['split']['400']['reach']:.0f} "
               "units at mass 400), so the counter is distance held in advance, not "
               "reaction. If something twice your size is pointing at you and closing, "
               "you are already inside its range.", S_BODY))
    s.append(callout(
        "The counter nobody uses",
        "A player who has just split is two half-sized cells that cannot rejoin for "
        "tens of seconds. If they miss you, they are prey - and for that window they "
        "are the most profitable target on the board. Baiting a split and turning on "
        "the pieces is the highest-value play in the game."))

    s.append(PageBreak())

    s.append(technique("Virus mechanics",
                       "Skilled players use viruses offensively and defensively."))
    s.append(P("<b>Defensively</b>, while you are under "
               f"{POP_MASS:.0f} mass, a virus is a place nothing dangerous can follow "
               "you. Learn where they are and treat them as safe squares - a chase "
               "that would kill you in open water ends the moment you sit on one.", S_BODY))
    s.append(P("<b>Offensively</b>, there are two plays. The first needs no setup: "
               "herd a large player toward a virus. They know the danger, so the "
               "threat of it alone steers them, which is often all you want.", S_BODY))
    s.append(P(f"The second is feeding. {K['VIRUS_FEED_HITS']} blobs of ejected mass "
               "split a virus and launch a new one along the line your mass came in "
               "on, about 450 units. That is how a small player removes a large one "
               "without ever being big enough to fight it - and how you close off the "
               "open water someone was running for.", S_BODY))
    s.append(bullets([
        f"Cost: {K['VIRUS_FEED_HITS'] * K['EJECT_MASS']} of your own mass, "
        "unrecoverable.",
        "Only mass still in flight counts, so feed from a distance you can actually "
        "throw - a blob that stops short has missed.",
        f"Do not set up a feed while over {POP_MASS:.0f} mass without watching your "
        "own drift. Walking in to aim is how people burst themselves.",
    ]))

    s.append(technique("Team tactics",
                       "Feeding, baiting, splitting and coordinating - where applicable."))
    s.append(P("The mechanics exist, so it is worth knowing what they are. <b>Feeding</b> "
               "transfers mass to another player at "
               f"{EJECT_LOSS:.0f}% loss per throw. <b>Baiting</b> means one player "
               "presenting as catchable so a third party splits at them, and the "
               "partner taking the pieces. <b>Coordinated splitting</b> means two "
               "players cutting off both escape directions at once, which defeats the "
               "geometry in the positioning section above.", S_BODY))

    s.append(Spacer(1, 3))
    s.append(callout(
        "Where this applies, and where it does not",
        "In Practice, and in any friendly round, all of the above is fair play and "
        "good fun. <b>In a wagered round it is not a tactic, it is collusion.</b> Two "
        "accounts moving stakes between themselves by feeding is precisely the "
        "behaviour a staked game has to exclude, and the fact that the mechanics "
        "allow it is an open problem rather than a licence. Treat wagered rounds as "
        "what they are: every other player is an opponent.",
        DANGER, colors.HexColor("#fbeceb")))
    s.append(Spacer(1, 7))
    s.append(P("The one piece of it that is always legitimate is reading other "
               "people's coordination. If two cells keep arriving together, assume "
               "they are working together and stop treating either as a lone target.",
               S_BODY))

    s.append(PageBreak())

    # ---- playbook ----------------------------------------------------------
    s.append(Mark("Playbook"))
    s.append(P("A ten-minute playbook", S_H1))
    s.append(P("One way to structure a round. Not the only way, but a shape to "
               "depart from rather than playing on instinct for ten minutes.", S_LEAD))

    s.append(datatable(
        ["Clock", "Priority", "What you are doing"],
        [["10:00 - 8:00", "Grow, quietly",
          "You open equidistant from two neighbours who are exactly your size, so "
          "nobody can eat anybody. Leave. Sweep orbs away from the ring and let the "
          "players who fight at the opening whistle eat each other."],
         ["8:00 - 5:00", "Convert size into kills",
          "You should be comfortably over 100. Hunt players in the band you can "
          f"actually eat - anything under {1 / K['EAT_RATIO']:.2f}x your mass - and take "
          "them without splitting where possible. In a wagered round this is the "
          "only part that grows your pot."],
         ["5:00 - 2:00", "Manage the crown",
          f"If you are large, you are slow and you are decaying above "
          f"{K['DECAY_ABOVE']}. Stay off viruses, stay off walls, and keep eating "
          "enough to cover the leak. If you are mid-sized, pick off the fragments "
          "from other people's fights - a burst player is nine free meals."],
         ["2:00 - 0:30", "Find the line",
          f"Look at where {STD['paidPositions']}th place sits. If you are above it, "
          "your job is no longer to grow. If you are below it, you need one player, "
          "and viruses are how a smaller cell removes a bigger one."],
         ["0:30 - 0:00", "Survive",
          "Do not split. Do not chase. Do not go near a virus. Hold open water and "
          "let the clock run out."]],
        [24 * mm, 30 * mm, None]))

    s.append(P("The five mistakes that cost the most", S_H2))
    s.append(bullets([
        "<b>Splitting to catch something you did not need.</b> The halves are what "
        "gets eaten, and the cooldown is measured in tens of seconds.",
        f"<b>Carrying more than {K['DECAY_ABOVE']} mass without a plan.</b> Above it "
        "you leak, you are slow, and viruses are lethal to you.",
        "<b>Chasing a rank instead of a pot.</b> Rank without kills pays back a "
        "stake and a shrug.",
        "<b>Fighting in the last thirty seconds.</b> A place in hand is worth more "
        "than a place you might win.",
        "<b>Treating a respawn as a second chance at the money.</b> It is not. Your "
        "pot left with the player who ate you.",
    ]))

    s.append(PageBreak())

    # ---- reference ---------------------------------------------------------
    s.append(Mark("Reference"))
    s.append(P("Quick reference", S_H1))
    s.append(P("Every number the game runs on, on one page.", S_LEAD))

    ref_a = [P("Eating and growing", S_H3), datatable(
        ["", ""],
        [["Starting mass", f"{K['START_MASS']}"],
         ["Orb value", f"{K['PELLET_MASS']} mass"],
         ["To eat a rival", f"you must be {K['EAT_RATIO']}x their mass ({EAT_PCT:.1f}% bigger)"],
         ["Reward for eating", f"{K['EAT_BONUS']}x the mass you swallowed"],
         ["Decay", f"above {K['DECAY_ABOVE']} mass, 0.22% per second"],
         ["Speed", "falls as mass<super>-0.24</super>"]],
        [30 * mm, None]),
        P("Splitting and ejecting", S_H3), datatable(
        ["", ""],
        [["Maximum cells", f"{K['MAX_CELLS']}"],
         ["Rejoin cooldown", "about 20s at small sizes, 50s at mass 1,600"],
         ["Eject cost", f"{K['EJECT_MASS']} mass spent, {K['EJECT_KEEP']} delivered "
                        f"({EJECT_LOSS:.0f}% lost)"],
         ["Eject range", "about 237 units past your own membrane"],
         ["Own-mass cooldown", f"{K['EJECT_OWNER_COOLDOWN']}s before eating your "
                               "own throw back"]],
        [30 * mm, None])]

    ref_b = [P("Viruses", S_H3), datatable(
        ["", ""],
        [["Virus mass", f"{K['VIRUS_MASS']}"],
         ["Dangerous to you above", f"{POP_MASS:.0f} mass"],
         ["Pieces you burst into", f"{K['VIRUS_PIECES']}"],
         ["Feeds to split one", f"{K['VIRUS_FEED_HITS']} blobs of ejected mass, still in flight"],
         ["Where the new one goes", "along the line your mass came in on, about 450 units"],
         ["Population ceiling", f"{K['VIRUS_MAX_RATIO']}x the count the arena seeds"]],
        [30 * mm, None]),
        P("The round", S_H3), datatable(
        ["", "Std", "High"],
        [["Stake", money(STD["stake"]), money(HIGH["stake"])],
         ["Players needed", str(STD["lobbyMin"]), str(HIGH["lobbyMin"])],
         ["Arena", f"{STD['world']['size']:,}", f"{HIGH['world']['size']:,}"],
         ["Orbs", f"{STD['world']['pellets']:,}", f"{HIGH['world']['pellets']:,}"],
         ["Viruses", str(STD["world"]["viruses"]), str(HIGH["world"]["viruses"])],
         ["Round length", mmss(STD["roundSeconds"]), mmss(HIGH["roundSeconds"])],
         ["Paid places", str(STD["paidPositions"]), str(HIGH["paidPositions"])],
         ["Countdown", f"{T['countdown']}s", f"{T['countdown']}s"],
         ["Standings", f"{T['intermission']}s", f"{T['intermission']}s"]],
        [30 * mm, 14 * mm, None])]

    s.append(two_col(ref_a, ref_b))
    s.append(Spacer(1, 6 * mm))
    s.append(P("Practice is a third tier with no stake, no lobby and no server: it "
               "runs against bots in your own browser. Use it for everything in the "
               "skills chapter.", S_CAPTION))

    return s


if __name__ == "__main__":
    path = build()
    print(f"wrote {path}")
