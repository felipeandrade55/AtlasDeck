"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, Mail, Pause, Play, RotateCcw, ExternalLink, Copy } from "lucide-react";

interface Client {
  slug: string;
  name: string;
  contact_email: string | null;
  plan: string | null;
  status: string;
  fqdn: string | null;
  admin_password?: string | null;
  credentials_delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "var(--text-muted)",
  provisioning: "var(--warning, #FFD60A)",
  deploying: "var(--warning, #FFD60A)",
  active: "var(--success, #32D74B)",
  failed: "var(--danger, #FF3B30)",
  suspended: "var(--text-muted)",
};

function slugifyClient(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

export default function SaasPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [coolifyConfigured, setCoolifyConfigured] = useState(true);
  const [baseDomain, setBaseDomain] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [justCreated, setJustCreated] = useState<Client | null>(null);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  const effectiveSlug = slugEdited ? slug : slugifyClient(name);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/saas/clients", { cache: "no-store" });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setClients(data.clients ?? []);
      setCoolifyConfigured(!!data.coolifyConfigured);
      setBaseDomain(data.baseDomain ?? "");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while any client is mid-deploy.
  const anyDeploying = useMemo(
    () => clients.some((c) => c.status === "deploying" || c.status === "provisioning"),
    [clients],
  );
  useEffect(() => {
    if (!anyDeploying) return;
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [anyDeploying, load]);

  const create = async () => {
    setCreating(true);
    setMsg(null);
    setJustCreated(null);
    try {
      const res = await fetch("/api/saas/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), slug: effectiveSlug, email: email.trim(), plan: plan.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ kind: "err", text: data.error ?? "Falha ao criar cliente." });
        return;
      }
      setJustCreated(data.client as Client);
      setMsg({ kind: "ok", text: `Cliente ${data.client.slug} criado — provisionando no Coolify…` });
      setName(""); setSlug(""); setEmail(""); setPlan(""); setSlugEdited(false);
      load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Erro de rede." });
    } finally {
      setCreating(false);
    }
  };

  const action = async (slugArg: string, act: "resend" | "suspend" | "reactivate" | "reprovision") => {
    setMsg(null);
    try {
      const res = await fetch(`/api/saas/clients/${slugArg}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: act }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ kind: "err", text: data.error ?? `Falha em '${act}'.` });
      } else {
        setMsg({ kind: "ok", text: `Ação '${act}' aplicada a ${slugArg}.` });
      }
      load();
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Erro de rede." });
    }
  };

  if (forbidden) {
    return (
      <div style={{ padding: 32, color: "var(--text-secondary)" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-primary)", marginBottom: 8 }}>Clientes SaaS</h1>
        Este painel só existe na instância do <strong>dono</strong> (modo nativo). Este container é de um cliente.
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text-primary)", marginBottom: 4 }}>Clientes SaaS</h1>
      <p style={{ fontSize: 13.5, color: "var(--text-secondary)", marginBottom: 18 }}>
        Provisione um AtlasDeck dedicado por cliente em <code>&lt;slug&gt;.{baseDomain || "ih01.atlasdeck.ia.br"}</code>.
        O deploy roda no Coolify; o status atualiza sozinho aqui.
      </p>

      {!coolifyConfigured && (
        <div style={banner("var(--danger, #FF3B30)")}>
          Coolify não configurado. Defina <code>COOLIFY_URL</code> e <code>COOLIFY_TOKEN</code> (env do processo do dono
          ou <code>data/saas-config.json</code>) para provisionar.
        </div>
      )}
      {msg && <div style={banner(msg.kind === "ok" ? "var(--success, #32D74B)" : "var(--danger, #FF3B30)")}>{msg.text}</div>}

      {justCreated && (
        <div style={{ ...card, borderColor: "var(--success, #32D74B)", marginBottom: 16 }}>
          <strong style={{ color: "var(--text-primary)" }}>Credenciais de {justCreated.name}</strong>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 8, display: "grid", gap: 4 }}>
            <Row label="URL" value={`https://${justCreated.fqdn}`} copyable />
            <Row label="Usuário" value="admin" copyable />
            <Row label="Senha" value={justCreated.admin_password ?? "—"} copyable mono />
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
            Guarde agora. Se informou email, as credenciais serão enviadas automaticamente quando ficar no ar.
          </p>
        </div>
      )}

      {/* Novo cliente */}
      <div style={{ ...card, marginBottom: 20 }}>
        <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>Novo cliente</strong>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
          <Field label="Nome">
            <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Felipe Andrade" />
          </Field>
          <Field label={`Slug (vira ${effectiveSlug || "—"}.${baseDomain || "…"})`}>
            <input
              style={input}
              value={effectiveSlug}
              onChange={(e) => { setSlug(slugifyClient(e.target.value)); setSlugEdited(true); }}
              placeholder="felipeandrade"
            />
          </Field>
          <Field label="Email do cliente (entrega das credenciais)">
            <input style={input} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@email.com" />
          </Field>
          <Field label="Plano (opcional)">
            <input style={input} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="pro" />
          </Field>
        </div>
        <button
          type="button"
          onClick={create}
          disabled={creating || !name.trim() || !coolifyConfigured}
          style={primaryBtn}
        >
          {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Provisionar cliente
        </button>
      </div>

      {/* Lista */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>Clientes ({clients.length})</strong>
        <button type="button" onClick={load} style={ghostBtn}><RefreshCw size={12} /> Atualizar</button>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: 16, display: "flex", gap: 8, alignItems: "center" }}>
          <Loader2 size={14} className="animate-spin" /> Carregando…
        </div>
      ) : clients.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: 16 }}>Nenhum cliente ainda.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {clients.map((c) => (
            <div key={c.slug} style={card}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 8, background: STATUS_COLORS[c.status] ?? "var(--text-muted)" }} />
                    <strong style={{ color: "var(--text-primary)" }}>{c.name}</strong>
                    <span style={{ fontSize: 11, color: STATUS_COLORS[c.status] ?? "var(--text-muted)" }}>{c.status}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                    {c.fqdn ? (
                      <a href={`https://${c.fqdn}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", textDecoration: "none" }}>
                        {c.fqdn} <ExternalLink size={10} style={{ display: "inline" }} />
                      </a>
                    ) : c.slug}
                    {c.contact_email ? ` · ${c.contact_email}` : ""}{c.plan ? ` · ${c.plan}` : ""}
                  </div>
                  {c.last_error && <div style={{ fontSize: 11, color: "var(--danger, #FF3B30)", marginTop: 2 }}>{c.last_error}</div>}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => action(c.slug, "resend")} style={ghostBtn} title="Reenviar credenciais por email"><Mail size={12} /> Reenviar</button>
                  {c.status === "suspended"
                    ? <button type="button" onClick={() => action(c.slug, "reactivate")} style={ghostBtn}><Play size={12} /> Reativar</button>
                    : <button type="button" onClick={() => action(c.slug, "suspend")} style={ghostBtn}><Pause size={12} /> Suspender</button>}
                  {c.status === "failed" && <button type="button" onClick={() => action(c.slug, "reprovision")} style={ghostBtn}><RotateCcw size={12} /> Reprovisionar</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, copyable, mono }: { label: string; value: string; copyable?: boolean; mono?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: "var(--text-muted)", width: 70 }}>{label}</span>
      <code style={{ color: "var(--text-primary)", fontFamily: mono ? "var(--font-mono)" : "inherit" }}>{value}</code>
      {copyable && (
        <button type="button" onClick={() => navigator.clipboard.writeText(value).catch(() => {})} style={{ ...ghostBtn, padding: "2px 6px" }} title="Copiar">
          <Copy size={11} />
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</span>
      {children}
    </label>
  );
}

const card: React.CSSProperties = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 10, padding: 14 };
const input: React.CSSProperties = { padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-primary)", fontSize: 13, fontFamily: "inherit", outline: "none" };
const primaryBtn: React.CSSProperties = { marginTop: 12, display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "var(--accent)", color: "var(--bg)", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const ghostBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 6, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", fontSize: 12, cursor: "pointer" };
function banner(color: string): React.CSSProperties {
  return { padding: "10px 14px", borderRadius: 8, border: `1px solid ${color}`, background: "color-mix(in srgb, " + color + " 8%, transparent)", color: "var(--text-primary)", fontSize: 13, marginBottom: 14 };
}
