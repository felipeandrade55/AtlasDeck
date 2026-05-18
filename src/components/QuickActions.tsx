"use client";

import { useState } from "react";
import {
  RefreshCw,
  Trash2,
  FileText,
  Key,
  Loader2,
  CheckCircle,
  AlertCircle,
  X,
} from "lucide-react";
import { ChangePasswordModal } from "./ChangePasswordModal";

interface QuickActionsProps {
  onActionComplete?: () => void;
}

interface ActionButton {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  color: "emerald" | "blue" | "yellow" | "red";
  action: () => Promise<void> | void;
}

export function QuickActions({ onActionComplete }: QuickActionsProps) {
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [logsModal, setLogsModal] = useState<string | null>(null);
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const showNotification = (type: "success" | "error", message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 3000);
  };

  const handleRestartGateway = async () => {
    setLoadingAction("restart");
    try {
      const res = await fetch("/api/recovery/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "gateway-restart" }),
      });
      const data = await res.json();
      if (data.success) {
        showNotification("success", "Gateway reiniciado com sucesso");
        onActionComplete?.();
      } else {
        showNotification("error", `Falha ao reiniciar: ${data.error || "erro desconhecido"}`);
      }
    } catch (e) {
      showNotification("error", `Erro: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleClearActivityLog = async () => {
    setLoadingAction("clear_log");
    try {
      const res = await fetch("/api/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_activity_log" }),
      });

      if (!res.ok) throw new Error("Failed to clear log");

      showNotification("success", "Registro de atividades limpo com sucesso");
      onActionComplete?.();
    } catch {
      showNotification("error", "Falha ao limpar registro de atividades");
    } finally {
      setLoadingAction(null);
    }
  };

  const handleViewLogs = async () => {
    setLoadingAction("view_logs");
    try {
      const res = await fetch("/api/recovery/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "gateway-logs" }),
      });
      const data = await res.json();
      if (data.output) {
        setLogsModal(data.output);
      } else {
        showNotification("error", data.error || "Sem logs disponíveis");
      }
    } catch (e) {
      showNotification("error", `Erro: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingAction(null);
    }
  };

  const actions: ActionButton[] = [
    {
      id: "restart",
      label: "Reiniciar Gateway",
      icon: RefreshCw,
      color: "blue",
      action: handleRestartGateway,
    },
    {
      id: "clear_log",
      label: "Limpar Registro de Atividades",
      icon: Trash2,
      color: "yellow",
      action: handleClearActivityLog,
    },
    {
      id: "view_logs",
      label: "Ver Logs do Gateway",
      icon: FileText,
      color: "emerald",
      action: handleViewLogs,
    },
    {
      id: "change_password",
      label: "Alterar Senha",
      icon: Key,
      color: "red",
      action: () => setShowPasswordModal(true),
    },
  ];

  const colorClasses = {
    emerald:
      "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20",
    blue: "bg-blue-500/10 text-blue-400 border-blue-500/30 hover:bg-blue-500/20",
    yellow:
      "bg-yellow-500/10 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/20",
    red: "bg-red-500/10 text-red-400 border-red-500/30 hover:bg-red-500/20",
  };

  return (
    <>
      <div className="bg-gray-900 rounded-xl p-6">
        <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-2">
          <RefreshCw className="w-5 h-5 text-emerald-400" />
          Ações Rápidas
        </h2>

        {/* Notification */}
        {notification && (
          <div
            className={`flex items-center gap-2 p-3 rounded-lg mb-4 ${
              notification.type === "success"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                : "bg-red-500/10 text-red-400 border border-red-500/30"
            }`}
          >
            {notification.type === "success" ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <AlertCircle className="w-4 h-4" />
            )}
            <span className="text-sm">{notification.message}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {actions.map((action) => {
            const Icon = action.icon;
            const isLoading = loadingAction === action.id;

            return (
              <button
                key={action.id}
                onClick={() => action.action()}
                disabled={isLoading}
                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  colorClasses[action.color]
                }`}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Icon className="w-4 h-4" />
                )}
                <span className="font-medium">{action.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <ChangePasswordModal
        isOpen={showPasswordModal}
        onClose={() => setShowPasswordModal(false)}
        onSuccess={() => {
          showNotification("success", "Senha alterada com sucesso");
          setShowPasswordModal(false);
        }}
      />

      {logsModal !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.7)" }}
          onClick={() => setLogsModal(null)}
        >
          <div
            className="bg-gray-900 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col"
            style={{ border: "1px solid var(--border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <h3 className="font-semibold text-white flex items-center gap-2">
                <FileText className="w-4 h-4 text-emerald-400" />
                Logs do Gateway (openclaw-gateway)
              </h3>
              <button
                onClick={() => setLogsModal(null)}
                className="text-gray-400 hover:text-white p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="p-4 text-xs font-mono whitespace-pre-wrap overflow-auto flex-1 text-gray-200">
              {logsModal}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}
