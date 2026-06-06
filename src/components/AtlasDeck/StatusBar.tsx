"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Cpu, HardDrive, MemoryStick, Shield, ShieldCheck, Clock, Activity, Send } from "lucide-react";

interface SystemStats {
  cpu: number;
  ram: { used: number; total: number };
  disk: { used: number; total: number };
  vpnActive: boolean;
  firewallActive: boolean;
  activeServices: number;
  totalServices: number;
  uptime: string;
  gatewayActive?: boolean;
  gatewayRuntime?: string;
  telegramEnabled?: boolean;
  telegramStatus?: "pass" | "warn" | "fail" | "unknown";
  telegramDetail?: string;
  telegramBotName?: string;
  telegramPendingUpdates?: number;
}

interface StatusBarProps {
  isMobile?: boolean;
}

export function StatusBar({ isMobile = false }: StatusBarProps) {
  const [stats, setStats] = useState<SystemStats>({
    cpu: 0,
    ram: { used: 0, total: 4 },
    disk: { used: 0, total: 100 },
    vpnActive: false,
    firewallActive: true,
    activeServices: 0,
    totalServices: 4,
    uptime: "0d 0h",
    gatewayActive: false,
    gatewayRuntime: "unknown",
    telegramEnabled: false,
    telegramStatus: "unknown",
    telegramDetail: "Não diagnosticado",
    telegramBotName: "",
    telegramPendingUpdates: 0,
  });

  const [updateInfo, setUpdateInfo] = useState<{ hasUpdate: boolean, sha: string }>({ hasUpdate: false, sha: "..." });
  const router = useRouter();

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch("/api/system/stats");
        if (res.ok) {
          const data = await res.json();
          setStats(data);
        }
      } catch (error) {
        console.error("Failed to fetch system stats:", error);
      }
    };

    const fetchUpdateCheck = async () => {
      try {
        const res = await fetch("/api/update/check");
        if (res.ok) {
          const data = await res.json();
          setUpdateInfo({ hasUpdate: data.hasUpdate, sha: data.localSha?.slice(0, 7) || "..." });
        }
      } catch (error) {}
    };

    fetchStats();
    fetchUpdateCheck();
    const interval = setInterval(fetchStats, 10000); // Update every 10s
    const updateInterval = setInterval(fetchUpdateCheck, 5 * 60 * 1000); // Check update every 5m

    return () => {
      clearInterval(interval);
      clearInterval(updateInterval);
    };
  }, []);

  const cpuColor = stats.cpu < 60 ? "var(--positive)" : stats.cpu < 85 ? "var(--warning)" : "var(--negative)";
  const ramPercent = stats.ram.total > 0 ? (stats.ram.used / stats.ram.total) * 100 : 0;
  const ramColor = ramPercent < 60 ? "var(--positive)" : ramPercent < 85 ? "var(--warning)" : "var(--negative)";
  const diskPercent = stats.disk.total > 0 ? (stats.disk.used / stats.disk.total) * 100 : 0;
  const diskColor = diskPercent < 60 ? "var(--positive)" : diskPercent < 85 ? "var(--warning)" : "var(--negative)";

  // StatusMetric component
  const StatusMetric = ({ icon: Icon, label, value, barPercent, color, title, onClick }: any) => (
    <div 
      className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-all active:scale-[0.98]" 
      style={{ height: "24px" }}
      title={title}
      onClick={onClick}
    >
      <Icon style={{ width: "14px", height: "14px", color: "var(--text-muted)" }} />
      <span
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "11px",
          fontWeight: 600,
          letterSpacing: "1px",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-body)",
          fontSize: "11px",
          fontWeight: 600,
          color: "var(--text-secondary)",
        }}
      >
        {value}
      </span>
      {barPercent !== undefined && (
        <div
          style={{
            width: "48px",
            height: "4px",
            backgroundColor: "var(--surface-elevated)",
            borderRadius: "2px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, barPercent)}%`,
              height: "100%",
              backgroundColor: color,
              borderRadius: "2px",
            }}
          />
        </div>
      )}
    </div>
  );

  // Dense system telemetry doesn't fit a phone screen — the same metrics are
  // available on the /system page (linked from the nav drawer). Hide the bar on
  // mobile so content can run to the bottom edge.
  if (isMobile) return null;

  return (
    <div
      className="status-bar"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        height: "32px",
        backgroundColor: "var(--surface)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 16px 0 84px",
        gap: "16px",
        zIndex: 40,
      }}
    >
      {/* CPU */}
      <StatusMetric 
        icon={Cpu} 
        label="CPU" 
        value={`${stats.cpu}%`} 
        barPercent={stats.cpu} 
        color={cpuColor} 
        title="Uso do Processador (CPU) · Carga média de processamento do servidor. Clique para abrir o painel de Monitoramento."
        onClick={() => router.push('/system?tab=hardware')}
      />

      {/* RAM */}
      <StatusMetric
        icon={MemoryStick}
        label="RAM"
        value={`${stats.ram.used.toFixed(1)}/${stats.ram.total}GB`}
        barPercent={ramPercent}
        color={ramColor}
        title="Memória RAM física ativa · Quantidade de RAM sendo consumida do total disponível. Clique para abrir o painel de Monitoramento."
        onClick={() => router.push('/system?tab=hardware')}
      />

      {/* Disk */}
      <StatusMetric
        icon={HardDrive}
        label="DISK"
        value={`${diskPercent.toFixed(0)}%`}
        barPercent={diskPercent}
        color={diskColor}
        title="Espaço em Disco · Porcentagem de armazenamento principal em uso no servidor. Clique para ver detalhes de I/O."
        onClick={() => router.push('/system?tab=hardware')}
      />

      {/* Separator */}
      <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border)" }} />

      {/* VPN Status */}
      <div 
        className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-all active:scale-[0.98]"
        title={`Conexão segura VPN Tailscale · Status: ${stats.vpnActive ? "Ativo" : "Inativo"}. Permite acessar o sistema com segurança máxima. Clique para gerenciar.`}
        onClick={() => router.push('/system?tab=hardware')}
      >
        <div
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: stats.vpnActive ? "var(--positive)" : "var(--negative)",
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "1px",
            color: "var(--text-muted)",
          }}
        >
          VPN
        </span>
      </div>

      {/* Firewall Status */}
      <div 
        className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-all active:scale-[0.98]"
        title={`Firewall UFW (Proteção do Sistema) · Status: ${stats.firewallActive ? "Ativo e Protegendo (bloqueia conexões públicas desconhecidas)" : "Inativo (Atenção: servidor exposto)"}. Clique para ver regras.`}
        onClick={() => router.push('/system?tab=hardware')}
      >
        <ShieldCheck
          style={{
            width: "12px",
            height: "12px",
            color: stats.firewallActive ? "var(--positive)" : "var(--negative)",
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "1px",
            color: "var(--text-muted)",
          }}
        >
          UFW
        </span>
      </div>

      {/* Separator */}
      <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border)" }} />

      {/* Gateway OpenClaw Status */}
      <div 
        className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-all active:scale-[0.98]"
        title={`Serviço do Gateway OpenClaw · Conecta e encaminha requisições do robô para as APIs das IAs. Status: ${stats.gatewayActive ? `Ativo (${stats.gatewayRuntime})` : "Inativo (Crítico: o robô não responderá às mensagens)"}. Clique para reiniciar ou configurar.`}
        onClick={() => router.push('/system?tab=services')}
      >
        <Activity
          style={{
            width: "12px",
            height: "12px",
            color: stats.gatewayActive ? "var(--positive)" : "var(--negative)",
            animation: stats.gatewayActive ? "pulse 2s infinite" : undefined,
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "1px",
            color: "var(--text-muted)",
          }}
        >
          GATEWAY
        </span>
      </div>

      {/* Telegram Status */}
      {(() => {
        const isEnabled = stats.telegramEnabled;
        const status = stats.telegramStatus || "unknown";
        const botName = stats.telegramBotName || "";
        const pending = stats.telegramPendingUpdates || 0;
        
        let color = "var(--text-muted)";
        let statusLabel = "DESATIVADO";
        let detail = "Integração do Telegram desabilitada ou sem contas configuradas.";
        
        if (isEnabled) {
          if (status === "pass") {
            color = "var(--positive)";
            statusLabel = "CONECTADO";
            detail = `Tudo saudável. Bot ativo: ${botName}. Prontificado a responder mensagens.`;
          } else if (status === "warn") {
            color = "var(--warning)";
            statusLabel = "PENDÊNCIAS";
            detail = `Atenção: ${pending} updates pendentes acumulados no backlog do bot. Pode haver latência ou travamento.`;
          } else if (status === "fail") {
            color = "var(--negative)";
            statusLabel = "ERRO BOT";
            detail = `Erro crítico na integração do Telegram: ${stats.telegramDetail || "Falha de comunicação ou token inválido"}.`;
          } else {
            color = "var(--text-muted)";
            statusLabel = "SINDICALIZADO";
            detail = "Buscando integridade do robô do Telegram...";
          }
        }
        
        return (
          <div 
            className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 transition-all active:scale-[0.98]"
            title={`Integração Telegram · Status: ${statusLabel}. ${detail} Clique para executar o Telegram Doctor.`}
            onClick={() => router.push('/settings?openDoctor=1')}
          >
            <Send
              style={{
                width: "11px",
                height: "11px",
                color,
              }}
            />
            <span
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "1px",
                color: "var(--text-muted)",
              }}
            >
              TG: {statusLabel}
            </span>
          </div>
        );
      })()}

      {/* Separator */}
      <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border)" }} />

      {/* Systemd Services */}
      <div 
        className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-all active:scale-[0.98]"
        title={`Serviços de Sistema · ${stats.activeServices} ativos de ${stats.totalServices} monitorados no ecossistema AtlasDeck (Mission Control, Content Vault, ClassVault, CreatorOS). Clique para gerenciar.`}
        onClick={() => router.push('/system?tab=services')}
      >
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "10px",
            fontWeight: 500,
            color: "var(--text-muted)",
          }}
        >
          SVC: {stats.activeServices}/{stats.totalServices}
        </span>
      </div>

      {/* Separator */}
      <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border)" }} />

      {/* Uptime */}
      <div 
        className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-all active:scale-[0.98]"
        title={`Tempo de Operação · O sistema está rodando sem interrupção há ${stats.uptime}. Clique para monitorar de perto.`}
        onClick={() => router.push('/system?tab=hardware')}
      >
        <Clock style={{ width: "12px", height: "12px", color: "var(--text-muted)" }} />
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "10px",
            fontWeight: 500,
            color: "var(--text-muted)",
          }}
        >
          Ativo: {stats.uptime}
        </span>
      </div>

      {/* Separator */}
      <div style={{ width: "1px", height: "16px", backgroundColor: "var(--border)" }} />

      {/* Update Indicator */}
      {updateInfo.hasUpdate ? (
        <div 
          className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-all active:scale-[0.98]" 
          style={{ animation: "pulse 2s infinite" }} 
          title="Nova versão disponível no repositório GitHub do Jarvis! Clique para atualizar e implantar."
          onClick={() => router.push('/settings')}
        >
          <div style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "var(--warning)" }} />
          <span style={{ fontFamily: "var(--font-body)", fontSize: "10px", fontWeight: 600, color: "var(--warning)", letterSpacing: "0.5px" }}>
            ATUALIZAR
          </span>
        </div>
      ) : (
        <div 
          className="flex items-center gap-1 cursor-pointer hover:opacity-80 transition-all active:scale-[0.98]" 
          title={`O seu Jarvis está atualizado na última versão de produção. Commit SHA: ${updateInfo.sha}. Clique para gerenciar atualizações.`}
          onClick={() => router.push('/settings')}
        >
          <div style={{ width: "6px", height: "6px", borderRadius: "50%", backgroundColor: "var(--positive)" }} />
          <span style={{ fontFamily: "var(--font-body)", fontSize: "10px", fontWeight: 500, color: "var(--text-muted)" }}>
            v{updateInfo.sha}
          </span>
        </div>
      )}
    </div>
  );
}
