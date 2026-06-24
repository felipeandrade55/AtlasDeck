"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { StatsCard } from "@/components/StatsCard";
import { ActivityFeed } from "@/components/ActivityFeed";
import { WeatherWidget } from "@/components/WeatherWidget";
import { CostWidget } from "@/components/CostWidget";
import { Notepad } from "@/components/Notepad";
import { BriefingCard } from "@/components/BriefingCard";
import { VpsBriefingCard } from "@/components/VpsBriefingCard";
import {
  Activity,
  CheckCircle,
  XCircle,
  CalendarDays,
  Circle,
  Bot,
  MessageSquare,
  Users,
  Gamepad2,
  Brain,
  Puzzle,
  Zap,
  Server,
  Terminal,
  Clock,
  Bell,
  Mail,
  Captions,
  ArrowRight,
  CloudSun,
  Inbox,
  WalletCards,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";

interface Stats {
  total: number;
  today: number;
  success: number;
  error: number;
  pending: number;
  byType: Record<string, number>;
}

interface Agent {
  id: string;
  name: string;
  emoji: string;
  color: string;
  model: string;
  status: "online" | "offline";
  lastActivity?: string;
  botToken?: string;
}

interface DashboardHomeProps {
  stats: Stats;
  agents: Agent[];
  onAgentsClick: () => void;
}

const QUICK_LINKS: Array<{
  href: string;
  icon: LucideIcon;
  label: string;
  color: string;
  group: "Hoje" | "Operação" | "Sistema" | "Conhecimento";
  description: string;
  featured?: boolean;
}> = [
  { href: "/calendar", icon: CalendarDays, label: "Calendário", color: "#FF3B30", group: "Hoje", description: "Eventos e agenda", featured: true },
  { href: "/paginas", icon: LayoutGrid, label: "Páginas", color: "#38bdf8", group: "Operação", description: "Landing pages criadas", featured: true },
  { href: "/actions", icon: Zap, label: "Ações Rápidas", color: "var(--accent)", group: "Hoje", description: "Executar comandos", featured: true },
  { href: "/whatsapp/briefing", icon: Inbox, label: "Recados", color: "#fbbf24", group: "Hoje", description: "WhatsApp Assessor", featured: true },
  { href: "/costs", icon: WalletCards, label: "Custos", color: "#32D74B", group: "Hoje", description: "Orçamento e uso", featured: true },
  { href: "/cron", icon: Clock, label: "Tarefas Agendadas", color: "#a78bfa", group: "Operação", description: "Rotinas e automações" },
  { href: "/system", icon: Server, label: "Sistema", color: "var(--success)", group: "Sistema", description: "Saúde do servidor" },
  { href: "/logs", icon: Terminal, label: "Logs ao Vivo", color: "#60a5fa", group: "Sistema", description: "Eventos técnicos" },
  { href: "/emails", icon: Mail, label: "E-mails", color: "#38bdf8", group: "Operação", description: "Caixa de entrada" },
  { href: "/memory", icon: Brain, label: "Memória", color: "#f59e0b", group: "Conhecimento", description: "Fatos e recall" },
  { href: "/skills", icon: Puzzle, label: "Habilidades", color: "#4ade80", group: "Conhecimento", description: "Skills disponíveis" },
  { href: "/reminders", icon: Bell, label: "Lembretes", color: "#f472b6", group: "Hoje", description: "Pendências pessoais" },
  { href: "/transcriptions", icon: Captions, label: "Transcrições", color: "#818cf8", group: "Conhecimento", description: "Áudios e textos" },
];

const LEGACY_QUICK_LINKS: Array<{
  href: string;
  icon: LucideIcon;
  label: string;
  color: string;
}> = [
  { href: "/calendar", icon: CalendarDays, label: "Calendário", color: "#FF3B30" },
  { href: "/paginas", icon: LayoutGrid, label: "Páginas", color: "#38bdf8" },
  { href: "/cron", icon: Clock, label: "Tarefas Agendadas", color: "#a78bfa" },
  { href: "/actions", icon: Zap, label: "Ações Rápidas", color: "var(--accent)" },
  { href: "/system", icon: Server, label: "Sistema", color: "var(--success)" },
  { href: "/logs", icon: Terminal, label: "Logs ao Vivo", color: "#60a5fa" },
  { href: "/emails", icon: Mail, label: "E-mails", color: "#38bdf8" },
  { href: "/memory", icon: Brain, label: "Memória", color: "#f59e0b" },
  { href: "/skills", icon: Puzzle, label: "Habilidades", color: "#4ade80" },
  { href: "/reminders", icon: Bell, label: "Lembretes", color: "#f472b6" },
  { href: "/transcriptions", icon: Captions, label: "Transcrições", color: "#818cf8" },
];

const HOME_VARIANT = process.env.NEXT_PUBLIC_DASHBOARD_HOME_VARIANT;

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats>({ total: 0, today: 0, success: 0, error: 0, pending: 0, byType: {} });
  const [agents, setAgents] = useState<Agent[]>([]);
  const router = useRouter();

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [actStats, agentsData] = await Promise.all([
          fetch("/api/activities/stats", { cache: "no-store" }).then(r => r.json()),
          fetch("/api/agents", { cache: "no-store" }).then(r => r.json()),
        ]);
        setStats({
          total:   actStats.total             || 0,
          today:   actStats.today             || 0,
          success: actStats.byStatus?.success || 0,
          error:   actStats.byStatus?.error   || 0,
          pending: (actStats.byStatus?.pending || 0) + (actStats.byStatus?.running || 0),
          byType:  actStats.byType            || {},
        });
        setAgents(agentsData.agents || []);
      } catch (err) {
        console.error(err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, []);

  const props = {
    stats,
    agents,
    onAgentsClick: () => router.push("/agents"),
  };

  if (HOME_VARIANT === "legacy") {
    return <LegacyDashboardHome {...props} />;
  }

  return <RedesignedDashboardHome {...props} />;
}

