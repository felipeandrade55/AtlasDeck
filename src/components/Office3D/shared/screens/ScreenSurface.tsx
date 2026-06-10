'use client';

/**
 * A glowing in-world screen driven by a tiny canvas "program"
 * (see screenPrograms.ts). Cheap by construction: ≤128px canvas,
 * redraws throttled to a few fps, textures shared across identical
 * (program, color) pairs via the texture cache.
 */
import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { acquireScreenTexture, releaseScreenTexture, tickScreenTexture } from './textureCache';
import type { ScreenProgramName } from './screenPrograms';

interface ScreenSurfaceProps {
  /** World-space width/height of the screen plane. */
  size: [number, number];
  program: ScreenProgramName;
  /** Accent color, usually the agent-status color. */
  color?: string;
  /** Canvas resolution; keep tiny. */
  resolution?: [number, number];
  /** Redraw rate. */
  fps?: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
}

export default function ScreenSurface({
  size,
  program,
  color = '#22c55e',
  resolution = [128, 96],
  fps = 6,
  position,
  rotation,
}: ScreenSurfaceProps) {
  const [resW, resH] = resolution;

  const texture = useMemo(
    () => acquireScreenTexture(program, color, resW, resH),
    [program, color, resW, resH],
  );
  useEffect(() => {
    return () => releaseScreenTexture(program, color, resW, resH);
  }, [program, color, resW, resH]);

  useFrame(({ clock }) => {
    tickScreenTexture(program, color, resW, resH, clock.elapsedTime, fps);
  });

  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={size} />
      {/* basic material + toneMapped:false reads as emissive without lights */}
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}
