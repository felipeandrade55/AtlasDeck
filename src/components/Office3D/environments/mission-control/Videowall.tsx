'use client';

/**
 * The giant videowall: a 3D frame whose content is REAL React — kanban,
 * current mission, live activity feed, costs and alerts — rendered as ONE
 * drei <Html transform> grid (a single DOM subtree = a single matrix update
 * per frame; five separate Html instances would 5× that cost).
 *
 * Pointer handling: the DOM panel is `pointer-events: none` by default so
 * OrbitControls keeps working. Clicking the frame enters interactive mode
 * (store flag → OrbitControls disabled, panel clickable); ESC or clicking
 * the frame again leaves it.
 */
import { useEffect } from 'react';
import { Box, Html, Text } from '@react-three/drei';
import type { Task } from '@/components/LiveMission/types';
import type { OfficeData } from '../../shared/data/useOfficeData';
import type { OfficeBus } from '../../shared/data/OfficeDataProvider';
import { useOfficeStore } from '../../shared/data/officeStore';
import { VIDEOWALL } from './layout';
import { MissionPanel, KanbanMini, FeedMini, CostsMini, AlertsMini } from './videowall/panels';

// Aspect ratio mirrors the 3D frame (14 × 4.8 world units).
const PANEL_W = 1600;
const PANEL_H = 548;

interface VideowallProps {
  data: OfficeData;
  tasks: Task[];
  bus: OfficeBus;
}

export default function Videowall({ data, tasks, bus }: VideowallProps) {
  const [cx, cy, cz] = VIDEOWALL.center;
  const { width, height } = VIDEOWALL;
  const interactive = useOfficeStore((s) => s.videowallInteractive);
  const setInteractive = useOfficeStore((s) => s.setVideowallInteractive);

  // ESC leaves interactive mode.
  useEffect(() => {
    if (!interactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInteractive(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactive, setInteractive]);

  // drei's <Html transform> css-px → world mapping was calibrated
  // empirically (screenshot + getBoundingClientRect): ~0.0307 world units
  // per css px at scale=1 in this scene. Solve for the frame's inner area.
  const htmlScale = (width - 0.6) / (PANEL_W * 0.0307);

  return (
    <group position={[cx, cy, cz]}>
      {/* Outer frame — click toggles interactive mode */}
      <Box
        args={[width + 0.5, height + 0.5, 0.3]}
        position={[0, 0, -0.18]}
        castShadow
        onClick={(e) => {
          e.stopPropagation();
          setInteractive(!interactive);
        }}
      >
        <meshStandardMaterial
          color="#0b1220"
          emissive={interactive ? '#2563eb' : '#000000'}
          emissiveIntensity={interactive ? 0.35 : 0}
          metalness={0.6}
          roughness={0.4}
        />
      </Box>
      {/* Dark screen backing (covers gaps between DOM panels) */}
      <Box args={[width, height, 0.04]} position={[0, 0, -0.02]}>
        <meshBasicMaterial color="#05070d" />
      </Box>

      <Html
        transform
        position={[0, 0, 0.03]}
        scale={htmlScale}
        zIndexRange={[0, 10]}
        style={{ pointerEvents: 'none' }}
      >
        <div
          style={{
            width: PANEL_W,
            height: PANEL_H,
            pointerEvents: interactive ? 'auto' : 'none',
            display: 'grid',
            gridTemplateColumns: '360px 1fr 360px',
            gridTemplateRows: '1fr 240px',
            gap: 14,
            padding: 6,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: '#e2e8f0',
            userSelect: 'none',
          }}
        >
          <style>{`
            .vw-panel {
              height: 100%;
              box-sizing: border-box;
              background: linear-gradient(180deg, rgba(10,16,32,0.96), rgba(7,11,22,0.96));
              border: 1px solid rgba(56,90,160,0.45);
              border-radius: 10px;
              padding: 14px 16px;
              box-shadow: inset 0 0 40px rgba(30,58,138,0.15), 0 0 18px rgba(37,99,235,0.12);
              position: relative;
              overflow: hidden;
              display: flex;
              flex-direction: column;
            }
            .vw-panel::after {
              content: '';
              position: absolute;
              inset: 0;
              pointer-events: none;
              background: repeating-linear-gradient(
                0deg, rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 1px,
                transparent 1px, transparent 4px
              );
            }
            .vw-title {
              font-size: 12px;
              letter-spacing: 0.18em;
              font-weight: 700;
              color: #60a5fa;
            }
          `}</style>

          <div style={{ gridColumn: 1, gridRow: 1 }}>
            <KanbanMini tasks={tasks} />
          </div>
          <div style={{ gridColumn: 2, gridRow: '1 / span 2' }}>
            <MissionPanel tasks={tasks} agents={data.agents} agentStates={data.agentStates} />
          </div>
          <div style={{ gridColumn: 3, gridRow: 1 }}>
            <FeedMini agents={data.agents} bus={bus} />
          </div>
          <div style={{ gridColumn: 1, gridRow: 2 }}>
            <CostsMini />
          </div>
          <div style={{ gridColumn: 3, gridRow: 2 }}>
            <AlertsMini agents={data.agents} agentStates={data.agentStates} tasks={tasks} />
          </div>
        </div>
      </Html>

      {/* Header + interaction hint */}
      <Text
        position={[0, height / 2 + 0.55, 0.05]}
        fontSize={0.34}
        color="#e2e8f0"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.015}
        outlineColor="#000000"
      >
        ATLAS MISSION CONTROL
      </Text>
      <Text
        position={[0, -height / 2 - 0.4, 0.05]}
        fontSize={0.16}
        color={interactive ? '#60a5fa' : '#475569'}
        anchorX="center"
        anchorY="middle"
      >
        {interactive ? 'modo interativo — ESC para sair' : 'clique na moldura para interagir'}
      </Text>
    </group>
  );
}