function RedesignedDashboardHome({ stats, agents, onAgentsClick }: DashboardHomeProps) {
  const onlineAgents = agents.filter((agent) => agent.status === "online").length;

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6">
      <section
        className="rounded-2xl overflow-hidden"
        style={{
          background:
            "radial-gradient(circle at top left, rgba(255,59,48,0.18), transparent 34%), linear-gradient(135deg, var(--card) 0%, #111 100%)",
          border: "1px solid var(--border)",
        }}
      >
        <div className="p-5 md:p-7 grid grid-cols-1 xl:grid-cols-[1fr_auto] gap-5">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 mb-3">
              <span className="badge" style={{ backgroundColor: "var(--accent-soft)", color: "var(--accent)" }}>
                Dashboard inicial
              </span>
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                Foco no que você mais usa
              </span>
            </div>
            <h1
              className="text-3xl md:text-5xl font-bold mb-3"
              style={{
                fontFamily: "var(--font-heading)",
                color: "var(--text-primary)",
                letterSpacing: "-2px",
              }}
            >
              Hoje no AtlasDeck
            </h1>
            <p className="text-sm md:text-base leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              Clima, recados do WhatsApp, custos e atalhos ficam em primeiro plano. O restante continua disponível logo abaixo, sem mexer na navegação do sistema.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 md:min-w-[360px]">
            <HeroMetric icon={Zap} label="Hoje" value={stats.today.toLocaleString()} color="var(--accent)" />
            <HeroMetric icon={Clock} label="Em andamento" value={stats.pending.toLocaleString()} color="var(--warning)" />
            <HeroMetric icon={Bot} label="Agentes online" value={`${onlineAgents}/${agents.length || 0}`} color="var(--success)" />
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-12 gap-4 md:gap-6">
        <div className="xl:col-span-8 space-y-4 md:space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
            <PriorityPanel icon={CloudSun} label="Agora" title="Clima e rotina">
              <WeatherWidget />
            </PriorityPanel>

            <div className="space-y-4 md:space-y-6">
              <PriorityPanel icon={Inbox} label="Atenção" title="Recados WhatsApp">
                <BriefingCard />
              </PriorityPanel>
              <PriorityPanel icon={WalletCards} label="Controle" title="Custos">
                <CostWidget />
              </PriorityPanel>
            </div>
          </div>

          <TodayFocusPanel stats={stats} agents={agents} />
        </div>

        <div className="xl:col-span-4">
          <QuickActionsPanel />
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-12 gap-4 md:gap-6">
        <div className="xl:col-span-8">
          <VpsBriefingCard />
        </div>
        <div className="xl:col-span-4">
          <DashboardSection title="Anotações rápidas" action={null}>
            <div className="p-4">
              <Notepad />
            </div>
          </DashboardSection>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-12 gap-4 md:gap-6">
        <div className="xl:col-span-12">
          <SystemPulse stats={stats} />
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-12 gap-4 md:gap-6">
        <div className="xl:col-span-7">
          <AgentsPanel agents={agents} onAgentsClick={onAgentsClick} />
        </div>
        <div className="xl:col-span-5">
          <ActivityPanel />
        </div>
      </section>
    </div>
  );
}

