// Fork (Livezul): server side of the guided spectator camera. An OBS browser
// source is headless (no way to type a login), so the spectator page must
// self-provision. These two endpoints, gated by a shared secret in the query
// (?key=, the same pattern the StreamDeck plugins use), hand the page a session
// for the pre-configured camera account and the online-player roster — so the
// browser never needs an admin token or an interactive login.
//
//   GET /api/spectator/session?key=  -> { token, username } for the camera acct
//   GET /api/spectator/roster?key=   -> { players: [{name,class,level,zone}] }
//
// Off unless BOTH SPECTATOR_KEY and SPECTATOR_ACCOUNT are set.
import { newToken } from './auth';
import { findAccount, saveToken } from './db';
import type { Ctx, RouteDef } from './http/types';
import { json } from './http_util';

export interface SpectatorOnlineRow {
  name: string;
  class: string;
  level: number;
  zone: string | null;
}

export interface SpectatorHooks {
  /** Live online players (server-side; excludes staff camera sessions). */
  onlinePlayers: () => SpectatorOnlineRow[];
}

let runtime: SpectatorHooks | null = null;
export function configureSpectatorRuntime(hooks: SpectatorHooks): void {
  runtime = hooks;
}

function secret(): string {
  return process.env.SPECTATOR_KEY ?? '';
}
function cameraAccount(): string {
  return process.env.SPECTATOR_ACCOUNT ?? '';
}
export function spectatorEnabled(): boolean {
  return secret() !== '' && cameraAccount() !== '';
}
function authorized(ctx: Ctx): boolean {
  return spectatorEnabled() && ctx.url.searchParams.get('key') === secret();
}

// GET /api/spectator/roster?key= — online player names for the rotation.
async function rosterHandler(ctx: Ctx): Promise<void> {
  if (!authorized(ctx)) return json(ctx.res, 403, { error: 'forbidden' });
  return json(ctx.res, 200, { players: runtime?.onlinePlayers() ?? [] });
}

// GET /api/spectator/session?key= — mint a fresh session for the camera account
// so the headless page can auth the WS without a login. Long TTL so an overnight
// stream never expires mid-run; labelled 'spectator' for auditing.
async function sessionHandler(ctx: Ctx): Promise<void> {
  if (!authorized(ctx)) return json(ctx.res, 403, { error: 'forbidden' });
  const account = await findAccount(cameraAccount());
  if (!account) return json(ctx.res, 404, { error: 'camera account not found' });
  const token = newToken();
  await saveToken(token, account.id, 24 * 30, 'full', 'spectator');
  return json(ctx.res, 200, { token, username: account.username });
}

export const routes: RouteDef[] = [
  { method: 'GET', path: '/api/spectator/roster', surface: 'api', handler: rosterHandler },
  { method: 'GET', path: '/api/spectator/session', surface: 'api', handler: sessionHandler },
];
