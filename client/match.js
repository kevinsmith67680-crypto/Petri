// ---------------------------------------------------------------------------
// Asking the matchmaker for a seat.
//
// Every connection attempt starts here, reconnects included: the matchmaker
// reserves a seat on a game server and answers with where it is and a signed
// ticket for it. The socket then presents the ticket and nothing else. A
// ticket lives for seconds and is spent on use, so it is never kept.
// ---------------------------------------------------------------------------

// The matchmaker has said no, and why. `code` decides whether asking again
// can help: see FINAL_MATCH in net.js.
export class MatchRefused extends Error {
  constructor(code, message, { status = 0, retryMs = 0 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryMs = retryMs;
  }
}

export async function requestTicket({
  endpoint, token, stake, region = null, bots = null, timeoutMs = 6000
}) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      // bots: the difficulty asked for. The matchmaker seats the player only
      // with others who asked for the same, where the server has bots at all.
      body: JSON.stringify({ stake, ...(region ? { region } : {}), ...(bots ? { bots } : {}) }),
      cache: "no-store",
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(timeoutMs) : undefined
    });
  } catch (err) {
    throw new MatchRefused("unavailable", "Could not reach the matchmaker.");
  }

  let body = {};
  try { body = await res.json(); } catch { /* an error page, most likely */ }
  if (!res.ok || typeof body.ticket !== "string") {
    throw new MatchRefused(
      body.code || "unavailable",
      body.error || `The matchmaker answered ${res.status}.`,
      { status: res.status, retryMs: body.retryMs || 0 }
    );
  }
  return body;
}
