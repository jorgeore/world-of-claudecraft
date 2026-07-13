// Twitch integration HTTP shell (DB + network IO). Mirrors server/discord.ts
// (the pure URL/parse helpers live in server/twitch_oauth.ts and all SQL in
// server/twitch_db.ts) minus Discord's guild/reward/native machinery: this is
// identity-only login/register/link for the fork's Twitch-first community.
//
//   POST   /api/auth/twitch/start       OAuth start (JSON { url })
//   GET    /api/auth/twitch/callback    OAuth callback (HTML bounce; NON-JSON)
//   POST   /api/auth/twitch/login/new   first-login "create new" chooser (JSON)
//   POST   /api/auth/twitch/login/link  first-login "link existing" chooser (JSON)
//   GET    /api/twitch                  link status (JSON)
//   DELETE /api/twitch                  unlink (JSON)

import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { verifyLoginTwoFactor } from './account';
import { hashPassword, newToken, offensiveName, validPassword, verifyPassword } from './auth';
import {
  type AccountRow,
  accountAndScopeForToken,
  accountById,
  backfillAccountEmailIfEmpty,
  createAccount,
  findAccount,
  moderationStatusForAccount,
  pool,
  saveToken,
  scopeAllowsMutation,
  touchLogin,
  updatePasswordHash,
} from './db';
import { ctxAccountId } from './http/context';
import { logger } from './http/logger';
import {
  type BearerActiveGuardDb,
  bearerToken,
  createActiveGuard,
  NOT_AUTHENTICATED,
  READ_ONLY_TOKEN,
} from './http/middleware/bearer_active_guard';
import type { Ctx, Middleware, Next, RouteDef } from './http/types';
import { isUniqueViolation, json, moderationErrorBody } from './http_util';
import {
  authThrottled,
  clearAuthFailures,
  recordAuthFailure,
  requestIp,
  twitchRateLimited,
} from './ratelimit';
import { publicOriginFromRequest } from './realm';
import {
  accountForTwitch,
  consumeTwitchOAuthState,
  consumeTwitchPendingLogin,
  createTwitchOAuthState,
  createTwitchPendingLogin,
  linkTwitchToAccount,
  peekTwitchPendingLogin,
  setTwitchLinkEmail,
  twitchForAccount,
  unlinkTwitch,
} from './twitch_db';
import {
  buildAuthorizeUrl,
  buildTokenRequestBody,
  TWITCH_API_BASE,
  TWITCH_TOKEN_URL,
  type TwitchLinkMode,
  type TwitchUser,
  isTwitchLinkMode,
  parseTokenResponse,
  parseTwitchUser,
  twitchDisplayName,
} from './twitch_oauth';

const STATE_TTL_MINUTES = 10;
// Same TTL rationale as Discord: a human decision (create vs link, maybe typing
// a password + 2FA) sits between the callback and the chooser endpoints.
const PENDING_LOGIN_TTL_MINUTES = 15;

export interface TwitchConfig {
  clientId: string;
  clientSecret: string;
}

