'use client';

/**
 * "Parede das entregas": the last approved/done missions hang as framed
 * pictures on the back wall. Pure drei <Text> on planes — no canvas work.
 */
import { Box, Text } from '@react-three/drei';
import type { Task } from '@/components/LiveMission/types';
import { DONE_WALL } from './layout';

export default function DoneWall({ tasks }: { tasks: Task[] }) {
  const done = tasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => (b.completed_at ?? b.created_at).localeCompare(a.completed_at ?? a.created_at))
    .slice(0, DONE_WALL.cols * DONE_WALL.rows);

  const [cx, cy, cz] = DONE_WALL.center;
  const [sx, sy] = DONE_WALL.spacing;

  return (
    <group position={[cx, cy, cz]}>
      <Text position={[0, (DONE_WALL.rows * sy) / 2 + 0.35, 0.02]} fontSize={0.24} color="#facc15" anchorX="center" anchorY="middle" outlineWidth={0.012} outlineColor="#000000">
        🏆 ENTREGAS
      </Text>
      {done.map((task, i) => {
        const col = i % DONE_WALL.cols;
        const row = Math.floor(i / DONE_WALL.cols);
        const x = (col - (DONE_WALL.cols - 1) / 2) * sx;
        const y = ((DONE_WALL.rows - 1) / 2 - row) * sy;
        return (
          <group key={task.id} position={[x, y, 0]}>
            {/* Frame */}
            <Box args={[1.5, 1.1, 0.06]} castShadow>
              <meshStandardMaterial color="#92722a" metalness={0.4} roughness={0.5} />
            </Box>
            {/* Canvas */}
            <Box args={[1.34, 0.94, 0.02]} position={[0, 0, 0.035]}>
              <meshStandardMaterial color="#0f172a" />
            </Box>
            <Text position={[0, 0.28, 0.06]} fontSize={0.16} color="#22c55e" anchorX="center" anchorY="middle">
              ✓
            </Text>
            <Text
              position={[0, -0.06, 0.06]}
              fontSize={0.085}
              color="#e2e8f0"
              anchorX="center"
              anchorY="middle"
              maxWidth={1.2}
              textAlign="center"
            >
              {(task.title || task.prompt).slice(0, 70)}
            </Text>
          </group>
        );
      })}
      {done.length === 0 && (
        <Text position={[0, 0, 0.02]} fontSize={0.14} color="#475569" anchorX="center" anchorY="middle">
          as primeiras entregas aprovadas aparecem aqui
        </Text>
      )}
    </group>
  );
}
