// Fork (Livezul): the IDLE-mode toggle button + status readout. Self-contained
// DOM injection into the existing micro-menu cluster (#side-buttons) and #ui —
// zero edits to hud.ts. Also freezes movement when the tab goes hidden (a
// minimized tab stalls rAF while the server keeps applying the last direction;
// an OBS browser source stays "visible" so streams are unaffected).
import type { IdleAutopilot } from './autopilot';

export function installIdleUi(autopilot: IdleAutopilot): void {
  const cluster = document.getElementById('side-buttons');
  const ui = document.getElementById('ui') ?? document.body;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'mm-idle';
  btn.className = 'micro-btn';
  btn.title = 'Modo IDLE (auto-farm)';
  btn.setAttribute('aria-label', 'Modo IDLE (auto-farm)');
  btn.textContent = 'IDLE';
  btn.style.fontSize = '9px';
  btn.style.fontWeight = '700';
  btn.style.letterSpacing = '0.4px';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    autopilot.toggle();
    paint();
  });
  cluster?.appendChild(btn);

  const status = document.createElement('div');
  status.id = 'idle-status';
  status.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:72px',
    'transform:translateX(-50%)',
    'padding:4px 12px',
    'background:rgba(10,12,18,0.78)',
    'border:1px solid rgba(255,215,106,0.35)',
    'border-radius:8px',
    'color:#ffd76a',
    'font-size:12px',
    'letter-spacing:0.3px',
    'pointer-events:none',
    'z-index:40',
    'display:none',
    'white-space:nowrap',
  ].join(';');
  ui.appendChild(status);

  const paint = (): void => {
    const on = autopilot.active;
    btn.style.boxShadow = on ? '0 0 8px rgba(255,215,106,0.9)' : '';
    btn.style.borderColor = on ? '#ffd76a' : '';
    btn.style.color = on ? '#ffd76a' : '';
    status.style.display = on ? 'block' : 'none';
    if (on) status.textContent = autopilot.status();
  };
  window.setInterval(paint, 400);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) autopilot.onHidden();
  });

  // Debug/observability handle (used by the deploy smoke test; harmless — the
  // autopilot only issues the same commands a keyboard could).
  (window as { __livezulIdle?: IdleAutopilot }).__livezulIdle = autopilot;
}