function HeroMetric({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      className="rounded-xl p-3"
      style={{
        backgroundColor: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <Icon className="w-4 h-4 mb-3" style={{ color }} />
      <div
        className="text-xl md:text-2xl font-bold"
        style={{ fontFamily: "var(--font-heading)", color: "var(--text-primary)", letterSpacing: "-1px" }}
      >
        {value}
      </div>
      <div className="text-[11px] md:text-xs" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
    </div>
  );
}

function PriorityPanel({
  icon: Icon,
  label,
  title,
  children,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4" style={{ color: "var(--accent)" }} />
          <span className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: "var(--text-muted)" }}>
            {label}
          </span>
        </div>
        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function QuickActionsPanel() {
  const featured = QUICK_LINKS.filter((link) => link.featured);
  const grouped = QUICK_LINKS.reduce<Record<string, typeof QUICK_LINKS>>((acc, link) => {
    if (!link.featured) {
      acc[link.group] = [...(acc[link.group] || []), link];
    }
    return acc;
  }, {});

  return (
    <DashboardSection title="Links rápidos" action={<LinkArrow href="/actions" label="Ações" />}>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {featured.map(({ href, icon: Icon, label, color, description }) => (
            <Link
              key={href}
              href={href}
              className="group p-3 rounded-xl transition-all hover:scale-[1.02]"
              style={{
                backgroundColor: "var(--card-elevated)",
                border: "1px solid var(--border)",
                textDecoration: "none",
              }}
            >
              <div className="flex items-center justify-between mb-3">
                <Icon className="w-5 h-5" style={{ color }} />
                <ArrowRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100" style={{ color: "var(--text-muted)" }} />
              </div>
              <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                {label}
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
                {description}
              </div>
            </Link>
          ))}
        </div>

        <div className="space-y-3">
          {Object.entries(grouped).map(([group, links]) => (
            <div key={group}>
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] mb-2" style={{ color: "var(--text-muted)" }}>
                {group}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {links.map(({ href, icon: Icon, label, color }) => (
                  <Link
                    key={href}
                    href={href}
                    className="flex items-center gap-2 p-2.5 rounded-lg transition-all hover:scale-[1.01]"
                    style={{
                      backgroundColor: "rgba(255,255,255,0.025)",
                      border: "1px solid var(--border)",
                      textDecoration: "none",
                    }}
                  >
                    <Icon className="w-4 h-4" style={{ color }} />
                    <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
                      {label}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </DashboardSection>
  );
}

function TodayFocusPanel({ stats, agents }: { stats: Stats; agents: Agent[] }) {
  const onlineAgents = agents.filter((agent) => agent.status === "online").length;
  const successRate = stats.success + stats.error > 0
    ? Math.round((stats.success / (stats.success + stats.error)) * 100)
    : 100;

  return (
    <DashboardSection title="Resumo do dia" action={<LinkArrow href="/activity" label="Ver detalhes" />}>
      <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <FocusCard
          icon={Inbox}
          title="Prioridade"
          value="Recados e custos"
          description="Acompanhe WhatsApp e orçamento antes de abrir tarefas longas."
          color="var(--accent)"
        />
        <FocusCard
          icon={Activity}
          title="Atividade"
          value={`${stats.today.toLocaleString()} hoje`}
          description={`${stats.pending.toLocaleString()} em andamento agora.`}
          color="var(--info)"
        />
        <FocusCard
          icon={Bot}
          title="Operação"
          value={`${onlineAgents}/${agents.length || 0} agentes online`}
          description={`${successRate}% de sucesso nas ações finalizadas.`}
          color="var(--success)"
        />
      </div>
    </DashboardSection>
  );
}

function FocusCard({
  icon: Icon,
  title,
  value,
  description,
  color,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
  description: string;
  color: string;
}) {
  return (
    <div
      className="rounded-xl p-4"
      style={{
        backgroundColor: "var(--card-elevated)",
        border: "1px solid var(--border)",
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4" style={{ color }} />
        <span className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "var(--text-muted)" }}>
          {title}
        </span>
      </div>
      <div className="text-base font-bold mb-1" style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}>
        {value}
      </div>
      <p className="text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
        {description}
      </p>
    </div>
  );
}

function SystemPulse({ stats }: { stats: Stats }) {
  return (
    <DashboardSection title="Pulso do sistema" action={<LinkArrow href="/activity" label="Atividades" />}>
      <div className="p-4 grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatsCard
          title="Total"
          value={stats.total.toLocaleString()}
          icon={<Activity className="w-5 h-5" />}
          iconColor="var(--info)"
          subtitle="Ações registradas"
        />
        <StatsCard
          title="Hoje"
          value={stats.today.toLocaleString()}
          icon={<Zap className="w-5 h-5" />}
          iconColor="var(--accent)"
          subtitle="Desde meia-noite"
        />
        <StatsCard
          title="Em andamento"
          value={stats.pending.toLocaleString()}
          icon={<Clock className="w-5 h-5" />}
          iconColor="var(--warning)"
          subtitle="Pendentes ou rodando"
        />
        <StatsCard
          title="Sucessos"
          value={stats.success.toLocaleString()}
          icon={<CheckCircle className="w-5 h-5" />}
          iconColor="var(--success)"
          subtitle="Finalizadas com sucesso"
        />
        <StatsCard
          title="Erros"
          value={stats.error.toLocaleString()}
          icon={<XCircle className="w-5 h-5" />}
          iconColor="var(--error)"
          subtitle="Falhas recentes"
        />
      </div>
    </DashboardSection>
  );
}

function AgentsPanel({ agents, onAgentsClick }: { agents: Agent[]; onAgentsClick: () => void }) {
  return (
    <DashboardSection
      title="Sistema Multi-Agente"
      action={
        <div className="flex items-center gap-3">
          <Link
            href="/office"
            className="text-sm font-medium px-3 py-1.5 rounded-lg transition-all"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--text-primary)",
              textDecoration: "none",
            }}
          >
            <Gamepad2 className="inline-block w-4 h-4 mr-1 mb-0.5" />
            Escritório
          </Link>
          <LinkArrow href="/agents" label="Ver todos" />
        </div>
      }
    >
      <div className="p-4 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        {agents.map((agent) => (
          <AgentTile key={agent.id} agent={agent} onClick={onAgentsClick} />
        ))}
      </div>
    </DashboardSection>
  );
}

