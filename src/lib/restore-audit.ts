import fs from "fs";

import {
  RESTORE_PHASE_LABELS,
  RestoreLiveStatus,
  RestorePhase,
  restoreLogPath,
} from "./restore";

/**
 * Categorias de erro reconhecidas. O classificador faz pattern-matching sobre
 * a mensagem de erro do bash + a fase em que falhou para escolher uma das
 * categorias abaixo — cada uma tem texto explicativo em português e ações
 * sugeridas para o usuário.
 */
export type ErrorCategory =
  | "disk-full"
  | "permission-denied"
  | "tar-corrupt"
  | "archive-missing-marker"
  | "platform-mismatch"
  | "pm2-missing"
  | "pm2-start-timeout"
  | "health-check-failed"
  | "db-corrupt"
  | "preview-failed"
  | "cancelled"
  | "unknown";

export interface PhaseAudit {
  name: string;
  label: string;
  status: RestorePhase["status"];
  durationSec?: number;
  error?: string;
  /** Bytes restaurados nessa fase (apenas apply-*), parseado do log. */
  bytesRestored?: number;
  /** Arquivos restaurados (apenas apply-*). */
  filesRestored?: number;
}

export interface RestoreAudit {
  sessionId: string;
  /** Resultado consolidado em uma única palavra. */
  overallStatus: "success" | "rolled-back" | "failed-no-rollback" | "manual-recovery";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  origin: {
    user?: string;
    hostname?: string;
    platform?: string;
    homeDir?: string;
  } | null;
  safetyBackupPath?: string;
  rolledBack: boolean;
  pm2Managed: boolean;

  phases: PhaseAudit[];

  /** Inventário pós-falha: o que foi efetivamente aplicado vs ignorado. */
  inventory: {
    safetyBackupCreated: boolean;
    appStopped: boolean;
    archiveExtracted: boolean;
    dataApplied: boolean;
    envApplied: boolean;
    homeApplied: boolean;
    openclawRestarted: boolean;
    appStarted: boolean;
    healthVerified: boolean;
  };

  /** Análise do erro — preenchida apenas em falha. */
  failedPhase?: string;
  errorCategory?: ErrorCategory;
  errorTitle?: string;
  errorExplanation?: string;
  errorImpact?: string;
  suggestedActions?: string[];

  /** Resumo legível para humanos (uma linha) — útil para activity log e notif. */
  headline: string;
}

interface ErrorDiagnosis {
  category: ErrorCategory;
  title: string;
  explanation: string;
  impact: string;
  suggestedActions: string[];
}

/**
 * Classifica a mensagem de erro do bash + fase em uma categoria conhecida com
 * texto humano. Mantemos os padrões em português E inglês porque o restore.sh
 * mistura mensagens nossas com mensagens de `tar`, `pm2`, etc.
 */
