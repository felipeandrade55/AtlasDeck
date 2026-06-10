/**
 * Deterministic role → accessory mapping so each agent is visually
 * distinguishable: the orchestrator wears the tie; specialists get a
 * stable accessory derived from their id.
 */
import type { Accessory } from './accessories';

const SPECIALIST_ROTATION: Accessory[] = ['headset', 'glasses', 'cap'];

export function accessoriesFor(agentId: string, role: string): Accessory[] {
  if (agentId === 'main' || agentId === 'jarvis') return ['tie'];
  const r = role.toLowerCase();
  if (/(infra|dev|code|engenh)/.test(r)) return ['headset'];
  if (/(research|pesquis|acad|escrit|writer|análise|analista)/.test(r)) return ['glasses'];
  // Stable hash of the id picks the rest
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
  return [SPECIALIST_ROTATION[Math.abs(hash) % SPECIALIST_ROTATION.length]];
}