function AgentTile({ agent, onClick }: { agent: Agent; onClick: () => void }) {
  return (
    <button
      type="button"
      className="p-3 rounded-xl transition-all hover:scale-[1.02] text-left"
      style={{
        backgroundColor: "var(--card-elevated)",
        border: `1px solid ${agent.color}`,
        cursor: "pointer",
      }}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-2xl">{agent.emoji}</div>
        <Circle
          className="w-2 h-2"
          style={{
            fill: agent.status === "online" ? "#4ade80" : "#6b7280",
            color: agent.status === "online" ? "#4ade80" : "#6b7280",
          }}
        />
      </div>
      <div
        className="text-sm font-bold mb-1"
        style={{
          fontFamily: "var(--font-heading)",
          color: "var(--text-primary)",
        }}
      >
        {agent.name}
      </div>
      <div className="text-xs truncate" style={{ color: "var(--text-muted)" }} title={agent.model}>
        <Bot className="inline-block w-3 h-3 mr-1" />
        {agent.model.split("/").pop()}
      </div>
      {agent.botToken && (
        <div className="text-xs mt-2 flex items-center gap-1" style={{ color: "#0088cc" }}>
          <MessageSquare className="w-3 h-3" />
          Telegram
        </div>
      )}
    </button>
  );
}

