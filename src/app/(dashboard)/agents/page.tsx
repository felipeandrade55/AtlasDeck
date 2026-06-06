"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Circle,
  MessageSquare,
  Shield,
  Users,
  Activity,
  GitBranch,
  LayoutGrid,
  Radio,
  Plus,
  Edit2,
  Trash2,
  X,
  HelpCircle,
  ArrowRight,
  Cpu,
  Sparkles,
} from "lucide-react";
import { AgentOrganigrama } from "@/components/AgentOrganigrama";
import { AgentTemplatePicker, type AgentTemplate } from "@/components/AgentTemplatePicker";
import { OperatorChatPanel } from "@/components/OperatorChatPanel";
import { OrchestrationSettingsCard } from "@/components/OrchestrationSettingsCard";
import { LearningsTimeline } from "@/components/LearningsTimeline";
import { LiveMissionTab } from "@/components/LiveMission/LiveMissionTab";
import { ModelPicker } from "@/components/ModelPicker";
import { OpenClawDefaultsCard } from "@/components/OpenClawDefaultsCard";
import { RestartStatusBanner } from "@/components/RestartStatusBanner";
import { WorkspaceImporter } from "@/components/WorkspaceImporter";
import { AgentMemoryConnector } from "@/components/AgentMemoryConnector";
import { MemoryIngestPanel } from "@/components/MemoryIngestPanel";
import { MemoryConnectNudge } from "@/components/MemoryConnectNudge";
import { validateModelId } from "@/lib/openclaw-models";
import {
  restartGatewayClient,
  getAutoRestartPref,
  type ClientRestartResult,
} from "@/lib/restart-gateway-client";

