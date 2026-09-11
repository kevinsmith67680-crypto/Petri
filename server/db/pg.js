// ---------------------------------------------------------------------------
// Postgres / Supabase backend.
//
// CONNECTING FROM RENDER: Supabase's direct connection (db.<ref>.supabase.co)
// resolves to IPv6 only, and Render is IPv4, so a direct connection string
// will fail with ENETUNREACH or "Address family not supported". Use the Shared
// Pooler (Supavisor).
//
// Session mode, port 5432  <- use this. Behaves like a direct connection,
//                             supports prepared statements, IPv4. Correct for
//                             a long-lived server like this one.
// Transaction mode, 6543   <- for serverless and autoscaling, not for us.
//
//   postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
//
// `pg` is imported dynamically so it stays an optional dependency: running in
// memory mode does not require it to be installed.
// ---------------------------------------------------------------------------

let Pool = null;

async function loadDriver() {
  if (Pool) return Pool;
  try {
    ({ Pool } = await import("pg"));
  } catch {
    throw new Error(
      "DATABASE_URL is set but the 'pg' driver is not installed. Run: npm install pg"
    );
  }
  return Pool;
}

export async function createPool(connectionString) {
  const PoolCtor = await loadDriver();
  const pool = new PoolCtor({
    connectionString,
    // Supabase terminates TLS with a certificate this pool will not have a
    // root for. The connection is still encrypted; it is not authenticated.
    // For stronger guarantees, download Supabase's CA certificate and pass
    // { ca } here instead.
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    // Fail fast rather than letting the game loop wait on a dead socket.
    connectionTimeoutMillis: 8_000
  });

  pool.on("error", err => console.error("postgres pool error:", err.message));

  // Prove the connection and the schema before the server claims to be up.
  const probe = await pool.query("select 1 as ok from petri.accounts limit 0");
  if (!probe) throw new Error("schema probe failed");

  return pool;
}

// ── row mapping ─────────────────────────────────────────────────────────────
// The rest of the codebase speaks camelCase; Postgres speaks snake_case.
// Converting in one place keeps that difference from leaking everywhere.

// A `date` column carries a calendar day and no timezone, but node-postgres
// hands it back as a Date at LOCAL midnight. Reading that with toISOString()
// shifts the day backwards anywhere east of UTC — which on a date of birth is
// how someone's birthday moves and, one day a year, their age with it. Read
// the local components back out instead, which is what was stored.
const pad = n => String(n).padStart(2, "0");
const toIsoDate = value => {
  if (!value) return null;
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
};

const toAccount = row => row && {
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  password: row.password,
  googleSub: row.google_sub || null,
  dateOfBirth: toIsoDate(row.date_of_birth),
  createdAt: new Date(row.created_at).getTime(),
  createdIp: row.created_ip,
  nameChangedAt: row.name_changed_at ? new Date(row.name_changed_at).getTime() : 0
};

const toSession = row => row && {
  id: row.id,
  accountId: row.account_id,
  createdAt: new Date(row.created_at).getTime(),
  expiresAt: new Date(row.expires_at).getTime()
};

export function emptyStats() {
  return {
    matches: 0, wins: 0, timePlayed: 0, orbsAbsorbed: 0, playersEaten: 0,
    bestPeakMass: 0, bestPosition: null, firstPlaces: 0,
    currentStreak: 0, longestStreak: 0, totalStaked: 0, totalWon: 0,
    lastPlayedAt: null
  };
}

export class PgRepo {
  constructor(pool) { this.pool = pool; }

  // ── accounts ──────────────────────────────────────────────────────────────
  // Indexed lookups, not scans. The memory implementation walks every account
  // on each signup, which is fine for ten and quadratic misery for ten
  // thousand; this is the reason the repository interface exists at all.

  async findAccountByUsername(username) {
    const { rows } = await this.pool.query(
      "select * from petri.accounts where lower(username) = lower($1) limit 1",
      [username]
    );
    return toAccount(rows[0]) || null;
  }

