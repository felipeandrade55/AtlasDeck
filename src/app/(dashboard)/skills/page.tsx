"use client";

import { useEffect, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import {
  Search,
  RefreshCw,
  Puzzle,
  Package,
  FolderOpen,
  ExternalLink,
  FileText,
  X,
  AlertTriangle,
  ChevronDown,
  BookOpen,
} from "lucide-react";
import { SectionHeader, MetricCard } from "@/components/TenacitOS";

interface Skill {
  id: string;
  name: string;
  description: string;
  location: string;
  source: "workspace" | "system";
  homepage?: string;
  emoji?: string;
  fileCount: number;
  fullContent: string;
  files: string[];
  agents: string[];
  missing?: boolean;
}

interface SkillsData {
  skills: Skill[];
  total: number;
  missing: number;
}

export default function SkillsPage() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterSource, setFilterSource] = useState<"all" | "workspace" | "system">("all");
  const [filterAgent, setFilterAgent] = useState<string>("all");
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);

  const fetchSkills = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/skills");
      const json = await res.json();
      setData(json);
    } catch {
      setData({ skills: [], total: 0, missing: 0 });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  if (!data) {
    return (
      <div style={{ padding: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", paddingTop: "96px", paddingBottom: "96px" }}>
          <RefreshCw className="w-8 h-8 animate-spin" style={{ color: "var(--accent)" }} />
        </div>
      </div>
    );
  }

  const { skills } = data;

  // Collect unique agents across all skills
  const allAgents = Array.from(
    new Set(skills.flatMap((s) => s.agents))
  ).sort();

  // Apply filters
  let filtered = skills;

  if (filterSource !== "all") {
    filtered = filtered.filter((s) => s.source === filterSource);
  }

  if (filterAgent !== "all") {
    filtered = filtered.filter((s) => s.agents.includes(filterAgent));
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
    );
  }

  const workspaceSkills = filtered.filter((s) => s.source === "workspace" && !s.missing);
  const systemSkills = filtered.filter((s) => s.source === "system" && !s.missing);
  const missingSkills = filtered.filter((s) => s.missing);

  const workspaceCount = skills.filter((s) => s.source === "workspace" && !s.missing).length;
  const systemCount = skills.filter((s) => s.source === "system" && !s.missing).length;

  return (
    <div style={{ padding: "24px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "24px" }}>
        <div>
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
            Gerenciador de Skills
          </h1>
          <p style={{ fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-secondary)" }}>
            Skills disponíveis no sistema OpenClaw
          </p>
        </div>
        <button
          onClick={fetchSkills}
          disabled={refreshing}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "8px 14px",
            borderRadius: "6px",
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text-secondary)",
            fontFamily: "var(--font-body)",
            fontSize: "12px",
            fontWeight: 600,
            cursor: refreshing ? "not-allowed" : "pointer",
            opacity: refreshing ? 0.6 : 1,
            transition: "all 150ms ease",
          }}
        >
          <RefreshCw
            style={{
              width: "14px",
              height: "14px",
              animation: refreshing ? "spin 1s linear infinite" : "none",
            }}
          />
          Atualizar
        </button>
      </div>

      {/* Stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "16px",
          marginBottom: "24px",
        }}
      >
        <MetricCard icon={Puzzle} value={skills.filter((s) => !s.missing).length} label="Total de Skills" />
        <MetricCard icon={FolderOpen} value={workspaceCount} label="Skills de Workspace" changeColor="positive" />
        <MetricCard icon={Package} value={systemCount} label="Skills do Sistema" changeColor="secondary" />
        {data.missing > 0 && (
          <MetricCard icon={AlertTriangle} value={data.missing} label="Não instaladas" changeColor="negative" />
        )}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: "12px", marginBottom: "24px", flexWrap: "wrap" }}>
        {/* Search */}
        <div style={{ position: "relative", flex: 1, minWidth: "240px" }}>
          <Search
            style={{
              position: "absolute",
              left: "12px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "16px",
              height: "16px",
              color: "var(--text-muted)",
            }}
          />
          <input
            type="text"
            placeholder="Buscar skills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              paddingLeft: "40px",
              paddingRight: "16px",
              paddingTop: "10px",
              paddingBottom: "10px",
              borderRadius: "6px",
              backgroundColor: "var(--surface-elevated)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-body)",
              fontSize: "12px",
            }}
          />
        </div>

        {/* Source Filter */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {(["all", "workspace", "system"] as const).map((src) => {
            const label = src === "all" ? `Todas (${skills.length})` : src === "workspace" ? `Workspace (${workspaceCount})` : `Sistema (${systemCount})`;
            return (
              <button
                key={src}
                onClick={() => setFilterSource(src)}
                style={{
                  padding: "10px 16px",
                  borderRadius: "6px",
                  backgroundColor: filterSource === src ? "var(--accent-soft)" : "var(--surface)",
                  color: filterSource === src ? "var(--accent)" : "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  fontFamily: "var(--font-body)",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "all 150ms ease",
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Agent Filter */}
        {allAgents.length > 0 && (
          <div style={{ position: "relative" }}>
            <select
              value={filterAgent}
              onChange={(e) => setFilterAgent(e.target.value)}
              style={{
                appearance: "none",
                padding: "10px 36px 10px 14px",
                borderRadius: "6px",
                backgroundColor: filterAgent !== "all" ? "var(--accent-soft)" : "var(--surface)",
                color: filterAgent !== "all" ? "var(--accent)" : "var(--text-secondary)",
                border: "1px solid var(--border)",
                fontFamily: "var(--font-body)",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              <option value="all">Todos os agentes</option>
              {allAgents.map((a) => (
                <option key={a} value={a}>
                  @{a}
                </option>
              ))}
            </select>
            <ChevronDown
              style={{
                position: "absolute",
                right: "10px",
                top: "50%",
                transform: "translateY(-50%)",
                width: "14px",
                height: "14px",
                color: "var(--text-muted)",
                pointerEvents: "none",
              }}
            />
          </div>
        )}
      </div>

      {/* Skills List */}
      {filtered.length === 0 ? (
        <div
          style={{
            backgroundColor: "var(--surface)",
            borderRadius: "12px",
            padding: "48px",
            textAlign: "center",
          }}
        >
          <Puzzle style={{ width: "48px", height: "48px", color: "var(--text-muted)", margin: "0 auto 16px" }} />
          <p style={{ color: "var(--text-secondary)" }}>Nenhuma skill encontrada</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "32px" }}>
          {workspaceSkills.length > 0 && (filterSource === "all" || filterSource === "workspace") && (
            <div>
              <SectionHeader label="SKILLS DO WORKSPACE" />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                  gap: "12px",
                  marginTop: "16px",
                }}
              >
                {workspaceSkills.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} onClick={() => setSelectedSkill(skill)} />
                ))}
              </div>
            </div>
          )}

          {systemSkills.length > 0 && (filterSource === "all" || filterSource === "system") && (
            <div>
              <SectionHeader label="SKILLS DO SISTEMA" />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                  gap: "12px",
                  marginTop: "16px",
                }}
              >
                {systemSkills.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} onClick={() => setSelectedSkill(skill)} />
                ))}
              </div>
            </div>
          )}

          {missingSkills.length > 0 && (
            <div>
              <SectionHeader label="NÃO INSTALADAS" />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                  gap: "12px",
                  marginTop: "16px",
                }}
              >
                {missingSkills.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} onClick={() => setSelectedSkill(skill)} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {selectedSkill && (
        <SkillDetailModal skill={selectedSkill} onClose={() => setSelectedSkill(null)} />
      )}
    </div>
  );
}

