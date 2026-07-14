// Fork rebrand — build-time replace over the BUILT output (dist/, dist-server/,
// dist-bot/). The upstream sources stay byte-identical (merge-friendly: upstream
// pushes daily); the fork's brand is applied after `npm run build*` inside the
// Docker image build (see the Dockerfile RUN hook).
//
// Ordering matters: URLs/domains first, then full names, then the short word.
// Deliberately NOT touched:
//  - lowercase "worldofclaudecraft" outside the .com domain (asset filenames like
//    worldofclaudecraft-logo.png, the desktop protocol, native appIds) — renaming
//    those would break file references;
//  - "woc"/"WoC" tokens (localStorage keys woc_session/woc_discord_choice,
//    postMessage sources, woc_*.webp filenames) — functional identifiers;
//  - "$WOC" (the wallet UI ships disabled via VITE_WALLET_DISABLED=1).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NAME = process.env.FORK_GAME_NAME || 'World of Jorgelives';
const SHORT = process.env.FORK_GAME_SHORT || 'Jorgelives';
const DOMAIN = process.env.FORK_DOMAIN || 'mmo.jorgelives.com';
const COMMUNITY = process.env.FORK_COMMUNITY_URL || 'https://www.twitch.tv/jorge';
const DONATE = process.env.FORK_DONATE_URL || 'https://jorgelives.com';
const GITHUB = process.env.FORK_GITHUB || 'github.com/jorgeore/world-of-claudecraft';
const REALM_WORD = process.env.FORK_REALM_WORD || 'Jorgelives';

// [from, to] — applied in order, plain string replace (all occurrences).
const RULES = [
  // Community-button labels in the fork's audience languages: the href already
  // points at the Twitch channel, so the visible label follows. (Discord LOGIN
  // is disabled at build time via VITE_DISCORD_DISABLED=1; these are the
  // always-visible footer/menu community links.)
  ['Join the Discord', 'Live on Twitch'],
  ['Entre no Discord', 'Live na Twitch'],
  ['Entrar no Discord', 'Live na Twitch'],
  ['Juntar-se ao Discord', 'Live na Twitch'],
  ['Únete al Discord', 'Live en Twitch'],
  // Community/external links first (before the domain rule rewrites their hosts).
  ['https://discord.gg/GjhnUsBtw', COMMUNITY],
  ['https://ko-fi.com/worldofclaudecraft', DONATE],
  ['ko-fi.com/worldofclaudecraft', DONATE.replace(/^https?:\/\//, '')],
  ['github.com/levy-street/world-of-claudecraft', GITHUB],
  // Social handles in JSON-LD sameAs entries.
  ['WoClaudeCraft', 'jorgelives'],
  ['WoClaudecraft', 'jorgelives'],
  // Public web domain (canonical/hreflang/OG/share URLs).
  ['worldofclaudecraft.com', DOMAIN],
  // The visible product name (both capitalizations that appear in the tree).
  ['World of ClaudeCraft', NAME],
  ['World of Claudecraft', NAME],
  ['World Of ClaudeCraft', NAME],
  // Default realm word (our deploy sets REALM_NAME to the same value).
  ['Claudemoon', REALM_WORD],
  // Short brand, capitalized variants only (lowercase belongs to filenames/ids).
  ['ClaudeCraft', SHORT],
  ['Claudecraft', SHORT],
];

// UI elements the fork hides outright (jorge 2026-07-14: no Donate, no GitHub
// link in the chrome — donations for the live run through their own flow). The
// data-i18n-aria attribute values are i18n KEYS, so they are locale-independent
// and stable across upstream UI copy changes. Covers header CTA, home community
// row, footer socials, and the mobile tray in one stroke.
// #token-ca is the upstream $WOC crypto-token contract-address card on the home
// screen — advertising THEIR token on the fork's page would mislead the chat.
const HIDE_SELECTORS =
  process.env.FORK_HIDE_SELECTORS ||
  '[data-i18n-aria="a11y.githubProject"],[data-i18n-aria="a11y.donateProject"],#token-ca';
const HIDE_STYLE = `<style data-fork-hide>${HIDE_SELECTORS}{display:none!important}</style>`;

const TEXT_EXT = new Set([
  '.html', '.js', '.cjs', '.mjs', '.css', '.json', '.webmanifest',
  '.txt', '.xml', '.svg', '.map',
]);
const SKIP_DIRS = new Set(['media', 'audio']);

const roots = process.argv.slice(2);
const targets = roots.length ? roots : ['dist', 'dist-server', 'dist-bot'];

function listTextFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      listTextFiles(p, out);
      continue;
    }
    if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

function replaceAll(s, pairs) {
  let out = s;
  let hits = 0;
  for (const [from, to] of pairs) {
    if (!out.includes(from)) continue;
    const parts = out.split(from);
    hits += parts.length - 1;
    out = parts.join(to);
  }
  return { out, hits };
}

// ── Pass 1: brand replace over every text file ────────────────────────────────
let filesTouched = 0;
let totalHits = 0;
const changedFiles = new Set();
const allTextFiles = targets.flatMap((r) => listTextFiles(r));
for (const p of allTextFiles) {
  let s;
  try {
    s = fs.readFileSync(p, 'utf8');
  } catch {
    continue;
  }
  const { out, hits } = replaceAll(s, RULES);
  if (hits > 0) {
    fs.writeFileSync(p, out);
    filesTouched++;
    totalHits += hits;
    changedFiles.add(p);
  }
}

// ── Pass 1b: inject the hide-list stylesheet into every built HTML page ───────
let stylesInjected = 0;
for (const p of allTextFiles) {
  if (!p.endsWith('.html')) continue;
  let s;
  try {
    s = fs.readFileSync(p, 'utf8');
  } catch {
    continue;
  }
  if (s.includes('data-fork-hide') || !s.includes('</head>')) continue;
  fs.writeFileSync(p, s.replace('</head>', `${HIDE_STYLE}</head>`));
  stylesInjected++;
}

// ── Pass 2: rename files whose NAME carries the capitalized brand ─────────────
// (e.g. the whitepaper PDF) — the content replace above rewrote every reference.
// Lowercase asset names (worldofclaudecraft-logo.png, woc_*.webp) stay put.
let renamed = 0;
for (const root of targets) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    let name = e.name;
    for (const [from, to] of RULES) name = name.split(from).join(to);
    // URLs are not valid in filenames; only the plain-word rules can apply.
    if (name !== e.name && !/[/:]/.test(name)) {
      fs.renameSync(path.join(root, e.name), path.join(root, name));
      renamed++;
    }
  }
}

