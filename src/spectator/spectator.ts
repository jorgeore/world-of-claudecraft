// Fork (Livezul): the guided spectator camera ("live observatory"). A hands-off
// broadcast scene the owner parks in an OBS browser source: it logs in as a
// dedicated moderator camera account, hides the HUD, and every few seconds
// re-anchors the game's built-in /spectate camera onto the next online player —
// showing each person actually playing, with their name on screen.
//
// Zero server changes: it reuses the moderator /spectate chat command and the
// admin online roster (both permissions the `moderator` role already carries).
// Interest management means it shows ONE player at a time (and whoever is within
// ~90-130yd of them) — which is exactly the rotating-observatory behaviour.
import type { IWorld } from '../world_api';

interface OnlineRow {
  name: string;
  class?: string;
  level?: number;
  zone?: string;
}

export interface SpectatorOptions {
  key: string; // shared secret for the fork spectator endpoints
  dwellMs: number; // ms per player on camera
}
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

export function startSpectatorMode(world: IWorld, opts: SpectatorOptions): void {
  // Style is injected now, but the HUD is only hidden once we are IN the world
  // (below) — otherwise the owner could not see the login/character screens the
  // first time they set up the OBS source.
  injectStyle();
  const overlay = buildOverlay();

  let lastName: string | null = null;
  let rotateTimer: number | null = null;
  let ready = false;

  const setStatus = (main: string, sub: string): void => {
    overlay.name.textContent = main;
    overlay.sub.textContent = sub;
  };

  async function fetchRoster(): Promise<OnlineRow[]> {
    try {
      const res = await fetch(`/api/spectator/roster?key=${encodeURIComponent(opts.key)}`);
      if (!res.ok) return [];
      const data = (await res.json()) as { players?: OnlineRow[] };
      const self = world.player?.name;
      // The server already drops staff sessions; also guard our own character.
      return (data.players ?? []).filter((r) => r.name && r.name !== self);
    } catch {
      return [];
    }
  }

  async function rotate(): Promise<void> {
    const roster = await fetchRoster();
    overlay.count.textContent = String(roster.length);
    if (roster.length === 0) {
      lastName = null;
      setStatus('Aguardando jogadores…', 'O mundo de Livezul está tranquilo agora');
      return;
    }
    // Advance to the next name after the one currently shown (stable order by
    // name so the rotation is fair even as the roster changes).
    roster.sort((a, b) => a.name.localeCompare(b.name));
    const idx = lastName ? roster.findIndex((r) => r.name === lastName) : -1;
    const next = roster[(idx + 1) % roster.length];
    lastName = next.name;
    world.chat(`/spectate ${next.name}`);
    const cls = next.class ? (CLASS_PT[next.class] ?? next.class) : '';
    const bits = [cls, next.level ? `nível ${next.level}` : '', next.zone ?? ''].filter(Boolean);
    setStatus(next.name, bits.join(' · '));
  }

  // Wait until the client is actually in the world (snapshots flowing), then
  // start rotating. Robust to however entry happened (auto or a one-time login).
  const waitReady = window.setInterval(() => {
    if (ready) return;
    if (world.entities.size > 0 && world.player?.name) {
      ready = true;
      window.clearInterval(waitReady);
      document.body.classList.add('spectator-cam'); // now hide the HUD
      setStatus('Conectando…', '');
      void rotate();
      rotateTimer = window.setInterval(() => void rotate(), Math.max(6000, opts.dwellMs));
    }
  }, 1000);

  // Manual controls when the owner is watching: → skip, Space pause/resume.
  let paused = false;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') void rotate();
    else if (e.code === 'Space') {
      paused = !paused;
      if (paused && rotateTimer !== null) {
        window.clearInterval(rotateTimer);
        rotateTimer = null;
        overlay.live.textContent = '⏸ PAUSADO';
      } else if (!paused && rotateTimer === null) {
        rotateTimer = window.setInterval(() => void rotate(), Math.max(6000, opts.dwellMs));
        overlay.live.textContent = '🔴 AO VIVO';
      }
    }
  });
}

function buildOverlay(): { name: HTMLElement; sub: HTMLElement; count: HTMLElement; live: HTMLElement } {
  const wrap = document.createElement('div');
  wrap.id = 'spectator-overlay';
  wrap.innerHTML = `
    <div id="spec-top">
      <span id="spec-live">🔴 AO VIVO</span>
      <span id="spec-brand">WORLD OF LIVEZUL</span>
    </div>
    <div id="spec-bottom">
      <div id="spec-nowwatching">ASSISTINDO</div>
      <div id="spec-name">Conectando…</div>
      <div id="spec-sub"></div>
      <div id="spec-count-row"><span id="spec-count">0</span> jogadores online agora</div>
    </div>`;
  document.body.appendChild(wrap);
  return {
    name: wrap.querySelector('#spec-name') as HTMLElement,
    sub: wrap.querySelector('#spec-sub') as HTMLElement,
    count: wrap.querySelector('#spec-count') as HTMLElement,
    live: wrap.querySelector('#spec-live') as HTMLElement,
  };
}

function injectStyle(): void {
  const css = `
    body.spectator-cam #ui { display: none !important; }
    #spectator-overlay { display: none; }
    body.spectator-cam #spectator-overlay { display: block; }
    #spectator-overlay {
      position: fixed; inset: 0; pointer-events: none; z-index: 9999;
      font-family: 'Cinzel', Georgia, serif; color: #fff6df;
      text-shadow: 0 2px 8px rgba(0,0,0,0.9);
    }
    #spec-top {
      position: absolute; top: 22px; left: 28px; right: 28px;
      display: flex; align-items: center; justify-content: space-between;
    }
    #spec-live {
      font-family: system-ui, sans-serif; font-weight: 800; font-size: 15px;
      letter-spacing: 1px; color: #fff;
      background: rgba(200,30,30,0.85); padding: 4px 12px; border-radius: 6px;
    }
    #spec-brand {
      font-size: 20px; font-weight: 700; letter-spacing: 3px; color: #ffd76a;
    }
    #spec-bottom {
      position: absolute; left: 40px; bottom: 44px; max-width: 60%;
    }
    #spec-nowwatching {
      font-family: system-ui, sans-serif; font-size: 12px; letter-spacing: 4px;
      color: #ffd76a; opacity: 0.85; margin-bottom: 2px;
    }
    #spec-name { font-size: 46px; font-weight: 700; line-height: 1.05; }
    #spec-sub {
      font-family: system-ui, sans-serif; font-size: 16px; color: #e8e2d0;
      opacity: 0.9; margin-top: 4px; letter-spacing: 0.5px;
    }
    #spec-count-row {
      font-family: system-ui, sans-serif; font-size: 14px; color: #cbb98a;
      margin-top: 14px; letter-spacing: 0.5px;
    }
    #spec-count { color: #ffd76a; font-weight: 700; }`;
  const el = document.createElement('style');
  el.id = 'spectator-style';
  el.textContent = css;
  document.head.appendChild(el);
}