function categorizeError(rawError: string, phase: string): ErrorDiagnosis {
  const msg = (rawError || "").toLowerCase();

  if (
    msg.includes("enospc") ||
    msg.includes("no space left") ||
    msg.includes("disk full") ||
    msg.includes("espaço insuficiente")
  ) {
    return {
      category: "disk-full",
      title: "Disco cheio",
      explanation:
        "Não havia espaço suficiente no disco para concluir o restore. Como medida de segurança, " +
        "exigimos pelo menos 3× o tamanho do arquivo de backup em espaço livre — 1× para a extração temporária, " +
        "1× para o snapshot pré-restore e 1× de margem.",
      impact: "Paramos antes de tocar em qualquer dado atual. Nada foi modificado.",
      suggestedActions: [
        "Libere espaço em disco — comece por backups antigos em ~/AtlasDeckBackups ou logs em data/*.log",
        "Verifique o espaço livre com 'df -h' (em produção: df -h /)",
        "Após liberar espaço, faça o upload e tente novamente",
      ],
    };
  }

  if (msg.includes("eacces") || msg.includes("permission denied") || msg.includes("eperm")) {
    return {
      category: "permission-denied",
      title: "Permissão negada",
      explanation:
        "O processo de restore tentou escrever em um diretório onde não tem permissão. " +
        "Isso geralmente acontece quando o backup foi criado por outro usuário (ex: root) e " +
        "agora está sendo restaurado por um usuário sem privilégios.",
      impact:
        "Dependendo da fase em que parou, algumas pastas podem ter sido tocadas parcialmente. " +
        "Confira o inventário abaixo.",
      suggestedActions: [
        "Confirme que o restore está rodando pelo mesmo usuário que originou o backup",
        "Verifique permissões em ./data, ~/.openclaw e ~/.claude",
        "Em último caso, ajuste a propriedade dos diretórios alvo (chown) antes de tentar novamente",
      ],
    };
  }

  if (
    msg.includes("unexpected eof") ||
    msg.includes("unexpected end of file") ||
    msg.includes("arquivo tar inválido") ||
    msg.includes("invalid archive") ||
    (phase === "extract" && msg.includes("falha"))
  ) {
    return {
      category: "tar-corrupt",
      title: "Arquivo de backup corrompido",
      explanation:
        "O arquivo .tar.gz não pôde ser extraído — parece estar incompleto ou foi modificado " +
        "após a geração. Isso costuma acontecer quando o download foi interrompido ou o arquivo " +
        "foi truncado por algum sistema de transferência.",
      impact: "Nenhum dado atual foi tocado. Paramos antes ou durante a extração.",
      suggestedActions: [
        "Verifique o tamanho do arquivo na origem e compare com o que está aqui",
        "Faça novo download da fonte original",
        "Se possível, valide o arquivo com 'tar -tzf <arquivo>' antes de tentar de novo",
      ],
    };
  }

  if (msg.includes("não contém data/backup-origin.json") || msg.includes("backup-origin.json")) {
    return {
      category: "archive-missing-marker",
      title: "Arquivo não é um backup do AtlasDeck",
      explanation:
        "O arquivo enviado é um .tar.gz válido, mas não contém o manifesto data/backup-origin.json " +
        "que todos os backups do AtlasDeck incluem. Pode ser um backup de outro sistema, ou um backup " +
        "muito antigo (anterior à feature de manifesto).",
      impact: "Nenhum dado foi modificado.",
      suggestedActions: [
        "Confirme que o arquivo veio da função 'Backup' do próprio AtlasDeck",
        "Para backups muito antigos sem manifesto, restauração automática não é suportada",
      ],
    };
  }

  if (msg.includes("platform mismatch") || msg.includes("plataforma")) {
    return {
      category: "platform-mismatch",
      title: "Backup de plataforma diferente",
      explanation:
        "O backup foi gerado em um sistema operacional diferente (ex: Linux) e estamos tentando " +
        "restaurar em outro (ex: macOS). Os layouts de paths, permissões e binários são incompatíveis.",
      impact: "Nenhum dado foi modificado.",
      suggestedActions: [
        "Use um backup gerado no mesmo sistema operacional desta máquina",
        "Restauração cross-platform exigiria conversão manual de paths — não suportado nesta versão",
      ],
    };
  }

  if (phase === "stop-app" && (msg.includes("pm2") || msg.includes("not found"))) {
    return {
      category: "pm2-missing",
      title: "PM2 não respondeu",
      explanation:
        "Tentamos parar a aplicação via 'pm2 stop atlasdeck', mas o comando falhou. Pode ser que " +
        "o PM2 não esteja instalado, ou o processo não esteja sob gestão dele.",
      impact: "Nenhum dado foi modificado — paramos antes da fase de aplicação.",
      suggestedActions: [
        "Em produção: execute 'pm2 list' e confirme que o processo 'atlasdeck' aparece como online",
        "Em dev local: o restore detecta automaticamente e pula essa fase — verifique que o restore.sh recebeu a flag correta",
      ],
    };
  }

  if (
    phase === "start-app" ||
    msg.includes("timeout 90s") ||
    msg.includes("aguardando") ||
    msg.includes("app não respondeu")
  ) {
    return {
      category: "pm2-start-timeout",
      title: "Aplicação não voltou a responder",
      explanation:
        "Os arquivos do backup foram aplicados, mas a aplicação não conseguiu subir após o restart " +
        "(timeout de 90 segundos esperando pela porta 3000). Causas comuns: o .env restaurado tem " +
        "alguma variável inválida, o build foi quebrado, ou outro processo está ocupando a porta.",
      impact:
        "Os arquivos foram aplicados, mas o sistema não está respondendo. " +
        "Vamos tentar o rollback automático para reverter ao estado anterior.",
      suggestedActions: [
        "Em produção: rode 'pm2 logs atlasdeck --lines 100' para ver o erro de boot",
        "Verifique se a porta 3000 está livre: 'lsof -i :3000' ou 'netstat -tlnp | grep 3000'",
        "Confirme que o .env do backup tem todas as variáveis necessárias para esta máquina",
      ],
    };
  }

  if (phase === "verify" || msg.includes("health") || msg.includes("critical")) {
    return {
      category: "health-check-failed",
      title: "Verificação de saúde falhou",
      explanation:
        "A aplicação subiu, mas o health check (/api/health) reportou status crítico. Isso indica que " +
        "múltiplos serviços (Mission Control, OpenClaw Gateway, Anthropic API) não estão respondendo " +
        "corretamente após o restore.",
      impact: "Os arquivos foram aplicados. Vamos tentar o rollback automático para reverter.",
      suggestedActions: [
        "Abra /api/health no browser para ver detalhes de cada check",
        "Verifique se o OpenClaw Gateway está rodando ('systemctl status openclaw-gateway' ou equivalente)",
        "Cheque a conectividade externa (api.anthropic.com)",
      ],
    };
  }

  if (msg.includes("sqlite") || msg.includes("database disk image") || msg.includes("malformed")) {
    return {
      category: "db-corrupt",
      title: "Banco SQLite corrompido",
      explanation:
        "Após aplicar os arquivos, um dos bancos SQLite não pôde ser aberto sem erro. Isso pode " +
        "indicar que o arquivo .db do backup estava corrompido na origem, ou que a cópia foi interrompida.",
      impact: "Os arquivos foram aplicados, mas os bancos não estão íntegros. Rollback automático será tentado.",
      suggestedActions: [
        "Use um backup mais antigo (manualmente em ~/AtlasDeckBackups)",
        "Verifique se a máquina de origem teve falha de disco recente",
      ],
    };
  }

  if (msg.includes("cancelado") || msg.includes("cancelled") || msg.includes("sigterm")) {
    return {
      category: "cancelled",
      title: "Restore cancelado",
      explanation: "O restore foi interrompido manualmente antes de concluir.",
      impact:
        "Se o cancelamento ocorreu antes da fase 'apply-data', nenhum dado foi tocado. " +
        "Caso contrário, o rollback automático foi acionado (veja o inventário).",
      suggestedActions: ["Tente o restore novamente quando estiver pronto"],
    };
  }

  if (phase === "preview") {
    return {
      category: "preview-failed",
      title: "Não foi possível ler o backup",
      explanation:
        "Falhamos ao ler o manifesto interno do arquivo. O .tar.gz pode estar truncado, " +
        "ter sido criado por uma versão muito antiga, ou estar corrompido.",
      impact: "Nada foi modificado.",
      suggestedActions: [
        "Tente fazer upload de novo",
        "Se persistir, o arquivo provavelmente está corrompido — use outro backup",
      ],
    };
  }

  return {
    category: "unknown",
    title: "Erro durante o restore",
    explanation:
      rawError ||
      "Ocorreu um erro não classificado. Veja o terminal logo acima para detalhes técnicos.",
    impact:
      "O estado dos dados depende da fase em que falhou. Confira o inventário pós-falha abaixo para " +
      "entender exatamente o que foi tocado.",
    suggestedActions: [
      "Revise o log completo no terminal acima",
      "Se o snapshot pré-restore foi criado, seus dados originais estão preservados",
      "Tente novamente — se o erro persistir, abra uma issue com o log",
    ],
  };
}

