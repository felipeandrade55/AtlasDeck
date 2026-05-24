"use client";

import { useMemo, useState } from "react";
import { AlertCircle, AlertTriangle, ChevronDown } from "lucide-react";
import {
  KNOWN_MODELS,
  detectProvider,
  findKnownModel,
  validateModelId,
  type ModelProvider,
} from "@/lib/openclaw-models";

const PROVIDER_LABEL: Record<ModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama (local)",
  google: "Google",
  custom: "Outro",
};

const PROVIDER_COLOR: Record<ModelProvider, string> = {
  openai: "#10b981",
  anthropic: "#d97757",
  ollama: "#3b82f6",
  google: "#f59e0b",
  custom: "#6b7280",
};

interface Props {
  value: string;
  onChange: (next: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  placeholder?: string;
  showWarning?: boolean;
  compact?: boolean;
}

export function ModelPicker({
  value, onChange,
  allowEmpty = false,
  emptyLabel = "(nenhum)",
  placeholder = "Selecione ou digite o modelo",
  showWarning = true,
  compact = false,
}: Props) {
  const [mode, setMode] = useState<"select" | "custom">(
    value && !findKnownModel(value) ? "custom" : "select",
  );
  const [customValue, setCustomValue] = useState(value || "");
  const [lastSyncedValue, setLastSyncedValue] = useState(value || "");

  // Sync local state when `value` changes externally (React-recommended pattern
  // for derived state — happens during render, not in an effect).
  if (value !== lastSyncedValue) {
    setLastSyncedValue(value);
    setCustomValue(value || "");
    if (value && !findKnownModel(value)) setMode("custom");
  }

  const warning = useMemo(() => {
    if (!showWarning) return null;
    if (!value && allowEmpty) return null;
    if (!value) return null;
    return validateModelId(value);
  }, [value, showWarning, allowEmpty]);

  const grouped = useMemo(() => {
    const g: Record<ModelProvider, typeof KNOWN_MODELS> = {
      openai: [], anthropic: [], ollama: [], google: [], custom: [],
    };
    for (const m of KNOWN_MODELS) g[m.provider].push(m);
    return g;
  }, []);

  const known = findKnownModel(value);
  const provider = value ? detectProvider(value) : null;

  return (
    <div className="space-y-1.5">
      {mode === "select" ? (
        <div className="relative">
          <select
            value={value}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__custom__") {
                setMode("custom");
                return;
              }
              if (v === "__empty__") {
                onChange("");
                return;
              }
              onChange(v);
            }}
            className={`w-full pr-9 rounded-lg text-xs outline-none bg-zinc-900 border text-white appearance-none ${compact ? "px-2 py-1.5" : "px-3 py-2"}`}
            style={{ borderColor: "var(--border)" }}
          >
            {allowEmpty && <option value="__empty__">{emptyLabel}</option>}
            {value && !known && (
              <option value={value}>{value} (customizado)</option>
            )}
            {(Object.keys(grouped) as ModelProvider[])
              .filter((p) => grouped[p].length > 0)
              .map((p) => (
                <optgroup key={p} label={PROVIDER_LABEL[p]}>
                  {grouped[p].map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {m.id}
                    </option>
                  ))}
                </optgroup>
              ))}
            <option value="__custom__">▸ Inserir modelo customizado…</option>
          </select>
          <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-zinc-400" />
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onBlur={() => onChange(customValue.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onChange(customValue.trim());
              }
            }}
            placeholder={placeholder}
            className={`flex-1 rounded-lg text-xs outline-none bg-zinc-900 border text-white font-mono ${compact ? "px-2 py-1.5" : "px-3 py-2"}`}
            style={{ borderColor: "var(--border)" }}
          />
          <button
            type="button"
            onClick={() => {
              setMode("select");
              setCustomValue(value);
            }}
            className="px-2.5 py-1 rounded-lg text-[10px] font-medium uppercase tracking-wider text-zinc-400 hover:bg-zinc-800 border"
            style={{ borderColor: "var(--border)" }}
          >
            Lista
          </button>
        </div>
      )}

      {value && (
        <div className="flex items-center gap-2 text-[10px]" style={{ color: "var(--text-muted)" }}>
          {provider && (
            <span
              className="px-1.5 py-0.5 rounded uppercase tracking-wider font-bold"
              style={{ backgroundColor: `${PROVIDER_COLOR[provider]}15`, color: PROVIDER_COLOR[provider] }}
            >
              {PROVIDER_LABEL[provider]}
            </span>
          )}
          {known?.notes && <span className="italic">{known.notes}</span>}
        </div>
      )}

      {warning && (
        <div
          className="flex items-start gap-1.5 text-xs px-2 py-1.5 rounded"
          style={{
            backgroundColor: warning.level === "error" ? "rgba(239,68,68,0.1)" : "rgba(234,179,8,0.1)",
            color: warning.level === "error" ? "#fca5a5" : "#fde68a",
            border: `1px solid ${warning.level === "error" ? "rgba(239,68,68,0.3)" : "rgba(234,179,8,0.3)"}`,
          }}
        >
          {warning.level === "error" ? (
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          )}
          <span>{warning.message}</span>
        </div>
      )}
    </div>
  );
}
