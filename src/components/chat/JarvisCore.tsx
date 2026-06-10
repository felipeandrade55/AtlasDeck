"use client";

import { useEffect, useRef } from "react";

/**
 * Visual state of the animated core. The page derives this from the
 * real pipeline (wake word, ASR interim, stream, TTS) so the animation
 * always reflects what Jarvis is actually doing:
 *
 *  - off:        auto-listen disabled — dim standby, slow drift
 *  - listening:  mic armed, waiting for wake word / utterance
 *  - hearing:    user is speaking right now (interim transcript flowing)
 *  - thinking:   request in flight, no token received yet
 *  - responding: tokens streaming in
 *  - speaking:   TTS audio playing
 *  - error:      mic / recogniser failure
 */
export type JarvisMode =
  | "off"
  | "listening"
  | "hearing"
  | "thinking"
  | "responding"
  | "speaking"
  | "error";

interface ModeParams {
  color: [number, number, number];
  rot: number;
  pulse: number;
  glow: number;
  bars: number;
  jitter: number;
}

const MODE_PARAMS: Record<JarvisMode, ModeParams> = {
  off: { color: [100, 116, 139], rot: 0.12, pulse: 0.35, glow: 0.2, bars: 0.05, jitter: 0 },
  listening: { color: [34, 211, 238], rot: 0.35, pulse: 0.7, glow: 0.55, bars: 0.16, jitter: 0 },
  hearing: { color: [52, 211, 153], rot: 0.85, pulse: 1.6, glow: 0.85, bars: 0.78, jitter: 0 },
  thinking: { color: [167, 139, 250], rot: 2.6, pulse: 2.2, glow: 0.8, bars: 0.3, jitter: 0 },
  responding: { color: [251, 146, 60], rot: 1.5, pulse: 1.4, glow: 0.85, bars: 0.55, jitter: 0 },
  speaking: { color: [255, 69, 58], rot: 0.9, pulse: 1.1, glow: 0.95, bars: 0.9, jitter: 0 },
  error: { color: [239, 68, 68], rot: 0.18, pulse: 3.0, glow: 0.5, bars: 0.08, jitter: 1 },
};

interface Ripple {
  born: number;
  hue: [number, number, number];
}

