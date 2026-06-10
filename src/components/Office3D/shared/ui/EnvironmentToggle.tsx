'use client';

/**
 * Floating switcher between the office environments. Sits top-right so it
 * never collides with the classic scene's own overlays (top-left controls,
 * bottom-right legend).
 */
export type OfficeEnvironment = 'mission-control' | 'startup-campus' | 'classic';

export const ENVIRONMENT_LABELS: Record<OfficeEnvironment, string> = {
  'mission-control': '🛰️ Mission Control',
  'startup-campus': '🏢 Startup Campus',
  classic: '🪑 Clássico',
};

interface EnvironmentToggleProps {
  value: OfficeEnvironment;
  onChange: (env: OfficeEnvironment) => void;
}

export default function EnvironmentToggle({ value, onChange }: EnvironmentToggleProps) {
  return (
    <div className="absolute top-4 right-4 z-40 bg-black/70 text-white p-2 rounded-lg backdrop-blur-sm flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-gray-400 px-1">Ambiente</span>
      {(Object.keys(ENVIRONMENT_LABELS) as OfficeEnvironment[]).map((env) => (
        <button
          key={env}
          onClick={() => onChange(env)}
          className={`text-left text-xs font-semibold px-3 py-1.5 rounded transition-colors ${
            value === env
              ? 'bg-yellow-500 text-black'
              : 'bg-white/5 hover:bg-white/15 text-gray-200'
          }`}
        >
          {ENVIRONMENT_LABELS[env]}
        </button>
      ))}
    </div>
  );
}
