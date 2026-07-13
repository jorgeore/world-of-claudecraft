// Pure (IO-free) helpers for the OUTBOUND Twitch OAuth2 flow: where the game
// server is the CLIENT to id.twitch.tv. Mirrors server/discord_oauth.ts (the
// same pure/IO split), minus Discord's guild machinery which has no Twitch
// analog. Twitch's authorization-code grant does not document PKCE for
// confidential clients, so the CSRF/replay guard is the single-use `state` row
// plus the client_secret held server-side; no code_challenge is sent.

export const TWITCH_AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
export const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
export const TWITCH_API_BASE = 'https://api.twitch.tv/helix';

// `user:read:email` adds the verified account email to GET /helix/users, which
// we capture as a recovery address exactly like the Discord email scope. Twitch
// only ever returns a VERIFIED address on that field.
export const DEFAULT_TWITCH_SCOPES = ['user:read:email'] as const;

/** Twitch user ids are numeric strings (not snowflakes). */
export function isTwitchUserId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
}

/** Build the id.twitch.tv authorize URL the browser is redirected to. */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  forceVerify?: boolean;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: (opts.scopes ?? DEFAULT_TWITCH_SCOPES).join(' '),
    state: opts.state,
  });
  // force_verify=true would re-prompt consent every time; default (false) lets a
  // returning viewer bounce straight through, which is the one-click login we want.
  if (opts.forceVerify) params.set('force_verify', 'true');
  return `${TWITCH_AUTHORIZE_URL}?${params.toString()}`;
}

/** Form body for the authorization-code -> token exchange (server POSTs this). */
export function buildTokenRequestBody(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): string {
  return new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
  }).toString();
}

export interface TwitchTokenResult {
  accessToken: string;
  tokenType: string;
  scope: string;
  expiresIn: number;
}

/**
 * Validate a Twitch token-endpoint response. Returns null on any bad shape.
 * Twitch returns `scope` as an ARRAY of strings (unlike Discord's space-joined
 * string); normalize to space-joined so callers share one shape.
 */
export function parseTokenResponse(value: unknown): TwitchTokenResult | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const accessToken = typeof v.access_token === 'string' ? v.access_token : '';
  if (!accessToken) return null;
  const scope = Array.isArray(v.scope)
    ? v.scope.filter((s): s is string => typeof s === 'string').join(' ')
    : typeof v.scope === 'string'
      ? v.scope
      : '';
  return {
    accessToken,
    tokenType: typeof v.token_type === 'string' ? v.token_type : 'bearer',
    scope,
    expiresIn: typeof v.expires_in === 'number' ? v.expires_in : 0,
  };
}

export interface TwitchUser {
  id: string;
  /** The lowercase login name (twitch.tv/<login>). */
  login: string;
  /** The capitalized/localized display name. */
  displayName: string;
  avatarUrl: string | null;
  // Present only when the `user:read:email` scope was granted. Twitch documents
  // the field as the user's VERIFIED email, so presence implies verified.
  email: string | null;
  emailVerified: boolean;
}

/**
 * Validate a GET /helix/users response ({ data: [user] }). Returns null when
 * the shape is wrong or the id is not a Twitch numeric id.
 */
export function parseTwitchUser(value: unknown): TwitchUser | null {
  if (!value || typeof value !== 'object') return null;
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const v = data[0] as Record<string, unknown>;
  if (!v || typeof v !== 'object' || !isTwitchUserId(v.id)) return null;
  // Same shape + RFC 5321 length gate as the Discord parser (mirrored comment
  // there): only a well-formed, bounded address is captured.
  const rawEmail = typeof v.email === 'string' ? v.email.trim() : '';
  const email =
    rawEmail && rawEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)
      ? rawEmail
      : null;
  return {
    id: v.id,
    login: typeof v.login === 'string' ? v.login : '',
    displayName: typeof v.display_name === 'string' ? v.display_name : '',
    avatarUrl: typeof v.profile_image_url === 'string' ? v.profile_image_url : null,
    email,
    emailVerified: email !== null,
  };
}

/** Preferred display name: the display name, else the login, else a fallback. */
export function twitchDisplayName(user: Pick<TwitchUser, 'login' | 'displayName'>): string {
  return user.displayName.trim() || user.login || 'Twitch user';
}

// The two link modes carried through the OAuth `state` row. `login` may provision
// a new account; `link` attaches Twitch to the already-authenticated account.
export type TwitchLinkMode = 'login' | 'link';

export function isTwitchLinkMode(value: unknown): value is TwitchLinkMode {
  return value === 'login' || value === 'link';
}