// ── Pass 3: cache-bust edited hashed assets (to a fixpoint) ───────────────────
// Vite hashes chunk filenames from their PRE-rebrand content, so an edited chunk
// keeps its old name across builds while its bytes change — and immutable-cached
// browsers keep serving the stale version forever (bit us with the i18n locale
// chunks). Re-hash every edited assets/ file from its FINAL content and rewrite
// all references. Reference rewrites change the REFERRERS' content too, so those
// hashed referrers are re-hashed in the next round, up to a fixpoint: a file's
// LAST rename always follows its last content change, so final name = hash of
// final content and every referrer is updated after it (round cap guards true
// import cycles). index.html and friends are unhashed and revalidated by the
// browser, which terminates the chain.
const HASHED_NAME = /^(.+)-([A-Za-z0-9_-]{8,})(\.[A-Za-z0-9.]+)$/;
let rehashedCount = 0;
let refFixes = 0;
let pending = [...changedFiles];
for (let round = 0; round < 6 && pending.length > 0; round++) {
  const basenameMap = new Map(); // old basename -> new basename
  for (const p of pending) {
    if (!fs.existsSync(p)) continue;
    if (!path.dirname(p).replace(/\\/g, '/').endsWith('/assets')) continue;
    const base = path.basename(p);
    // Sourcemaps ride along with their parent chunk, never renamed on their own.
    if (base.endsWith('.map')) continue;
    const m = HASHED_NAME.exec(base);
    if (!m) continue;
    const content = fs.readFileSync(p);
    const fresh = createHash('md5').update(content).digest('hex').slice(0, 8);
    if (fresh === m[2]) continue;
    const next = `${m[1]}-${fresh}${m[3]}`;
    fs.renameSync(p, path.join(path.dirname(p), next));
    rehashedCount++;
    basenameMap.set(base, next);
    const mapPath = `${p}.map`;
    if (fs.existsSync(mapPath)) {
      fs.renameSync(mapPath, path.join(path.dirname(p), `${next}.map`));
      basenameMap.set(`${base}.map`, `${next}.map`);
    }
  }
  if (basenameMap.size === 0) break;
  // Rewrite references everywhere; newly changed hashed assets feed the next round.
  const nextPending = [];
  const pairs = [...basenameMap.entries()];
  for (const root of targets) {
    for (const p of listTextFiles(root)) {
      let s;
      try {
        s = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const { out, hits } = replaceAll(s, pairs);
      if (hits > 0) {
        fs.writeFileSync(p, out);
        refFixes += hits;
        nextPending.push(p);
      }
    }
  }
  pending = nextPending;
}

console.log(
  `[fork-rebrand] "${NAME}" applied: ${totalHits} replacements in ${filesTouched} files, ` +
    `${renamed} files renamed, ${stylesInjected} pages got the hide-list, ` +
    `${rehashedCount} assets re-hashed (${refFixes} refs updated) (roots: ${targets.join(', ')})`,
);
if (filesTouched === 0) {
  console.warn('[fork-rebrand] WARNING: no files changed — did the build run first?');
}