/** Resolve Twitch OAuth config from env, or null when not configured (feature off). */
export function twitchConfig(): TwitchConfig | null {
  const clientId = process.env.TWITCH_CLIENT_ID ?? '';
  const clientSecret = process.env.TWITCH_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Whether the feature is configured (read by /api/status for the client gate). */
export function twitchEnabled(): boolean {
  return twitchConfig() !== null;
}

function redirectUriFor(req: http.IncomingMessage): string {
  return `${publicOriginFromRequest(req)}/api/auth/twitch/callback`;
}

// ── OAuth start: returns the id.twitch.tv authorize URL ────────────────────────
// POST /api/auth/twitch/start?mode=login|link
export async function handleTwitchStart(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { mode: TwitchLinkMode; accountId: number | null },
): Promise<void> {
  const cfg = twitchConfig();
  if (!cfg)
    return json(res, 503, {
      error: 'Twitch integration is not configured',
      code: 'twitch.not_configured',
    });
  if (!twitchRateLimited(req, opts.accountId ?? 0).allowed) {
    return json(res, 429, { error: 'rate limited' });
  }
  const state = newToken();
  await createTwitchOAuthState(pool, {
    state,
    mode: opts.mode,
    accountId: opts.accountId,
    ttlMinutes: STATE_TTL_MINUTES,
  });
  const url = buildAuthorizeUrl({
    clientId: cfg.clientId,
    redirectUri: redirectUriFor(req),
    state,
  });
  return json(res, 200, { url });
}

// ── OAuth callback (top-level browser redirect from id.twitch.tv) ──────────────
// GET /api/auth/twitch/callback?code=&state=
// No Authorization header and no browser Origin (it is a twitch.tv redirect), so
// this route is exempt from the web-login Origin guard — the single-use state row
// is the credential, exactly like the Discord callback.
export async function handleTwitchCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  isIpBlocked: (ip: string) => boolean = () => false,
): Promise<void> {
  const u = new URL(req.url ?? '/', 'http://localhost');
  const state = u.searchParams.get('state') ?? '';
  if (!state && isIpBlocked(requestIp(req))) {
    return bouncePage(res, 403, { ok: false, mode: 'login', error: 'server_error' });
  }
  const cfg = twitchConfig();
  if (!cfg) return bouncePage(res, 503, { ok: false, mode: 'login', error: 'not_configured' });
  const code = u.searchParams.get('code') ?? '';
  if (u.searchParams.get('error') && !state) {
    return bouncePage(res, 200, { ok: false, mode: 'login', error: 'cancelled' });
  }
  if (!state) return bouncePage(res, 400, { ok: false, mode: 'login', error: 'bad_request' });

  const stateRow = await consumeTwitchOAuthState(pool, state);
  if (!stateRow) {
    return bouncePage(res, 400, { ok: false, mode: 'login', error: 'expired' });
  }
  const mode: TwitchLinkMode = isTwitchLinkMode(stateRow.mode) ? stateRow.mode : 'login';
  const respond = (status: number, payload: BouncePayload): void =>
    bouncePage(res, status, payload);

  if (isIpBlocked(requestIp(req))) {
    return respond(403, { ok: false, mode, error: 'server_error' });
  }
  if (u.searchParams.get('error')) {
    // User clicked "Cancel"/"Decline" on Twitch's consent screen.
    return respond(200, { ok: false, mode, error: 'cancelled' });
  }
  if (!code) return respond(400, { ok: false, mode, error: 'bad_request' });

  const user = await exchangeCodeForIdentity(code, redirectUriFor(req), cfg);
  if (!user) {
    return respond(502, { ok: false, mode, error: 'twitch_error' });
  }

  try {
    if (mode === 'link') {
      return await completeLink(respond, stateRow.account_id, user, mode);
    }
    return await completeLogin(req, respond, user);
  } catch (err) {
    logger.error({ err }, 'twitch callback error');
    return respond(500, { ok: false, mode, error: 'server_error' });
  }
}

// Seed the account's recovery email from a Twitch grant, but only when the
// account has none yet (never clobbering an owner-set address). Twitch only
// returns verified addresses, so a captured email is stamped verified.
async function captureTwitchEmail(
  accountId: number,
  email: string | null,
  verified: boolean,
): Promise<void> {
  if (email) await backfillAccountEmailIfEmpty(accountId, email, verified);
}

