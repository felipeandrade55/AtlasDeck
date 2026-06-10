'use client';

/**
 * Entry point for /office. Owns the environment toggle (persisted in
 * localStorage) and, for the new environments, a single persistent
 * <Canvas> + the single useOfficeData instance.
 *
 * Only one environment is ever mounted: the scenes are lazy chunks via
 * next/dynamic, and the classic scene keeps its own self-contained
 * component (removed in Fase 6).
 */
import { Suspense, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { PCFShadowMap } from 'three';
import EnvironmentToggle, { type OfficeEnvironment } from './shared/ui/EnvironmentToggle';
import StatusLegend from './shared/ui/StatusLegend';
import OfficeDataProvider, { useOfficeBus } from './shared/data/OfficeDataProvider';
import { useOfficeData } from './shared/data/useOfficeData';
import { useTasksPipeline } from './shared/data/useTasksPipeline';
import { useOfficeStore } from './shared/data/officeStore';
import AgentPanel from './AgentPanel';
import FirstPersonControls from './FirstPersonControls';

const STORAGE_KEY = 'atlasdeck.office.env';

const MissionControlScene = dynamic(() => import('./environments/mission-control/MissionControlScene'), {
  ssr: false,
});
const StartupCampusScene = dynamic(() => import('./environments/startup-campus/StartupCampusScene'), {
  ssr: false,
});
const ClassicOffice = dynamic(() => import('./Office3D'), { ssr: false });

function isEnvironment(v: string | null): v is OfficeEnvironment {
  return v === 'mission-control' || v === 'startup-campus' || v === 'classic';
}

const ENV_CHANGE_EVENT = 'atlasdeck-office-env-change';

function subscribeEnv(cb: () => void) {
  window.addEventListener(ENV_CHANGE_EVENT, cb);
  return () => window.removeEventListener(ENV_CHANGE_EVENT, cb);
}

function readEnv(): OfficeEnvironment {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isEnvironment(stored) ? stored : 'mission-control';
}

export default function OfficeShell() {
  // localStorage via useSyncExternalStore: server/hydration sees null
  // (loading shade), the client snapshot kicks in right after — no
  // hydration mismatch, no setState-in-effect.
  const env = useSyncExternalStore(subscribeEnv, readEnv, () => null);

  const changeEnv = (next: OfficeEnvironment) => {
    localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(ENV_CHANGE_EVENT));
  };

  if (!env) {
    return <div className="fixed inset-0 bg-gray-950" />;
  }

  if (env === 'classic') {
    return (
      <div className="fixed inset-0">
        <ClassicOffice />
        <EnvironmentToggle value={env} onChange={changeEnv} />
      </div>
    );
  }

  return (
    <OfficeDataProvider>
      <ModernOffice env={env} onChangeEnv={changeEnv} />
    </OfficeDataProvider>
  );
}

function ModernOffice({
  env,
  onChangeEnv,
}: {
  env: 'mission-control' | 'startup-campus';
  onChangeEnv: (env: OfficeEnvironment) => void;
}) {
  const data = useOfficeData();
  const { tasks } = useTasksPipeline();
  const bus = useOfficeBus();
  const videowallInteractive = useOfficeStore((s) => s.videowallInteractive);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [controlMode, setControlMode] = useState<'orbit' | 'fps'>('orbit');

  const selectedAgent = selectedAgentId ? data.agents.find((a) => a.id === selectedAgentId) ?? null : null;

  return (
    <div className="fixed inset-0 bg-gray-950" style={{ height: '100vh', width: '100vw' }}>
      <Canvas
        camera={{ position: [0, 10, 16], fov: 55 }}
        shadows={{ type: PCFShadowMap }}
        gl={{ antialias: true, alpha: false }}
        style={{ width: '100%', height: '100%' }}
        onPointerMissed={() => setSelectedAgentId(null)}
      >
        <Suspense fallback={null}>
          {env === 'mission-control' ? (
            <MissionControlScene
              data={data}
              tasks={tasks}
              bus={bus}
              selectedAgentId={selectedAgentId}
              onSelectAgent={setSelectedAgentId}
            />
          ) : (
            <StartupCampusScene
              data={data}
              tasks={tasks}
              bus={bus}
              selectedAgentId={selectedAgentId}
              onSelectAgent={setSelectedAgentId}
            />
          )}
          {controlMode === 'orbit' ? (
            <OrbitControls
              enabled={!videowallInteractive}
              enableDamping
              dampingFactor={0.05}
              minDistance={4}
              maxDistance={34}
              maxPolarAngle={Math.PI / 2.15}
            />
          ) : (
            <FirstPersonControls moveSpeed={5} />
          )}
        </Suspense>
      </Canvas>

      {/* Camera mode + hints */}
      <div className="absolute top-4 left-4 bg-black/70 text-white p-4 rounded-lg backdrop-blur-sm">
        <h2 className="text-lg font-bold mb-2">
          {env === 'mission-control' ? '🛰️ Mission Control HQ' : '🏢 Startup Campus'}
        </h2>
        <div className="text-sm space-y-1 mb-3">
          <p><strong>Modo: {controlMode === 'orbit' ? '🖱️ Órbita' : '🎮 FPS'}</strong></p>
          {controlMode === 'orbit' ? (
            <>
              <p>🖱️ Mouse: girar vista</p>
              <p>🔄 Scroll: zoom</p>
              <p>👆 Clique: selecionar agente</p>
            </>
          ) : (
            <>
              <p>Clique para travar o cursor</p>
              <p>WASD/Setas: mover</p>
              <p>Espaço: subir | Shift: descer</p>
              <p>Mouse: olhar | ESC: destravar</p>
            </>
          )}
        </div>
        <button
          onClick={() => setControlMode(controlMode === 'orbit' ? 'fps' : 'orbit')}
          className="w-full bg-yellow-500 hover:bg-yellow-600 text-black font-bold py-2 px-3 rounded text-xs transition-colors"
        >
          {controlMode === 'orbit' ? 'Modo FPS' : 'Modo Órbita'}
        </button>
      </div>

      <EnvironmentToggle value={env} onChange={onChangeEnv} />
      <StatusLegend />

      {selectedAgent && (
        <AgentPanel
          agent={{ ...selectedAgent, position: [0, 0, 0] }}
          state={data.agentStates[selectedAgent.id]}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  );
}
