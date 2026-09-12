// ---------------------------------------------------------------------------
// HTTP API for accounts.
//
// Auth lives on HTTP rather than the WebSocket because it happens before the
// socket exists, and because a password exchange has no business sharing a
// path with the 20Hz gameplay loop.
//
// The session token is returned as a bearer token for the client to store.
// That is a real trade-off: a bearer token in localStorage is readable by any
// XSS on the page, whereas an HttpOnly cookie is not. It is used here because
// the WebSocket handshake needs to carry the token in its join payload, and
// cookies would add CSRF handling for no gain in that path. If this ever
// guards real funds, revisit the decision rather than inheriting it.
// ---------------------------------------------------------------------------

import { AccountError } from "./accounts.js";
import { verifyIdToken, GoogleAuthError } from "./google.js";

const MAX_BODY = 4096;   // no legitimate request here is larger

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readJson(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let killed = false;
    const chunks = [];
    req.on("data", chunk => {
      if (killed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        killed = true;
        // Answer before hanging up, so the caller sees a status rather than a
        // bare connection reset.
        try { send(res, 413, { error: "Request too large." }); } catch { /* already gone */ }
        req.destroy();
        reject(new AccountError("Request too large.", "sent"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (killed) return;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new AccountError("Malformed JSON.")); }
    });
    req.on("error", err => { if (!killed) reject(err); });
  });
}

const bearer = req => {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
};

// Returns true if it handled the request.
export async function handleApi(req, res, ctx) {
  const { accounts, backend, ramp, url, ip, googleClientId } = ctx;
  if (!url.pathname.startsWith("/api/")) return false;

  const route = url.pathname.slice(5);
  const withAccount = async () => {
    const account = await accounts.resolveSession(bearer(req));
    if (!account) throw new AccountError("Not signed in.", "unauthorised");
    return account;
  };

  // Balances are keyed by account id, so a signed-in player keeps their
  // balance across devices and cannot get a fresh one by changing IP.
  // Balances are keyed by the account uuid, so a signed-in player keeps their
  // balance across devices and cannot get a fresh one by changing IP.
  const shape = async account => ({
    account: accounts.publicView(account),
    demo: !ramp.isReal,
    ...(await backend.snapshot(account.id))
  });

  try {
    // Public, and safe to expose: a Google client id is not a secret, it
    // appears in the page of every site that uses one. The client asks for it
    // rather than duplicating it in config, so there is one source of truth.
    if (route === "config" && req.method === "GET") {
      return send(res, 200, {
        googleClientId: googleClientId || null,
        demo: !ramp.isReal
      }), true;
    }

    if (route === "google" && req.method === "POST") {
      if (!googleClientId) throw new AccountError("Google sign-in is not configured.");
      const body = await readJson(req, res);
      let profile;
      try {
        profile = await verifyIdToken(body.credential, googleClientId);
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          // Log the real reason, tell the client almost nothing: the detail is
          // useful to an attacker probing which check failed.
          console.warn("google sign-in rejected:", err.message);
          throw new AccountError("Could not verify that Google account.", "credentials");
        }
        throw err;
      }

      // dateOfBirth is only consulted when this creates an account; a Google
      // sign-in to an existing one ignores it entirely.
      const account = await accounts.findOrCreateGoogle({
        ...profile, dateOfBirth: body.dateOfBirth, ip
      });
      if (!ramp.isReal) await ramp.grant(account.id);
      const token = await accounts.createSession(account.id);
      return send(res, 200, { token, ...(await shape(account)) }), true;
    }

    if (route === "signup" && req.method === "POST") {
      const body = await readJson(req, res);
      const account = await accounts.signup({ ...body, ip });
      if (!ramp.isReal) await ramp.grant(account.id);
      const token = await accounts.createSession(account.id);
      return send(res, 201, { token, ...(await shape(account)) }), true;
    }

    if (route === "login" && req.method === "POST") {
      const body = await readJson(req, res);
      const account = await accounts.login({ ...body, ip });
      if (!ramp.isReal) await ramp.grant(account.id);
      const token = await accounts.createSession(account.id);
      return send(res, 200, { token, ...(await shape(account)) }), true;
    }

    if (route === "logout" && req.method === "POST") {
      await accounts.destroySession(bearer(req));
      return send(res, 200, { ok: true }), true;
    }

    if (route === "me" && req.method === "GET") {
      return send(res, 200, await shape(await withAccount())), true;
    }

    if (route === "stats" && req.method === "GET") {
      const account = await withAccount();
      const [stats, matches] = await Promise.all([
        backend.getStats(account.id),
        backend.getMatches(account.id, 10)
      ]);
      return send(res, 200, { stats, matches }), true;
    }

    // Public: no session needed, and it exposes display names only.
    if (route === "board" && req.method === "GET") {
      const kind = url.searchParams.get("kind") || "mass";
      if (!["mass", "streak", "orbs"].includes(kind)) {
        throw new AccountError("Unknown board.");
      }
      const rows = await backend.getBoard(kind, Number(url.searchParams.get("limit")) || 10);
      return send(res, 200, { kind, rows }), true;
    }

    if (route === "name" && req.method === "POST") {
      const account = await withAccount();
      const body = await readJson(req, res);
      const updated = await accounts.setDisplayName(account.id, body.displayName);
      return send(res, 200, await shape(updated)), true;
    }

    send(res, 404, { error: "No such endpoint." });
    return true;
  } catch (err) {
    if (err instanceof AccountError) {
      if (err.code === "sent") return true;   // already answered (413)
      const status = err.code === "unauthorised" ? 401
        : err.code === "throttled" ? 429
        : err.code === "taken" ? 409
        // Not 400: the request was well formed and understood, and the answer
        // is still no. A retry with the same body will always be refused.
        : err.code === "underage" ? 403
        : 400;
      send(res, status, { error: err.message, code: err.code });
      return true;
    }
    console.error("api error:", err);
    // Never leak internals to the client.
    send(res, 500, { error: "Something went wrong." });
    return true;
  }
}
