/**
 * Tiny 2D "programs" drawn into CanvasTextures for the stylized in-world
 * screens (console monitors, arcade cabinet, lounge TV…). Each program is
 * a pure draw function — state it needs across frames hangs off `mem`,
 * a scratch object owned by the texture cache entry.
 *
 * Resolution is tiny (~128px) and redraws are throttled to a few fps, so
 * these can be naive — no need for shaders or sprite sheets.
 */

export interface ScreenDrawArgs {
  ctx: CanvasRenderingContext2D;
  /** Seconds since the app clock started. */
  t: number;
  w: number;
  h: number;
  /** Accent color (usually the agent-status color). */
  color: string;
  /** Per-entry scratch memory (persists across redraws). */
  mem: Record<string, unknown>;
}

export type ScreenProgramName = 'codeScroll' | 'pong' | 'kanbanColumns' | 'graphWave' | 'tvShow' | 'off';

export type ScreenProgram = (args: ScreenDrawArgs) => void;

/** Terminal-style scrolling "code" lines tinted by status color. */
const codeScroll: ScreenProgram = ({ ctx, t, w, h, color }) => {
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, w, h);
  const lineH = 7;
  const lines = Math.ceil(h / lineH) + 1;
  const scroll = (t * 10) % lineH;
  for (let i = 0; i < lines; i++) {
    const y = i * lineH - scroll;
    // Deterministic pseudo-random widths per visible row index
    const row = Math.floor(t * 10 / lineH) + i;
    const rnd = Math.abs(Math.sin(row * 12.9898) * 43758.5453) % 1;
    const segments = 1 + Math.floor(rnd * 3);
    let x = 4;
    for (let s = 0; s < segments; s++) {
      const segRnd = Math.abs(Math.sin((row * 7 + s) * 78.233) * 12543.21) % 1;
      const segW = 8 + segRnd * (w / segments - 14);
      ctx.fillStyle = s === 0 ? color : 'rgba(148,163,184,0.55)';
      ctx.globalAlpha = 0.5 + segRnd * 0.5;
      ctx.fillRect(x, y, segW, 3.5);
      x += segW + 6;
    }
  }
  ctx.globalAlpha = 1;
  // Blinking cursor
  if (Math.floor(t * 2) % 2 === 0) {
    ctx.fillStyle = color;
    ctx.fillRect(4, h - 8, 5, 4);
  }
};

/** Self-playing pong for the arcade cabinet. */
const pong: ScreenProgram = ({ ctx, t, w, h, color, mem }) => {
  type PongState = { x: number; y: number; vx: number; vy: number; lt: number };
  let s = mem.pong as PongState | undefined;
  if (!s) {
    s = { x: w / 2, y: h / 2, vx: 28, vy: 17, lt: t };
    mem.pong = s;
  }
  const dt = Math.min(0.3, Math.max(0, t - s.lt));
  s.lt = t;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  if (s.y < 4 || s.y > h - 4) s.vy *= -1;
  if (s.x < 10 || s.x > w - 10) s.vx *= -1;
  s.x = Math.min(w - 10, Math.max(10, s.x));
  s.y = Math.min(h - 4, Math.max(4, s.y));

  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, w, h);
  // Center line
  ctx.fillStyle = 'rgba(148,163,184,0.3)';
  for (let y = 0; y < h; y += 8) ctx.fillRect(w / 2 - 1, y, 2, 4);
  // Paddles track the ball (perfect AI — nobody ever scores)
  const padH = h / 4;
  const padY = Math.min(h - padH, Math.max(0, s.y - padH / 2));
  ctx.fillStyle = color;
  ctx.fillRect(3, padY, 4, padH);
  ctx.fillRect(w - 7, padY, 4, padH);
  // Ball
  ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
  // Score
  ctx.font = 'bold 12px monospace';
  ctx.fillStyle = 'rgba(226,232,240,0.8)';
  ctx.fillText('12', w / 2 - 22, 14);
  ctx.fillText('12', w / 2 + 10, 14);
};

/** Mini kanban: columns of little cards shuffling around. */
const kanbanColumns: ScreenProgram = ({ ctx, t, w, h, color }) => {
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, w, h);
  const cols = 4;
  const colW = (w - 10) / cols;
  for (let c = 0; c < cols; c++) {
    const x = 5 + c * colW;
    ctx.fillStyle = 'rgba(148,163,184,0.18)';
    ctx.fillRect(x, 4, colW - 4, h - 8);
    const cards = 1 + Math.floor(Math.abs(Math.sin(c * 3.7 + Math.floor(t / 4))) * 4);
    for (let i = 0; i < cards; i++) {
      ctx.fillStyle = i === 0 ? color : 'rgba(226,232,240,0.5)';
      ctx.fillRect(x + 2, 8 + i * 12, colW - 8, 8);
    }
  }
};

/** Scrolling line chart (costs / activity). */
const graphWave: ScreenProgram = ({ ctx, t, w, h, color }) => {
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(148,163,184,0.25)';
  ctx.lineWidth = 1;
  for (let y = h / 4; y < h; y += h / 4) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 4) {
    const v =
      Math.sin((x + t * 18) * 0.05) * 0.3 +
      Math.sin((x + t * 18) * 0.013) * 0.45;
    const y = h / 2 - v * (h / 3);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
};

/** Lounge TV: color-bar "show" with occasional static. */
const tvShow: ScreenProgram = ({ ctx, t, w, h }) => {
  const channel = Math.floor(t / 6) % 3;
  if (channel === 2) {
    // Static
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const v = Math.floor(Math.abs(Math.sin(x * 91.7 + y * 47.3 + Math.floor(t * 8) * 13.1)) * 255);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x, y, 3, 3);
      }
    }
    return;
  }
  // "Show": drifting color blobs (channel 0) or color bars (channel 1)
  if (channel === 1) {
    const bars = ['#e11d48', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#f1f5f9'];
    const bw = w / bars.length;
    bars.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(i * bw, 0, bw + 1, h);
    });
    return;
  }
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 3; i++) {
    const x = w / 2 + Math.sin(t * 0.7 + i * 2.1) * (w / 3);
    const y = h / 2 + Math.cos(t * 0.9 + i * 1.7) * (h / 3);
    const r = 10 + i * 6;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, ['#f472b6', '#38bdf8', '#facc15'][i]);
    g.addColorStop(1, 'rgba(30,41,59,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
};

/** Powered-off screen with a faint reflection. */
const off: ScreenProgram = ({ ctx, w, h }) => {
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(148,163,184,0.06)';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w * 0.45, 0);
  ctx.lineTo(0, h * 0.7);
  ctx.closePath();
  ctx.fill();
};

export const SCREEN_PROGRAMS: Record<ScreenProgramName, ScreenProgram> = {
  codeScroll,
  pong,
  kanbanColumns,
  graphWave,
  tvShow,
  off,
};