function ActivityPanel() {
  return (
    <DashboardSection title="Atividade recente" action={<LinkArrow href="/activity" label="Ver todos" />}>
      <ActivityFeed limit={5} />
    </DashboardSection>
  );
}

function DashboardSection({
  title,
  action,
  children,
}: {
  title: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="rounded-xl overflow-hidden h-full"
      style={{
        backgroundColor: "var(--card)",
        border: "1px solid var(--border)",
      }}
    >
      <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="flex items-center gap-3">
          <div className="accent-line" />
          <h2
            className="text-base font-semibold"
            style={{
              fontFamily: "var(--font-heading)",
              color: "var(--text-primary)",
            }}
          >
            {title}
          </h2>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function LinkArrow({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-sm font-medium" style={{ color: "var(--accent)", textDecoration: "none" }}>
      {label} →
    </Link>
  );
}

function LegacyDashboardHome({ stats, agents, onAgentsClick }: DashboardHomeProps) {
  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="mb-4 md:mb-6">
        <h1 
          className="text-2xl md:text-3xl font-bold mb-1"
          style={{ 
            fontFamily: 'var(--font-heading)',
            color: 'var(--text-primary)',
            letterSpacing: '-1.5px'
          }}
        >
          🦞 Mission Control
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
          Visão geral da atividade dos agentes
        </p>
      </div>

      {/* Stats Grid + Weather */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-4 md:mb-6">
        {/* Stats */}
        <div className="lg:col-span-3 grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatsCard
            title="Total de Atividades"
            value={stats.total.toLocaleString()}
            icon={<Activity className="w-5 h-5" />}
            iconColor="var(--info)"
            subtitle="Todas as ações registradas nos últimos 365 dias"
          />
          <StatsCard
            title="Hoje"
            value={stats.today.toLocaleString()}
            icon={<Zap className="w-5 h-5" />}
            iconColor="var(--accent)"
            subtitle="Ações executadas desde meia-noite de hoje"
          />
          <StatsCard
            title="Em andamento"
            value={stats.pending.toLocaleString()}
            icon={<Clock className="w-5 h-5" />}
            iconColor="var(--warning)"
            subtitle="Ações pendentes ou em execução no momento"
          />
          <StatsCard
            title="Bem-sucedidos"
            value={stats.success.toLocaleString()}
            icon={<CheckCircle className="w-5 h-5" />}
            iconColor="var(--success)"
            subtitle="Ações que terminaram com sucesso"
          />
          <StatsCard
            title="Erros"
            value={stats.error.toLocaleString()}
            icon={<XCircle className="w-5 h-5" />}
            iconColor="var(--error)"
            subtitle="Ações que falharam ou retornaram erro"
          />
        </div>

        {/* Weather Widget */}
        <div className="lg:col-span-1">
          <WeatherWidget />
        </div>
      </div>

      {/* Cost Summary + Briefing side-by-side on wide screens */}
      <div className="mb-4 md:mb-6 grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        <div className="lg:col-span-2">
          <CostWidget />
        </div>
        <div className="lg:col-span-1">
          <BriefingCard />
        </div>
      </div>

      {/* Multi-Agent Status */}
      <div
        className="mb-6 rounded-xl overflow-hidden"
        style={{
          backgroundColor: 'var(--card)',
          border: '1px solid var(--border)',
        }}
      >
        <div 
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-3">
            <div className="accent-line" />
            <h2 
              className="text-base font-semibold"
              style={{ 
                fontFamily: 'var(--font-heading)',
                color: 'var(--text-primary)'
              }}
            >
              <Users className="inline-block w-5 h-5 mr-2 mb-1" />
              Sistema Multi-Agente
            </h2>
          </div>
          <div className="flex gap-2">
            <Link
              href="/office"
              className="text-sm font-medium px-3 py-1.5 rounded-lg transition-all"
              style={{ 
                backgroundColor: 'var(--accent)',
                color: 'var(--text-primary)',
              }}
            >
              <Gamepad2 className="inline-block w-4 h-4 mr-1 mb-0.5" />
              Abrir Escritório
            </Link>
            <Link
              href="/agents"
              className="text-sm font-medium"
              style={{ color: 'var(--accent)' }}
            >
              Ver todos →
            </Link>
          </div>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="p-3 rounded-lg transition-all hover:scale-105"
                style={{
                  backgroundColor: 'var(--card-elevated)',
                  border: `2px solid ${agent.color}`,
                  cursor: 'pointer',
                }}
                onClick={onAgentsClick}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="text-2xl">{agent.emoji}</div>
                  <Circle
                    className="w-2 h-2"
                    style={{
                      fill: agent.status === "online" ? "#4ade80" : "#6b7280",
                      color: agent.status === "online" ? "#4ade80" : "#6b7280",
                    }}
                  />
                </div>
                <div 
                  className="text-sm font-bold mb-1"
                  style={{ 
                    fontFamily: 'var(--font-heading)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {agent.name}
                </div>
                <div 
                  className="text-xs truncate mb-1"
                  style={{ color: 'var(--text-muted)' }}
                  title={agent.model}
                >
                  <Bot className="inline-block w-3 h-3 mr-1" />
                  {agent.model.split('/').pop()}
                </div>
                {agent.botToken && (
                  <div
                    className="text-xs mt-1 flex items-center gap-1"
                    style={{ color: '#0088cc' }}
                    title="Token Telegram configurado — não significa que o daemon está rodando"
                  >
                    <MessageSquare className="w-3 h-3" />
                    Telegram conectado
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        {/* Activity Feed */}
        <div 
          className="lg:col-span-2 rounded-xl overflow-hidden"
          style={{
            backgroundColor: 'var(--card)',
            border: '1px solid var(--border)',
          }}
        >
          <div 
            className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-3">
              <div className="accent-line" />
              <h2 
                className="text-base font-semibold"
                style={{ 
                  fontFamily: 'var(--font-heading)',
                  color: 'var(--text-primary)'
                }}
              >
                Atividade Recente
              </h2>
            </div>
            <a
              href="/activity"
              className="text-sm font-medium"
              style={{ color: 'var(--accent)' }}
            >
              Ver todos →
            </a>
          </div>
          <div className="p-0">
            <ActivityFeed limit={5} />
          </div>
        </div>

        {/* Quick Links */}
        <div 
          className="rounded-xl overflow-hidden"
          style={{
            backgroundColor: 'var(--card)',
            border: '1px solid var(--border)',
          }}
        >
          <div 
            className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-3">
              <div className="accent-line" />
              <h2 
                className="text-base font-semibold"
                style={{ 
                  fontFamily: 'var(--font-heading)',
                  color: 'var(--text-primary)'
                }}
              >
                Links Rápidos
              </h2>
            </div>
          </div>
          <div className="p-4 grid grid-cols-2 gap-2">
            {LEGACY_QUICK_LINKS.map(({ href, icon: Icon, label, color }) => (
              <Link
                key={href}
                href={href}
                className="p-3 rounded-lg transition-all hover:scale-[1.02]"
                style={{ backgroundColor: 'var(--card-elevated)', border: '1px solid var(--border)' }}
              >
                <div className="flex items-center gap-2">
                  <Icon className="w-4 h-4" style={{ color }} />
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
                </div>
              </Link>
            ))}
          </div>

          {/* Notepad */}
          <div style={{ margin: "1rem", marginTop: "0.5rem" }}>
            <Notepad />
          </div>
        </div>
      </div>
    </div>
  );
}