function SkillCard({ skill, onClick }: { skill: Skill; onClick: () => void }) {
  const isMissing = skill.missing;

  return (
    <div
      style={{
        backgroundColor: "var(--surface)",
        borderRadius: "8px",
        padding: "16px",
        border: `1px solid ${isMissing ? "var(--warning, #f59e0b)" : "var(--border)"}`,
        cursor: "pointer",
        transition: "all 150ms ease",
        opacity: isMissing ? 0.7 : 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface-hover)";
        e.currentTarget.style.borderColor = isMissing ? "var(--warning, #f59e0b)" : "var(--border-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "var(--surface)";
        e.currentTarget.style.borderColor = isMissing ? "var(--warning, #f59e0b)" : "var(--border)";
      }}
      onClick={onClick}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "12px" }}>
        {isMissing ? (
          <AlertTriangle style={{ width: "24px", height: "24px", flexShrink: 0, color: "var(--warning, #f59e0b)" }} />
        ) : skill.emoji ? (
          <span style={{ fontSize: "24px", flexShrink: 0 }}>{skill.emoji}</span>
        ) : (
          <Puzzle style={{ width: "24px", height: "24px", flexShrink: 0, color: "var(--text-muted)" }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "14px",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "4px",
            }}
          >
            {skill.name}
          </h3>
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "12px",
              color: "var(--text-secondary)",
              lineHeight: "1.5",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {skill.description}
          </p>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: "12px",
          borderTop: "1px solid var(--border)",
          flexWrap: "wrap",
          gap: "6px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          {isMissing ? (
            <div
              style={{
                backgroundColor: "rgba(245, 158, 11, 0.15)",
                color: "var(--warning, #f59e0b)",
                padding: "3px 8px",
                borderRadius: "4px",
                fontFamily: "var(--font-body)",
                fontSize: "9px",
                fontWeight: 700,
                letterSpacing: "1px",
                textTransform: "uppercase",
              }}
            >
              Não instalada
            </div>
          ) : (
            <div
              style={{
                backgroundColor: skill.source === "workspace" ? "var(--accent-soft)" : "var(--surface-elevated)",
                color: skill.source === "workspace" ? "var(--accent)" : "var(--text-muted)",
                padding: "3px 8px",
                borderRadius: "4px",
                fontFamily: "var(--font-body)",
                fontSize: "9px",
                fontWeight: 700,
                letterSpacing: "1px",
                textTransform: "uppercase",
              }}
            >
              {skill.source}
            </div>
          )}
          {skill.agents.map((agent) => (
            <div
              key={agent}
              style={{
                backgroundColor: "var(--surface-elevated)",
                color: "var(--text-secondary)",
                padding: "3px 7px",
                borderRadius: "4px",
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                fontWeight: 600,
                border: "1px solid var(--border)",
              }}
            >
              {agent}
            </div>
          ))}
          {!isMissing && (
            <span style={{ fontFamily: "var(--font-body)", fontSize: "10px", color: "var(--text-muted)" }}>
              {skill.fileCount} arq.
            </span>
          )}
        </div>
        {skill.homepage && (
          <ExternalLink style={{ width: "14px", height: "14px", color: "var(--text-muted)", flexShrink: 0 }} />
        )}
      </div>
    </div>
  );
}

