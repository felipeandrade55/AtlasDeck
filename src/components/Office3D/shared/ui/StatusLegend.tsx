'use client';

/**
 * The 7-state legend, extracted from the classic Office3D overlay so the
 * new environments share it.
 */
import { STATUS_COLOR, STATUS_LABEL_PT } from '../statusColors';
import type { AgentStatus } from '../../agentsConfig';

const PULSING: AgentStatus[] = ['thinking', 'reviewing', 'stuck'];

export default function StatusLegend() {
  return (
    <div className="absolute bottom-4 right-4 bg-black/70 text-white p-4 rounded-lg backdrop-blur-sm">
      <h3 className="text-sm font-bold mb-2">Estados</h3>
      <div className="text-xs space-y-1">
        {(Object.keys(STATUS_COLOR) as AgentStatus[]).map((status) => (
          <div key={status} className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${PULSING.includes(status) ? 'animate-pulse' : ''}`}
              style={{ backgroundColor: STATUS_COLOR[status] }}
            />
            <span>{STATUS_LABEL_PT[status]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
