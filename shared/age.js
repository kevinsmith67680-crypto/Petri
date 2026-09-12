// ---------------------------------------------------------------------------
// Age arithmetic.
//
// Shared so the form and the server agree on what "18" means. The server is
// the gate — the client half only exists to fail early and to bound the date
// picker, and nothing here is trusted when it arrives over the wire.
//
// WHAT THIS IS NOT. A date of birth typed into a form is a self-declaration,
// not age verification. It keeps honest minors out and records what the player
// asserted; it does not prove anything. A licensed real-money operator needs
// documentary or third-party verification on top of this.
//
// Everything is computed in UTC. Age from local components is off by a day for
// anyone whose timezone has rolled over when the server's has not, and on a
// birthday that is the difference between eligible and not.
// ---------------------------------------------------------------------------

export const MIN_AGE = 18;

// Nobody is applying at 121. A bound this loose rejects only typos and
// obviously junk input, which is all it is for.
export const MAX_AGE = 120;

// Returns a Date at UTC midnight, or null if the text is not a real calendar
// date. The round-trip check is what rejects 2007-02-30: Date.UTC rolls an
// impossible day forward into the next month rather than refusing it.
export function parseDob(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return date;
}

// Whole years completed on `now`. The birthday itself counts as the birthday:
// someone born exactly eighteen years ago today is 18, not 17.
export function ageOn(dob, now = new Date()) {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const month = now.getUTCMonth() - dob.getUTCMonth();
  if (month < 0 || (month === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

// The most recent date of birth that still clears MIN_AGE, as YYYY-MM-DD.
// Used as the `max` on the date input so the picker cannot offer an ineligible
// day in the first place.
export function latestEligibleDob(now = new Date()) {
  const d = new Date(Date.UTC(
    now.getUTCFullYear() - MIN_AGE, now.getUTCMonth(), now.getUTCDate()
  ));
  return d.toISOString().slice(0, 10);
}