// Link an authenticated session's account to the Twitch identity.
async function completeLink(
  respond: (status: number, payload: BouncePayload) => void,
  accountId: number | null,
  user: TwitchUser,
  mode: TwitchLinkMode,
): Promise<void> {
  if (accountId === null) return respond(400, { ok: false, mode, error: 'no_session' });
  const linked = await linkTwitchToAccount(pool, accountId, {
    twitchUserId: user.id,
    login: user.login,
    displayName: twitchDisplayName(user),
    avatar: user.avatarUrl,
    email: user.email,
  });
  if (!linked) {
    return respond(409, { ok: false, mode, error: 'already_linked' });
  }
  await captureTwitchEmail(accountId, user.email, user.emailVerified);
  return respond(200, { ok: true, mode, username: twitchDisplayName(user) });
}

// Log in the account that owns this Twitch identity, OR (first time) hand the
// browser a one-time link token so the player can CHOOSE to create a new account
// or link an existing one. We never auto-link by email/username (account-takeover
// vector), mirroring the Discord flow.
async function completeLogin(
  req: http.IncomingMessage,
  respond: (status: number, payload: BouncePayload) => void,
  user: TwitchUser,
): Promise<void> {
  const meta = requestMeta(req);
  const accountId = await accountForTwitch(pool, user.id);
  if (accountId === null) {
    const linkToken = newToken();
    await createTwitchPendingLogin(pool, {
      token: linkToken,
      twitchUserId: user.id,
      login: user.login,
      displayName: twitchDisplayName(user),
      avatar: user.avatarUrl,
      email: user.email,
      emailVerified: user.emailVerified,
      ttlMinutes: PENDING_LOGIN_TTL_MINUTES,
    });
    return respond(200, {
      ok: true,
      mode: 'login',
      choose: true,
      linkToken,
      username: twitchDisplayName(user),
    });
  }
  // Returning Twitch user: refresh the captured email, then mint a session.
  const acct = await accountById(accountId);
  await setTwitchLinkEmail(pool, accountId, user.email);
  await captureTwitchEmail(accountId, user.email, user.emailVerified);
  const status = await moderationStatusForAccount(accountId);
  if (status.locked) return respond(403, { ok: false, mode: 'login', error: 'locked' });
  const token = await issueTwitchSession(accountId, meta);
  return respond(200, {
    ok: true,
    mode: 'login',
    token,
    username: acct?.username ?? 'player',
  });
}

// Touch last-login + mint a fresh full session token labelled 'twitch'. Same
// 7-day bearer as password login (saveToken default TTL).
async function issueTwitchSession(
  accountId: number,
  meta: { ip: string; userAgent: string },
): Promise<string> {
  await touchLogin(accountId, meta);
  const token = newToken();
  await saveToken(token, accountId, undefined, 'full', 'twitch');
  return token;
}

function requestMeta(req: http.IncomingMessage): { ip: string; userAgent: string } {
  return { ip: requestIp(req), userAgent: String(req.headers['user-agent'] ?? '') };
}

