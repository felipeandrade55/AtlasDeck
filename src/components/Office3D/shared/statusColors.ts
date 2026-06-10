/**
 * Canonical status → color maps for every 3D surface that reflects an
 * agent's state (desk monitors, console screens, legend chips, canvas
 * screen programs). Single source of truth so Mission Control and the
 * Startup Campus never drift from the classic scene.
 */
import type { AgentStatus } from '../agentsConfig';

export const STATUS_COLOR: Record<AgentStatus, string> = {
  idle:        '#6b7280',
  thinking:    '#3b82f6',
  working:     '#22c55e',
  delegating:  '#a855f7',
  reviewing:   '#f97316',
  stuck:       '#ef4444',
  offline:     '#3f3f46',
};

export const STATUS_EMISSIVE: Record<AgentStatus, string> = {
  idle:        '#374151',
  thinking:    '#1e40af',
  working:     '#15803d',
  delegating:  '#6b21a8',
  reviewing:   '#9a3412',
  stuck:       '#991b1b',
  offline:     '#18181b',
};

export const STATUS_LABEL_PT: Record<AgentStatus, string> = {
  idle:        'Ocioso',
  thinking:    'Pensando',
  working:     'Trabalhando',
  delegating:  'Delegando',
  reviewing:   'Revisando',
  stuck:       'Travado',
  offline:     'Offline',
};
