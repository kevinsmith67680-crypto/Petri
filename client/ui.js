// ---------------------------------------------------------------------------
// DOM chrome: readout, leaderboard, settings, and the start / death cards.
// Knows nothing about the simulation beyond the view shape.
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function createUI({ settings, onStart, onThemeChange }) {
  const el = {
    orbs: $("orbCount"),
    mass: $("statMass"),
    rank: $("statRank"),
    cells: $("statCells"),
    time: $("statTime"),
    board: $("board"),
    boardList: $("boardList"),
    minimap: $("minimap"),
    startVeil: $("startVeil"),
    overVeil: $("overVeil"),
    mode: $("modeNote")
  };

  let tickTimer = null;
  let hudAt = 0;

  function bumpCounter() {
    el.orbs.classList.remove("tick");
    void el.orbs.offsetWidth;      // force reflow so the animation restarts
    el.orbs.classList.add("tick");
    clearTimeout(tickTimer);
    tickTimer = setTimeout(() => el.orbs.classList.remove("tick"), 300);
  }

  function update(view, elapsed, now) {
    if (!view) return;
    el.orbs.textContent = view.me.orbs;
    el.cells.textContent = view.me.eaten;
    el.mass.textContent = Math.round(view.me.mass);
    el.time.textContent = mmss(elapsed);

    if (now - hudAt < 400) return;
    hudAt = now;

    el.rank.textContent = view.me.alive ? `${view.me.rank} of ${view.me.of}` : "—";

    if (settings.board) {
      el.boardList.innerHTML = view.board.map((r, i) =>
        `<li class="${r.id === view.me.id ? "you" : ""}">` +
        `<span>${i + 1}. ${escapeHtml(r.name)}</span><b>${r.mass}</b></li>`
      ).join("");
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── settings ──────────────────────────────────────────────────────────────

  const gearBtn = $("gearBtn");
  const panel = $("settings");

  gearBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    gearBtn.setAttribute("aria-expanded", String(!panel.hidden));
  });

  document.addEventListener("pointerdown", e => {
    if (panel.hidden || e.target.closest(".settings, .gear")) return;
    panel.hidden = true;
    gearBtn.setAttribute("aria-expanded", "false");
  });

  function bindSwitch(id, key, onChange) {
    const sw = $(id);
    sw.setAttribute("aria-checked", String(settings[key]));
    sw.addEventListener("click", () => {
      settings[key] = !settings[key];
      sw.setAttribute("aria-checked", String(settings[key]));
      onChange?.(settings[key]);
    });
  }

  const swTheme = $("swTheme");
  swTheme.addEventListener("click", () => {
    settings.theme = settings.theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", settings.theme);
    swTheme.setAttribute("aria-checked", String(settings.theme === "dark"));
    onThemeChange?.(settings.theme);
  });

  bindSwitch("swMap", "map", on => { el.minimap.hidden = !on; });
  bindSwitch("swBoard", "board", on => { el.board.hidden = !on; hudAt = 0; });
  bindSwitch("swGrid", "grid");
  bindSwitch("swNames", "names");

  // ── panels ────────────────────────────────────────────────────────────────

  $("btnStart").addEventListener("click", () => {
    document.activeElement?.blur?.();
    el.startVeil.hidden = true;
    el.overVeil.hidden = true;
    onStart();
  });

  $("btnAgain").addEventListener("click", () => {
    document.activeElement?.blur?.();
    el.overVeil.hidden = true;
    onStart();
  });

  function showDeath({ orbs, peak, eaten, elapsed, best }) {
    $("finalOrbs").textContent = orbs;
    $("finalMass").textContent = Math.round(peak);
    $("finalCells").textContent = eaten;
    $("finalTime").textContent = mmss(elapsed);
    $("finalBest").textContent = `${best} orbs`;
    $("overLine").textContent = orbs === 0
      ? "Something larger reached you before you absorbed anything."
      : "Something larger reached you.";
    el.overVeil.hidden = false;
    $("btnAgain").focus();
  }

  function setMode(text) { if (el.mode) el.mode.textContent = text; }

  return { update, bumpCounter, showDeath, setMode, el };
}
