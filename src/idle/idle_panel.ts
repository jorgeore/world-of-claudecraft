// Fork (Livezul): the IDLE configuration panel — the player picks the rotation
// (which abilities, in what priority), emergency potion thresholds, and rest
// eating. Pure DOM module (no hud.ts edits); config persists per character via
// the autopilot's localStorage store.
import type { IdleAutopilot } from './autopilot';

const PANEL_ID = 'idle-config-panel';

export interface IdlePanel {
  toggle(): void;
  close(): void;
}

export function installIdlePanel(autopilot: IdleAutopilot): IdlePanel {
  const ui = document.getElementById('ui') ?? document.body;

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.style.cssText = [
    'position:absolute',
    'right:64px',
    'top:50%',
    'transform:translateY(-50%)',
    'width:272px',
    'max-height:70vh',
    'overflow-y:auto',
    'padding:14px 14px 12px',
    'background:rgba(10,12,18,0.92)',
    'border:1px solid rgba(255,215,106,0.45)',
    'border-radius:10px',
    'color:#e8e2d0',
    'font-size:12px',
    'z-index:60',
    'display:none',
    'box-shadow:0 8px 28px rgba(0,0,0,0.55)',
  ].join(';');

  const gold = '#ffd76a';

  function sectionTitle(text: string): string {
    return `<div style="color:${gold};font-weight:700;letter-spacing:0.5px;margin:10px 0 6px;font-size:11px;text-transform:uppercase">${text}</div>`;
  }

  function pctOptions(current: number): string {
    return [0.15, 0.25, 0.35, 0.5, 0.65]
      .map((v) => `<option value="${v}" ${Math.abs(v - current) < 0.01 ? 'selected' : ''}>${Math.round(v * 100)}%</option>`)
      .join('');
  }

  function render(): void {
    autopilot.loadConfig();
    autopilot.syncSkillsFromKnown();
    const cfg = autopilot.config;

    const skillRows = cfg.skills.length
      ? cfg.skills
          .map(
            (s, i) => `
      <div data-skill-row="${i}" style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
        <input type="checkbox" data-skill-toggle="${i}" ${s.enabled ? 'checked' : ''} style="accent-color:${gold}">
        <span style="flex:1;${s.enabled ? '' : 'opacity:0.45'}">${i + 1}. ${s.name}</span>
        <button type="button" data-skill-up="${i}" ${i === 0 ? 'disabled' : ''} style="width:20px;background:none;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:inherit;cursor:pointer">▲</button>
        <button type="button" data-skill-down="${i}" ${i === cfg.skills.length - 1 ? 'disabled' : ''} style="width:20px;background:none;border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:inherit;cursor:pointer">▼</button>
      </div>`,
          )
          .join('')
      : '<div style="opacity:0.6;padding:4px 0">Nenhuma habilidade ofensiva conhecida ainda.</div>';

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="color:${gold};font-weight:700;font-size:13px;letter-spacing:0.4px">⚙ Modo IDLE</div>
        <button type="button" data-close style="background:none;border:none;color:#aaa;font-size:15px;cursor:pointer;padding:0 2px">✕</button>
      </div>
      ${sectionTitle('Rotação (prioridade)')}
      ${skillRows}
      ${sectionTitle('Poções de emergência')}
      <div style="display:flex;align-items:center;gap:6px;padding:2px 0">
        <input type="checkbox" data-hp-pot ${cfg.hpPotionEnabled ? 'checked' : ''} style="accent-color:${gold}">
        <span style="flex:1">Poção de vida abaixo de</span>
        <select data-hp-pct style="background:#1a1d26;color:inherit;border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:1px 2px">${pctOptions(cfg.hpPotionPct)}</select>
      </div>
      <div style="display:flex;align-items:center;gap:6px;padding:2px 0">
        <input type="checkbox" data-mana-pot ${cfg.manaPotionEnabled ? 'checked' : ''} style="accent-color:${gold}">
        <span style="flex:1">Poção de mana abaixo de</span>
        <select data-mana-pct style="background:#1a1d26;color:inherit;border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:1px 2px">${pctOptions(cfg.manaPotionPct)}</select>
      </div>
      ${sectionTitle('Descanso')}
      <div style="display:flex;align-items:center;gap:6px;padding:2px 0">
        <input type="checkbox" data-eat ${cfg.eatDrinkEnabled ? 'checked' : ''} style="accent-color:${gold}">
        <span style="flex:1">Comer e beber ao descansar</span>
      </div>
      <div style="margin-top:10px;opacity:0.55;font-size:10.5px;line-height:1.4">
        Usa sempre o consumível mais fraco que resolve. Configuração salva por personagem.
      </div>`;

    panel.querySelector('[data-close]')?.addEventListener('click', () => api.close());
    panel.querySelectorAll<HTMLInputElement>('[data-skill-toggle]').forEach((el) => {
      el.addEventListener('change', () => {
        const i = Number(el.dataset.skillToggle);
        cfg.skills[i].enabled = el.checked;
        autopilot.saveConfig();
        render();
      });
    });
    const move = (i: number, dir: -1 | 1): void => {
      const j = i + dir;
      if (j < 0 || j >= cfg.skills.length) return;
      const [row] = cfg.skills.splice(i, 1);
      cfg.skills.splice(j, 0, row);
      autopilot.saveConfig();
      render();
    };
    panel.querySelectorAll<HTMLButtonElement>('[data-skill-up]').forEach((el) => {
      el.addEventListener('click', () => move(Number(el.dataset.skillUp), -1));
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-skill-down]').forEach((el) => {
      el.addEventListener('click', () => move(Number(el.dataset.skillDown), 1));
    });
    const bindCheck = (sel: string, apply: (v: boolean) => void): void => {
      panel.querySelector<HTMLInputElement>(sel)?.addEventListener('change', (e) => {
        apply((e.target as HTMLInputElement).checked);
        autopilot.saveConfig();
      });
    };
    const bindPct = (sel: string, apply: (v: number) => void): void => {
      panel.querySelector<HTMLSelectElement>(sel)?.addEventListener('change', (e) => {
        apply(Number((e.target as HTMLSelectElement).value));
        autopilot.saveConfig();
      });
    };
    bindCheck('[data-hp-pot]', (v) => (cfg.hpPotionEnabled = v));
    bindCheck('[data-mana-pot]', (v) => (cfg.manaPotionEnabled = v));
    bindCheck('[data-eat]', (v) => (cfg.eatDrinkEnabled = v));
    bindPct('[data-hp-pct]', (v) => (cfg.hpPotionPct = v));
    bindPct('[data-mana-pct]', (v) => (cfg.manaPotionPct = v));
  }

  ui.appendChild(panel);

  const api: IdlePanel = {
    toggle(): void {
      if (panel.style.display === 'none') {
        render();
        panel.style.display = 'block';
      } else {
        panel.style.display = 'none';
      }
    },
    close(): void {
      panel.style.display = 'none';
    },
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.style.display !== 'none') api.close();
  });

  return api;
}