// ── POST /api/auth/twitch/login/new { linkToken } ──────────────────────────────
export async function handleTwitchLoginNew(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  isIpBlocked: (ip: string) => boolean,
): Promise<void> {
  if (!twitchRateLimited(req, 0).allowed) return json(res, 429, { error: 'rate limited' });
  // A blocked IP must not mint a fresh account + session through Twitch, exactly
  // as /api/register refuses one. Opaque 429, mirroring the Discord path.
  if (isIpBlocked(requestIp(req))) return json(res, 429, { error: 'rate limited' });
  const body = await readJsonBody(req);
  const linkToken = typeof body.linkToken === 'string' ? body.linkToken : '';
  const pending = await consumeTwitchPendingLogin(pool, linkToken);
  if (!pending) return json(res, 400, { error: 'expired', code: 'twitch.expired' });
  const meta = requestMeta(req);
  const user: TwitchUser = {
    id: pending.twitch_user_id,
    login: pending.twitch_login ?? '',
    displayName: pending.twitch_display_name ?? '',
    avatarUrl: pending.twitch_avatar,
    email: pending.twitch_email,
    emailVerified: pending.twitch_email_verified,
  };
  try {
    // Defensive: if this Twitch id is already linked (double-submit / two-tab
    // race), log into the OWNING account instead of provisioning a duplicate.
    let accountId = await accountForTwitch(pool, user.id);
    let username: string;
    if (accountId === null) {
      const account = await provisionTwitchAccount(user, meta);
      const linked = await linkTwitchToAccount(pool, account.id, {
        twitchUserId: user.id,
        login: user.login,
        displayName: twitchDisplayName(user),
        avatar: user.avatarUrl,
        email: user.email,
      });
      if (!linked) {
        const ownerId = await accountForTwitch(pool, user.id);
        if (ownerId === null)
          return json(res, 409, { error: 'already_linked', code: 'twitch.already_linked' });
        accountId = ownerId;
        username = (await accountById(ownerId))?.username ?? 'player';
      } else {
        accountId = account.id;
        username = account.username;
      }
    } else {
      username = (await accountById(accountId))?.username ?? 'player';
      await setTwitchLinkEmail(pool, accountId, user.email);
    }
    await captureTwitchEmail(accountId, user.email, user.emailVerified);
    const status = await moderationStatusForAccount(accountId);
    if (status.locked) return json(res, 403, moderationErrorBody(status));
    const token = await issueTwitchSession(accountId, meta);
    return json(res, 200, { token, username });
  } catch (err) {
    logger.error({ err }, 'twitch login/new error');
    return json(res, 500, { error: 'server_error' });
  }
}

// ── POST /api/auth/twitch/login/link { linkToken, username, password, code? } ──
// Verify the account's password (and 2FA / moderation, exactly like /api/login),
// then attach the parked Twitch identity and mint a session. The pending token is
// only consumed on the final commit (wrong password / 2FA challenge = reusable).
export async function handleTwitchLoginLink(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  isIpBlocked: (ip: string) => boolean,
): Promise<void> {
  if (!twitchRateLimited(req, 0).allowed) return json(res, 429, { error: 'rate limited' });
  if (isIpBlocked(requestIp(req))) return json(res, 429, { error: 'rate limited' });
  const body = await readJsonBody(req);
  const linkToken = typeof body.linkToken === 'string' ? body.linkToken : '';
  const pending = await peekTwitchPendingLogin(pool, linkToken);
  if (!pending) return json(res, 400, { error: 'expired', code: 'twitch.expired' });
  const username = typeof body.username === 'string' ? body.username : '';
  if (username && !authThrottled(username).allowed) {
    return json(res, 429, {
      error: 'too many failed attempts, wait a few minutes and try again',
      code: 'auth.too_many_failed_attempts',
    });
  }
  const account = username ? await findAccount(username) : null;
  const password = typeof body.password === 'string' ? body.password : '';
  if (!account || !(await verifyPassword(password, account.password_hash))) {
    if (username) recordAuthFailure(username);
    return json(res, 401, {
      error: 'invalid username or password',
      code: 'auth.invalid_credentials',
    });
  }
  const status = await moderationStatusForAccount(account.id);
  if (status.locked) return json(res, 403, moderationErrorBody(status));
  if (account.totp_enabled_at) {
    const code = typeof body.code === 'string' ? body.code : '';
    const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode : '';
    if (!code && !recoveryCode) return json(res, 200, { twoFactorRequired: true });
    if (!(await verifyLoginTwoFactor(account, code, recoveryCode))) {
      recordAuthFailure(username);
      return json(res, 401, {
        error: 'that code is not valid, try again',
        code: 'two_factor.code_invalid',
      });
    }
  }
  clearAuthFailures(username);
  const consumed = await consumeTwitchPendingLogin(pool, linkToken);
  if (!consumed) return json(res, 400, { error: 'expired', code: 'twitch.expired' });
  const linked = await linkTwitchToAccount(pool, account.id, {
    twitchUserId: consumed.twitch_user_id,
    login: consumed.twitch_login,
    displayName: consumed.twitch_display_name,
    avatar: consumed.twitch_avatar,
    email: consumed.twitch_email,
  });
  if (!linked) return json(res, 409, { error: 'already_linked', code: 'twitch.already_linked' });
  await captureTwitchEmail(account.id, consumed.twitch_email, consumed.twitch_email_verified);
  const token = await issueTwitchSession(account.id, requestMeta(req));
  return json(res, 200, { token, username: account.username });
}

