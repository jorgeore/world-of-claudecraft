// Fork (Livezul): public, read-only endpoints for the Twitch chat bridge. A
// Nightbot command hits one of these with $(urlfetch) and posts the PLAIN-TEXT
// body verbatim in chat — so a viewer types !perfil and sees their own
// character, or !online / !ranking for the realm pulse. No auth (all of this is
// public in-game info), light per-IP rate limit, and text/plain responses.
import type http from 'node:http';
import { REALM } from './realm';
import { pool } from './db';
import { formatMoney } from '../src/sim/format_money';
import type { Ctx, RouteDef } from './http/types';
import { requestIp } from './ratelimit';

const CLASS_PT: Record<string, string> = {
  warrior: 'Guerreiro',
  paladin: 'Paladino',
  hunter: 'Caçador',
  rogue: 'Ladino',
  priest: 'Sacerdote',
  mage: 'Mago',
  warlock: 'Bruxo',
  druid: 'Druida',
  shaman: 'Xamã',
};
const className = (c: string): string => CLASS_PT[c] ?? c;

// ── runtime hook (online count from the live game) ────────────────────────────
export interface PublicApiHooks {
  onlineCount: () => number;
}
let runtime: PublicApiHooks | null = null;
export function configurePublicApiRuntime(hooks: PublicApiHooks): void {
  runtime = hooks;
}

// ── tiny per-IP sliding-window limiter (public endpoints) ─────────────────────
const HITS = new Map<string, number[]>();
const MAX_PER_MIN = 40;
function rateLimited(req: http.IncomingMessage): boolean {
  const ip = requestIp(req);
  const now = Date.now();
  const win = (HITS.get(ip) ?? []).filter((t) => now - t < 60_000);
  win.push(now);
  HITS.set(ip, win);
  return win.length > MAX_PER_MIN;
}

function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

// ── GET /api/public/hero?login=<twitch_login> ─────────────────────────────────
async function heroHandler(ctx: Ctx): Promise<void> {
  if (rateLimited(ctx.req)) return text(ctx.res, 429, 'Calma aí, muitos pedidos. Tente em instantes.');
  const login = (ctx.url.searchParams.get('login') ?? '').trim().replace(/^@/, '');
  if (!login) return text(ctx.res, 200, 'Uso: !perfil (mostra seu personagem em Livezul).');
  const res = await pool.query(
    `SELECT c.name, c.class, c.level, c.state
       FROM twitch_links tl
       JOIN characters c ON c.account_id = tl.account_id
      WHERE lower(tl.twitch_login) = lower($1) AND c.realm = $2
      ORDER BY c.level DESC, ((c.state->>'lifetimeXp')::bigint) DESC NULLS LAST, c.id ASC
      LIMIT 1`,
    [login, REALM],
  );
  const row = res.rows[0];
  if (!row) {
    return text(
      ctx.res,
      200,
      `@${login} ainda não tem personagem em ${REALM}! Entre com a Twitch e comece a aventura em mmo.jorgelives.com 🌊`,
    );
  }
  const copper = Number(row.state?.copper ?? 0);
  const gold = formatMoney(copper) || '0c';
  return text(
    ctx.res,
    200,
    `🦸 ${row.name} — ${className(row.class)} nível ${row.level} · ${gold} · aventurando em ${REALM}! 🌊`,
  );
}

// ── GET /api/public/online ────────────────────────────────────────────────────
async function onlineHandler(ctx: Ctx): Promise<void> {
  if (rateLimited(ctx.req)) return text(ctx.res, 429, 'Calma aí, muitos pedidos.');
  const n = runtime?.onlineCount() ?? 0;
  const body =
    n === 0
      ? `O mundo de ${REALM} está tranquilo agora. Seja o primeiro: mmo.jorgelives.com 🌊`
      : `🌊 ${n} ${n === 1 ? 'aventureiro' : 'aventureiros'} online agora em ${REALM}! Entre você também: mmo.jorgelives.com`;
  return text(ctx.res, 200, body);
}

// ── GET /api/public/top ───────────────────────────────────────────────────────
async function topHandler(ctx: Ctx): Promise<void> {
  if (rateLimited(ctx.req)) return text(ctx.res, 429, 'Calma aí, muitos pedidos.');
  const res = await pool.query(
    `SELECT name, class, level
       FROM characters
      WHERE realm = $1
      ORDER BY level DESC, ((state->>'lifetimeXp')::bigint) DESC NULLS LAST, id ASC
      LIMIT 5`,
    [REALM],
  );
  if (res.rows.length === 0) return text(ctx.res, 200, `Ninguém no ranking de ${REALM} ainda. Seja o primeiro! 🌊`);
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  const line = res.rows
    .map((r, i) => `${medals[i]} ${r.name} (${className(r.class)} ${r.level})`)
    .join(' · ');
  return text(ctx.res, 200, `🏆 Top ${REALM}: ${line}`);
}

export const routes: RouteDef[] = [
  { method: 'GET', path: '/api/public/hero', surface: 'api', handler: heroHandler },
  { method: 'GET', path: '/api/public/online', surface: 'api', handler: onlineHandler },
  { method: 'GET', path: '/api/public/top', surface: 'api', handler: topHandler },
];
