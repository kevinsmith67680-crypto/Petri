// ---------------------------------------------------------------------------
// Client account API.
//
// A thin wrapper over /api/*. Holds the session token and nothing else: the
// display name, the balance and the account itself all live on the server and
// are re-read rather than cached, so this file can never disagree with it.
// ---------------------------------------------------------------------------

const TOKEN_KEY = "petri.session";

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function writeToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private browsing; the session just will not persist */ }
}

export function createAccountClient({ base = "" } = {}) {
  let token = readToken();
  let account = null;

  async function call(path, { method = "GET", body } = {}) {
    const res = await fetch(`${base}/api/${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    let payload = {};
    try { payload = await res.json(); } catch { /* empty body */ }

    if (!res.ok) {
      // An expired or revoked session should sign the user out rather than
      // leaving the UI insisting they are logged in.
      if (res.status === 401) { token = null; account = null; writeToken(null); }
      throw new ApiError(payload.error || "Request failed.", payload.code, res.status);
    }
    return payload;
  }

  function adopt(payload) {
    if (payload.token) { token = payload.token; writeToken(token); }
    if (payload.account) account = payload.account;
    return payload;
  }

  return {
    get token() { return token; },
    get account() { return account; },
    get signedIn() { return !!token && !!account; },

    // Called on load: validates whatever token is in storage. A null result
    // simply means "show the signed-out menu".
    async restore() {
      if (!token) return null;
      try { return adopt(await call("me")); }
      catch { return null; }
    },

    async signup(username, password, displayName) {
      return adopt(await call("signup", {
        method: "POST", body: { username, password, displayName }
      }));
    },

    async login(username, password) {
      return adopt(await call("login", { method: "POST", body: { username, password } }));
    },

    async logout() {
      try { await call("logout", { method: "POST" }); } catch { /* already gone */ }
      token = null;
      account = null;
      writeToken(null);
    },

    async stats() {
      return call("stats");
    },

    async board(kind = "mass", limit = 10) {
      return call(`board?kind=${encodeURIComponent(kind)}&limit=${limit}`);
    },

    async setDisplayName(displayName) {
      return adopt(await call("name", { method: "POST", body: { displayName } }));
    }
  };
}
