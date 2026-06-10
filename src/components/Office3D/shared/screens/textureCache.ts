/**
 * Shared CanvasTexture pool for stylized screens. Keyed by
 * (program, color, resolution) so e.g. all consoles in `working` green
 * share ONE canvas: a single redraw per tick feeds every mesh using it.
 *
 * Entries are ref-counted by the ScreenSurface components that acquire
 * them and disposed when the last user unmounts (env toggle cleanup).
 */
import { CanvasTexture, SRGBColorSpace } from 'three';
import { SCREEN_PROGRAMS, type ScreenProgramName } from './screenPrograms';

interface CacheEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: CanvasTexture;
  program: ScreenProgramName;
  color: string;
  w: number;
  h: number;
  mem: Record<string, unknown>;
  lastDrawT: number;
  refs: number;
}

const cache = new Map<string, CacheEntry>();

function entryKey(program: ScreenProgramName, color: string, w: number, h: number): string {
  return `${program}:${color}:${w}x${h}`;
}

export function acquireScreenTexture(
  program: ScreenProgramName,
  color: string,
  w: number,
  h: number,
): CanvasTexture {
  const key = entryKey(program, color, w, h);
  let entry = cache.get(key);
  if (!entry) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    entry = { canvas, ctx, texture, program, color, w, h, mem: {}, lastDrawT: -1, refs: 0 };
    cache.set(key, entry);
    // First frame so the screen never flashes blank
    SCREEN_PROGRAMS[program]({ ctx, t: 0, w, h, color, mem: entry.mem });
    texture.needsUpdate = true;
  }
  entry.refs += 1;
  return entry.texture;
}

export function releaseScreenTexture(
  program: ScreenProgramName,
  color: string,
  w: number,
  h: number,
): void {
  const key = entryKey(program, color, w, h);
  const entry = cache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entry.texture.dispose();
    cache.delete(key);
  }
}

/**
 * Redraw an entry if its throttle window elapsed. Called from useFrame by
 * every ScreenSurface sharing the entry — only the first caller per tick
 * actually draws.
 */
export function tickScreenTexture(
  program: ScreenProgramName,
  color: string,
  w: number,
  h: number,
  t: number,
  fps: number,
): void {
  const entry = cache.get(entryKey(program, color, w, h));
  if (!entry) return;
  if (entry.lastDrawT >= 0 && t - entry.lastDrawT < 1 / fps) return;
  entry.lastDrawT = t;
  SCREEN_PROGRAMS[program]({ ctx: entry.ctx, t, w, h, color, mem: entry.mem });
  entry.texture.needsUpdate = true;
}