interface Agent {
  id: string;
  name: string;
  emoji: string;
  color: string;
  model: string;
  fallback?: string;
  workspace: string;
  dmPolicy?: string;
  allowAgents: string[];
  allowAgentsDetails?: Array<{
    id: string;
    name: string;
    emoji: string;
    color: string;
  }>;
  botToken?: string;
  status: "online" | "offline";
  lastActivity?: string;
  activeSessions: number;
  role?: "orchestrator" | "specialist" | "reviewer";
  specialty?: string[];
  inherit_jarvis_skills?: boolean;
  override_autonomous?: "inherit" | "force_manual" | "force_auto";
  cost_caps?: { per_task_cents?: number | null; per_day_cents?: number | null };
  template_id?: string;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"cards" | "organigrama" | "live">("cards");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  
  // Modals / Form State
  const [showModal, setShowModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [formId, setFormId] = useState("");
  const [formName, setFormName] = useState("");
  const [formEmoji, setFormEmoji] = useState("🤖");
  const [formColor, setFormColor] = useState("#3b82f6");
  const [formModel, setFormModel] = useState("openai/gpt-5.5-codex");
  const [formFallback, setFormFallback] = useState("");
  const [formWorkspace, setFormWorkspace] = useState("");
  const [formDmPolicy, setFormDmPolicy] = useState("pairing");
  const [formBotToken, setFormBotToken] = useState("");
  // When set to an agent id (e.g. "main"), the backend reuses that agent's
  // saved botToken for the new/edited agent — letting the user spin up
  // unlimited sub-agents that all answer on the same Telegram bot without
  // re-typing the token. Empty string = use own token (formBotToken).
  const [formShareBotWith, setFormShareBotWith] = useState<string>("");
  const [formAllowAgents, setFormAllowAgents] = useState<string[]>([]);
  // Multi-agent orchestration meta (stored in agents-meta.json on save)
  const [formRole, setFormRole] = useState<"orchestrator" | "specialist" | "reviewer">("specialist");
  const [formSpecialty, setFormSpecialty] = useState<string[]>([]);
  const [formSpecialtyInput, setFormSpecialtyInput] = useState("");
  const [formInheritSkills, setFormInheritSkills] = useState(true);
  const [formOverrideAutonomous, setFormOverrideAutonomous] = useState<
    "inherit" | "force_manual" | "force_auto"
  >("inherit");
  const [formCostPerTask, setFormCostPerTask] = useState<string>("");
  const [formCostPerDay, setFormCostPerDay] = useState<string>("");
  const [formTemplateId, setFormTemplateId] = useState<string | undefined>(undefined);
  const [errorMsg, setErrorMsg] = useState("");

  // Gateway auto-restart after saving an agent (so the new model takes effect)
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<ClientRestartResult | null>(null);

  // Existing Telegram account IDs — surfaced as suggestions so the user picks
  // an agent ID that matches a configured bot account (otherwise Telegram
  // messages silently fail to route).
  const [telegramAccountIds, setTelegramAccountIds] = useState<string[]>([]);

  const fetchTelegramAccountIds = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/telegram?live=0", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const ids = Array.isArray(data?.accounts)
        ? (data.accounts as Array<{ id: string; hasToken: boolean }>)
            .filter((a) => a.hasToken)
            .map((a) => a.id)
        : [];
      setTelegramAccountIds(ids);
    } catch {
      // best effort — no warning needed
    }
  }, []);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      const data = await res.json();
      setAgents(data.agents || []);
    } catch (error) {
      console.error("Error fetching agents:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, 8000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  const handleOpenCreate = () => {
    setEditingAgent(null);
    setFormId("");
    setFormName("");
    setFormEmoji("🤖");
    setFormColor("#3b82f6");
    setFormModel("openai/gpt-5.5-codex");
    setFormFallback("");
    setFormWorkspace("");
    setFormDmPolicy("pairing");
    setFormBotToken("");
    setFormShareBotWith("");
    setFormAllowAgents([]);
    setFormRole("specialist");
    setFormSpecialty([]);
    setFormSpecialtyInput("");
    setFormInheritSkills(true);
    setFormOverrideAutonomous("inherit");
    setFormCostPerTask("");
    setFormCostPerDay("");
    setFormTemplateId(undefined);
    setErrorMsg("");
    setShowModal(true);
    void fetchTelegramAccountIds();
  };

  // Pre-fills the create form from a template. Everything stays editable —
  // the template_id is just persisted so the UI can show "based on dev" later.
  const applyTemplate = (t: AgentTemplate) => {
    setFormId((cur) => cur || t.id);
    setFormName((cur) => cur || t.name);
    setFormEmoji(t.emoji);
    setFormColor(t.color);
    setFormModel(t.suggested_model);
    setFormFallback(t.suggested_fallback || "");
    setFormRole(t.role);
    setFormSpecialty(t.specialty);
    setFormInheritSkills(t.inherit_jarvis_skills);
    setFormCostPerTask(
      t.default_cost_caps?.per_task_cents !== undefined
        ? String(t.default_cost_caps.per_task_cents)
        : "",
    );
    setFormCostPerDay(
      t.default_cost_caps?.per_day_cents !== undefined
        ? String(t.default_cost_caps.per_day_cents)
        : "",
    );
    setFormTemplateId(t.id);
  };

  const handleOpenEdit = (agent: Agent) => {
    setEditingAgent(agent);
    setFormId(agent.id);
    setFormName(agent.name);
    setFormEmoji(agent.emoji);
    setFormColor(agent.color);
    setFormModel(agent.model);
    setFormFallback(agent.fallback || "");
    setFormWorkspace(agent.workspace);
    setFormDmPolicy(agent.dmPolicy || "pairing");
    setFormBotToken(agent.botToken === "configured" ? "configured" : "");
    setFormShareBotWith("");
    setFormAllowAgents(agent.allowAgents || []);
    setFormRole(agent.role || "specialist");
    setFormSpecialty(agent.specialty || []);
    setFormSpecialtyInput("");
    setFormInheritSkills(agent.inherit_jarvis_skills ?? true);
    setFormOverrideAutonomous(agent.override_autonomous || "inherit");
    setFormCostPerTask(
      typeof agent.cost_caps?.per_task_cents === "number" ? String(agent.cost_caps.per_task_cents) : "",
    );
    setFormCostPerDay(
      typeof agent.cost_caps?.per_day_cents === "number" ? String(agent.cost_caps.per_day_cents) : "",
    );
    setFormTemplateId(agent.template_id);
    setErrorMsg("");
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formId.trim() || !formName.trim()) {
      setErrorMsg("ID e Nome são obrigatórios.");
      return;
    }

    const primaryWarning = validateModelId(formModel);
    if (primaryWarning?.level === "error") {
      setErrorMsg(`Modelo primário inválido: ${primaryWarning.message}`);
      return;
    }
    if (formFallback.trim()) {
      const fbWarning = validateModelId(formFallback);
      if (fbWarning?.level === "error") {
        setErrorMsg(`Modelo de fallback inválido: ${fbWarning.message}`);
        return;
      }
    }

    const isEdit = !!editingAgent;
    const url = "/api/agents";
    const method = isEdit ? "PUT" : "POST";

    // When the user opted to reuse another agent's bot, send shareBotWith
    // INSTEAD of botToken so the backend pulls the token from the source
    // account — the real token never crosses back through the browser.
    // Filter out shareBotWith pointing at the current agent (would be a
    // self-reference no-op) and ignore it when editing the source agent
    // itself (you can't reuse your own bot).
    const useSharedBot =
      formShareBotWith.trim().length > 0 && formShareBotWith.trim() !== formId.trim();

    const payload: Record<string, unknown> = {
      id: formId.trim(),
      name: formName.trim(),
      emoji: formEmoji,
      color: formColor,
      model: formModel,
      fallback: formFallback.trim(),
      workspace: formWorkspace.trim() || `./workspace/${formId.trim()}`,
      dmPolicy: formDmPolicy,
      allowAgents: formAllowAgents,
      // Orchestration meta — backend persists in agents-meta.json so the
      // openclaw.json strict schema stays clean.
      role: formRole,
      specialty: formSpecialty,
      inherit_jarvis_skills: formInheritSkills,
      override_autonomous: formOverrideAutonomous,
      cost_caps: {
        per_task_cents: formCostPerTask.trim() ? Number(formCostPerTask) : null,
        per_day_cents: formCostPerDay.trim() ? Number(formCostPerDay) : null,
      },
      template_id: formTemplateId,
    };
    if (useSharedBot) {
      payload.shareBotWith = formShareBotWith.trim();
    } else {
      payload.botToken = formBotToken;
    }

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || "Ocorreu um erro ao salvar o agente.");
        return;
      }
      setShowModal(false);
      fetchAgents();
      // Auto-restart gateway so the new model.primary / fallback takes effect.
      // OpenClaw caches openclaw.json on boot; without restart the daemon keeps
      // the previous model in memory.
      if (getAutoRestartPref()) {
        setRestarting(true);
        setRestartResult(null);
        const result = await restartGatewayClient();
        setRestartResult(result);
        setRestarting(false);
        // Auto-dismiss success banner after a few seconds
        if (result.success) {
          setTimeout(() => setRestartResult((r) => (r?.success ? null : r)), 5000);
        }
      }
    } catch {
      setErrorMsg("Erro de conexão ao servidor.");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(`Deseja realmente remover o agente ${id}? Isto limpará suas delegações correspondentes.`)) return;

    try {
      const res = await fetch(`/api/agents?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setSelectedAgentId(null);
        fetchAgents();
      }
    } catch (error) {
      console.error("Failed to delete agent:", error);
    }
  };

  const toggleFormSubagent = (subId: string) => {
    setFormAllowAgents(prev => 
      prev.includes(subId) ? prev.filter(x => x !== subId) : [...prev, subId]
    );
  };

  const formatLastActivity = (timestamp?: string) => {
    if (!timestamp) return "Nunca";
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "Agora mesmo";
    if (minutes < 60) return `há ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `há ${hours}h`;
    const days = Math.floor(hours / 24);
    return `há ${days}d`;
  };

  const selectedAgent = agents.find(a => a.id === selectedAgentId);

  if (loading && agents.length === 0) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="flex flex-col items-center gap-3">
            <Cpu className="w-8 h-8 animate-spin" style={{ color: "var(--accent)" }} />
            <span style={{ color: "var(--text-secondary)" }}>Carregando Enxame de Agentes...</span>
          </div>
        </div>
      </div>
    );
  }

  // Aggregate stats
  const totalAgents = agents.length;
  const onlineAgents = agents.filter(a => a.status === "online").length;
  const activeSessions = agents.reduce((acc, curr) => acc + (curr.activeSessions || 0), 0);
  const connectedBots = agents.filter(a => a.botToken).length;

  return (
    <div className="p-4 md:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-2 flex items-center gap-2"
            style={{
              fontFamily: "var(--font-heading)",
              color: "var(--text-primary)",
              letterSpacing: "-1px",
            }}
          >
            <Users className="w-8 h-8" style={{ color: "var(--accent)" }} />
            Agentes
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "14px" }}>
            Visão geral do enxame de agentes • Controle de delegação em tempo real
          </p>
        </div>
        
        <button
          onClick={handleOpenCreate}
          className="flex items-center gap-2 px-4 py-2 rounded-lg font-semibold transition-all hover:scale-105"
          style={{ backgroundColor: "var(--accent)", color: "white", border: "none", cursor: "pointer" }}
        >
          <Plus className="w-4 h-4" />
          Adicionar Agente
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { icon: Users, label: "Total de Agentes", value: totalAgents.toString(), color: "var(--accent)" },
          { icon: Circle, label: "Ativos Agora", value: `${onlineAgents} online`, color: onlineAgents > 0 ? "var(--success)" : "var(--text-muted)", fillDot: true },
          { icon: Activity, label: "Sessões de Trabalho", value: activeSessions.toString(), color: "var(--warning)" },
          { icon: MessageSquare, label: "Telegram Bots", value: `${connectedBots} integrados`, color: "#0088cc" },
        ].map((kpi, idx) => {
          const KIcon = kpi.icon;
          return (
            <div key={idx} className="p-4 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
              <div className="flex items-center gap-2 mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                <KIcon className="w-4 h-4" style={{ color: kpi.color, fill: kpi.fillDot ? kpi.color : "none" }} />
                {kpi.label}
              </div>
              <div className="text-xl md:text-2xl font-bold" style={{ color: "var(--text-primary)" }}>{kpi.value}</div>
            </div>
          );
        })}
      </div>

      {/* Orchestration global switches (autonomous_mode etc.) */}
      <OrchestrationSettingsCard />

      {/* What Jarvis learned about the user — preference model timeline */}
      <LearningsTimeline />

      {/* OpenClaw Defaults (global) */}
      <OpenClawDefaultsCard onSaved={fetchAgents} />

      {/* Nudge: detected memory resources not yet wired to instructions.md */}
      <MemoryConnectNudge
        agents={agents.map((a) => ({ id: a.id, name: a.name }))}
        onOpenAgent={(id) => {
          const a = agents.find((x) => x.id === id);
          if (a) handleOpenEdit(a);
        }}
        onChanged={fetchAgents}
      />

      <RestartStatusBanner
        restarting={restarting}
        result={restartResult}
        successHint="mudanças aplicadas"
        className="flex flex-col gap-2 p-3 rounded-xl text-sm border"
      />

      {/* Delegation Warning Tip */}
      <div className="flex items-start gap-3 p-4 rounded-xl text-sm" style={{ backgroundColor: "rgba(59,130,246,0.06)", border: "1px solid rgba(59,130,246,0.15)" }}>
        <HelpCircle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: "#3b82f6" }} />
        <div style={{ color: "var(--text-secondary)" }}>
          <span className="font-semibold text-white">Como funciona a delegação?</span> Ao configurar um agente principal (ex: <code className="text-xs px-1 py-0.5 rounded bg-zinc-800">main</code>), você pode definir quais sub-agentes ele tem permissão para disparar. Quando você pedir algo complexo no chat ou no Telegram, o OpenClaw principal enviará tarefas automaticamente para o sub-agente correspondente de forma transparente!
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-2 border-b" style={{ borderColor: "var(--border)" }}>
        {[
          { id: "cards" as const, label: "Cards dos Agentes", icon: LayoutGrid },
          { id: "organigrama" as const, label: "Visualização de Fluxos (Organograma)", icon: GitBranch },
          { id: "live" as const, label: "Live Mission", icon: Radio },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className="flex items-center gap-2 px-4 py-2 font-semibold transition-all"
            style={{
              color: activeTab === id ? "var(--accent)" : "var(--text-secondary)",
              borderBottom: activeTab === id ? "2px solid var(--accent)" : "2px solid transparent",
              background: "none", border: "none", cursor: "pointer",
              paddingBottom: "0.75rem",
            }}
          >
            <Icon className="w-4.5 h-4.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Main Views */}
      {activeTab === "organigrama" && (
        <div className="rounded-xl overflow-hidden" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <div className="px-5 py-4 border-b" style={{ borderColor: "var(--border)" }}>
            <h2 className="font-bold text-lg" style={{ color: "var(--text-primary)" }}>Hierarquia de Delegação de Tarefas</h2>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Gráfico interativo ilustrando a rede de sub-agentes permitidos por origem</p>
          </div>
          <AgentOrganigrama agents={agents} onSelectAgent={setSelectedAgentId} />
        </div>
      )}

      {activeTab === "live" && (
        <LiveMissionTab
          agents={agents.map((a) => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color }))}
        />
      )}

      {activeTab === "cards" && agents.length === 0 && (
        <div
          className="rounded-xl p-6 md:p-8 flex flex-col sm:flex-row items-start gap-4"
          style={{
            backgroundColor: "rgba(139, 92, 246, 0.05)",
            border: "1px dashed rgba(139, 92, 246, 0.4)",
          }}
        >
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
            style={{ backgroundColor: "rgba(139, 92, 246, 0.15)" }}
          >
            <Users className="w-6 h-6" style={{ color: "#a78bfa" }} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-base" style={{ color: "var(--text-primary)" }}>
              Nenhum agente configurado ainda
            </h3>
            <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
              O OpenClaw só responde no Telegram/chat quando há pelo menos um agente cadastrado.
              Sem isso, mensagens ficam num loop de &ldquo;Something went wrong, use /new&rdquo;.
            </p>
            <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>
              Crie o agente <code>main</code> aqui — pode colar o token do Telegram no mesmo modal.
              Após salvar, o gateway reinicia sozinho e o bot volta a responder.
            </p>
            <button
              onClick={handleOpenCreate}
              className="flex items-center gap-2 mt-4 px-3.5 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                backgroundColor: "rgba(139, 92, 246, 0.2)",
                color: "#c4b5fd",
                border: "1px solid rgba(139, 92, 246, 0.4)",
              }}
            >
              <Plus className="w-4 h-4" />
              Criar o agente &lsquo;main&rsquo; agora
            </button>
          </div>
        </div>
      )}

      {activeTab === "cards" && agents.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => (
            <div
              key={agent.id}
              onClick={() => setSelectedAgentId(agent.id)}
              className="rounded-xl overflow-hidden transition-all hover:-translate-y-1 hover:shadow-lg cursor-pointer"
              style={{
                backgroundColor: "var(--card)",
                border: selectedAgentId === agent.id ? `2px solid ${agent.color}` : "1px solid var(--border)",
              }}
            >
              {/* Card Header */}
              <div
                className="px-4 py-3 flex items-center justify-between border-b"
                style={{
                  borderColor: "var(--border)",
                  background: `linear-gradient(135deg, ${agent.color}10, transparent)`,
                }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center text-xl"
                    style={{
                      backgroundColor: `${agent.color}15`,
                      border: `1.5px solid ${agent.color}40`,
                    }}
                  >
                    {agent.emoji}
                  </div>
                  <div>
                    <h3 className="font-bold text-sm md:text-base" style={{ color: "var(--text-primary)" }}>
                      {agent.name}
                    </h3>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: agent.status === "online" ? "#4ade80" : "#6b7280" }} />
                      <span
                        className="text-[10px] font-semibold uppercase tracking-wider"
                        style={{ color: agent.status === "online" ? "#4ade80" : "var(--text-muted)" }}
                        title={agent.status === "online"
                          ? "Escreveu na memória há menos de 5min"
                          : "Sem escrita na memória nos últimos 5min — não confirma estado do daemon. Para checar o processo, use Resgate → 'Diagnosticar Tudo'."}
                      >
                        {agent.status === "online" ? "ativo" : "inativo"}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleOpenEdit(agent); }}
                    className="p-1.5 rounded-md hover:bg-zinc-800 transition-colors"
                    style={{ color: "var(--text-muted)", border: "none", background: "none", cursor: "pointer" }}
                    title="Editar Agente"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(agent.id); }}
                    className="p-1.5 rounded-md hover:bg-red-950 transition-colors"
                    style={{ color: "#ef4444", border: "none", background: "none", cursor: "pointer" }}
                    title="Excluir Agente"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Card Body */}
              <div className="p-4 space-y-3 text-xs">
                <div className="flex justify-between">
                  <span style={{ color: "var(--text-muted)" }}>Modelo Principal</span>
                  <span className="font-mono text-white text-[11px] truncate max-w-[160px]" title={agent.model}>
                    {agent.model.split("/").pop()}
                  </span>
                </div>
                {(() => {
                  const w = validateModelId(agent.model);
                  if (!w) return null;
                  return (
                    <div
                      className="text-[10px] px-2 py-1 rounded -mt-1.5"
                      style={{
                        backgroundColor: w.level === "error" ? "rgba(239,68,68,0.1)" : "rgba(234,179,8,0.1)",
                        color: w.level === "error" ? "#fca5a5" : "#fde68a",
                        border: `1px solid ${w.level === "error" ? "rgba(239,68,68,0.3)" : "rgba(234,179,8,0.3)"}`,
                      }}
                    >
                      ⚠ {w.message}
                    </div>
                  );
                })()}
                <div className="flex justify-between">
                  <span style={{ color: "var(--text-muted)" }}>Modelo Fallback</span>
                  <span className="font-mono text-[11px] truncate max-w-[160px]" title={agent.fallback || "(herda default)"} style={{ color: agent.fallback ? "white" : "var(--text-muted)" }}>
                    {agent.fallback ? agent.fallback.split("/").pop() : "(default global)"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: "var(--text-muted)" }}>Sub-agentes Ativos</span>
                  <span className="font-semibold text-white">{agent.allowAgents.length}</span>
                </div>
                <div className="flex justify-between">
                  <span style={{ color: "var(--text-muted)" }}>Workspace</span>
                  <span className="font-mono text-[10px] text-zinc-400 truncate max-w-[160px]">{agent.workspace}</span>
                </div>

                {agent.allowAgents.length > 0 && (
                  <div className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
                    <div className="mb-1 text-[10px] uppercase font-bold text-zinc-500">Delega chamadas para:</div>
                    <div className="flex flex-wrap gap-1">
                      {agent.allowAgentsDetails?.map(sub => (
                        <span key={sub.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: `${sub.color}15`, color: sub.color, border: `1.5px solid ${sub.color}25` }}>
                          <span>{sub.emoji}</span>
                          <span>{sub.name}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Drawer / Sidebar de Detalhes do Agente */}
      {selectedAgent && (
        <div className="fixed inset-y-0 right-0 w-full max-w-md bg-zinc-950 shadow-2xl border-l z-50 p-6 flex flex-col space-y-6 animate-in slide-in-from-right duration-200" style={{ borderColor: "var(--border)", backgroundColor: "var(--card-elevated)" }}>
          <div className="flex items-center justify-between border-b pb-4" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center gap-3">
              <div className="text-3xl p-1.5 rounded-lg" style={{ backgroundColor: `${selectedAgent.color}15`, border: `1.5px solid ${selectedAgent.color}40` }}>{selectedAgent.emoji}</div>
              <div>
                <h2 className="font-bold text-lg text-white">{selectedAgent.name}</h2>
                <div className="flex items-center gap-1">
                  <Circle className="w-2 h-2" style={{ fill: selectedAgent.status === "online" ? "#4ade80" : "#6b7280", color: selectedAgent.status === "online" ? "#4ade80" : "#6b7280" }} />
                  <span
                    className="text-xs text-zinc-400 capitalize"
                    title={selectedAgent.status === "online"
                      ? "Escreveu na memória há menos de 5min"
                      : "Sem escrita na memória recente — não confirma estado do daemon"}
                  >
                    {selectedAgent.status === "online" ? "ativo (memória recente)" : "inativo (sem memória recente)"}
                  </span>
                </div>
              </div>
            </div>
            <button onClick={() => setSelectedAgentId(null)} className="p-1 rounded-md hover:bg-zinc-800 text-zinc-400" style={{ background: "none", border: "none", cursor: "pointer" }}>
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-5 text-sm pr-1">
            <div className="space-y-3">
              <h3 className="font-bold text-xs uppercase tracking-wider text-zinc-500">Configurações Gerais</h3>
              <div className="space-y-2.5 p-3 rounded-lg bg-zinc-900/50 border" style={{ borderColor: "var(--border)" }}>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">ID Único:</span>
                  <span className="font-mono text-white font-bold">{selectedAgent.id}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">Modelo Primário:</span>
                  <span className="font-mono text-white">{selectedAgent.model}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">Modelo Fallback:</span>
                  <span className="font-mono" style={{ color: selectedAgent.fallback ? "white" : "var(--text-muted)" }}>
                    {selectedAgent.fallback || "(herda default global)"}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">Diretório Workspace:</span>
                  <span className="font-mono text-zinc-300">{selectedAgent.workspace}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">Política de DM:</span>
                  <span className="text-white capitalize">{selectedAgent.dmPolicy}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-400">Integração Telegram:</span>
                  <span className="font-bold" style={{ color: selectedAgent.botToken ? "#0088cc" : "var(--text-muted)" }}>
                    {selectedAgent.botToken ? "✓ Ativo" : "Não configurado"}
                  </span>
                </div>
              </div>
            </div>

            {/* Subagent delegation detail */}
            <div className="space-y-3">
              <h3 className="font-bold text-xs uppercase tracking-wider text-zinc-500">Sub-agentes Autorizados</h3>
              {selectedAgent.allowAgents.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs text-zinc-400">Este agente tem permissão para acionar e delegar tarefas aos seguintes sub-agentes:</p>
                  <div className="grid grid-cols-1 gap-2">
                    {selectedAgent.allowAgentsDetails?.map(sub => (
                      <div key={sub.id} className="flex items-center justify-between p-2.5 rounded-lg border text-xs" style={{ borderColor: "var(--border)", backgroundColor: "var(--card)" }}>
                        <div className="flex items-center gap-2">
                          <span>{sub.emoji}</span>
                          <span className="font-semibold text-white">{sub.name}</span>
                          <span className="text-[10px] font-mono text-zinc-500">({sub.id})</span>
                        </div>
                        <ArrowRight className="w-3.5 h-3.5 text-zinc-500" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-4 text-center rounded-lg border text-xs text-zinc-500" style={{ borderColor: "var(--border)", backgroundColor: "var(--card)" }}>
                  Este agente não pode delegar tarefas para sub-agentes. Ele resolve tudo de forma isolada.
                </div>
              )}
            </div>

            {/* Activity integrations */}
            <div className="space-y-3">
              <h3 className="font-bold text-xs uppercase tracking-wider text-zinc-500">Atividade Recente</h3>
              <div className="p-3 rounded-lg border space-y-2 text-xs" style={{ borderColor: "var(--border)", backgroundColor: "var(--card)" }}>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Última ação registrada:</span>
                  <span className="text-white font-medium">{formatLastActivity(selectedAgent.lastActivity)}</span>
                </div>
                <a
                  href={`/activity?agent=${selectedAgent.id}`}
                  className="flex items-center justify-center gap-1.5 w-full py-2 mt-2 rounded-md font-semibold transition-all"
                  style={{ backgroundColor: "var(--accent)", color: "white", textDecoration: "none" }}
                >
                  <Activity className="w-3.5 h-3.5" />
                  Ver Histórico de Atividades
                </a>
              </div>
            </div>
          </div>

          <div className="flex gap-3 pt-4 border-t" style={{ borderColor: "var(--border)" }}>
            <button
              onClick={() => handleOpenEdit(selectedAgent)}
              className="flex-1 py-2 rounded-lg font-semibold border flex items-center justify-center gap-2 transition-all hover:bg-zinc-800 text-white"
              style={{ borderColor: "var(--border)", backgroundColor: "transparent", cursor: "pointer" }}
            >
              <Edit2 className="w-4 h-4" /> Editar
            </button>
            <button
              onClick={() => handleDelete(selectedAgent.id)}
              className="flex-1 py-2 rounded-lg font-semibold flex items-center justify-center gap-2 transition-all hover:bg-red-950 text-white"
              style={{ backgroundColor: "#ef4444", border: "none", cursor: "pointer" }}
            >
              <Trash2 className="w-4 h-4" /> Excluir
            </button>
          </div>
        </div>
      )}

      {/* Modal Criar / Editar Agente */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-zinc-950 border rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150" style={{ borderColor: "var(--border)", backgroundColor: "var(--card-elevated)" }}>
            <div className="px-6 py-4 border-b flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
              <h3 className="font-bold text-lg text-white">
                {editingAgent ? `Editar Agente: ${editingAgent.id}` : "Adicionar Novo Agente ao Enxame"}
              </h3>
              <button onClick={() => setShowModal(false)} className="p-1 rounded-md hover:bg-zinc-800 text-zinc-400" style={{ background: "none", border: "none", cursor: "pointer" }}>
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
              {errorMsg && (
                <div className="p-3 text-xs font-semibold rounded-lg bg-red-950/40 border border-red-500/20 text-red-400">
                  {errorMsg}
                </div>
              )}

              {!editingAgent && (
                <AgentTemplatePicker
                  selectedTemplateId={formTemplateId}
                  onPick={applyTemplate}
                />
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label className="block space-y-1">
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">ID do Agente (Fixo)</span>
                  <input
                    disabled={!!editingAgent}
                    value={formId}
                    onChange={(e) => setFormId(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                    placeholder="ex: data-analyst"
                    className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white"
                    style={{ borderColor: "var(--border)" }}
                  />
                  {!editingAgent && telegramAccountIds.length > 0 && (() => {
                    const orphans = telegramAccountIds.filter(
                      (id) => !agents.some((a) => a.id === id),
                    );
                    if (orphans.length === 0) return null;
                    const mismatch = formId.trim() && !orphans.includes(formId.trim());
                    return (
                      <div
                        className="mt-1.5 text-[10px] px-2 py-1.5 rounded leading-relaxed"
                        style={{
                          backgroundColor: mismatch ? "rgba(234,179,8,0.1)" : "rgba(59,130,246,0.1)",
                          color: mismatch ? "#fde68a" : "#93c5fd",
                          border: `1px solid ${mismatch ? "rgba(234,179,8,0.3)" : "rgba(59,130,246,0.3)"}`,
                        }}
                      >
                        {mismatch ? "⚠ " : "💡 "}
                        Conta{orphans.length > 1 ? "s" : ""} Telegram sem agente{orphans.length > 1 ? "s" : ""}: {" "}
                        {orphans.map((id, i) => (
                          <span key={id}>
                            <button
                              type="button"
                              onClick={() => setFormId(id)}
                              className="font-mono font-bold underline cursor-pointer hover:opacity-80"
                            >
                              {id}
                            </button>
                            {i < orphans.length - 1 ? ", " : ""}
                          </span>
                        ))}
                        {mismatch
                          ? ` — clique pra usar (assim o bot @${orphans[0]} vai rotear pra este agente).`
                          : " — use uma dessas IDs pra que o bot do Telegram saiba pra onde mandar mensagens."}
                      </div>
                    );
                  })()}
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Nome de Exibição</span>
                  <input
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="ex: Analista de Dados"
                    className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white"
                    style={{ borderColor: "var(--border)" }}
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block space-y-1 col-span-1">
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Emoji</span>
                  <input
                    value={formEmoji}
                    onChange={(e) => setFormEmoji(e.target.value)}
                    placeholder="🤖"
                    maxLength={4}
                    className="w-full px-3 py-2 text-center rounded-lg text-sm outline-none bg-zinc-900 border text-white"
                    style={{ borderColor: "var(--border)" }}
                  />
                </label>

                <label className="block space-y-1 col-span-2">
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Cor do Tema</span>
                  <div className="flex gap-2">
                    <input
                      type="color"
                      value={formColor}
                      onChange={(e) => setFormColor(e.target.value)}
                      className="w-10 h-8 rounded border-none cursor-pointer bg-transparent"
                    />
                    <input
                      value={formColor}
                      onChange={(e) => setFormColor(e.target.value)}
                      placeholder="#3b82f6"
                      className="min-w-0 flex-1 px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white font-mono"
                      style={{ borderColor: "var(--border)" }}
                    />
                  </div>
                </label>
              </div>

              <label className="block space-y-1">
                <span className="flex items-center gap-1.5 text-xs font-bold text-zinc-400 uppercase tracking-wide">
                  <Sparkles className="w-3 h-3" />
                  Modelo de IA Primário
                </span>
                <ModelPicker value={formModel} onChange={setFormModel} />
              </label>

              <label className="block space-y-1">
                <span className="flex items-center gap-1.5 text-xs font-bold text-zinc-400 uppercase tracking-wide">
                  <Shield className="w-3 h-3" />
                  Modelo de Fallback (opcional)
                </span>
                <ModelPicker
                  value={formFallback}
                  onChange={setFormFallback}
                  allowEmpty
                  emptyLabel="(usar o default global)"
                />
                <span className="text-[10px] text-zinc-500 block">
                  Usado se o primário ficar inalcançável. Se vazio, herda o fallback definido nos defaults globais acima.
                </span>
              </label>

              <label className="block space-y-1">
                <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Diretório Workspace no Servidor</span>
                <input
                  value={formWorkspace}
                  onChange={(e) => setFormWorkspace(e.target.value)}
                  placeholder="ex: ./workspace/data-analyst (ou deixar em branco para auto)"
                  className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-zinc-300 font-mono"
                  style={{ borderColor: "var(--border)" }}
                />
              </label>

              {/* Subagents Checklist - Delegation Mappings */}
              <div className="space-y-1.5">
                <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide block">Delegação: Permissões de Sub-Agente</span>
                <span className="text-[10px] text-zinc-500 block mb-1">Selecione quais outros agentes este agente pode instanciar e delegar sub-tarefas:</span>
                <div className="max-h-28 overflow-y-auto p-2 rounded-lg bg-zinc-900 border space-y-1.5" style={{ borderColor: "var(--border)" }}>
                  {agents.filter(a => a.id !== formId).map(a => (
                    <label key={a.id} className="flex items-center gap-2 text-xs text-white cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={formAllowAgents.includes(a.id)}
                        onChange={() => toggleFormSubagent(a.id)}
                        className="rounded text-red-500 focus:ring-0 cursor-pointer"
                      />
                      <span>{a.emoji}</span>
                      <span className="font-semibold">{a.name}</span>
                      <span className="text-[10px] text-zinc-500">({a.id})</span>
                    </label>
                  ))}
                  {agents.filter(a => a.id !== formId).length === 0 && (
                    <div className="text-center py-2 text-zinc-500 text-xs">Crie outros agentes primeiro para permitir delegação.</div>
                  )}
                </div>
              </div>

              {/* Orchestration Meta Fold */}
              <div className="pt-3 border-t space-y-3" style={{ borderColor: "var(--border)" }}>
                <h4 className="font-bold text-xs uppercase text-zinc-400 tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-purple-400" /> Orquestração (Multi-Agente)
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="block space-y-1">
                    <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Papel</span>
                    <select
                      value={formRole}
                      onChange={(e) => setFormRole(e.target.value as typeof formRole)}
                      className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <option value="orchestrator">Orquestrador (delega)</option>
                      <option value="specialist">Especialista (executa)</option>
                      <option value="reviewer">Revisor (avalia)</option>
                    </select>
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">
                      Modo Autônomo (override)
                    </span>
                    <select
                      value={formOverrideAutonomous}
                      onChange={(e) =>
                        setFormOverrideAutonomous(e.target.value as typeof formOverrideAutonomous)
                      }
                      className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <option value="inherit">Herdar do global</option>
                      <option value="force_manual">Sempre pedir aprovação</option>
                      <option value="force_auto">Sempre autônomo</option>
                    </select>
                  </label>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Especialidades</span>
                  <div className="flex flex-wrap gap-1.5 mb-1">
                    {formSpecialty.map((s) => (
                      <span
                        key={s}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-zinc-800 text-zinc-200 border"
                        style={{ borderColor: "var(--border)" }}
                      >
                        {s}
                        <button
                          type="button"
                          onClick={() => setFormSpecialty((arr) => arr.filter((x) => x !== s))}
                          className="text-zinc-500 hover:text-red-400"
                          style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                          aria-label={`Remover ${s}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <input
                    value={formSpecialtyInput}
                    onChange={(e) => setFormSpecialtyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        const v = formSpecialtyInput.trim().replace(/,$/, "");
                        if (v && !formSpecialty.includes(v)) {
                          setFormSpecialty([...formSpecialty, v]);
                        }
                        setFormSpecialtyInput("");
                      }
                    }}
                    placeholder="ex: coding, debugging — Enter ou vírgula para adicionar"
                    className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white"
                    style={{ borderColor: "var(--border)" }}
                  />
                  <span className="text-[10px] text-zinc-500 block">
                    Usado pelo orquestrador para decidir quem deve receber cada tarefa.
                  </span>
                </label>

                <label className="flex items-start gap-2 p-2.5 rounded-lg bg-zinc-900/60 border cursor-pointer hover:bg-zinc-900" style={{ borderColor: "var(--border)" }}>
                  <input
                    type="checkbox"
                    checked={formInheritSkills}
                    onChange={(e) => setFormInheritSkills(e.target.checked)}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <div className="text-xs font-semibold text-white">Herdar skills do Jarvis</div>
                    <div className="text-[11px] text-zinc-400 leading-relaxed">
                      Quando ativo, este agente acessa todas as skills do agente principal
                      (Jarvis) além das próprias. Desligue se quiser isolar o agente.
                    </div>
                  </div>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block space-y-1">
                    <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">
                      Cap por tarefa (¢)
                    </span>
                    <input
                      type="number"
                      min="0"
                      value={formCostPerTask}
                      onChange={(e) => setFormCostPerTask(e.target.value)}
                      placeholder="ex: 200 = US$ 2,00"
                      className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white"
                      style={{ borderColor: "var(--border)" }}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">
                      Cap por dia (¢)
                    </span>
                    <input
                      type="number"
                      min="0"
                      value={formCostPerDay}
                      onChange={(e) => setFormCostPerDay(e.target.value)}
                      placeholder="ex: 2000 = US$ 20,00"
                      className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white"
                      style={{ borderColor: "var(--border)" }}
                    />
                  </label>
                </div>
                <span className="text-[10px] text-zinc-500 block -mt-2">
                  Valores em centavos. Vazio = sem limite. O dispatcher pausa quando excede.
                </span>
              </div>

              {/* Telegram Integration Fold */}
              <div className="pt-3 border-t space-y-3" style={{ borderColor: "var(--border)" }}>
                <h4 className="font-bold text-xs uppercase text-zinc-400 tracking-wider flex items-center gap-1.5">
                  <MessageSquare className="w-3.5 h-3.5 text-[#0088cc]" /> Integração Telegram (Opcional)
                </h4>

                {/* Share-bot shortcut: lets the user create a sub-agent that
                    responds on the SAME Telegram bot as an existing agent
                    (typically `main`) — no need to re-type the token. The
                    backend copies the source account's token server-side. */}
                {telegramAccountIds.filter((id) => id !== formId.trim()).length > 0 && (
                  <label className="flex items-start gap-2 p-2.5 rounded-lg bg-zinc-900/60 border cursor-pointer hover:bg-zinc-900" style={{ borderColor: "var(--border)" }}>
                    <input
                      type="checkbox"
                      checked={formShareBotWith.length > 0}
                      onChange={(e) => {
                        if (e.target.checked) {
                          const defaultSource =
                            telegramAccountIds.find((id) => id === "main" && id !== formId.trim()) ||
                            telegramAccountIds.find((id) => id !== formId.trim()) ||
                            "";
                          setFormShareBotWith(defaultSource);
                          // Token field doesn't apply when sharing — clear it to
                          // avoid the user thinking they need to paste anything.
                          if (formBotToken !== "configured") setFormBotToken("");
                        } else {
                          setFormShareBotWith("");
                        }
                      }}
                      className="mt-0.5"
                    />
                    <div className="flex-1 space-y-1">
                      <div className="text-xs font-semibold text-white">
                        Reusar o bot de outro agente
                      </div>
                      <div className="text-[11px] text-zinc-400 leading-relaxed">
                        Esse agente vai responder no mesmo bot do Telegram de outro
                        agente já configurado — útil para sub-agentes ligados ao{" "}
                        <code className="text-[10px] px-1 py-0.5 rounded bg-zinc-800">main</code>.
                        Sem isso, você precisa colar um token de bot separado embaixo.
                      </div>
                      {formShareBotWith.length > 0 && (
                        <div className="pt-1">
                          <span className="text-[11px] text-zinc-400">Bot de origem: </span>
                          <select
                            value={formShareBotWith}
                            onChange={(e) => setFormShareBotWith(e.target.value)}
                            className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 border text-white"
                            style={{ borderColor: "var(--border)" }}
                          >
                            {telegramAccountIds
                              .filter((id) => id !== formId.trim())
                              .map((id) => (
                                <option key={id} value={id}>
                                  {id}
                                </option>
                              ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </label>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="block space-y-1" style={{ opacity: formShareBotWith.length > 0 ? 0.5 : 1 }}>
                    <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">
                      Token do Telegram Bot
                      {formShareBotWith.length > 0 && (
                        <span className="text-[10px] font-normal text-zinc-500 normal-case ml-1">
                          (ignorado — usando bot de &quot;{formShareBotWith}&quot;)
                        </span>
                      )}
                    </span>
                    <input
                      type="password"
                      value={formBotToken}
                      onChange={(e) => setFormBotToken(e.target.value)}
                      disabled={formShareBotWith.length > 0}
                      placeholder={
                        formShareBotWith.length > 0
                          ? "—"
                          : formBotToken === "configured"
                          ? "•••••••••••••••••••••"
                          : "ex: 123456:ABC-DEF... (cole um token separado pra dar canal próprio)"
                      }
                      className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white font-mono disabled:cursor-not-allowed"
                      style={{ borderColor: "var(--border)" }}
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Política de DM</span>
                    <select
                      value={formDmPolicy}
                      onChange={(e) => setFormDmPolicy(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <option value="pairing">Pairing (Pareamento Múltiplo)</option>
                      <option value="direct">Direct (Comando Direto Único)</option>
                      <option value="disabled">Disabled (Desabilitado)</option>
                    </select>
                  </label>
                </div>
              </div>

              {/* Workspace migration — só faz sentido editando (agente já existe) */}
              {editingAgent && (
                <WorkspaceImporter
                  agentId={editingAgent.id}
                  currentWorkspace={formWorkspace.trim() || editingAgent.workspace}
                  onImported={fetchAgents}
                />
              )}

              {/* Conector de memória custom (memory engine + KB + skills + sessions) */}
              {editingAgent && (
                <AgentMemoryConnector agentId={editingAgent.id} onChanged={fetchAgents} />
              )}

              {/* Ingest de sessions antigas como memórias searchable */}
              {editingAgent && (
                <MemoryIngestPanel agentId={editingAgent.id} onIngested={fetchAgents} />
              )}

              <div className="flex gap-3 pt-4 border-t" style={{ borderColor: "var(--border)" }}>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="flex-1 py-2 rounded-lg font-semibold text-xs border transition-all hover:bg-zinc-800 text-white"
                  style={{ borderColor: "var(--border)", backgroundColor: "transparent", cursor: "pointer" }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 rounded-lg font-semibold text-xs transition-all hover:scale-105 text-white"
                  style={{ backgroundColor: "var(--accent)", border: "none", cursor: "pointer" }}
                >
                  Salvar Agente
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Persistent Operator Chat — floats over content, fixed bottom-right */}
      <OperatorChatPanel />
    </div>
  );
}