/** Cheap deterministic pseudo-noise — good enough for organic motion. */
function noise(i: number, t: number): number {
  return (
    0.5 +
    0.5 *
      Math.sin(i * 12.9898 + t * 2.1) *
      Math.sin(i * 78.233 + t * 1.3 + Math.sin(t * 0.7 + i))
  );
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

export function JarvisCore({
  mode,
  size = 320,
}: {
  mode: JarvisMode;
  size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modeRef = useRef<JarvisMode>(mode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // Current (smoothed) parameters — eased toward the active mode's
    // targets every frame so state changes morph instead of snapping.
    const cur: ModeParams = { ...MODE_PARAMS.off, color: [...MODE_PARAMS.off.color] };
    const ripples: Ripple[] = [];
    let lastMode: JarvisMode = modeRef.current;
    let lastAmbientRipple = 0;
    // Rotation accumulators — integrating speed (instead of multiplying
    // t * speed) keeps the rings from "jumping" when speed eases.
    let rotA = 0;
    let rotB = 0;
    let rotC = 0;
    let raf = 0;
    let alive = true;
    const t0 = performance.now();

    const frame = (now: number) => {
      if (!alive) return;
      const t = (now - t0) / 1000;
      const target = MODE_PARAMS[modeRef.current];

      // Spawn a ripple on meaningful transitions (wake detected, TTS
      // start, thinking start) and a soft ambient one while listening.
      if (modeRef.current !== lastMode) {
        if (
          modeRef.current === "hearing" ||
          modeRef.current === "speaking" ||
          modeRef.current === "thinking"
        ) {
          ripples.push({ born: t, hue: [...target.color] });
        }
        lastMode = modeRef.current;
      }
      if (modeRef.current === "listening" && t - lastAmbientRipple > 2.8) {
        ripples.push({ born: t, hue: [...target.color] });
        lastAmbientRipple = t;
      }

      const ease = 0.055;
      cur.rot = lerp(cur.rot, target.rot, ease);
      cur.pulse = lerp(cur.pulse, target.pulse, ease);
      cur.glow = lerp(cur.glow, target.glow, ease);
      cur.bars = lerp(cur.bars, target.bars, ease);
      cur.jitter = lerp(cur.jitter, target.jitter, ease);
      for (let c = 0; c < 3; c++) {
        cur.color[c] = lerp(cur.color[c], target.color[c], ease);
      }

      const dt = 1 / 60;
      rotA += cur.rot * dt;
      rotB -= cur.rot * 1.6 * dt;
      rotC += cur.rot * 0.45 * dt;

      const [r, g, b] = cur.color.map(Math.round);
      const col = (a: number) => `rgba(${r},${g},${b},${a})`;
      const w = size;
      const cx = w / 2;
      const cy = w / 2;
      const R = w / 2;
      const jx = cur.jitter > 0.05 ? (Math.random() - 0.5) * 3 * cur.jitter : 0;
      const jy = cur.jitter > 0.05 ? (Math.random() - 0.5) * 3 * cur.jitter : 0;

      ctx.clearRect(0, 0, w, w);
      ctx.save();
      ctx.translate(cx + jx, cy + jy);

      const breathe = 0.5 + 0.5 * Math.sin(t * cur.pulse * Math.PI);

      // ---- expanding ripples -------------------------------------------
      for (let i = ripples.length - 1; i >= 0; i--) {
        const age = t - ripples[i].born;
        const life = 1.8;
        if (age > life) {
          ripples.splice(i, 1);
          continue;
        }
        const p = age / life;
        const [rr, rg, rb] = ripples[i].hue;
        ctx.beginPath();
        ctx.arc(0, 0, R * (0.32 + p * 0.62), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rr},${rg},${rb},${0.35 * (1 - p)})`;
        ctx.lineWidth = 1.5 * (1 - p) + 0.4;
        ctx.stroke();
      }

      // ---- outer tick ring ---------------------------------------------
      ctx.save();
      ctx.rotate(rotC);
      const ticks = 72;
      for (let i = 0; i < ticks; i++) {
        const a = (i / ticks) * Math.PI * 2;
        const long = i % 6 === 0;
        const r1 = R * 0.94;
        const r2 = R * (long ? 0.885 : 0.915);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
        ctx.strokeStyle = col(long ? 0.5 : 0.22);
        ctx.lineWidth = long ? 1.6 : 1;
        ctx.stroke();
      }
      ctx.restore();

      // ---- arc ring A (3 segments, clockwise) ---------------------------
      ctx.save();
      ctx.rotate(rotA);
      for (let i = 0; i < 3; i++) {
        const start = (i / 3) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.8, start, start + Math.PI * 0.42);
        ctx.strokeStyle = col(0.65);
        ctx.lineWidth = 2.4;
        ctx.lineCap = "round";
        ctx.stroke();
      }
      ctx.restore();

      // ---- arc ring B (2 segments, counter-clockwise) -------------------
      ctx.save();
      ctx.rotate(rotB);
      for (let i = 0; i < 2; i++) {
        const start = (i / 2) * Math.PI * 2 + 0.6;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.7, start, start + Math.PI * 0.7);
        ctx.strokeStyle = col(0.3);
        ctx.lineWidth = 5;
        ctx.lineCap = "round";
        ctx.stroke();
      }
      ctx.restore();

      // ---- thin dashed ring ---------------------------------------------
      ctx.save();
      ctx.rotate(-rotC * 1.8);
      ctx.beginPath();
      ctx.setLineDash([2, 7]);
      ctx.arc(0, 0, R * 0.61, 0, Math.PI * 2);
      ctx.strokeStyle = col(0.35);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // ---- orbiting particles -------------------------------------------
      for (let i = 0; i < 8; i++) {
        const a = rotA * (1.2 + (i % 3) * 0.35) + (i / 8) * Math.PI * 2;
        const pr = R * (0.66 + 0.05 * Math.sin(t * 1.3 + i));
        const px = Math.cos(a) * pr;
        const py = Math.sin(a) * pr;
        ctx.beginPath();
        ctx.arc(px, py, 1.6 + breathe, 0, Math.PI * 2);
        ctx.fillStyle = col(0.55 + 0.3 * breathe);
        ctx.fill();
      }

      // ---- circular waveform around the core ----------------------------
      const barCount = 48;
      const baseR = R * 0.44;
      for (let i = 0; i < barCount; i++) {
        const a = (i / barCount) * Math.PI * 2 + rotC * 0.5;
        // Speech-like envelope: a couple of moving "formant" bumps over
        // the base noise so speaking/hearing reads as voice, not static.
        const bump =
          0.6 * Math.exp(-Math.pow((((i / barCount) * 4 + t * 1.7) % 4) - 2, 2)) +
          0.4 * Math.exp(-Math.pow((((i / barCount) * 4 - t * 2.3) % 4) - 1, 2));
        const amp =
          cur.bars * (0.25 + 0.75 * noise(i, t * (1 + cur.bars * 2)) * (0.5 + bump));
        const len = 2 + amp * R * 0.16;
        const r1 = baseR;
        const r2 = baseR + len;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
        ctx.strokeStyle = col(0.3 + amp * 0.6);
        ctx.lineWidth = 1.8;
        ctx.lineCap = "round";
        ctx.stroke();
      }

      // ---- core glow ------------------------------------------------------
      const coreR = R * (0.3 + 0.025 * breathe);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 1.45);
      glow.addColorStop(0, col(0.85 * cur.glow + 0.1));
      glow.addColorStop(0.35, col(0.4 * cur.glow));
      glow.addColorStop(1, col(0));
      ctx.beginPath();
      ctx.arc(0, 0, coreR * 1.45, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      // bright nucleus
      const nucleus = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 0.55);
      nucleus.addColorStop(0, `rgba(255,255,255,${0.55 + 0.35 * breathe * cur.glow})`);
      nucleus.addColorStop(0.5, col(0.75));
      nucleus.addColorStop(1, col(0));
      ctx.beginPath();
      ctx.arc(0, 0, coreR * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = nucleus;
      ctx.fill();

      // core outline ring
      ctx.beginPath();
      ctx.arc(0, 0, coreR, 0, Math.PI * 2);
      ctx.strokeStyle = col(0.5 + 0.3 * breathe);
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.restore();
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden
    />
  );
}