// Exchange the auth code for a token, then fetch the user identity. Returns null
// on any network/parse failure (handled as twitch_error). NOTE: unlike Discord,
// Helix requires the Client-Id header ALONGSIDE the bearer token.
async function exchangeCodeForIdentity(
  code: string,
  redirectUri: string,
  cfg: TwitchConfig,
): Promise<TwitchUser | null> {
  const tokenJson = await postForm(
    TWITCH_TOKEN_URL,
    buildTokenRequestBody({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
      redirectUri,
    }),
  );
  const token = parseTokenResponse(tokenJson);
  if (!token) return null;
  const userJson = await fetchJsonWithTimeout(`${TWITCH_API_BASE}/users`, {
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Client-Id': cfg.clientId,
    },
  });
  return parseTwitchUser(userJson);
}

async function postForm(url: string, body: string): Promise<unknown> {
  return fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 8000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeBaseUsername(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, '');
  if (s.length > 18) s = s.slice(0, 18);
  if (s.length < 3 || offensiveName(s)) s = `ttv${randomBytes(3).toString('hex')}`;
  return s;
}

async function provisionTwitchAccount(
  user: TwitchUser,
  meta: { ip: string; userAgent: string },
): Promise<AccountRow> {
  // Prefer the login (twitch.tv/<login>) over the display name: it is already
  // ASCII [a-z0-9_], so the in-game name matches what the chat knows them by.
  const base = sanitizeBaseUsername(user.login || twitchDisplayName(user));
  for (let i = 0; i < 8; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 18)}${randomBytes(2).toString('hex')}`;
    if (candidate.length < 3 || candidate.length > 24 || offensiveName(candidate)) continue;
    if (await findAccount(candidate)) continue;
    try {
      // Random unguessable password so the row satisfies NOT NULL password_hash
      // while staying password-unusable. passwordSet:false = reachable only
      // through Twitch until the owner sets a real password.
      return await createAccount(candidate, await hashPassword(newToken()), meta, {
        passwordSet: false,
      });
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
  const fallback = `ttv${randomBytes(8).toString('hex').slice(0, 18)}`;
  return createAccount(fallback, await hashPassword(newToken()), meta, { passwordSet: false });
}

// ── GET /api/twitch (link status) ──────────────────────────────────────────────
export async function handleTwitchStatus(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  accountId: number,
): Promise<void> {
  const [link, acct] = await Promise.all([
    twitchForAccount(pool, accountId),
    accountById(accountId),
  ]);
  return json(res, 200, {
    enabled: twitchConfig() !== null,
    linked: link !== null,
    // Whether the account has a real (owner-chosen) password; a Twitch-only
    // account must set one before unlinking (mirrors the Discord contract).
    passwordSet: acct?.password_set ?? true,
    username: link?.twitch_display_name ?? link?.twitch_login ?? null,
    login: link?.twitch_login ?? null,
    avatar: link?.twitch_avatar ?? null,
  });
}

// ── DELETE /api/twitch (unlink) ────────────────────────────────────────────────
// A Twitch-provisioned account (password_set = false) is reachable ONLY through
// Twitch; unlinking requires setting a password first (same recipe as Discord).
export async function handleTwitchUnlink(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  accountId: number,
): Promise<void> {
  const acct = await accountById(accountId);
  if (!acct) return json(res, 404, { error: 'account not found', code: 'account.not_found' });
  if (!acct.password_set) {
    const body = await readJsonBody(req);
    const next = typeof body.password === 'string' ? body.password : '';
    if (!validPassword(next)) {
      return json(res, 400, { error: 'password_required', code: 'twitch.password_required' });
    }
    await updatePasswordHash(accountId, await hashPassword(next));
  }
  await unlinkTwitch(pool, accountId);
  return json(res, 200, { unlinked: true });
}

// ── small local helpers ────────────────────────────────────────────────────────

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) return {};
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface BouncePayload {
  ok: boolean;
  mode: TwitchLinkMode;
  token?: string;
  username?: string;
  error?: string;
  // First-time login: no session yet. The verified identity is parked server-side
  // under `linkToken`; the SPA shows the create-new / link-existing chooser.
  choose?: boolean;
  linkToken?: string;
}

// Render the callback result as an HTML page that messages the SPA. Login mode is
// a top-level redirect (store the session + go to the app); link mode posts to a
// popup opener with source 'woc-twitch'. Same XSS escapes as the Discord bounce.
function bouncePage(res: http.ServerResponse, status: number, payload: BouncePayload): void {
  const data = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>World of ClaudeCraft</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{background:#14100a;color:#fff6df;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}main{text-align:center;padding:24px}</style>
</head><body><main><p id="m">Connecting Twitch...</p></main><script>
(function(){
  var p = ${data};
  try {
    if (p.ok && p.mode === 'login' && p.token) {
      localStorage.setItem('woc_session', JSON.stringify({ token: p.token, username: p.username }));
    } else if (p.ok && p.mode === 'login' && p.choose && p.linkToken) {
      localStorage.setItem('woc_twitch_choice', JSON.stringify({ linkToken: p.linkToken, username: p.username || '', ts: Date.now() }));
    }
  } catch (e) {}
  var msg = { source: 'woc-twitch', ok: p.ok, mode: p.mode, error: p.error || null };
  if (window.opener) {
    try { window.opener.postMessage(msg, location.origin); } catch (e) {}
    setTimeout(function(){ try { window.close(); } catch (e) {} location.replace('/'); }, 200);
  } else {
    location.replace('/');
  }
})();
</script></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ── Route layer (mirrors the Discord RouteDef port; see that header comment) ───

/** The main.ts game-session hooks the Twitch routes need (boot-injected). */
export interface TwitchGameHooks {
  isIpBlocked(ip: string): boolean;
}

let runtime: TwitchGameHooks | null = null;

/** Inject the main.ts game-session hooks the Twitch routes need (boot). */
export function configureTwitchRuntime(rt: TwitchGameHooks): void {
  runtime = rt;
}

/** Clear the injected runtime so a unit test can install its own fake. */
export function resetTwitchRuntimeForTests(): void {
  runtime = null;
}

function useRuntime(): TwitchGameHooks {
  if (runtime === null) {
    throw new Error('twitch runtime is not configured; call configureTwitchRuntime');
  }
  return runtime;
}

const REAL_TWITCH_DB = { accountAndScopeForToken, moderationStatusForAccount };
let twitchDb: BearerActiveGuardDb = REAL_TWITCH_DB;

/** Override the Twitch guard db with a fake (test-only). */
export function setTwitchDbForTests(overrides: Partial<typeof REAL_TWITCH_DB>): void {
  twitchDb = { ...REAL_TWITCH_DB, ...overrides };
}

/** Restore the real Twitch guard db (test-only). */
export function resetTwitchDbForTests(): void {
  twitchDb = REAL_TWITCH_DB;
}

/** Mutating + account-scoped gate for status/unlink (mirrors bearerActiveAccount). */
const activeGuard = createActiveGuard(() => twitchDb);

/** Resolve the caller's active account inline for start's LINK mode. */
async function resolveActiveAccount(ctx: Ctx): Promise<number | null> {
  const token = bearerToken(ctx.req);
  const info = token === null ? null : await twitchDb.accountAndScopeForToken(token);
  if (info === null) {
    json(ctx.res, 401, NOT_AUTHENTICATED);
    return null;
  }
  if (!scopeAllowsMutation(info.scope)) {
    json(ctx.res, 403, READ_ONLY_TOKEN);
    return null;
  }
  const status = await twitchDb.moderationStatusForAccount(info.accountId);
  if (status.locked) {
    json(ctx.res, 403, moderationErrorBody(status));
    return null;
  }
  return info.accountId;
}

const twitchActiveRateGuard: Middleware = async (ctx: Ctx, next: Next) => {
  if (!twitchRateLimited(ctx.req, ctxAccountId(ctx)).allowed) {
    json(ctx.res, 429, { error: 'rate limited' });
    return;
  }
  await next();
};

/** POST /api/auth/twitch/start: OAuth start (link mode resolves the caller first). */
async function twitchStartHandler(ctx: Ctx): Promise<void> {
  const mode: TwitchLinkMode = ctx.url.searchParams.get('mode') === 'link' ? 'link' : 'login';
  let accountId: number | null = null;
  if (mode === 'link') {
    accountId = await resolveActiveAccount(ctx);
    if (accountId === null) return;
  }
  // A blocked IP must not open the OAuth flow (login mode can provision an
  // account via the callback). Opaque 429, matching the Discord port.
  if (useRuntime().isIpBlocked(ctx.ip)) return json(ctx.res, 429, { error: 'rate limited' });
  return handleTwitchStart(ctx.req, ctx.res, { mode, accountId });
}

/** GET /api/auth/twitch/callback: OAuth callback (HTML bounce; never problem+json). */
async function twitchCallbackHandler(ctx: Ctx): Promise<void> {
  return handleTwitchCallback(ctx.req, ctx.res, useRuntime().isIpBlocked);
}

/** POST /api/auth/twitch/login/new: first-login "create new account" chooser. */
async function twitchLoginNewHandler(ctx: Ctx): Promise<void> {
  return handleTwitchLoginNew(ctx.req, ctx.res, useRuntime().isIpBlocked);
}

/** POST /api/auth/twitch/login/link: first-login "link existing account" chooser. */
async function twitchLoginLinkHandler(ctx: Ctx): Promise<void> {
  return handleTwitchLoginLink(ctx.req, ctx.res, useRuntime().isIpBlocked);
}

/** GET /api/twitch: link status. */
async function twitchStatusHandler(ctx: Ctx): Promise<void> {
  return handleTwitchStatus(ctx.req, ctx.res, ctxAccountId(ctx));
}

/** DELETE /api/twitch: unlink (account-scoped; sets a password first if needed). */
async function twitchUnlinkHandler(ctx: Ctx): Promise<void> {
  return handleTwitchUnlink(ctx.req, ctx.res, ctxAccountId(ctx));
}

export const routes: RouteDef[] = [
  {
    method: 'POST',
    path: '/api/auth/twitch/start',
    surface: 'api',
    handler: twitchStartHandler,
  },
  {
    method: 'GET',
    path: '/api/auth/twitch/callback',
    surface: 'api',
    // HTML bounce page, never problem+json (same contract as the Discord callback).
    meta: { envelope: 'html' },
    handler: twitchCallbackHandler,
  },
  {
    method: 'POST',
    path: '/api/auth/twitch/login/new',
    surface: 'api',
    handler: twitchLoginNewHandler,
  },
  {
    method: 'POST',
    path: '/api/auth/twitch/login/link',
    surface: 'api',
    handler: twitchLoginLinkHandler,
  },
  {
    method: 'GET',
    path: '/api/twitch',
    surface: 'api',
    middleware: [activeGuard, twitchActiveRateGuard],
    handler: twitchStatusHandler,
  },
  {
    method: 'DELETE',
    path: '/api/twitch',
    surface: 'api',
    middleware: [activeGuard, twitchActiveRateGuard],
    handler: twitchUnlinkHandler,
  },
];
