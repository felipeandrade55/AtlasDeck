"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  Compass,
  Database,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Server,
  Terminal,
  XCircle,
} from "lucide-react";

interface OpenClawConfig {
  openclawDir: string;
  openclawBin: string;
  openclawWorkspace: string;
  sources: {
    dir: "saved" | "env" | "default";
    bin: "saved" | "env" | "default";
    workspace: "saved" | "env" | "default";
  };
}

interface OpenClawStatus {
  dirExists: boolean;
  configExists: boolean;
  agentsDirExists: boolean;
  workspaceExists: boolean;
  binReachable: boolean;
  binDetail: string | null;
  sessionsReachable?: boolean;
  sessionsSeen?: number;
  sessionsDetail?: string | null;
}

interface DirectoryEntry {
  name: string;
  path: string;
  exists?: boolean;
  readable: boolean;
  hasOpenClawConfig: boolean;
  hasAgentsDir: boolean;
}

interface ConfigResponse {
  config: OpenClawConfig;
  status: OpenClawStatus;
  roots: string[];
  candidates: DirectoryEntry[];
  configPath: string;
}

interface BrowseResponse {
  currentPath?: string;
  parentPath?: string;
  entries?: DirectoryEntry[];
  roots?: string[];
  error?: string | null;
}

interface SearchResponse {
  root: string;
  scanned: number;
  results: DirectoryEntry[];
  roots: string[];
}

function statusColor(ok: boolean): string {
  return ok ? "var(--success)" : "var(--error)";
}

function statusBg(ok: boolean): string {
  return ok ? "var(--success-bg)" : "var(--error-bg)";
}

function dirname(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized.startsWith("/") ? "/" : normalized;
  return normalized.slice(0, index);
}

function isCandidate(entry: DirectoryEntry): boolean {
  return entry.hasOpenClawConfig || entry.hasAgentsDir;
}

function StateItem({ label, ok, detail }: { label: string; ok: boolean; detail?: string | null }) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg p-3"
      style={{
        backgroundColor: "rgba(255,255,255,0.03)",
        border: "1px solid var(--border)",
      }}
    >
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: "var(--success)" }} />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: "var(--error)" }} />
      )}
      <div className="min-w-0">
        <div className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</div>
        {detail && <div className="truncate text-xs" style={{ color: "var(--text-muted)" }}>{detail}</div>}
      </div>
    </div>
  );
}