function SkillDetailModal({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<"readme" | "files">("readme");

  // Strip front matter for rendering
  const markdownBody = skill.fullContent.replace(/^---[\s\S]*?---\s*\n/, "").trim();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "var(--surface)",
          borderRadius: "12px",
          maxWidth: "820px",
          width: "100%",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div style={{ padding: "24px", borderBottom: "1px solid var(--border)", position: "relative", flexShrink: 0 }}>
          <button
            onClick={onClose}
            style={{
              position: "absolute",
              top: "20px",
              right: "20px",
              padding: "8px",
              borderRadius: "6px",
              backgroundColor: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--text-muted)",
            }}
          >
            <X style={{ width: "20px", height: "20px" }} />
          </button>

          <div style={{ display: "flex", alignItems: "flex-start", gap: "16px", paddingRight: "40px" }}>
            {skill.missing ? (
              <AlertTriangle style={{ width: "48px", height: "48px", flexShrink: 0, color: "var(--warning, #f59e0b)" }} />
            ) : skill.emoji ? (
              <span style={{ fontSize: "48px", flexShrink: 0 }}>{skill.emoji}</span>
            ) : (
              <Puzzle style={{ width: "48px", height: "48px", flexShrink: 0, color: "var(--text-muted)" }} />
            )}
            <div style={{ flex: 1 }}>
              <h2
                style={{
                  fontFamily: "var(--font-heading)",
                  fontSize: "22px",
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  marginBottom: "6px",
                }}
              >
                {skill.name}
              </h2>
              <p style={{ fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-secondary)", marginBottom: "12px" }}>
                {skill.description}
              </p>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                {skill.missing ? (
                  <span
                    style={{
                      backgroundColor: "rgba(245, 158, 11, 0.15)",
                      color: "var(--warning, #f59e0b)",
                      padding: "3px 10px",
                      borderRadius: "4px",
                      fontSize: "11px",
                      fontWeight: 700,
                    }}
                  >
                    Não instalada
                  </span>
                ) : (
                  <>
                    <span className="badge-positive">{skill.source}</span>
                    <span className="badge-info">{skill.fileCount} arquivos</span>
                  </>
                )}
                {skill.agents.map((agent) => (
                  <span
                    key={agent}
                    style={{
                      backgroundColor: "var(--surface-elevated)",
                      color: "var(--text-secondary)",
                      padding: "3px 10px",
                      borderRadius: "4px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "11px",
                      fontWeight: 600,
                      border: "1px solid var(--border)",
                    }}
                  >
                    @{agent}
                  </span>
                ))}
                {skill.homepage && (
                  <a
                    href={skill.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      color: "var(--accent)",
                      fontSize: "12px",
                      fontWeight: 600,
                      textDecoration: "none",
                    }}
                  >
                    Homepage <ExternalLink style={{ width: "12px", height: "12px" }} />
                  </a>
                )}
              </div>
              <p
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                  color: "var(--text-muted)",
                  marginTop: "10px",
                }}
              >
                {skill.location}
              </p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        {!skill.missing && (
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => setActiveTab("readme")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "12px 20px",
                backgroundColor: "transparent",
                border: "none",
                borderBottom: activeTab === "readme" ? "2px solid var(--accent)" : "2px solid transparent",
                color: activeTab === "readme" ? "var(--accent)" : "var(--text-muted)",
                fontFamily: "var(--font-body)",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                marginBottom: "-1px",
              }}
            >
              <BookOpen style={{ width: "14px", height: "14px" }} />
              SKILL.md
            </button>
            <button
              onClick={() => setActiveTab("files")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "12px 20px",
                backgroundColor: "transparent",
                border: "none",
                borderBottom: activeTab === "files" ? "2px solid var(--accent)" : "2px solid transparent",
                color: activeTab === "files" ? "var(--accent)" : "var(--text-muted)",
                fontFamily: "var(--font-body)",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                marginBottom: "-1px",
              }}
            >
              <FileText style={{ width: "14px", height: "14px" }} />
              Arquivos ({skill.files.length})
            </button>
          </div>
        )}

        {/* Modal Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "24px" }}>
          {skill.missing ? (
            <div
              style={{
                backgroundColor: "rgba(245, 158, 11, 0.08)",
                borderRadius: "8px",
                padding: "20px",
                border: "1px solid rgba(245, 158, 11, 0.3)",
              }}
            >
              <p style={{ fontFamily: "var(--font-body)", fontSize: "13px", color: "var(--text-secondary)", marginBottom: "8px" }}>
                Esta skill está configurada mas não foi encontrada no disco em:
              </p>
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "12px",
                  color: "var(--warning, #f59e0b)",
                  wordBreak: "break-all",
                }}
              >
                {skill.location}
              </code>
            </div>
          ) : activeTab === "readme" ? (
            markdownBody ? (
              <div
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "13px",
                  lineHeight: "1.8",
                  color: "var(--text-secondary)",
                }}
                className="skill-markdown"
              >
                <ReactMarkdown
                  components={{
                    h1: ({ children }) => (
                      <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "20px", fontWeight: 700, color: "var(--text-primary)", margin: "0 0 16px" }}>{children}</h1>
                    ),
                    h2: ({ children }) => (
                      <h2 style={{ fontFamily: "var(--font-heading)", fontSize: "16px", fontWeight: 700, color: "var(--text-primary)", margin: "20px 0 10px" }}>{children}</h2>
                    ),
                    h3: ({ children }) => (
                      <h3 style={{ fontFamily: "var(--font-heading)", fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", margin: "16px 0 8px" }}>{children}</h3>
                    ),
                    p: ({ children }) => (
                      <p style={{ margin: "0 0 12px" }}>{children}</p>
                    ),
                    code: ({ children, className }) => {
                      const isBlock = className?.includes("language-");
                      return isBlock ? (
                        <code
                          style={{
                            display: "block",
                            backgroundColor: "var(--bg)",
                            padding: "12px 16px",
                            borderRadius: "6px",
                            fontFamily: "var(--font-mono)",
                            fontSize: "12px",
                            color: "var(--accent)",
                            overflowX: "auto",
                            marginBottom: "12px",
                          }}
                        >
                          {children}
                        </code>
                      ) : (
                        <code
                          style={{
                            backgroundColor: "var(--surface-elevated)",
                            padding: "2px 6px",
                            borderRadius: "4px",
                            fontFamily: "var(--font-mono)",
                            fontSize: "11px",
                            color: "var(--accent)",
                          }}
                        >
                          {children}
                        </code>
                      );
                    },
                    pre: ({ children }) => (
                      <pre style={{ margin: "0 0 12px", backgroundColor: "var(--bg)", borderRadius: "6px", padding: "12px 16px", overflowX: "auto" }}>{children}</pre>
                    ),
                    ul: ({ children }) => (
                      <ul style={{ paddingLeft: "20px", margin: "0 0 12px" }}>{children}</ul>
                    ),
                    ol: ({ children }) => (
                      <ol style={{ paddingLeft: "20px", margin: "0 0 12px" }}>{children}</ol>
                    ),
                    li: ({ children }) => (
                      <li style={{ marginBottom: "4px" }}>{children}</li>
                    ),
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "underline" }}>{children}</a>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote style={{ borderLeft: "3px solid var(--accent)", paddingLeft: "12px", margin: "0 0 12px", color: "var(--text-muted)" }}>{children}</blockquote>
                    ),
                    hr: () => (
                      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "16px 0" }} />
                    ),
                  }}
                >
                  {markdownBody}
                </ReactMarkdown>
              </div>
            ) : (
              <p style={{ color: "var(--text-muted)", fontFamily: "var(--font-body)", fontSize: "13px" }}>
                Sem conteúdo no SKILL.md
              </p>
            )
          ) : (
            <div>
              <div
                style={{
                  backgroundColor: "var(--bg)",
                  borderRadius: "8px",
                  padding: "16px",
                }}
              >
                {skill.files.length === 0 ? (
                  <p style={{ color: "var(--text-muted)", fontSize: "12px", fontFamily: "var(--font-body)" }}>Nenhum arquivo encontrado</p>
                ) : (
                  skill.files.map((file) => (
                    <div
                      key={file}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "12px",
                        color: "var(--text-secondary)",
                        padding: "4px 0",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <FileText style={{ width: "14px", height: "14px", color: "var(--text-muted)", flexShrink: 0 }} />
                      {file}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
