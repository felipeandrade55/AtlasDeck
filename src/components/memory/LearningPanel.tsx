"use client";

/**
 * Memória → Aprendizado: everything the assistant learned on its own,
 * visible and correctable (owner's choice: learning is automatic but
 * reviewable). Profile, preferences, clients + brand kits, deliverables,
 * extractor/bridge status.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Check, Pencil, Plug, Plus, RefreshCw, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { useToast } from "@/components/Toast";

interface Learning {
  id: string;
  pattern: string;
  source: string;
  confidence: number;
  evidence: string | null;
  last_seen_at: string;
}

interface BrandKit {
  colors?: string[];
  fonts?: string[];
  tone?: string;
  logo?: string;
  references?: string[];
  notes?: string;
}

interface Entity {
  id: string;
  type: string;
  name: string;
  summary: string | null;
  aliases: string[];
  attributes: { brand?: BrandKit };
  last_seen_at: string | null;
}

interface Deliverable {
  id: string;
  kind: string;
  title: string;
  client_name: string | null;
  approach: string | null;
  branding: string | null;
  artifact_url: string | null;
  artifact_path: string | null;
  outcome: string | null;
  created_at: string;
}

interface Job {
  status: string;
  detail: string | null;
  error: string | null;
  started_at: string;
}

interface LearningData {
  profile: string | null;
  preferences: Learning[];
  entities: Entity[];
  deliverables: Deliverable[];
  reflection: { lastRun: string | null; jobs: Job[] };
  extraction: {
    jobs: Job[];
    llm: { breakerOpen: boolean; lastError: string | null; preferred: string | null };
  };
  bridge: { lastSeen: string | null };
}

interface BridgeStatus {
  inConfig: boolean;
  enabled: boolean;
  active: boolean;
  lastSeen: string | null;
  pluginDirExists: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  conversation: "conversa",
  correction: "correção",
  feedback_text: "feedback",
  rejection: "rejeição",
  manual: "manual",
};

const TYPE_LABEL: Record<string, string> = {
  client: "Cliente",
  brand: "Marca",
  project: "Projeto",
  person: "Pessoa",
  organization: "Organização",
};

const card: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--surface, var(--card))",
  padding: 16,
};
const btn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: 12,
};
const iconBtn: React.CSSProperties = { ...btn, padding: "4px 6px", color: "var(--text-muted)" };
const input: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-primary)",
  fontSize: 12,
};
const h2: React.CSSProperties = {
  fontFamily: "var(--font-heading)",
  fontSize: 15,
  fontWeight: 600,
  color: "var(--text-primary)",
  margin: 0,
};
const muted: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)" };

function fmt(date: string | null): string {
  if (!date) return "—";
  const iso = date.includes("T") ? date : `${date.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function splitList(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function LearningPanel() {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const [data, setData] = useState<LearningData | null>(null);
  const [bridge, setBridge] = useState<BridgeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [newPref, setNewPref] = useState("");
  const [newClient, setNewClient] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, b] = await Promise.all([
        fetch("/api/memory/learning").then((r) => r.json()),
        fetch("/api/memory/bridge-plugin").then((r) => r.json()).catch(() => null),
      ]);
      setData(l as LearningData);
      setBridge(b as BridgeStatus | null);
    } catch {
      toastRef.current.error("Falha ao carregar o aprendizado");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (action: string, payload: Record<string, unknown> = {}, okMsg?: string) => {
      setBusy(action);
      try {
        const res = await fetch("/api/memory/learning", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...payload }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || "falhou");
        if (okMsg) toastRef.current.success(okMsg);
        await load();
        return body;
      } catch (err) {
        toastRef.current.error(err instanceof Error ? err.message : "Falha");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const runExtraction = async () => {
    setBusy("extract");
    try {
      const res = await fetch("/api/memory/extract/run", { method: "POST", body: "{}" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "falhou");
      toast.success(
        `Extração: +${body.created ?? 0} novas, ${body.updated ?? 0} atualizadas${body.failed ? `, ${body.failed} lote(s) com erro` : ""}`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha na extração");
    } finally {
      setBusy(null);
    }
  };

  const [backfill, setBackfill] = useState<{ active: boolean; batches: number; finishedAt?: string | null } | null>(null);
  useEffect(() => {
    fetch("/api/memory/backfill?days=90")
      .then((r) => r.json())
      .then((b) => setBackfill(b.state ?? null))
      .catch(() => undefined);
  }, [data]);

  const backfillAction = async () => {
    setBusy("backfill");
    try {
      if (backfill?.active) {
        await fetch("/api/memory/backfill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop" }) });
        toast.info("Reprocessamento pausado");
      } else {
        const est = await fetch("/api/memory/backfill?days=90").then((r) => r.json());
        const e = est.estimate as { threads: number; messages: number; estimatedCalls: number };
        if (!e.threads) {
          toast.info("Nada pendente nos últimos 90 dias");
          return;
        }
        if (
          !window.confirm(
            `Reprocessar ${e.threads} conversa(s) dos últimos 90 dias (${e.messages} mensagens, ~${e.estimatedCalls} chamadas ao modelo pela sua assinatura OpenClaw)?\n\nRoda em segundo plano, só quando o bot estiver ocioso.`,
          )
        )
          return;
        await fetch("/api/memory/backfill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", days: 90 }) });
        toast.success("Reprocessamento iniciado em segundo plano");
      }
      await load();
    } catch {
      toast.error("Falha no reprocessamento");
    } finally {
      setBusy(null);
    }
  };

  const bridgeAction = async (action: "install" | "disable") => {
    if (
      action === "install" &&
      !window.confirm(
        "Instalar o plugin de memória no gateway do OpenClaw? O gateway será reiniciado (o bot fica fora por alguns segundos). A config é validada e revertida se o OpenClaw recusar.",
      )
    )
      return;
    setBusy(`bridge-${action}`);
    try {
      const res = await fetch("/api/memory/bridge-plugin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        const steps = (body.steps ?? []) as Array<{ step: string; ok: boolean; output?: string }>;
        const failed = steps.find((s) => !s.ok);
        throw new Error(`${body.error ?? "falhou"}${failed?.output ? ` — ${failed.output.slice(0, 300)}` : ""}`);
      }
      toast.success(action === "install" ? "Plugin instalado e gateway reiniciado" : "Plugin desativado");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div style={{ padding: 24, color: "var(--text-secondary)" }}>Carregando…</div>;
  if (!data) return <div style={{ padding: 24, color: "var(--text-secondary)" }}>Sem dados.</div>;

  const lastExtract = data.extraction.jobs[0];
  const failedExtract = data.extraction.jobs.filter((j) => j.status === "failed").length;

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
      <div style={{ maxWidth: 960, marginInline: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Status */}
        <section style={{ ...card, display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <div>
            <p style={h2}>Aprendizado automático</p>
            <p style={{ ...muted, marginTop: 6 }}>
              {data.extraction.llm.breakerOpen ? (
                <span style={{ color: "var(--error, #FF453A)" }}>
                  Sem acesso ao modelo: {(data.extraction.llm.lastError ?? "").slice(0, 160)}
                </span>
              ) : lastExtract ? (
                <>
                  Último lote: {lastExtract.status} em {fmt(lastExtract.started_at)}
                  {lastExtract.detail ? ` (${lastExtract.detail})` : ""}
                  {failedExtract ? ` · ${failedExtract} erro(s) recentes` : ""}
                </>
              ) : (
                "Ainda não processou conversas. Roda sozinho ~90s depois de cada conversa."
              )}
            </p>
            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              <button style={btn} onClick={runExtraction} disabled={busy !== null}>
                <Sparkles size={13} /> {busy === "extract" ? "Extraindo…" : "Extrair agora"}
              </button>
              <button style={btn} onClick={() => act("run-reflection", {}, "Reflexão concluída")} disabled={busy !== null}>
                <Wand2 size={13} /> {busy === "run-reflection" ? "Refletindo…" : "Atualizar perfil"}
              </button>
              <button style={btn} onClick={backfillAction} disabled={busy !== null}>
                <RefreshCw size={13} />{" "}
                {backfill?.active ? `Pausar reprocessamento (${backfill.batches} lotes)` : "Aprender com os últimos 90 dias"}
              </button>
              <button style={iconBtn} onClick={() => void load()} title="Recarregar" aria-label="Recarregar">
                <RefreshCw size={13} />
              </button>
            </div>
            {backfill && !backfill.active && backfill.finishedAt && (
              <p style={{ ...muted, marginTop: 6 }}>
                Reprocessamento concluído em {fmt(backfill.finishedAt)} ({backfill.batches} lotes).
              </p>
            )}
          </div>
          <div>
            <p style={h2}>Memória no Telegram</p>
            <p style={{ ...muted, marginTop: 6 }}>
              {bridge?.active
                ? `Plugin ativo — visto ${fmt(bridge.lastSeen)}. O bot recebe o que é relevante a cada mensagem e aprende com cada conversa.`
                : bridge?.enabled
                  ? "Plugin habilitado, mas ainda não se comunicou. Mande uma mensagem ao bot para testar."
                  : "Sem plugin: no Telegram o bot só vê o resumo do MEMORY.md e aprende pelas sessões importadas (com atraso)."}
            </p>
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              {!bridge?.enabled ? (
                <button style={btn} onClick={() => bridgeAction("install")} disabled={busy !== null || !bridge?.pluginDirExists}>
                  <Plug size={13} /> {busy === "bridge-install" ? "Instalando…" : "Instalar plugin"}
                </button>
              ) : (
                <button style={btn} onClick={() => bridgeAction("disable")} disabled={busy !== null}>
                  <Ban size={13} /> Desativar plugin
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Profile */}
        <section style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <p style={h2}>Perfil aprendido</p>
            <span style={muted}>atualizado {fmt(data.reflection.lastRun)} · fica no USER.md do agente</span>
          </div>
          {data.profile ? (
            <div style={{ marginTop: 8, border: "1px solid var(--border)", borderRadius: 8, maxHeight: 320, overflow: "auto" }}>
              <MarkdownPreview content={data.profile.replace(/^## Perfil aprendido pelo AtlasDeck\s*/m, "")} />
            </div>
          ) : (
            <p style={{ ...muted, marginTop: 8 }}>Ainda não gerado — roda toda madrugada ou em &quot;Atualizar perfil&quot;.</p>
          )}
        </section>

        {/* Preferences */}
        <section style={card}>
          <p style={h2}>Preferências</p>
          <p style={{ ...muted, marginTop: 4 }}>
            Aprendidas nas conversas e correções. Abaixo de 0,25 de confiança ainda não entram nos prompts — a repetição reforça.
          </p>
          <form
            style={{ display: "flex", gap: 6, marginTop: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (newPref.trim().length < 4) return;
              void act("add-learning", { pattern: newPref.trim() }, "Preferência adicionada").then(() => setNewPref(""));
            }}
          >
            <input
              style={input}
              placeholder='Adicionar manualmente, ex.: "Sempre mandar o link da página no final"'
              value={newPref}
              onChange={(e) => setNewPref(e.target.value)}
            />
            <button type="submit" style={btn} disabled={busy !== null}>
              <Plus size={13} />
            </button>
          </form>
          <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "flex", flexDirection: "column", gap: 4 }}>
            {data.preferences.length === 0 && <li style={muted}>Nenhuma ainda.</li>}
            {data.preferences.map((p) => (
              <li
                key={p.id}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg)" }}
                title={p.evidence ?? undefined}
              >
                <span style={{ flex: 1, fontSize: 13, color: p.confidence < 0.25 ? "var(--text-muted)" : "var(--text-primary)" }}>
                  {p.pattern}
                </span>
                <span style={{ ...muted, whiteSpace: "nowrap" }}>
                  {SOURCE_LABEL[p.source] ?? p.source} · {p.confidence.toFixed(2)}
                </span>
                <button style={iconBtn} onClick={() => act("refute-learning", { id: p.id }, "Marcada como errada")} title="Está errada" aria-label="Marcar como errada">
                  <X size={13} />
                </button>
                <button style={iconBtn} onClick={() => act("delete-learning", { id: p.id })} title="Apagar" aria-label="Apagar">
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Entities */}
        <section style={card}>
          <p style={h2}>Clientes e marcas</p>
          <p style={{ ...muted, marginTop: 4 }}>
            A identidade visual registrada aqui é oferecida ao bot quando o cliente é citado. Para outro cliente, ele pergunta antes de reaproveitar.
          </p>
          <form
            style={{ display: "flex", gap: 6, marginTop: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!newClient.trim()) return;
              void act("create-entity", { type: "client", name: newClient.trim() }, "Cliente adicionado").then(() => setNewClient(""));
            }}
          >
            <input style={input} placeholder="Novo cliente" value={newClient} onChange={(e) => setNewClient(e.target.value)} />
            <button type="submit" style={btn} disabled={busy !== null}>
              <Plus size={13} />
            </button>
          </form>
          <div style={{ display: "grid", gap: 8, marginTop: 10, gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {data.entities.length === 0 && <p style={muted}>Nenhum ainda — aparecem conforme você fala deles.</p>}
            {data.entities.map((e) =>
              editing === e.id ? (
                <EntityEditor
                  key={e.id}
                  entity={e}
                  onCancel={() => setEditing(null)}
                  onSave={async (patch) => {
                    const ok = await act("update-entity", { id: e.id, ...patch }, "Salvo");
                    if (ok) setEditing(null);
                  }}
                />
              ) : (
                <div key={e.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, background: "var(--bg)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <strong style={{ fontSize: 13, color: "var(--text-primary)", flex: 1 }}>{e.name}</strong>
                    <span style={muted}>{TYPE_LABEL[e.type] ?? e.type}</span>
                    <button style={iconBtn} onClick={() => setEditing(e.id)} title="Editar" aria-label={`Editar ${e.name}`}>
                      <Pencil size={12} />
                    </button>
                    <button
                      style={iconBtn}
                      onClick={() => window.confirm(`Apagar ${e.name}?`) && act("delete-entity", { id: e.id })}
                      title="Apagar"
                      aria-label={`Apagar ${e.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {e.summary && <p style={{ ...muted, margin: "4px 0 0" }}>{e.summary}</p>}
                  <BrandView kit={e.attributes?.brand} />
                </div>
              ),
            )}
          </div>
        </section>

        {/* Deliverables */}
        <section style={card}>
          <p style={h2}>Entregas</p>
          <p style={{ ...muted, marginTop: 4 }}>O que foi produzido e para quem — base dos &quot;quer reaproveitar o que fizemos para X?&quot;.</p>
          <div style={{ overflowX: "auto", marginTop: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                  <th style={{ padding: 6 }}>Data</th>
                  <th style={{ padding: 6 }}>Tipo</th>
                  <th style={{ padding: 6 }}>Título</th>
                  <th style={{ padding: 6 }}>Cliente</th>
                  <th style={{ padding: 6 }}>Resultado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.deliverables.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ ...muted, padding: 6 }}>
                      Nenhuma ainda.
                    </td>
                  </tr>
                )}
                {data.deliverables.map((d) => (
                  <tr key={d.id} style={{ borderTop: "1px solid var(--border)" }} title={[d.approach, d.branding].filter(Boolean).join("\n")}>
                    <td style={{ padding: 6, whiteSpace: "nowrap", color: "var(--text-secondary)" }}>{fmt(d.created_at)}</td>
                    <td style={{ padding: 6 }}>{d.kind}</td>
                    <td style={{ padding: 6, color: "var(--text-primary)" }}>
                      {d.artifact_url ? (
                        <a href={d.artifact_url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                          {d.title}
                        </a>
                      ) : (
                        d.title
                      )}
                    </td>
                    <td style={{ padding: 6 }}>{d.client_name ?? "—"}</td>
                    <td style={{ padding: 6 }}>{d.outcome ?? "—"}</td>
                    <td style={{ padding: 6 }}>
                      <button style={iconBtn} onClick={() => act("delete-deliverable", { id: d.id })} title="Apagar" aria-label="Apagar entrega">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function BrandView({ kit }: { kit?: BrandKit }) {
  if (!kit || (!kit.colors?.length && !kit.fonts?.length && !kit.tone && !kit.logo && !kit.notes)) {
    return <p style={{ ...muted, margin: "6px 0 0" }}>Sem identidade visual registrada.</p>;
  }
  return (
    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
      {kit.colors?.length ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          {kit.colors.map((c) => (
            <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>
              <span
                aria-hidden="true"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  border: "1px solid var(--border)",
                  background: /^#[0-9a-f]{3,8}$/i.test(c) ? c : "transparent",
                }}
              />
              {c}
            </span>
          ))}
        </div>
      ) : null}
      {kit.fonts?.length ? <span style={muted}>Fontes: {kit.fonts.join(", ")}</span> : null}
      {kit.tone ? <span style={muted}>Tom: {kit.tone}</span> : null}
      {kit.logo ? <span style={muted}>Logo: {kit.logo}</span> : null}
      {kit.notes ? <span style={muted}>{kit.notes}</span> : null}
    </div>
  );
}

function EntityEditor({
  entity,
  onSave,
  onCancel,
}: {
  entity: Entity;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const kit = entity.attributes?.brand ?? {};
  const [name, setName] = useState(entity.name);
  const [summary, setSummary] = useState(entity.summary ?? "");
  const [colors, setColors] = useState((kit.colors ?? []).join(", "));
  const [fonts, setFonts] = useState((kit.fonts ?? []).join(", "));
  const [tone, setTone] = useState(kit.tone ?? "");
  const [logo, setLogo] = useState(kit.logo ?? "");
  const [notes, setNotes] = useState(kit.notes ?? "");

  return (
    <form
      style={{ border: "1px solid var(--accent)", borderRadius: 8, padding: 10, background: "var(--bg)", display: "flex", flexDirection: "column", gap: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        const brand = { colors: splitList(colors), fonts: splitList(fonts), tone, logo, notes };
        void onSave({ name, summary, brand });
      }}
    >
      <input style={input} value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome" />
      <input style={input} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Resumo" aria-label="Resumo" />
      <input style={input} value={colors} onChange={(e) => setColors(e.target.value)} placeholder="Cores (#123456, #ffcc00)" aria-label="Cores" />
      <input style={input} value={fonts} onChange={(e) => setFonts(e.target.value)} placeholder="Fontes" aria-label="Fontes" />
      <input style={input} value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Tom de voz" aria-label="Tom de voz" />
      <input style={input} value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="Logo (caminho ou URL)" aria-label="Logo" />
      <input style={input} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Observações" aria-label="Observações" />
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button type="button" style={btn} onClick={onCancel}>
          Cancelar
        </button>
        <button type="submit" style={{ ...btn, borderColor: "var(--accent)", color: "var(--accent)" }}>
          <Check size={13} /> Salvar
        </button>
      </div>
    </form>
  );
}
