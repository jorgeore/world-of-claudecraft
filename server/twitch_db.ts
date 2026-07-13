// Twitch integration persistence (SQL only). Mirrors server/discord_db.ts:
// schema is a const string appended to ensureSchema() in db.ts; every query
// function takes the shared `pool` argument so this module never imports db.ts,
// keeping db.ts <-> twitch_db.ts cycle-free. No reward economy here — the
// Twitch integration is identity-only (login/register/link).
import type { Pool } from 'pg';
import { isUniqueViolation } from './http_util';

export const TWITCH_SCHEMA = `
-- One Twitch identity per account (account_id PK) and one account per Twitch
-- user (twitch_user_id UNIQUE). ON DELETE CASCADE so deleting an account drops
-- the link. Ownership is proven by an OAuth code exchange (see twitch_oauth_states).
CREATE TABLE IF NOT EXISTS twitch_links (
  account_id INT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  twitch_user_id TEXT NOT NULL UNIQUE,
  twitch_login TEXT,
  twitch_display_name TEXT,
  twitch_avatar TEXT,
  twitch_email TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Single-use, short-lived OAuth state rows (the CSRF/replay guard). Twitch's
-- code grant has no PKCE for confidential clients, so unlike discord_oauth_states
-- there is no code_verifier column; the state row + client_secret are the guard.
CREATE TABLE IF NOT EXISTS twitch_oauth_states (
  state TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  account_id INT REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS twitch_oauth_states_expires ON twitch_oauth_states(expires_at);
-- Single-use, short-lived "what next?" rows for a FIRST-TIME Twitch login: the
-- callback verified the identity, but the player has not yet chosen to create a
-- new account or link an existing one. Mirrors discord_pending_logins.
CREATE TABLE IF NOT EXISTS twitch_pending_logins (
  token TEXT PRIMARY KEY,
  twitch_user_id TEXT NOT NULL,
  twitch_login TEXT,
  twitch_display_name TEXT,
  twitch_avatar TEXT,
  twitch_email TEXT,
  twitch_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS twitch_pending_logins_expires ON twitch_pending_logins(expires_at);
`;

// ── Twitch identity link (mirrors discord_links) ───────────────────────────────

export interface TwitchLinkRow {
  account_id: number;
  twitch_user_id: string;
  twitch_login: string | null;
  twitch_display_name: string | null;
  twitch_avatar: string | null;
  twitch_email: string | null;
  linked_at: Date | string;
}

export async function twitchForAccount(
  pool: Pool,
  accountId: number,
): Promise<TwitchLinkRow | null> {
  const res = await pool.query(
    `SELECT account_id, twitch_user_id, twitch_login, twitch_display_name, twitch_avatar, twitch_email, linked_at
       FROM twitch_links WHERE account_id = $1`,
    [accountId],
  );
  return res.rows[0] ?? null;
}

export async function accountForTwitch(pool: Pool, twitchUserId: string): Promise<number | null> {
  const res = await pool.query('SELECT account_id FROM twitch_links WHERE twitch_user_id = $1', [
    twitchUserId,
  ]);
  return res.rows[0]?.account_id ?? null;
}

/**
 * Link a Twitch identity to an account. One Twitch per account (account_id PK)
 * and one account per Twitch user (twitch_user_id UNIQUE). Returns false when
 * the Twitch id is already owned by a DIFFERENT account so the caller can 409.
 */
