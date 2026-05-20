"use client";

import { useState } from "react";

interface Agent {
  id: string;
  name: string;
  emoji: string;
  color: string;
  model: string;
  allowAgents: string[];
  allowAgentsDetails?: Array<{ id: string; name: string; emoji: string; color: string }>;
  status: "online" | "offline";
  activeSessions: number;
  botToken?: string;
}


interface AgentOrganigramaProps {
  agents: Agent[];
  onSelectAgent?: (id: string) => void;
}

interface NodePos {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  agent: Agent;
}

const NODE_W = 180;
const NODE_H = 80;
const H_GAP = 50;
const V_GAP = 100;

export function AgentOrganigrama({ agents, onSelectAgent }: AgentOrganigramaProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  if (agents.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "4rem 2rem", color: "var(--text-secondary)" }}>
        <p className="text-lg font-medium">Nenhum agente configurado</p>
        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Utilize o botão Adicionar Agente para iniciar o enxame.</p>
      </div>
    );
  }

  const agentMap = new Map(agents.map((a) => [a.id, a]));
  const childIds = new Set(agents.flatMap((a) => a.allowAgents));
  const roots = agents.filter((a) => !childIds.has(a.id));

  function getChildren(agentId: string): Agent[] {
    const agent = agentMap.get(agentId);
    if (!agent) return [];
    return (agent.allowAgents || []).map((id) => agentMap.get(id)).filter(Boolean) as Agent[];
  }

  const positions: NodePos[] = [];
  const leafXCounter = { val: 0 };

  function layoutDFS(agent: Agent, level: number): void {
    const children = getChildren(agent.id);

    if (children.length === 0) {
      positions.push({
        id: agent.id,
        x: leafXCounter.val,
        y: level * (NODE_H + V_GAP),
        width: NODE_W,
        height: NODE_H,
        agent,
      });
      leafXCounter.val += NODE_W + H_GAP;
    } else {
      for (const child of children) {
        layoutDFS(child, level + 1);
      }
      const childPositions = children.map((c) => positions.find((p) => p.id === c.id)).filter(Boolean) as NodePos[];
      const leftX = Math.min(...childPositions.map((p) => p.x));
      const rightX = Math.max(...childPositions.map((p) => p.x + p.width));
      const centerX = leftX + (rightX - leftX) / 2 - NODE_W / 2;
      positions.push({
        id: agent.id,
        x: centerX,
        y: level * (NODE_H + V_GAP),
        width: NODE_W,
        height: NODE_H,
        agent,
      });
    }
  }

  for (const root of roots) {
    layoutDFS(root, 0);
  }

  const minX = Math.min(...positions.map((p) => p.x));
  const maxX = Math.max(...positions.map((p) => p.x + p.width));
  const maxY = Math.max(...positions.map((p) => p.y + p.height));
  const padding = 40;
  const svgW = maxX - minX + padding * 2;
  const svgH = maxY + padding * 2;

  const offsetX = padding - minX;
  const offsetY = padding;

  const edges: Array<{ from: NodePos; to: NodePos }> = [];
  for (const pos of positions) {
    const children = getChildren(pos.id);
    for (const child of children) {
      const childPos = positions.find((p) => p.id === child.id);
      if (childPos) {
        edges.push({ from: pos, to: childPos });
      }
    }
  }

  return (
    <div style={{ overflowX: "auto", overflowY: "auto", padding: "1.5rem", position: "relative" }}>
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ fontFamily: "var(--font-heading, sans-serif)", display: "block", margin: "0 auto", maxWidth: "100%" }}
      >
        {/* SVG Defs for markers/effects */}
        <defs>
          <linearGradient id="edge-grad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="var(--border)" stopOpacity="0.5" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.8" />
          </linearGradient>
          <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx="0" dy="4" stdDeviation="6" floodColor="#000000" floodOpacity="0.4" />
          </filter>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Edges (Communication Flow) */}
        {edges.map(({ from, to }, i) => {
          const x1 = from.x + offsetX + from.width / 2;
          const y1 = from.y + offsetY + from.height;
          const x2 = to.x + offsetX + to.width / 2;
          const y2 = to.y + offsetY;
          const midY = (y1 + y2) / 2;

          const isHovered = hoveredId === from.id || hoveredId === to.id;

          return (
            <g key={i}>
              <path
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke={isHovered ? from.agent.color : "var(--border)"}
                strokeWidth={isHovered ? 2.5 : 1.5}
                opacity={isHovered ? 1 : 0.4}
                strokeDasharray={isHovered ? "6, 4" : "4, 4"}
                style={{ transition: "all 0.3s" }}
              />
              {/* Pulsing visual bubble for active paths */}
              {isHovered && (
                <circle r={3} fill={from.agent.color}>
                  <animateMotion
                    path={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                    dur="2.5s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
            </g>
          );
        })}

        {/* Nodes (Agents) */}
        {positions.map((pos) => {
          const x = pos.x + offsetX;
          const y = pos.y + offsetY;
          const agent = pos.agent;
          const isHovered = hoveredId === agent.id;
          const isOnline = agent.status === "online";

          return (
            <g
              key={pos.id}
              onMouseEnter={() => setHoveredId(agent.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => onSelectAgent?.(agent.id)}
              style={{ cursor: "pointer" }}
            >
              {/* Card background */}
              <rect
                x={x}
                y={y}
                width={pos.width}
                height={pos.height}
                rx={12}
                ry={12}
                fill={isHovered ? "var(--card-elevated)" : "var(--card)"}
                stroke={isHovered ? agent.color : "var(--border)"}
                strokeWidth={isHovered ? 2 : 1}
                filter={isHovered ? "url(#glow)" : "url(#shadow)"}
                style={{ transition: "all 0.3s" }}
              />

              {/* Side Accent color bar */}
              <rect
                x={x}
                y={y + 8}
                width={4}
                height={pos.height - 16}
                rx={2}
                fill={agent.color}
              />

              {/* Emoji inside custom circle */}
              <circle
                cx={x + 28}
                cy={y + pos.height / 2}
                r={18}
                fill={`${agent.color}15`}
                stroke={`${agent.color}33`}
                strokeWidth={1}
              />
              <text
                x={x + 28}
                y={y + pos.height / 2 + 6}
                fontSize={18}
                textAnchor="middle"
              >
                {agent.emoji}
              </text>

              {/* Name */}
              <text
                x={x + 56}
                y={y + pos.height / 2 - 4}
                fill="var(--text-primary)"
                fontSize={12}
                fontWeight={600}
                fontFamily="var(--font-heading, sans-serif)"
              >
                {agent.name.length > 15 ? agent.name.slice(0, 14) + "…" : agent.name}
              </text>

              {/* Model info */}
              <text
                x={x + 56}
                y={y + pos.height / 2 + 10}
                fill="var(--text-muted)"
                fontSize={9}
                fontFamily="monospace"
              >
                {agent.model.split("/").pop()?.slice(0, 18) || ""}
              </text>

              {/* Online/Offline Badge */}
              <circle
                cx={x + pos.width - 15}
                cy={y + 15}
                r={4}
                fill={isOnline ? "#4ade80" : "#6b7280"}
                style={{ filter: isOnline ? "drop-shadow(0 0 4px #4ade80)" : "none" }}
              />

              {/* Connected channels count */}
              {agent.botToken && (
                <text
                  x={x + pos.width - 18}
                  y={y + pos.height - 12}
                  fontSize={10}
                  fill="#0088cc"
                  fontWeight={700}
                >
                  ✈
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Legend / Caption */}
      <div style={{ display: "flex", gap: "1.5rem", justifyContent: "center", marginTop: "1.5rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#4ade80", display: "inline-block" }} /> Online
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#6b7280", display: "inline-block" }} /> Offline
        </span>
        <span>👉 Passe o mouse para ver fluxos de delegação</span>
      </div>
    </div>
  );
}
