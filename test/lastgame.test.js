// ---------------------------------------------------------------------------
// The last-game card and what gets shared. Run with:  node test/lastgame.test.js
//
// All words, no DOM. The rules worth pinning are the ones that are easy to get
// subtly wrong: a survivor's place has no denominator, an eaten player is not
// told they were "in the paid places" because the stats table counts them as
// a win, and nothing about money ever leaves in a shared post.
// ---------------------------------------------------------------------------

import { ago, headline, statRows, shareText, shareLinks } from "../client/lastgame.js";
import { UNIT } from "../shared/wager.js";

let failures = 0;
function check(label, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? "  " + detail : ""}`);
}

const game = over => ({
  endedAt: Date.now(), duration: 462, finishPosition: 3, playersInArena: 9,
  orbs: 140, playersEaten: 4, peakMass: 812, outcome: "survived", won: true,
  stake: 0, payout: 0, ...over
});
const row = (m, label) => (statRows(m).find(r => r[0] === label) || [])[1];

console.log("\n-- the headline --");

check("a survivor in the top five is told so",
  headline(game()) === "Finished 3rd, in the paid places", headline(game()));
check("and is given no denominator",
  !/of 9/.test(headline(game())));
check("sixth is just sixth",
  headline(game({ finishPosition: 6, won: false })) === "Finished 6th");
check("a survivor with no recorded place still survived",
  headline(game({ finishPosition: null })) === "Survived to the whistle");

// The stats table marks any finish in the top five a win, including one
// cut short by being eaten there. That player forfeited their stake.
const eatenHigh = game({ outcome: "eaten", finishPosition: 2, playersInArena: 40, won: true });
check("eaten in second is not called paid",
  headline(eatenHigh) === "Eaten by another player while 2nd of 40", headline(eatenHigh));
check("a bot is named as a bot",
  headline(game({ outcome: "bot", finishPosition: 12, playersInArena: 30 }))
    === "Eaten by a bot while 12th of 30");
check("with no standing to report, only what happened",
  headline(game({ outcome: "eaten", finishPosition: null })) === "Eaten by another player");
check("leaving early reads as leaving",
  headline(game({ outcome: "abandoned" })) === "Left before the whistle");

console.log("\n-- the numbers --");

check("time alive is minutes and seconds", row(game(), "Time alive") === "7:42", row(game(), "Time alive"));
check("peak mass is shown", row(game(), "Peak mass") === "812");
check("an unstaked game has no money row", row(game(), "Result") === undefined);

const paid = game({ stake: 1 * UNIT, payout: 1.4 * UNIT });
check("a paid finish shows what it made, net of the stake",
  row(paid, "Result") === "+0.40 USDC", row(paid, "Result"));
const lost = game({ outcome: "eaten", stake: 1 * UNIT, payout: 0 });
check("being eaten shows the stake lost",
  row(lost, "Result") === "−1.00 USDC", row(lost, "Result"));
const even = game({ stake: 2 * UNIT, payout: 2 * UNIT });
check("getting the stake back is not a win",
  row(even, "Result") === "0.00 USDC", row(even, "Result"));

console.log("\n-- the post --");

check("a survivor shares their place",
  shareText(game()) === "I finished 3rd in a round of Engulfs, peaking at 812 mass and eating 4 players. Can you beat that?",
  shareText(game()));
check("one player is one player",
  /eating 1 player\./.test(shareText(game({ playersEaten: 1 }))), shareText(game({ playersEaten: 1 })));
check("nobody eaten is left unsaid",
  !/\beating\b|\bate\b/.test(shareText(game({ playersEaten: 0 }))), shareText(game({ playersEaten: 0 })));
check("being eaten is owned up to",
  shareText(lost) === "I peaked at 812 mass in Engulfs and ate 4 players before something bigger got me. Can you beat that?",
  shareText(lost));
check("leaving early does not claim a death",
  !/bigger/.test(shareText(game({ outcome: "abandoned" }))));

const rich = game({ stake: 2 * UNIT, payout: 57.25 * UNIT });
const post = shareText(rich);
check("money never leaves in a post",
  !/USDC|\$|£|57|stake|won|paid|win/i.test(post), post);

console.log("\n-- the links --");

const url = "https://engulfs.io/?mode=online";
const text = shareText(game());
const links = shareLinks(text, url);
const param = (href, key) => new URL(href).searchParams.get(key);
check("X gets the words and the link",
  param(links.x, "text") === text && param(links.x, "url") === url);
check("Facebook gets the link alone", param(links.facebook, "u") === url &&
  new URL(links.facebook).searchParams.size === 1);
check("WhatsApp gets both in one message", param(links.whatsapp, "text") === `${text} ${url}`);
check("Reddit gets a title and the link",
  param(links.reddit, "title") === text && param(links.reddit, "url") === url);
check("every link is https",
  Object.values(links).every(h => h.startsWith("https://")));
const awkward = shareLinks("50% & more #1 ?x=y", url);
check("awkward characters survive the trip",
  param(awkward.x, "text") === "50% & more #1 ?x=y");

console.log("\n-- when --");

const now = 1_800_000_000_000;
check("seconds ago is just now", ago(now - 20_000, now) === "Just now");
check("minutes", ago(now - 12 * 60_000, now) === "12 min ago", ago(now - 12 * 60_000, now));
check("hours", ago(now - 3 * 3_600_000, now) === "3 h ago");
check("a day", ago(now - 30 * 3_600_000, now) === "Yesterday");
check("days", ago(now - 5 * 86_400_000, now) === "5 days ago");
check("a clock slightly ahead is not the future", ago(now + 5_000, now) === "Just now");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