  async findAccountByDisplayName(name) {
    const { rows } = await this.pool.query(
      "select * from petri.accounts where display_name_key = lower($1) limit 1",
      [name]
    );
    return toAccount(rows[0]) || null;
  }

  async findAccountByGoogleSub(sub) {
    if (!sub) return null;
    const { rows } = await this.pool.query(
      "select * from petri.accounts where google_sub = $1 limit 1", [sub]
    );
    return toAccount(rows[0]) || null;
  }

  async getAccount(id) {
    const { rows } = await this.pool.query(
      "select * from petri.accounts where id = $1", [id]
    );
    return toAccount(rows[0]) || null;
  }

  async insertAccount({ username, displayName, password, googleSub = null, dateOfBirth = null, createdIp }) {
    try {
      const { rows } = await this.pool.query(
        `insert into petri.accounts (username, display_name, password, google_sub, date_of_birth, created_ip)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [username, displayName, password, googleSub, dateOfBirth, createdIp]
      );
      return toAccount(rows[0]);
    } catch (err) {
      // 23505 = unique violation. The unique indexes are the real guard
      // against duplicate names; the application-level check is only there to
      // produce a nicer message first.
      if (err.code === "23505") {
        const field = err.constraint?.includes("google") ? "Google account"
          : err.constraint?.includes("display") ? "display name" : "username";
        const e = new Error(`That ${field} is taken.`);
        e.code = "taken";
        throw e;
      }
      throw err;
    }
  }

  async updateDisplayName(id, displayName) {
    try {
      const { rows } = await this.pool.query(
        `update petri.accounts
            set display_name = $2, name_changed_at = now()
          where id = $1 returning *`,
        [id, displayName]
      );
      return toAccount(rows[0]);
    } catch (err) {
      if (err.code === "23505") {
        const e = new Error("That display name is taken.");
        e.code = "taken";
        throw e;
      }
      throw err;
    }
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  async insertSession({ id, accountId, expiresAt }) {
    await this.pool.query(
      `insert into petri.sessions (id, account_id, expires_at)
       values ($1, $2, to_timestamp($3 / 1000.0))`,
      [id, accountId, expiresAt]
    );
  }

  // One round trip rather than two: resolving a session is on the hot path of
  // every WebSocket join.
  async findAccountBySession(sessionId) {
    const { rows } = await this.pool.query(
      `select a.* from petri.sessions s
         join petri.accounts a on a.id = s.account_id
        where s.id = $1 and s.expires_at > now()
        limit 1`,
      [sessionId]
    );
    return toAccount(rows[0]) || null;
  }

  async getSession(id) {
    const { rows } = await this.pool.query(
      "select * from petri.sessions where id = $1", [id]
    );
    return toSession(rows[0]) || null;
  }

  async deleteSession(id) {
    await this.pool.query("delete from petri.sessions where id = $1", [id]);
  }

  async sweepSessions() {
    const { rowCount } = await this.pool.query(
      "delete from petri.sessions where expires_at < now()"
    );
    return rowCount;
  }

  // ── money ─────────────────────────────────────────────────────────────────
  // Every one of these is a single atomic statement on the server. bigint
  // comes back from pg as a string, so it is parsed explicitly rather than
  // relying on coercion.

  async ensureBalance(accountId) {
    await this.pool.query("select petri.ensure_balance($1)", [accountId]);
  }

  async snapshot(accountId) {
    const { rows } = await this.pool.query(
      "select balance, escrow from petri.balances where account_id = $1",
      [accountId]
    );
    const row = rows[0];
    return {
      balance: row ? Number(row.balance) : 0,
      pot: row ? Number(row.escrow) : 0,
      staked: row ? Number(row.escrow) > 0 : false
    };
  }

  async deposit(accountId, units, ref = "mock") {
    const { rows } = await this.pool.query(
      "select * from petri.deposit($1, $2, $3)", [accountId, units, ref]
    );
    return Number(rows[0].balance);
  }

  async lockStake(accountId, units) {
    const { rows } = await this.pool.query(
      "select * from petri.lock_stake($1, $2)", [accountId, units]
    );
    return { balance: Number(rows[0].balance), pot: Number(rows[0].escrow) };
  }

  async claim(winnerId, loserId) {
    const { rows } = await this.pool.query(
      "select petri.claim_pot($1, $2) as moved", [winnerId, loserId]
    );
    return Number(rows[0].moved);
  }

  async cashOut(accountId, rakeBps) {
    const { rows } = await this.pool.query(
      "select * from petri.cash_out($1, $2)", [accountId, rakeBps]
    );
    return { paid: Number(rows[0].paid), rake: Number(rows[0].rake) };
  }

  async forfeit(accountId) {
    const { rows } = await this.pool.query(
      "select petri.forfeit_pot($1) as moved", [accountId]
    );
    return Number(rows[0].moved);
  }

  async refund(accountId) {
    const { rows } = await this.pool.query(
      "select petri.refund_pot($1) as moved", [accountId]
    );
    return Number(rows[0].moved);
  }

  // ── matches and stats ─────────────────────────────────────────────────────

  async recordMatch(m) {
    const { rows } = await this.pool.query(
      `select * from petri.record_match(
         $1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        m.accountId, m.startedAt, m.duration, m.finishPosition, m.playersInArena,
        m.orbs, m.playersEaten, m.peakMass, m.outcome, m.killerId || null,
        m.stake || 0, m.payout || 0
      ]
    );
    const r = rows[0];
    return {
      matchId: Number(r.match_id),
      won: r.won,
      currentStreak: r.current_streak,
      longestStreak: r.longest_streak
    };
  }

  async getStats(accountId) {
    const { rows } = await this.pool.query(
      "select * from petri.player_stats where account_id = $1", [accountId]
    );
    const r = rows[0];
    if (!r) return emptyStats();
    return {
      matches: r.matches,
      wins: r.wins,
      timePlayed: Number(r.time_played),
      orbsAbsorbed: Number(r.orbs_absorbed),
      playersEaten: Number(r.players_eaten),
      bestPeakMass: r.best_peak_mass,
      bestPosition: r.best_position,
      firstPlaces: r.first_places,
      currentStreak: r.current_streak,
      longestStreak: r.longest_streak,
      totalStaked: Number(r.total_staked),
      totalWon: Number(r.total_won),
      lastPlayedAt: r.last_played_at ? new Date(r.last_played_at).getTime() : null
    };
  }

  async getMatches(accountId, limit = 10) {
    const { rows } = await this.pool.query(
      `select id, ended_at, duration_seconds, finish_position, players_in_arena,
              orbs_absorbed, players_eaten, peak_mass, outcome, won, stake, payout
         from petri.matches where account_id = $1
        order by ended_at desc limit $2`,
      [accountId, Math.min(50, Math.max(1, limit))]
    );
    return rows.map(r => ({
      id: Number(r.id),
      endedAt: new Date(r.ended_at).getTime(),
      duration: Number(r.duration_seconds),
      finishPosition: r.finish_position,
      playersInArena: r.players_in_arena,
      orbs: r.orbs_absorbed,
      playersEaten: r.players_eaten,
      peakMass: r.peak_mass,
      outcome: r.outcome,
      won: r.won,
      stake: Number(r.stake),
      payout: Number(r.payout)
    }));
  }

  async getBoard(kind = "mass", limit = 10) {
    const view = { mass: "board_mass", streak: "board_streak", orbs: "board_orbs" }[kind];
    if (!view) throw new Error(`unknown board ${kind}`);
    const { rows } = await this.pool.query(
      `select display_name, value from petri.${view} limit $1`,
      [Math.min(100, Math.max(1, limit))]
    );
    return rows.map(r => ({ name: r.display_name, value: Number(r.value) }));
  }

  // Mirrors Ledger.total(): held must equal deposits minus withdrawals.
  async conservation() {
    const { rows } = await this.pool.query("select * from petri.money_total");
    return { held: Number(rows[0].held), expected: Number(rows[0].expected) };
  }

  async close() { await this.pool.end(); }
}
