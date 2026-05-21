"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Eye,
  Edit3,
  RefreshCw,
  Brain,
  Plus,
  FileText,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react";
import { FileTree, FileNode } from "@/components/FileTree";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { MemoryList } from "@/components/memory/MemoryList";
import { MemorySettings } from "@/components/memory/MemorySettings";
import { HealthCheckPanel } from "@/components/memory/HealthCheckPanel";
import { OnboardingWizard } from "@/components/memory/OnboardingWizard";
import { useToast } from "@/components/Toast";
import { PROTECTED_FILES, MEMORY_DIR } from "@/lib/memory-files";

type ViewMode = "edit" | "preview";
type Tab = "files" | "memories" | "setup" | "settings";

interface Workspace {
  id: string;
  name: string;
  emoji: string;
  path: string;
  agentName?: string;
}

const PROTECTED_SET = new Set<string>(PROTECTED_FILES);

function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export default function MemoryPage() {
  const toast = useToast();

  const [activeTab, setActiveTab] = useState<Tab>("files");

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);

  const hasUnsavedChanges = content !== originalContent;

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspacesError(null);
      const res = await fetch("/api/files/workspaces");
      if (!res.ok) throw new Error("Falha ao carregar workspaces");
      const data = await res.json();
      const list: Workspace[] = data.workspaces || [];
      setWorkspaces(list);
      if (list.length > 0) {
        setSelectedWorkspace((prev) => prev ?? list[0].id);
      }
    } catch (err) {
      console.error(err);
      setWorkspaces([]);
      setWorkspacesError("Não foi possível carregar os workspaces");
      toast.error("Falha ao carregar workspaces");
    }
  }, [toast]);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  const loadFileTree = useCallback(
    async (workspace: string) => {
      try {
        setIsLoading(true);
        setError(null);
        const res = await fetch(
          `/api/files?workspace=${encodeURIComponent(workspace)}`,
        );
        if (!res.ok) throw new Error("Falha ao carregar arquivos");
        const data = await res.json();
        setFiles(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error(err);
        setError("Falha ao carregar a árvore de arquivos");
        toast.error("Falha ao carregar arquivos do workspace");
      } finally {
        setIsLoading(false);
      }
    },
    [toast],
  );

  const loadFile = useCallback(
    async (workspace: string, filePath: string) => {
      try {
        setIsLoadingFile(true);
        setError(null);
        const res = await fetch(
          `/api/files?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(filePath)}`,
        );
        if (!res.ok) throw new Error("Falha ao carregar arquivo");
        const data = await res.json();
        setContent(data.content ?? "");
        setOriginalContent(data.content ?? "");
      } catch (err) {
        console.error(err);
        setError("Falha ao carregar arquivo");
        toast.error(`Falha ao carregar ${filePath}`);
      } finally {
        setIsLoadingFile(false);
      }
    },
    [toast],
  );

  const saveFile = useCallback(async () => {
    if (!selectedWorkspace || !selectedPath) return;
    try {
      setIsSaving(true);
      const res = await fetch("/api/files", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: selectedWorkspace,
          path: selectedPath,
          content,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Falha ao salvar");
      }
      setOriginalContent(content);
      toast.success(`${selectedPath} salvo`);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Falha ao salvar";
      toast.error(message);
      throw err;
    } finally {
      setIsSaving(false);
    }
  }, [selectedWorkspace, selectedPath, content, toast]);

  const handleSelectFile = useCallback(
    async (filePath: string) => {
      if (hasUnsavedChanges) {
        const confirmed = window.confirm(
          "Você tem alterações não salvas. Descartar?",
        );
        if (!confirmed) return;
      }
      setSelectedPath(filePath);
      if (selectedWorkspace) await loadFile(selectedWorkspace, filePath);
    },
    [hasUnsavedChanges, selectedWorkspace, loadFile],
  );

  const handleWorkspaceSelect = (workspaceId: string) => {
    if (hasUnsavedChanges) {
      const confirmed = window.confirm(
        "Você tem alterações não salvas. Descartar?",
      );
      if (!confirmed) return;
    }
    setSelectedWorkspace(workspaceId);
    setSelectedPath(null);
    setContent("");
    setOriginalContent("");
  };

  useEffect(() => {
    if (selectedWorkspace && activeTab === "files") {
      loadFileTree(selectedWorkspace);
    }
  }, [selectedWorkspace, activeTab, loadFileTree]);

  useEffect(() => {
    if (activeTab !== "files") return;
    if (files.length > 0 && !selectedPath) {
      const memoryMd = files.find(
        (f) => f.name === "MEMORY.md" && f.type === "file",
      );
      const firstFile = memoryMd || files.find((f) => f.type === "file");
      if (firstFile) handleSelectFile(firstFile.path);
    }
  }, [activeTab, files, selectedPath, handleSelectFile]);

  const refresh = useCallback(async () => {
    if (!selectedWorkspace) return;
    await loadFileTree(selectedWorkspace);
    if (selectedPath) await loadFile(selectedWorkspace, selectedPath);
  }, [selectedWorkspace, selectedPath, loadFileTree, loadFile]);

  const handleCreateMemory = useCallback(
    async (folderPath = MEMORY_DIR) => {
      if (!selectedWorkspace) return;
      const name = window.prompt(
        "Nome do novo arquivo (sem extensão):",
        new Date().toISOString().slice(0, 10),
      );
      if (!name) return;
      const slug = slugify(name);
      if (!slug) {
        toast.error("Nome inválido");
        return;
      }
      const targetPath = `${folderPath || MEMORY_DIR}/${slug}.md`;
      try {
        const res = await fetch("/api/files/write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace: selectedWorkspace,
            path: targetPath,
            content: `# ${name}\n\n`,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || "Falha ao criar memória");
        }
        toast.success(`Criado ${targetPath}`);
        await loadFileTree(selectedWorkspace);
        setSelectedPath(targetPath);
        await loadFile(selectedWorkspace, targetPath);
        setViewMode("edit");
      } catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : "Falha ao criar";
        toast.error(message);
      }
    },
    [selectedWorkspace, toast, loadFileTree, loadFile],
  );

  const handleRename = useCallback(
    async (node: FileNode) => {
      if (!selectedWorkspace) return;
      const current = node.name.replace(/\.md$/i, "");
      const next = window.prompt("Novo nome (sem extensão):", current);
      if (!next || next.trim() === current) return;
      const slug = slugify(next);
      if (!slug) {
        toast.error("Nome inválido");
        return;
      }
      try {
        const res = await fetch("/api/files/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace: selectedWorkspace,
            path: node.path,
            newName: `${slug}.md`,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || "Falha ao renomear");
        }
        const data = await res.json();
        toast.success("Arquivo renomeado");
        await loadFileTree(selectedWorkspace);
        if (selectedPath === node.path && data?.newPath) {
          setSelectedPath(data.newPath);
          await loadFile(selectedWorkspace, data.newPath);
        }
      } catch (err) {
        console.error(err);
        const message =
          err instanceof Error ? err.message : "Falha ao renomear";
        toast.error(message);
      }
    },
    [selectedWorkspace, selectedPath, toast, loadFileTree, loadFile],
  );

  const handleDelete = useCallback(
    async (node: FileNode) => {
      if (!selectedWorkspace) return;
      const confirmed = window.confirm(
        `Excluir "${node.name}"? Esta ação não pode ser desfeita.`,
      );
      if (!confirmed) return;
      try {
        const res = await fetch("/api/files/delete", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace: selectedWorkspace,
            path: node.path,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || "Falha ao excluir");
        }
        toast.success(`Excluído ${node.name}`);
        if (selectedPath === node.path) {
          setSelectedPath(null);
          setContent("");
          setOriginalContent("");
        }
        await loadFileTree(selectedWorkspace);
      } catch (err) {
        console.error(err);
        const message =
          err instanceof Error ? err.message : "Falha ao excluir";
        toast.error(message);
      }
    },
    [selectedWorkspace, selectedPath, toast, loadFileTree],
  );

  const selectedWorkspaceData = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspace),
    [workspaces, selectedWorkspace],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Page header */}
      <div style={{ padding: "24px 24px 12px 24px", flexShrink: 0 }}>
        <h1
          style={{
            fontFamily: "var(--font-heading)",
            fontSize: "24px",
            fontWeight: 700,
            letterSpacing: "-1px",
            color: "var(--text-primary)",
            marginBottom: "4px",
          }}
        >
          Memória
        </h1>
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "13px",
            color: "var(--text-secondary)",
            marginBottom: 14,
          }}
        >
          Sistema de memória adaptativa — extração automática, busca semântica e
          injeção contínua de contexto nos agentes.
        </p>

        {/* Tabs */}
        <div role="tablist" aria-label="Visões do sistema de memória" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)" }}>
          <TabButton
            label="Arquivos"
            icon={<FileText size={14} />}
            active={activeTab === "files"}
            onClick={() => setActiveTab("files")}
          />
          <TabButton
            label="Memórias"
            icon={<Brain size={14} />}
            active={activeTab === "memories"}
            onClick={() => setActiveTab("memories")}
          />
          <TabButton
            label="Setup"
            icon={<Sparkles size={14} />}
            active={activeTab === "setup"}
            onClick={() => setActiveTab("setup")}
          />
          <TabButton
            label="Configurações"
            icon={<SettingsIcon size={14} />}
            active={activeTab === "settings"}
            onClick={() => setActiveTab("settings")}
          />
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
        }}
      >
        {/* Workspace sidebar (hidden on Settings tab — settings are global) */}
        {activeTab !== "settings" && (
          <aside
            aria-label="Workspaces"
            style={{
              width: "220px",
              flexShrink: 0,
              borderRight: "1px solid var(--border)",
              overflowY: "auto",
              padding: "16px 0",
              backgroundColor: "var(--surface, var(--card))",
            }}
          >
            <p
              style={{
                fontSize: "10px",
                fontWeight: 700,
                letterSpacing: "0.08em",
                color: "var(--text-muted)",
                padding: "0 16px 8px",
                textTransform: "uppercase",
              }}
            >
              Workspaces
            </p>

            {workspacesError && (
              <div style={{ padding: "8px 16px", fontSize: 12, color: "var(--error, #FF453A)" }}>
                {workspacesError}
                <button
                  type="button"
                  onClick={loadWorkspaces}
                  style={{ display: "block", marginTop: 6, background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", borderRadius: 4, padding: "4px 8px", cursor: "pointer", fontSize: 11 }}
                >
                  Tentar novamente
                </button>
              </div>
            )}

            {!workspacesError && workspaces.length === 0 && (
              <p style={{ padding: "8px 16px", fontSize: 12, color: "var(--text-muted)" }}>
                Nenhum workspace encontrado
              </p>
            )}

            {workspaces.map((workspace) => {
              const isSelected = selectedWorkspace === workspace.id;
              return (
                <button
                  key={workspace.id}
                  onClick={() => handleWorkspaceSelect(workspace.id)}
                  aria-label={`Selecionar workspace ${workspace.name}${workspace.agentName ? ` (${workspace.agentName})` : ""}`}
                  aria-current={isSelected ? "page" : undefined}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "9px 16px",
                    background: isSelected ? "var(--accent-soft)" : "transparent",
                    border: "none",
                    borderLeft: isSelected
                      ? "3px solid var(--accent)"
                      : "3px solid transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all 120ms ease",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected)
                      e.currentTarget.style.background =
                        "var(--surface-hover, rgba(255,255,255,0.05))";
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }} aria-hidden="true">
                    {workspace.emoji}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: "var(--font-heading)",
                        fontSize: 13,
                        fontWeight: isSelected ? 600 : 400,
                        color: isSelected ? "var(--accent)" : "var(--text-primary)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {workspace.name}
                    </div>
                    {workspace.agentName && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {workspace.agentName}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </aside>
        )}

        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            minWidth: 0,
          }}
        >
          {activeTab === "files" &&
            (selectedWorkspace && selectedWorkspaceData ? (
              <FilesTabContent
                workspace={selectedWorkspaceData}
                files={files}
                selectedPath={selectedPath}
                content={content}
                viewMode={viewMode}
                isLoading={isLoading}
                isLoadingFile={isLoadingFile}
                isSaving={isSaving}
                hasUnsavedChanges={hasUnsavedChanges}
                error={error}
                onSelectFile={handleSelectFile}
                onChangeContent={setContent}
                onSave={saveFile}
                onSetViewMode={setViewMode}
                onRefresh={refresh}
                onCreate={handleCreateMemory}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                  fontSize: 14,
                }}
              >
                Selecione um workspace
              </div>
            ))}

          {activeTab === "memories" &&
            (selectedWorkspace ? (
              <MemoryList workspace={selectedWorkspace} />
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                  fontSize: 14,
                }}
              >
                Selecione um workspace
              </div>
            ))}

          {activeTab === "setup" &&
            (selectedWorkspace ? (
              <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
                <div style={{ maxWidth: 880, marginInline: "auto", display: "flex", flexDirection: "column", gap: 20 }}>
                  <HealthCheckPanel workspace={selectedWorkspace} />
                  <OnboardingWizard
                    workspace={selectedWorkspace}
                    onSwitchToFilesTab={() => setActiveTab("files")}
                  />
                </div>
              </div>
            ) : (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--text-muted)",
                  fontSize: 14,
                }}
              >
                Selecione um workspace
              </div>
            ))}

          {activeTab === "settings" && <MemorySettings />}
        </main>
      </div>
    </div>
  );
}

function TabButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px",
        background: "transparent",
        border: "none",
        borderBottom: active
          ? "2px solid var(--accent)"
          : "2px solid transparent",
        color: active ? "var(--accent)" : "var(--text-secondary)",
        fontWeight: active ? 600 : 500,
        fontSize: 13,
        cursor: "pointer",
        transition: "color 120ms ease",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

interface FilesTabProps {
  workspace: { id: string; name: string; emoji: string; agentName?: string };
  files: FileNode[];
  selectedPath: string | null;
  content: string;
  viewMode: ViewMode;
  isLoading: boolean;
  isLoadingFile: boolean;
  isSaving: boolean;
  hasUnsavedChanges: boolean;
  error: string | null;
  onSelectFile: (path: string) => void;
  onChangeContent: (content: string) => void;
  onSave: () => Promise<void>;
  onSetViewMode: (mode: ViewMode) => void;
  onRefresh: () => Promise<void>;
  onCreate: (folder?: string) => void;
  onRename: (node: FileNode) => void;
  onDelete: (node: FileNode) => void;
}

function FilesTabContent(props: FilesTabProps) {
  const {
    workspace,
    files,
    selectedPath,
    content,
    viewMode,
    isLoading,
    isLoadingFile,
    isSaving,
    hasUnsavedChanges,
    error,
    onSelectFile,
    onChangeContent,
    onSave,
    onSetViewMode,
    onRefresh,
    onCreate,
    onRename,
    onDelete,
  } = props;

  return (
    <>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 16px",
          borderBottom: "1px solid var(--border)",
          backgroundColor: "var(--surface, var(--card))",
          flexShrink: 0,
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Brain style={{ width: 16, height: 16, color: "var(--accent)" }} aria-hidden="true" />
          <span style={{ fontFamily: "var(--font-heading)", fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            {workspace.name}
          </span>
          {selectedPath && (
            <>
              <span style={{ color: "var(--text-muted)", fontSize: 13 }} aria-hidden="true">/</span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "var(--text-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 300,
                }}
              >
                {selectedPath}
              </span>
              {hasUnsavedChanges && (
                <span style={{ fontSize: 11, color: "var(--warning, #FFD60A)", marginLeft: 4 }}>
                  ● não salvo
                </span>
              )}
            </>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button
            onClick={() => onCreate(MEMORY_DIR)}
            aria-label="Nova memória"
            title="Nova memória"
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 9px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: 12 }}
          >
            <Plus size={13} />
            Nova memória
          </button>

          <button
            onClick={onRefresh}
            aria-label="Atualizar"
            title="Atualizar"
            style={{ padding: "5px 7px", borderRadius: 6, backgroundColor: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)", display: "flex", alignItems: "center" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <RefreshCw size={14} />
          </button>

          <div
            role="tablist"
            aria-label="Modo de visualização"
            style={{ display: "flex", backgroundColor: "var(--bg)", borderRadius: 6, padding: 3, gap: 2 }}
          >
            <button
              role="tab"
              aria-selected={viewMode === "preview"}
              aria-controls="memory-content"
              onClick={() => onSetViewMode("preview")}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 4, backgroundColor: viewMode === "preview" ? "var(--accent)" : "transparent", color: viewMode === "preview" ? "var(--bg, #111)" : "var(--text-muted)", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
            >
              <Eye size={13} />
              Preview
            </button>
            <button
              role="tab"
              aria-selected={viewMode === "edit"}
              aria-controls="memory-content"
              onClick={() => onSetViewMode("edit")}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 4, backgroundColor: viewMode === "edit" ? "var(--accent)" : "transparent", color: viewMode === "edit" ? "var(--bg, #111)" : "var(--text-muted)", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
            >
              <Edit3 size={13} />
              Editar
            </button>
          </div>
        </div>
      </div>

      {/* Tree + editor/preview */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ width: 230, flexShrink: 0, borderRight: "1px solid var(--border)", overflowY: "auto" }}>
          {isLoading ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>Carregando…</div>
          ) : error && files.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--error, #FF453A)" }}>
              {error}
              <button type="button" onClick={onRefresh} style={{ display: "block", margin: "12px auto 0", background: "transparent", border: "1px solid var(--border)", color: "var(--text-secondary)", borderRadius: 4, padding: "4px 8px", cursor: "pointer", fontSize: 11 }}>
                Tentar novamente
              </button>
            </div>
          ) : files.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
              Workspace vazio. Crie a primeira memória com o botão acima.
            </div>
          ) : (
            <FileTree
              files={files}
              selectedPath={selectedPath}
              onSelect={onSelectFile}
              onRename={onRename}
              onDelete={onDelete}
              onCreateInFolder={onCreate}
              protectedPaths={PROTECTED_SET}
            />
          )}
        </div>

        <div
          id="memory-content"
          style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, backgroundColor: "var(--bg)", overflow: "hidden" }}
        >
          {selectedPath ? (
            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              {isLoadingFile ? (
                <div style={{ padding: 24, color: "var(--text-secondary)" }}>Carregando arquivo…</div>
              ) : viewMode === "edit" ? (
                <MarkdownEditor
                  content={content}
                  onChange={onChangeContent}
                  onSave={onSave}
                  hasUnsavedChanges={hasUnsavedChanges || isSaving}
                />
              ) : (
                <MarkdownPreview content={content} />
              )}
            </div>
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
              <div style={{ textAlign: "center" }}>
                <Brain style={{ width: 64, height: 64, margin: "0 auto 16px", opacity: 0.3 }} aria-hidden="true" />
                <p style={{ fontSize: 14 }}>Selecione um arquivo para visualizar ou editar</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