/**
 * Parseia o log textual do restore atrás das linhas "result: {...}" que o
 * restore.sh emite após cada fase apply-*. Cada linha é o JSON retornado pelo
 * scripts/restore-apply.ts, ex.: { ok: true, files: 234, bytes: 1234567 }.
 */
function parseApplyOutput(
  logContent: string,
  phase: string
): { filesRestored?: number; bytesRestored?: number } {
  const lines = logContent.split("\n");
  const phaseHeader = lines.findIndex((l) => l.includes(`▶ ${phase}:`));
  if (phaseHeader < 0) return {};
  const slice = lines.slice(phaseHeader, Math.min(phaseHeader + 40, lines.length));
  for (const line of slice) {
    const m = line.match(/result:\s*(\{.*\})/);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[1]);
      const files =
        typeof parsed.files === "number"
          ? parsed.files
          : typeof parsed.restoredCount === "number"
          ? parsed.restoredCount
          : undefined;
      const bytes = typeof parsed.bytes === "number" ? parsed.bytes : undefined;
      return { filesRestored: files, bytesRestored: bytes };
    } catch {
      continue;
    }
  }
  return {};
}

function phaseStatus(
  status: RestoreLiveStatus,
  name: string
): RestorePhase["status"] | undefined {
  return status.phases.find((p) => p.name === name)?.status;
}

