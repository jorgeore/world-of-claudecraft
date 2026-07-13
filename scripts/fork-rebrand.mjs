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

const TEXT_EXT = new Set([
  '.html', '.js', '.cjs', '.mjs', '.css', '.json', '.webmanifest',
  '.txt', '.xml', '.svg', '.map',
]);
const SKIP_DIRS = new Set(['media', 'audio', 'assets/models']);

const roots = process.argv.slice(2);
const targets = roots.length ? roots : ['dist', 'dist-server', 'dist-bot'];

let filesTouched = 0;
let totalHits = 0;

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p);
      continue;
    }
    if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
    let s;
    try {
      s = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    let out = s;
    let hits = 0;
    for (const [from, to] of RULES) {
      if (!out.includes(from)) continue;
      const parts = out.split(from);
      hits += parts.length - 1;
      out = parts.join(to);
    }
    if (hits > 0) {
      fs.writeFileSync(p, out);
      filesTouched++;
      totalHits += hits;
    }
  }
}

for (const root of targets) walk(root);
console.log(`[fork-rebrand] "${NAME}" applied: ${totalHits} replacements in ${filesTouched} files (roots: ${targets.join(', ')})`);
if (filesTouched === 0) {
  console.warn('[fork-rebrand] WARNING: no files changed — did the build run first?');
}
