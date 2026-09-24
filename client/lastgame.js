// ---------------------------------------------------------------------------
// The player's last game: how the lobby card describes it, and what gets
// shared when they post it.
//
// Pure. A match record from /api/stats goes in; words and links come out. No
// DOM, so every phrasing rule below can be tested directly.
// ---------------------------------------------------------------------------

import { formatUsdc } from "../shared/wager.js";

export const ordinal = n => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const survived = m => m.outcome === "survived" || m.outcome === "cashed_out";

// How long ago, in the fewest words that are still true.
export function ago(endedAt, now = Date.now()) {
  const s = Math.max(0, Math.round((now - endedAt) / 1000));
  if (s < 60) return "Just now";
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "Yesterday" : `${d} days ago`;
}

// Positions follow the rules the round cards already use. A survivor's place
// has no denominator, because the standings count who was LEFT, not who
// started — "3rd of 9" would read as a far smaller result than a hundred-player
// round was. Someone eaten is told where they stood, and out of how many, at
// the moment it happened.
//
// `won` is not trusted outside a survival: the stats table counts any finish
// in the top five as a win, including a player eaten while ranked there, who
// forfeited their stake.
export function headline(m) {
  const pos = m.finishPosition;
  if (survived(m)) {
    if (!pos) return "Survived to the whistle";
    return m.won ? `Finished ${ordinal(pos)}, in the paid places` : `Finished ${ordinal(pos)}`;
  }
  if (m.outcome === "eaten" || m.outcome === "bot") {
    const by = m.outcome === "bot" ? "a bot" : "another player";
    return pos && m.playersInArena
      ? `Eaten by ${by} while ${ordinal(pos)} of ${m.playersInArena}`
      : `Eaten by ${by}`;
  }
  return "Left before the whistle";
}

// Label and value pairs for the stat grid.
export function statRows(m) {
  const rows = [
    ["Peak mass", String(m.peakMass || 0)],
    ["Players eaten", String(m.playersEaten || 0)],
    ["Orbs", String(m.orbs || 0)],
    ["Time alive", mmss(m.duration || 0)]
  ];
  // Only a staked game has a money result. Shown net of the stake, because
  // payout is what came back rather than what was won: a survivor paid back
  // exactly their stake broke even, and an eaten player lost all of it.
  if (m.stake > 0) {
    const net = (m.payout || 0) - m.stake;
    const sign = net > 0 ? "+" : net < 0 ? "−" : "";
    rows.push(["Result", `${sign}${formatUsdc(Math.abs(net))} USDC`]);
  }
  return rows;
}

// What a post says. Performance only, never money: this goes out under the
// player's name to people who never opted into a wagering game, and a
// winnings brag is the part of that most likely to be advertising.
export function shareText(m) {
  const peak = m.peakMass || 0;
  const n = m.playersEaten || 0;
  const players = `${n} player${n === 1 ? "" : "s"}`;
  if (survived(m) && m.finishPosition) {
    return `I finished ${ordinal(m.finishPosition)} in a round of Engulfs, peaking at ${peak} mass` +
      `${n ? ` and eating ${players}` : ""}. Can you beat that?`;
  }
  const eaten = m.outcome === "eaten" || m.outcome === "bot";
  return `I peaked at ${peak} mass in Engulfs${n ? ` and ate ${players}` : ""}` +
    `${eaten ? " before something bigger got me" : ""}. Can you beat that?`;
}

// Each platform's own "compose a post" address. Facebook takes only the link
// and builds the preview from the page's Open Graph tags; the others take the
// words as well.
export function shareLinks(text, url) {
  const t = encodeURIComponent(text);
  const u = encodeURIComponent(url);
  return {
    x: `https://twitter.com/intent/tweet?text=${t}&url=${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`,
    reddit: `https://www.reddit.com/submit?url=${u}&title=${t}`
  };
}