export function buildRestoreAudit(status: RestoreLiveStatus): RestoreAudit {
  let logContent = "";
  try {
    logContent = fs.readFileSync(restoreLogPath(), "utf-8");
  } catch {}

  const phases: PhaseAudit[] = status.phases.map((p) => {
    const audit: PhaseAudit = {
      name: p.name,
      label: RESTORE_PHASE_LABELS[p.name] || p.name,
      status: p.status,
      durationSec: p.durationSec,
      error: p.error,
    };
    if (p.name.startsWith("apply-")) {
      Object.assign(audit, parseApplyOutput(logContent, p.name));
    }
    return audit;
  });

  const okOrSkip = (name: string) => {
    const s = phaseStatus(status, name);
    return s === "ok" || s === "skip";
  };

  const inventory = {
    safetyBackupCreated: phaseStatus(status, "safety-backup") === "ok",
    appStopped: okOrSkip("stop-app"),
    archiveExtracted: phaseStatus(status, "extract") === "ok",
    dataApplied: phaseStatus(status, "apply-data") === "ok",
    envApplied: phaseStatus(status, "apply-env") === "ok",
    homeApplied: phaseStatus(status, "apply-home") === "ok",
    openclawRestarted: okOrSkip("restart-openclaw"),
    appStarted: okOrSkip("start-app"),
    healthVerified: okOrSkip("verify"),
  };

  let overallStatus: RestoreAudit["overallStatus"];
  if (status.status === "complete") overallStatus = "success";
  else if (status.rolledBack) overallStatus = "rolled-back";
  else if (status.status === "manual-recovery") overallStatus = "manual-recovery";
  else overallStatus = "failed-no-rollback";

  const completedAt = status.completedAt;
  const durationMs = completedAt
    ? new Date(completedAt).getTime() - new Date(status.startedAt).getTime()
    : undefined;

  const failedPhase = status.phases.find((p) => p.status === "fail");

  const audit: RestoreAudit = {
    sessionId: status.sessionId,
    overallStatus,
    startedAt: status.startedAt,
    completedAt,
    durationMs,
    origin: status.origin
      ? {
          user: status.origin.user,
          hostname: status.origin.hostname,
          platform: status.origin.platform,
          homeDir: status.origin.homeDir,
        }
      : null,
    safetyBackupPath: status.safetyBackupPath,
    rolledBack: !!status.rolledBack,
    pm2Managed: status.pm2Managed,
    phases,
    inventory,
    headline: "",
  };

  if (failedPhase) {
    const diag = categorizeError(failedPhase.error || status.error || "", failedPhase.name);
    audit.failedPhase = failedPhase.name;
    audit.errorCategory = diag.category;
    audit.errorTitle = diag.title;
    audit.errorExplanation = diag.explanation;
    audit.errorImpact = diag.impact;
    audit.suggestedActions = diag.suggestedActions;

    // Se o rollback foi bem-sucedido, sobrescreve o "impact" com a tranquilidade real
    if (status.rolledBack) {
      audit.errorImpact =
        "✓ O snapshot pré-restore foi re-aplicado automaticamente. Seu sistema está IGUAL ao " +
        "estado anterior ao restore — nenhum dado foi perdido.";
    } else if (!status.safetyBackupPath) {
      audit.errorImpact +=
        " ⚠ Você optou por não criar snapshot de segurança, então não há rollback automático.";
    }
  }

  // Headline (uma linha)
  if (overallStatus === "success") {
    const totalFiles = phases
      .filter((p) => p.name.startsWith("apply-"))
      .reduce((sum, p) => sum + (p.filesRestored || 0), 0);
    audit.headline = `Restaurado: ${totalFiles} arquivos aplicados${
      durationMs ? ` em ${Math.round(durationMs / 1000)}s` : ""
    }`;
  } else if (overallStatus === "rolled-back") {
    audit.headline = `Falha na fase ${
      RESTORE_PHASE_LABELS[failedPhase?.name || ""] || failedPhase?.name || "?"
    } — rollback automático aplicado`;
  } else {
    audit.headline = `Falha na fase ${
      RESTORE_PHASE_LABELS[failedPhase?.name || ""] || failedPhase?.name || "?"
    }${audit.errorCategory ? ` (${audit.errorCategory})` : ""}`;
  }

  return audit;
}