function DirectoryRow({
  entry,
  onOpen,
  onSelect,
}: {
  entry: DirectoryEntry;
  onOpen: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const candidate = isCandidate(entry);

  return (
    <div
      className="flex items-center gap-3 rounded-lg px-3 py-2"
      style={{
        backgroundColor: candidate ? "var(--success-bg)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${candidate ? "rgba(50,215,75,0.28)" : "var(--border)"}`,
      }}
    >
      <Folder className="h-4 w-4 flex-shrink-0" style={{ color: candidate ? "var(--success)" : "var(--text-muted)" }} />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left font-mono text-xs"
        onClick={() => onOpen(entry.path)}
        style={{ color: "var(--text-primary)" }}
        title={entry.path}
      >
        {entry.path}
      </button>
      {candidate && (
        <span className="rounded px-2 py-1 text-[10px] font-bold" style={{ color: "var(--success)", backgroundColor: "rgba(50,215,75,0.12)" }}>
          OpenClaw
        </span>
      )}
      <button
        type="button"
        className="rounded px-2 py-1 text-xs font-medium"
        onClick={() => onSelect(entry.path)}
        style={{ color: "var(--accent)", backgroundColor: "var(--accent-soft)" }}
      >
        Selecionar
      </button>
    </div>
  );
}

export function OpenClawConfigPanel() {
  const [config, setConfig] = useState<OpenClawConfig | null>(null);
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<DirectoryEntry[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [openclawDir, setOpenclawDir] = useState("/root/.openclaw");
  const [openclawBin, setOpenclawBin] = useState("openclaw");
  const [openclawWorkspace, setOpenclawWorkspace] = useState("/root/.openclaw/workspace/mission-control");
  const [browserPath, setBrowserPath] = useState("/root/.openclaw");
  const [searchRoot, setSearchRoot] = useState("/root");
  const [browse, setBrowse] = useState<BrowseResponse | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const applyConfigResponse = useCallback((data: ConfigResponse) => {
    setConfig(data.config);
    setStatus(data.status);
    setRoots(data.roots || []);
    setCandidates(data.candidates || []);
    setConfigPath(data.configPath || "");
    setOpenclawDir(data.config.openclawDir);
    setOpenclawBin(data.config.openclawBin);
    setOpenclawWorkspace(data.config.openclawWorkspace);
    setBrowserPath(data.config.openclawDir);
    setSearchRoot(dirname(data.config.openclawDir) || "/root");
  }, []);

  const loadConfig = useCallback(async (test = false) => {
    if (test) setTesting(true);
    try {
      const res = await fetch(`/api/openclaw/config${test ? "?test=1" : ""}`, { cache: "no-store" });
      const data = await res.json() as ConfigResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || "Falha ao carregar configuracao");
      applyConfigResponse(data);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Falha ao carregar configuracao" });
    } finally {
      setLoading(false);
      setTesting(false);
    }
  }, [applyConfigResponse]);

  const browseDirectory = useCallback(async (target: string) => {
    setBrowsing(true);
    try {
      const res = await fetch(`/api/openclaw/browse?path=${encodeURIComponent(target)}`, { cache: "no-store" });
      const data = await res.json() as BrowseResponse;
      setBrowse(data);
      if (data.currentPath) setBrowserPath(data.currentPath);
      if (data.roots) setRoots(data.roots);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Falha ao abrir pasta" });
    } finally {
      setBrowsing(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (config?.openclawDir) {
      browseDirectory(config.openclawDir);
    }
  }, [browseDirectory, config?.openclawDir]);

  const healthOk = useMemo(() => {
    if (!status) return false;
    return status.dirExists && status.configExists && status.binReachable;
  }, [status]);

  const saveConfig = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/openclaw/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openclawDir,
          openclawBin,
          openclawWorkspace,
          test: true,
        }),
      });
      const data = await res.json() as ConfigResponse & { error?: string; detail?: string };
      if (!res.ok) throw new Error(data.detail || data.error || "Falha ao salvar configuracao");
      applyConfigResponse(data);
      setMessage({ type: "success", text: "Configuracao OpenClaw salva." });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Falha ao salvar configuracao" });
    } finally {
      setSaving(false);
    }
  };

  const searchFolders = async () => {
    setSearching(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/openclaw/browse?search=1&depth=5&path=${encodeURIComponent(searchRoot)}`, { cache: "no-store" });
      const data = await res.json() as SearchResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || "Falha ao buscar pastas");
      setSearchResults(data);
      setRoots(data.roots || roots);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Falha ao buscar pastas" });
    } finally {
      setSearching(false);
    }
  };

  const selectDirectory = (pathValue: string) => {
    setOpenclawDir(pathValue);
    setOpenclawWorkspace(`${pathValue.replace(/[\\/]$/, "")}/workspace/mission-control`);
    browseDirectory(pathValue);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-xl p-8" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
        <Loader2 className="mr-2 h-5 w-5 animate-spin" style={{ color: "var(--accent)" }} />
        <span style={{ color: "var(--text-secondary)" }}>Carregando OpenClaw...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl p-6" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold" style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}>
              <Server className="h-5 w-5" style={{ color: "var(--accent)" }} />
              OpenClaw
            </h2>
            <div className="mt-1 font-mono text-xs" style={{ color: "var(--text-muted)" }}>
              {configPath || "data/openclaw-config.json"}
            </div>
          </div>
          <span
            className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold"
            style={{ color: statusColor(healthOk), backgroundColor: statusBg(healthOk) }}
          >
            {healthOk ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            {healthOk ? "Conectado" : "Pendente"}
          </span>
        </div>

        {message && (
          <div
            className="mb-4 flex items-center gap-2 rounded-lg p-3 text-sm"
            style={{
              color: message.type === "success" ? "var(--success)" : "var(--error)",
              backgroundColor: message.type === "success" ? "var(--success-bg)" : "var(--error-bg)",
              border: `1px solid ${message.type === "success" ? "rgba(50,215,75,0.28)" : "rgba(255,69,58,0.28)"}`,
            }}
          >
            {message.type === "success" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {message.text}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-xs font-bold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
                OPENCLAW_DIR
              </span>
              <div className="flex gap-2">
                <input
                  value={openclawDir}
                  onChange={(event) => setOpenclawDir(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-sm outline-none"
                  style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                />
                <button
                  type="button"
                  onClick={() => browseDirectory(openclawDir)}
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
                  style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
                >
                  <FolderOpen className="h-4 w-4" />
                  Abrir
                </button>
              </div>
            </label>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
                  OPENCLAW_BIN
                </span>
                <input
                  value={openclawBin}
                  onChange={(event) => setOpenclawBin(event.target.value)}
                  className="w-full rounded-lg px-3 py-2 font-mono text-sm outline-none"
                  style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
                  OPENCLAW_WORKSPACE
                </span>
                <input
                  value={openclawWorkspace}
                  onChange={(event) => setOpenclawWorkspace(event.target.value)}
                  className="w-full rounded-lg px-3 py-2 font-mono text-sm outline-none"
                  style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={saveConfig}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
                style={{ backgroundColor: "var(--accent)", color: "white" }}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Salvar
              </button>
              <button
                type="button"
                onClick={() => loadConfig(true)}
                disabled={testing}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
                style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
              >
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Testar
              </button>
            </div>
          </div>

          {status && (
            <div className="grid grid-cols-1 gap-2">
              <StateItem label="Diretorio" ok={status.dirExists} detail={openclawDir} />
              <StateItem label="openclaw.json" ok={status.configExists} detail="configuracao principal" />
              <StateItem label="agents/" ok={status.agentsDirExists} detail="transcricoes JSONL" />
              <StateItem label="CLI" ok={status.binReachable} detail={status.binDetail} />
              {status.sessionsReachable !== undefined && (
                <StateItem
                  label="Sessoes"
                  ok={status.sessionsReachable}
                  detail={status.sessionsReachable ? `${status.sessionsSeen || 0} encontradas` : status.sessionsDetail}
                />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="rounded-xl p-6" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 font-semibold" style={{ color: "var(--text-primary)" }}>
              <Compass className="h-4 w-4" style={{ color: "var(--accent)" }} />
              Navegador
            </h3>
            <button
              type="button"
              disabled={!browse?.parentPath || browsing}
              onClick={() => browse?.parentPath && browseDirectory(browse.parentPath)}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium"
              style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            >
              <ArrowUp className="h-3.5 w-3.5" />
              Subir
            </button>
          </div>

          <div className="mb-4 flex gap-2">
            <input
              value={browserPath}
              onChange={(event) => setBrowserPath(event.target.value)}
              className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-xs outline-none"
              style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            />
            <button
              type="button"
              onClick={() => browseDirectory(browserPath)}
              disabled={browsing}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
              style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
            >
              {browsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
            </button>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            {roots.slice(0, 8).map((root) => (
              <button
                key={root}
                type="button"
                onClick={() => browseDirectory(root)}
                className="rounded px-2 py-1 font-mono text-[11px]"
                style={{ backgroundColor: "var(--card-elevated)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
              >
                {root}
              </button>
            ))}
          </div>

          {browse?.error && (
            <div className="mb-3 flex items-center gap-2 rounded-lg p-3 text-sm" style={{ color: "var(--error)", backgroundColor: "var(--error-bg)" }}>
              <AlertTriangle className="h-4 w-4" />
              {browse.error}
            </div>
          )}

          <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
            {(browse?.entries || []).map((entry) => (
              <DirectoryRow key={entry.path} entry={entry} onOpen={browseDirectory} onSelect={selectDirectory} />
            ))}
            {browse && (browse.entries || []).length === 0 && (
              <div className="rounded-lg p-4 text-center text-sm" style={{ color: "var(--text-muted)", backgroundColor: "rgba(255,255,255,0.03)" }}>
                Nenhuma subpasta listada.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl p-6" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 font-semibold" style={{ color: "var(--text-primary)" }}>
              <Search className="h-4 w-4" style={{ color: "var(--accent)" }} />
              Busca
            </h3>
            {searchResults && (
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                {searchResults.scanned} pastas lidas
              </span>
            )}
          </div>

          <div className="mb-4 flex gap-2">
            <input
              value={searchRoot}
              onChange={(event) => setSearchRoot(event.target.value)}
              className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-xs outline-none"
              style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            />
            <button
              type="button"
              onClick={searchFolders}
              disabled={searching}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold"
              style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            >
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Buscar
            </button>
          </div>

          <div className="mb-4 space-y-2">
            {candidates.filter((item) => item.exists ?? item.readable).map((entry) => (
              <DirectoryRow key={entry.path} entry={entry} onOpen={browseDirectory} onSelect={selectDirectory} />
            ))}
          </div>

          <div className="max-h-[360px] space-y-2 overflow-auto pr-1">
            {(searchResults?.results || []).map((entry) => (
              <DirectoryRow key={entry.path} entry={entry} onOpen={browseDirectory} onSelect={selectDirectory} />
            ))}
            {searchResults && searchResults.results.length === 0 && (
              <div className="rounded-lg p-4 text-center text-sm" style={{ color: "var(--text-muted)", backgroundColor: "rgba(255,255,255,0.03)" }}>
                Nenhuma pasta OpenClaw encontrada.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
          <Database className="mb-2 h-4 w-4" style={{ color: "var(--accent)" }} />
          <span className="font-mono text-xs">{config?.sources.dir || "default"} / {config?.sources.bin || "default"}</span>
        </div>
        <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
          <Terminal className="mb-2 h-4 w-4" style={{ color: "var(--accent)" }} />
          <span className="font-mono text-xs">{openclawBin}</span>
        </div>
        <div className="rounded-lg p-3 text-sm" style={{ backgroundColor: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}>
          <FolderOpen className="mb-2 h-4 w-4" style={{ color: "var(--accent)" }} />
          <span className="font-mono text-xs">{openclawDir}</span>
        </div>
      </div>
    </div>
  );
}
