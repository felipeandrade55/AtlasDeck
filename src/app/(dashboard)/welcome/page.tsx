"use client";

/**
 * Welcome page — two modes.
 *
 *   1. setup_completed_at is null  → render the SetupStepper wizard
 *      (install OpenClaw, configure model, run interview, pair Telegram)
 *   2. setup is done               → render the original onboarding guide
 *
 * The dashboard layout's SetupGuard redirects here when setup is pending,
 * so first-time users see the wizard automatically. Once they finish, the
 * guide stays accessible at /welcome forever.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { SetupStepper, type SetupStatus } from "@/components/setup/SetupStepper";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Bot,
  Brain,
  CheckCircle2,
  Cpu,
  ExternalLink,
  FileBarChart,
  FolderOpen,
  Gamepad2,
  GitFork,
  History,
  LayoutDashboard,
  Puzzle,
  Search,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  SquareTerminal,
  Terminal,
  Timer,
  User,
  Users,
  Workflow,
  Zap,
  ShieldCheck,
  Database,
  Cog,
  PlayCircle,
  Lightbulb,
} from "lucide-react";
import type { ComponentType } from "react";

type IconType = ComponentType<{ size?: number; style?: React.CSSProperties; className?: string }>;

const inlineLinkStyle: React.CSSProperties = {
  color: "var(--accent)",
  textDecoration: "underline",
  textDecorationStyle: "dotted",
  textUnderlineOffset: 2,
};

interface MenuEntry {
  href: string;
  label: string;
  icon: IconType;
  description: string;
}

const MENUS: MenuEntry[] = [
  { href: "/", label: "Painel", icon: LayoutDashboard, description: "Visão geral: status dos agentes, atividade recente, custos do mês, saúde do sistema." },
  { href: "/agents", label: "Agentes", icon: Users, description: "Gerencia os agentes OpenClaw — cada um com workspace, modelo e configurações próprias." },
  { href: "/office", label: "Escritório 3D", icon: Gamepad2, description: "Visualização interativa em 3D do trabalho dos agentes — útil pra acompanhar o que está rolando agora." },
  { href: "/actions", label: "Ações Rápidas", icon: Zap, description: "Atalhos pra disparar comandos comuns nos agentes sem abrir o terminal." },
  { href: "/system", label: "Sistema", icon: Server, description: "Métricas do servidor (CPU, RAM, disco), firewall, Tailscale, status de serviços." },
  { href: "/logs", label: "Logs ao Vivo", icon: Terminal, description: "Tail em tempo real dos logs do PM2 — pra debugar quando algo dá errado." },
  { href: "/terminal", label: "Terminal", icon: SquareTerminal, description: "Terminal web embedded no VPS — útil pra comandos rápidos sem SSH." },
  { href: "/git", label: "Git", icon: GitFork, description: "Status do repositório, commits, push/pull. Útil pra ver o que mudou no código." },
  { href: "/workflows", label: "Fluxos de Trabalho", icon: Workflow, description: "Sequências de ações automatizadas — encadeia comandos OpenClaw + decisões." },
  { href: "/activity", label: "Atividade", icon: Activity, description: "Log granular de tudo que aconteceu: arquivos editados, comandos rodados, buscas, mensagens enviadas." },
  { href: "/memory", label: "Memória", icon: Brain, description: "★ Sistema de memória adaptativa: extração automática de conversas, busca semântica, AUTO-RECALL no MEMORY.md, wizard de identidade. Veja a seção dedicada abaixo." },
  { href: "/files", label: "Arquivos", icon: FolderOpen, description: "Browser de arquivos do workspace OpenClaw. Edita markdowns, vê código, navega pastas." },
  { href: "/cron", label: "Tarefas Agendadas", icon: Timer, description: "Jobs cron disparados pelo OpenClaw em horários definidos — análises automáticas, relatórios diários." },
  { href: "/sessions", label: "Sessões", icon: History, description: "Histórico de todas as conversas com os agentes — cada JSONL exportado em formato legível." },
  { href: "/search", label: "Busca", icon: Search, description: "Busca global combinada: memórias (FTS5) + atividades (SQLite) num único índice." },
  { href: "/analytics", label: "Análises", icon: BarChart3, description: "Gráficos de uso por modelo, por agente, por dia. Mostra onde o token está indo." },
  { href: "/reports", label: "Relatórios", icon: FileBarChart, description: "Relatórios gerados pelos agentes (análise de Twitter/Instagram, sumários, etc) acessíveis num só lugar." },
  { href: "/skills", label: "Habilidades", icon: Puzzle, description: "Catálogo de skills instaladas no OpenClaw — extensões que ampliam o que o agente sabe fazer." },
  { href: "/calendar", label: "Calendário", icon: Activity, description: "Eventos, lembretes e bookings — integração com Google Calendar quando configurada." },
  { href: "/costs", label: "Custos", icon: BarChart3, description: "Orçamento mensal, alertas Telegram, custos por modelo. Trava automática se ultrapassar limite." },
  { href: "/about", label: "Sobre o Agente", icon: User, description: "Identidade pública do agente — nome, emoji, descrição. Espelha IDENTITY.md." },
  { href: "/settings", label: "Configurações", icon: SettingsIcon, description: "Variáveis do sistema, OpenClaw paths, senhas, backups, atualizações." },
];

const QUICK_START_STEPS = [
  {
    icon: ShieldCheck,
    title: "Verifique a saúde do sistema",
    body: (
      <>
        Em <Link href="/memory" style={inlineLinkStyle}>Memória → Setup</Link>, clique em{" "}
        <strong>Verificar agora</strong>. São 8 checks em paralelo (DB, embeddings,
        índices, extrator, AUTO-RECALL) — você vê verde, amarelo ou vermelho em cada um.
      </>
    ),
  },
  {
    icon: Cpu,
    title: "Ative o Ollama (LLM local gratuito)",
    body: (
      <>
        Em <Link href="/memory" style={inlineLinkStyle}>Memória → Configurações → Extrator de memórias</Link>,
        escolha o card <strong>&quot;Ollama local&quot;</strong>. Se não tiver Ollama instalado, o
        sistema instala via 1 clique (Linux). Depois baixe <strong>Qwen 2.5 7B</strong> (~5
        GB) — toda a extração e o wizard passam a rodar sem custo.
      </>
    ),
  },
  {
    icon: Sparkles,
    title: "Faça o Wizard de Identidade",
    body: (
      <>
        Em <Link href="/memory" style={inlineLinkStyle}>Memória → Setup</Link>, role até o{" "}
        <strong>Wizard</strong>. Ele te entrevista em PT-BR (5–8 perguntas) e gera{" "}
        <code>IDENTITY.md</code>, <code>SOUL.md</code> e <code>USER.md</code> com base nas
        suas respostas. É a fundação da memória adaptativa.
      </>
    ),
  },
  {
    icon: Database,
    title: "Importe markdowns existentes",
    body: (
      <>
        Se você já tinha conteúdo nos arquivos do workspace, vai em{" "}
        <Link href="/memory" style={inlineLinkStyle}>Memória → Configurações</Link> e
        clique em <strong>&quot;Importar markdown existente&quot;</strong>. O sistema indexa cada
        seção com embedding semântico (Xenova local).
      </>
    ),
  },
  {
    icon: PlayCircle,
    title: "Use o agente normalmente",
    body: (
      <>
        Daí pra frente é só conversar. A cada 15 min, o extrator lê os JSONLs novos de
        sessão e cria memórias estruturadas. A cada 30 min, regenera o{" "}
        <code>AUTO_RECALL</code> dentro do MEMORY.md — então o agente abre a próxima
        sessão já te conhecendo melhor.
      </>
    ),
  },
];

export default function WelcomePage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/setup/status", { cache: "no-store" });
        if (!cancelled && res.ok) {
          const json = (await res.json()) as SetupStatus;
          setStatus(json);
        }
      } catch {
        // network blip — fall through to loaded state with null status
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) {
    return (
      <div
        style={{
          padding: "80px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          color: "var(--text-muted)",
        }}
      >
        <Loader2 size={16} className="spin" /> Carregando…
      </div>
    );
  }

  if (!status?.setup.completedAt) {
    return <SetupStepper initialStatus={status} />;
  }

  return <WelcomeGuide />;
}

function WelcomeGuide() {
  return (
    <div style={{ padding: "16px 24px 60px", maxWidth: 1080, marginInline: "auto" }}>
      {/* Hero */}
      <div
        style={{
          padding: "32px 28px",
          borderRadius: 16,
          background:
            "linear-gradient(135deg, rgba(255,59,48,0.12), rgba(168,85,247,0.10) 60%, transparent)",
          border: "1px solid var(--border)",
          marginBottom: 28,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <Sparkles size={20} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color: "var(--accent)", textTransform: "uppercase" }}>
            Bem-vindo
          </span>
        </div>
        <h1
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: 36,
            fontWeight: 800,
            color: "var(--text-primary)",
            letterSpacing: "-1.5px",
            lineHeight: 1.1,
            marginBottom: 12,
          }}
        >
          AtlasDeck — seu copiloto OpenClaw
        </h1>
        <p style={{ fontSize: 16, color: "var(--text-secondary)", lineHeight: 1.6, maxWidth: 720 }}>
          O AtlasDeck é o painel que orquestra seus agentes OpenClaw. A diferença
          principal? Uma camada de <strong style={{ color: "var(--text-primary)" }}>memória adaptativa</strong> —
          inspirada no Hermes Agent — que faz o agente te conhecer cada vez melhor
          ao longo do tempo. Este guia te leva do zero ao agente personalizado em
          poucos minutos.
        </p>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 16 }}>
          💡 Esta página fica disponível em <code>/welcome</code> a qualquer momento — favorite ou bookmark.
        </p>
      </div>

      {/* Section: Quick Start */}
      <Section
        eyebrow="Início rápido"
        title="5 passos para o agente te conhecer"
        intro="Faça uma vez por workspace novo. Cada passo leva 1-3 min. Os passos 2 e 3 são opcionais mas mudam o jogo."
      >
        <ol style={{ display: "flex", flexDirection: "column", gap: 12, listStyle: "none", padding: 0, margin: 0, counterReset: "qs" }}>
          {QUICK_START_STEPS.map((step, i) => {
            const StepIcon = step.icon;
            return (
              <li
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 16,
                  padding: "16px 18px",
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                }}
              >
                <div
                  style={{
                    flexShrink: 0,
                    width: 36,
                    height: 36,
                    borderRadius: 999,
                    background: "var(--accent)",
                    color: "var(--bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "var(--font-heading)",
                    fontWeight: 800,
                    fontSize: 16,
                  }}
                >
                  {i + 1}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <StepIcon size={15} style={{ color: "var(--accent)" }} />
                    <strong style={{ fontSize: 15, color: "var(--text-primary)" }}>
                      {step.title}
                    </strong>
                  </div>
                  <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                    {step.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </Section>

      {/* Section: Memory deep-dive */}
      <Section
        eyebrow="Diferencial do AtlasDeck"
        title="Como funciona a memória adaptativa"
        intro="Inspirada no Hermes. Aprende com cada conversa, sem você precisar fazer nada além de usar."
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          <Feature
            icon={Database}
            title="Memórias tipadas"
            body="Cada fato é classificado: episodic (eventos), semantic (preferências), procedural (how-to), identity (quem você é). Tudo num SQLite indexado e versionado."
          />
          <Feature
            icon={Brain}
            title="Extração automática"
            body="A cada 15 min, o sistema lê os JSONLs novos de sessão, manda pra um LLM (Ollama local ou OpenClaw) e cria memórias estruturadas — você não precisa fazer nada."
          />
          <Feature
            icon={Search}
            title="Busca semântica"
            body="Embeddings Xenova MiniLM-L6 rodando 100% local. Busque por significado, não só palavras — 'cliente irritado' acha 'usuário insatisfeito'."
          />
          <Feature
            icon={Workflow}
            title="Grafo de relações"
            body="Memórias parecidas (cosine > 0.85) ficam automaticamente ligadas. Você navega de uma pra outra como num wiki pessoal do agente."
          />
          <Feature
            icon={ArrowRight}
            title="Recall + injeção"
            body="O bloco AUTO-RECALL é regenerado no MEMORY.md a cada 30 min. Quando o OpenClaw boota uma sessão, lê esse bloco e já começa te conhecendo."
          />
          <Feature
            icon={Cog}
            title="Aprendizado contínuo"
            body="Vote 👍/👎 nas memórias úteis — importance sobe ou cai. Memórias irrelevantes < 0.2 sem acesso por 90 dias são auto-arquivadas (housekeep)."
          />
        </div>
      </Section>

      {/* Section: Ollama callout */}
      <Section
        eyebrow="Recomendação forte"
        title="Ative o Ollama: memória adaptativa por zero custo"
        intro="Sem Ollama, a extração consome tokens do seu OpenClaw (paga). Com Ollama, é 100% local — gratuito, offline, privado."
      >
        <div
          style={{
            padding: 20,
            borderRadius: 12,
            background: "var(--card)",
            border: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <Cpu size={18} style={{ color: "var(--success, #32D74B)" }} />
            <strong style={{ fontSize: 15, color: "var(--text-primary)" }}>
              Setup em 3 cliques
            </strong>
          </div>
          <ol style={{ paddingLeft: 22, fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.8, marginBottom: 16 }}>
            <li>
              Vá em <Link href="/memory" style={inlineLinkStyle}>Memória → Configurações</Link>
              {" → "}role até <strong>Extrator de memórias</strong>
            </li>
            <li>
              Clique no card <strong>&quot;Ollama local&quot;</strong>. Se não estiver instalado,
              clica em <strong>&quot;Instalar Ollama (Linux)&quot;</strong> — o script oficial roda
              em segundo plano com logs visíveis
            </li>
            <li>
              Na lista de modelos recomendados, clique em <strong>&quot;Baixar&quot;</strong> no{" "}
              <strong>Qwen 2.5 7B</strong> (~5 GB disco, ~8 GB RAM, qualidade ótima)
            </li>
          </ol>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
            Se você tem pouco RAM no VPS, use <strong>Qwen 2.5 3B</strong> (~4 GB RAM) ou{" "}
            <strong>Llama 3.2 3B</strong>. Para extração de memória, modelos menores
            funcionam bem.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 8,
              marginTop: 12,
            }}
          >
            <ComparePill
              variant="warning"
              label="Sem Ollama (OpenClaw)"
              value="~$2-30/mês"
              hint="depende do modelo configurado no OpenClaw"
            />
            <ComparePill
              variant="success"
              label="Com Ollama local"
              value="$0/mês"
              hint="100% local, offline, sem API key"
            />
          </div>
        </div>
      </Section>

      {/* Section: Menu guide */}
      <Section
        eyebrow="Mapa do dashboard"
        title="O que faz cada menu"
        intro="Conheça onde clicar quando precisar de cada coisa."
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
          {MENUS.map((menu) => {
            const isHighlight = menu.label === "Memória";
            const Icon = menu.icon;
            return (
              <Link
                key={menu.href}
                href={menu.href}
                style={{
                  textDecoration: "none",
                  display: "block",
                  padding: 14,
                  borderRadius: 10,
                  background: "var(--card)",
                  border: `1px solid ${isHighlight ? "var(--accent)" : "var(--border)"}`,
                  transition: "transform 120ms ease, border-color 120ms ease",
                  boxShadow: isHighlight ? "0 0 0 1px var(--accent) inset" : undefined,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-1px)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <Icon size={14} style={{ color: isHighlight ? "var(--accent)" : "var(--text-muted)" }} />
                  <strong
                    style={{
                      fontSize: 13.5,
                      color: isHighlight ? "var(--accent)" : "var(--text-primary)",
                    }}
                  >
                    {menu.label}
                  </strong>
                </div>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.55, margin: 0 }}>
                  {menu.description}
                </p>
              </Link>
            );
          })}
        </div>
      </Section>

      {/* Section: Important things to know */}
      <Section
        eyebrow="Importante saber"
        title="Coisas que valem a pena lembrar"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Tip
            icon={Lightbulb}
            title="Os arquivos .md continuam sendo a verdade"
            body="MEMORY.md, IDENTITY.md, SOUL.md, USER.md no workspace OpenClaw são a fonte canônica. O SQLite é apenas um índice/cache derivado. Você pode editar à mão a qualquer momento — o sistema re-sincroniza."
          />
          <Tip
            icon={ShieldCheck}
            title="Custos são travados automaticamente"
            body="O sistema de custos (menu Custos) tem orçamento mensal + alerta no Telegram + trava automática. Se atingir o limite, extração para sozinha — sem surpresas na fatura."
          />
          <Tip
            icon={Database}
            title="Backup do que importa"
            body="O deploy.sh tem opção --with-backup que empacota data/ + .env + workspace OpenClaw num tar.gz. Roda antes de qualquer update destrutivo."
          />
          <Tip
            icon={Bot}
            title="Cada agente tem sua memória"
            body="Workspaces como workspace-devops e workspace-academic têm memórias isoladas. O recall, AUTO-RECALL e extração são escopados por workspace."
          />
          <Tip
            icon={PlayCircle}
            title="Tudo automatiza no boot"
            body="O scheduler interno (instrumentation.ts) inicia junto com o servidor. Extração a cada 15 min, injeção a cada 30 min, housekeep a cada hora. Sem cron externo, sem PM2 extra."
          />
        </div>
      </Section>

      {/* Footer CTA */}
      <div
        style={{
          marginTop: 32,
          padding: 24,
          borderRadius: 12,
          background:
            "linear-gradient(135deg, rgba(50,215,75,0.08), rgba(10,132,255,0.06))",
          border: "1px solid var(--success, #32D74B)",
          textAlign: "center",
        }}
      >
        <CheckCircle2 size={28} style={{ color: "var(--success, #32D74B)", margin: "0 auto 10px" }} />
        <h3 style={{ fontFamily: "var(--font-heading)", fontSize: 18, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
          Pronto pra começar?
        </h3>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 14 }}>
          O primeiro passo é a verificação. Em ~5 segundos você sabe se está tudo no
          azul.
        </p>
        <Link
          href="/memory"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 20px",
            borderRadius: 8,
            background: "var(--accent)",
            color: "var(--bg)",
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Ir para Memória → Setup <ArrowRight size={14} />
        </Link>
      </div>

      <div style={{ marginTop: 24, textAlign: "center", fontSize: 11, color: "var(--text-muted)" }}>
        Quer revisitar este guia depois? Está sempre em{" "}
        <Link href="/welcome" style={inlineLinkStyle}>
          /welcome
        </Link>
        . Documentação no repositório:{" "}
        <a
          href="https://github.com/felipeandrade55/AtlasDeck"
          target="_blank"
          rel="noopener noreferrer"
          style={inlineLinkStyle}
        >
          github.com/felipeandrade55/AtlasDeck <ExternalLink size={10} style={{ display: "inline" }} />
        </a>
      </div>
    </div>
  );
}

