'use client';

import { X } from 'lucide-react';
import type { AgentConfig, AgentState } from './agentsConfig';

interface AgentPanelProps {
  agent: AgentConfig;
  state?: AgentState;
  onClose: () => void;
}

const IDLE_STATE: AgentState = { id: '', status: 'idle' };

export default function AgentPanel({ agent, state: stateProp, onClose }: AgentPanelProps) {
  const state = stateProp ?? IDLE_STATE;
  const getStatusColor = () => {
    switch (state.status) {
      case 'working': return 'text-green-500';
      case 'thinking': return 'text-blue-500 animate-pulse';
      case 'delegating': return 'text-purple-500';
      case 'reviewing': return 'text-orange-500 animate-pulse';
      case 'stuck': return 'text-red-500 animate-pulse';
      case 'offline': return 'text-zinc-600';
      case 'idle':
      default: return 'text-gray-500';
    }
  };

  const getStatusBgColor = () => {
    switch (state.status) {
      case 'working': return 'bg-green-500/20';
      case 'thinking': return 'bg-blue-500/20';
      case 'delegating': return 'bg-purple-500/20';
      case 'reviewing': return 'bg-orange-500/20';
      case 'stuck': return 'bg-red-500/20';
      case 'offline': return 'bg-zinc-700/30';
      case 'idle':
      default: return 'bg-gray-500/20';
    }
  };

  return (
    <div className="absolute right-0 top-0 h-full w-96 bg-black/90 backdrop-blur-md text-white p-6 shadow-2xl border-l border-white/10">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <span className="text-4xl">{agent.emoji}</span>
            {agent.name}
          </h2>
          <p className="text-sm text-gray-400 mt-1">{agent.role}</p>
        </div>
        <button
          onClick={onClose}
          className="p-2 hover:bg-white/10 rounded-lg transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      {/* Status badge */}
      <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full mb-6 ${getStatusBgColor()}`}>
        <div className={`w-2 h-2 rounded-full ${state.status === 'thinking' ? 'animate-pulse' : ''}`} style={{ backgroundColor: agent.color }}></div>
        <span className={`text-sm font-medium ${getStatusColor()}`}>
          {state.status.toUpperCase()}
        </span>
      </div>

      {/* Current task */}
      {state.currentTask && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-400 mb-2">Current Task</h3>
          <p className="text-base">{state.currentTask}</p>
        </div>
      )}

      {/* Stats */}
      <div className="space-y-4 mb-6">
        <h3 className="text-sm font-semibold text-gray-400">Stats</h3>
        
        <div className="grid grid-cols-2 gap-4">
          {/* Model */}
          <div className="bg-white/5 p-3 rounded-lg">
            <p className="text-xs text-gray-400 mb-1">Model</p>
            <p className="text-lg font-bold capitalize">{state.model || 'N/A'}</p>
          </div>

          {/* Tokens/hour */}
          <div className="bg-white/5 p-3 rounded-lg">
            <p className="text-xs text-gray-400 mb-1">Tokens/hour</p>
            <p className="text-lg font-bold">{state.tokensPerHour?.toLocaleString() || '0'}</p>
          </div>

          {/* Tasks in queue */}
          <div className="bg-white/5 p-3 rounded-lg">
            <p className="text-xs text-gray-400 mb-1">Queue</p>
            <p className="text-lg font-bold">{state.tasksInQueue || 0} tasks</p>
          </div>

          {/* Uptime */}
          <div className="bg-white/5 p-3 rounded-lg">
            <p className="text-xs text-gray-400 mb-1">Uptime</p>
            <p className="text-lg font-bold">{state.uptime || 0} days</p>
          </div>
        </div>
      </div>

      {/* Activity Feed (placeholder) */}
      <div>
        <h3 className="text-sm font-semibold text-gray-400 mb-3">Recent Activity</h3>
        <div className="space-y-2">
          <div className="bg-white/5 p-3 rounded-lg text-sm">
            <p className="text-gray-400 text-xs mb-1">2 minutes ago</p>
            <p>Completed task: Generate report</p>
          </div>
          <div className="bg-white/5 p-3 rounded-lg text-sm">
            <p className="text-gray-400 text-xs mb-1">15 minutes ago</p>
            <p>Started: {state.currentTask || 'Processing data'}</p>
          </div>
          <div className="bg-white/5 p-3 rounded-lg text-sm">
            <p className="text-gray-400 text-xs mb-1">1 hour ago</p>
            <p>Switched model to {state.model}</p>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-6 pt-6 border-t border-white/10">
        <h3 className="text-sm font-semibold text-gray-400 mb-3">Quick Actions</h3>
        <div className="grid grid-cols-2 gap-2">
          <button className="px-3 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm transition-colors">
            Send Message
          </button>
          <button className="px-3 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm transition-colors">
            View History
          </button>
          <button className="px-3 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm transition-colors">
            Change Model
          </button>
          <button className="px-3 py-2 bg-red-500/20 hover:bg-red-500/30 rounded-lg text-sm transition-colors text-red-400">
            Kill Task
          </button>
        </div>
      </div>
    </div>
  );
}