export async function linkTwitchToAccount(
  pool: Pool,
  accountId: number,
  info: {
    twitchUserId: string;
    login: string | null;
    displayName: string | null;
    avatar: string | null;
    email: string | null;
  },
): Promise<boolean> {
  const owner = await accountForTwitch(pool, info.twitchUserId);
  if (owner !== null && owner !== accountId) return false;
  try {
    await pool.query(
      `INSERT INTO twitch_links (account_id, twitch_user_id, twitch_login, twitch_display_name, twitch_avatar, twitch_email)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE SET
         twitch_user_id = EXCLUDED.twitch_user_id,
         twitch_login = EXCLUDED.twitch_login,
         twitch_display_name = EXCLUDED.twitch_display_name,
         twitch_avatar = EXCLUDED.twitch_avatar,
         twitch_email = COALESCE(EXCLUDED.twitch_email, twitch_links.twitch_email),
         linked_at = now()`,
      [accountId, info.twitchUserId, info.login, info.displayName, info.avatar, info.email],
    );
  } catch (err) {
    // TOCTOU: another account claimed this twitch_user_id between the check and
    // the upsert. twitch_user_id is UNIQUE (not the ON CONFLICT target), so the
    // race surfaces as 23505 -> treat as "already owned" (409), not a 500.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
  return true;
}

export async function unlinkTwitch(pool: Pool, accountId: number): Promise<void> {
  await pool.query('DELETE FROM twitch_links WHERE account_id = $1', [accountId]);
}

// Refresh the captured email on an existing link (a returning user may grant the
// email scope for the first time). No-op when the grant carried no email, so it
// never wipes a previously captured address.
export async function setTwitchLinkEmail(
  pool: Pool,
  accountId: number,
  email: string | null,
): Promise<void> {
  if (!email) return;
  await pool.query('UPDATE twitch_links SET twitch_email = $2 WHERE account_id = $1', [
    accountId,
    email,
  ]);
}

// ── OAuth state (mirrors discord_oauth_states) ─────────────────────────────────

export interface TwitchOAuthStateRow {
  state: string;
  mode: string;
  account_id: number | null;
}

export async function createTwitchOAuthState(
  pool: Pool,
  params: {
    state: string;
    mode: string;
    accountId: number | null;
    ttlMinutes: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO twitch_oauth_states (state, mode, account_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [params.state, params.mode, params.accountId, String(params.ttlMinutes)],
  );
}

/** Atomically consume an unexpired state row (single use). Null if missing/expired. */
export async function consumeTwitchOAuthState(
  pool: Pool,
  state: string,
): Promise<TwitchOAuthStateRow | null> {
  const res = await pool.query(
    `DELETE FROM twitch_oauth_states
      WHERE state = $1 AND expires_at > now()
      RETURNING state, mode, account_id`,
    [state],
  );
  return res.rows[0] ?? null;
}

export async function pruneTwitchOAuthStates(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM twitch_oauth_states WHERE expires_at <= now()');
}

// ── Pending first-time logins (verified Twitch identity, choice not yet made) ──

export interface TwitchPendingLoginRow {
  token: string;
  twitch_user_id: string;
  twitch_login: string | null;
  twitch_display_name: string | null;
  twitch_avatar: string | null;
  twitch_email: string | null;
  twitch_email_verified: boolean;
}

export async function createTwitchPendingLogin(
  pool: Pool,
  params: {
    token: string;
    twitchUserId: string;
    login: string | null;
    displayName: string | null;
    avatar: string | null;
    email: string | null;
    emailVerified: boolean;
    ttlMinutes: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO twitch_pending_logins
       (token, twitch_user_id, twitch_login, twitch_display_name, twitch_avatar, twitch_email, twitch_email_verified, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' minutes')::interval)`,
    [
      params.token,
      params.twitchUserId,
      params.login,
      params.displayName,
      params.avatar,
      params.email,
      params.emailVerified,
      String(params.ttlMinutes),
    ],
  );
}

/**
 * Read an unexpired pending-login row WITHOUT consuming it. The link-existing flow
 * peeks first so a wrong password (or a 2FA challenge) leaves the token reusable
 * for the retry; only the final commit calls consumeTwitchPendingLogin.
 */
export async function peekTwitchPendingLogin(
  pool: Pool,
  token: string,
): Promise<TwitchPendingLoginRow | null> {
  const res = await pool.query(
    `SELECT token, twitch_user_id, twitch_login, twitch_display_name, twitch_avatar, twitch_email, twitch_email_verified
       FROM twitch_pending_logins WHERE token = $1 AND expires_at > now()`,
    [token],
  );
  return res.rows[0] ?? null;
}

/** Atomically consume an unexpired pending-login row (single use). Null if gone/expired. */
export async function consumeTwitchPendingLogin(
  pool: Pool,
  token: string,
): Promise<TwitchPendingLoginRow | null> {
  const res = await pool.query(
    `DELETE FROM twitch_pending_logins
      WHERE token = $1 AND expires_at > now()
      RETURNING token, twitch_user_id, twitch_login, twitch_display_name, twitch_avatar, twitch_email, twitch_email_verified`,
    [token],
  );
  return res.rows[0] ?? null;
}

export async function pruneTwitchPendingLogins(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM twitch_pending_logins WHERE expires_at <= now()');
}