function Section({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 36 }}>
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--accent)",
            marginBottom: 4,
          }}
        >
          {eyebrow}
        </div>
        <h2
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: 22,
            fontWeight: 700,
            color: "var(--text-primary)",
            letterSpacing: "-0.5px",
            marginBottom: intro ? 6 : 0,
          }}
        >
          {title}
        </h2>
        {intro && (
          <p style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.6, maxWidth: 720 }}>
            {intro}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function Feature({
  icon: Icon,
  title,
  body,
}: {
  icon: IconType;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        background: "var(--card)",
        border: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Icon size={15} style={{ color: "var(--accent)" }} />
        <strong style={{ fontSize: 13.5, color: "var(--text-primary)" }}>
          {title}
        </strong>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55, margin: 0 }}>
        {body}
      </p>
    </div>
  );
}

function Tip({
  icon: Icon,
  title,
  body,
}: {
  icon: IconType;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: 14,
        borderRadius: 10,
        background: "var(--card)",
        border: "1px solid var(--border)",
      }}
    >
      <Icon size={16} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
      <div>
        <strong style={{ fontSize: 13.5, color: "var(--text-primary)", display: "block", marginBottom: 4 }}>
          {title}
        </strong>
        <p style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55, margin: 0 }}>
          {body}
        </p>
      </div>
    </div>
  );
}

function ComparePill({
  variant,
  label,
  value,
  hint,
}: {
  variant: "success" | "warning";
  label: string;
  value: string;
  hint: string;
}) {
  const colors = {
    success: { border: "var(--success, #32D74B)", bg: "rgba(50,215,75,0.08)", value: "var(--success, #32D74B)" },
    warning: { border: "var(--warning, #FFD60A)", bg: "rgba(255,214,10,0.08)", value: "var(--warning, #FFD60A)" },
  }[variant];
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 8,
        background: colors.bg,
        border: `1px solid ${colors.border}`,
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontFamily: "var(--font-heading)", fontSize: 20, fontWeight: 700, color: colors.value, marginBottom: 2 }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
        {hint}
      </div>
    </div>
  );
}
