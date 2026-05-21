"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { Search, MapPin, Crosshair, Save, Trash2, X, Sun, Send } from "lucide-react";

const MapView = dynamic(() => import("./LocationPickerMap"), {
  ssr: false,
  loading: () => (
    <div style={{ height: 360, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "var(--card-elevated)", borderRadius: "0.5rem", color: "var(--text-muted)" }}>
      Carregando mapa...
    </div>
  ),
});

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
}

interface SavedLocation {
  lat: number | null;
  lon: number | null;
  label: string | null;
  timezone: string | null;
  updated_at: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: (loc: SavedLocation) => void;
}

export function LocationPicker({ open, onClose, onSaved }: Props) {
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [label, setLabel] = useState<string>("");
  const [query, setQuery] = useState<string>("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);
  const [briefingStatus, setBriefingStatus] = useState<{ installed: boolean; available: boolean; loading: boolean }>({ installed: false, available: false, loading: true });
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  // Load existing location + briefing status on open
  useEffect(() => {
    if (!open) return;
    fetch("/api/user/location")
      .then((r) => r.json())
      .then((loc: SavedLocation) => {
        if (typeof loc.lat === "number") setLat(loc.lat);
        if (typeof loc.lon === "number") setLon(loc.lon);
        if (loc.label) setLabel(loc.label);
      })
      .catch(() => {});

    setBriefingStatus((s) => ({ ...s, loading: true }));
    fetch("/api/agent/morning-briefing/setup")
      .then((r) => r.json())
      .then((s: { installed: boolean; available: boolean }) => {
        setBriefingStatus({ installed: !!s.installed, available: !!s.available, loading: false });
      })
      .catch(() => setBriefingStatus({ installed: false, available: false, loading: false }));
  }, [open]);

  const toggleBriefing = async () => {
    setBriefingBusy(true);
    setError(null);
    try {
      if (briefingStatus.installed) {
        const res = await fetch("/api/agent/morning-briefing/setup", { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao desativar");
        setBriefingStatus({ ...briefingStatus, installed: false });
      } else {
        const res = await fetch("/api/agent/morning-briefing/setup", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao ativar");
        setBriefingStatus({ ...briefingStatus, installed: true });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao alterar briefing");
    } finally {
      setBriefingBusy(false);
    }
  };

  const previewBriefing = async () => {
    setPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch("/api/agent/morning-briefing?dry=1&force=1");
      const data = await res.json();
      if (data.message) {
        setPreview(data.message);
      } else if (data.error) {
        setError(data.error);
      } else if (data.skipped) {
        setError(`Briefing pulado: ${data.reason}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao gerar preview");
    } finally {
      setPreviewing(false);
    }
  };

  // Debounced Nominatim search
  useEffect(() => {
    if (!query.trim() || query.trim().length < 3) {
      setResults([]);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { headers: { "Accept-Language": "pt-BR" } });
        const data = (await res.json()) as NominatimResult[];
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query]);

  const useCurrentLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError("Geolocalização indisponível neste navegador");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude);
        setLon(pos.coords.longitude);
        setError(null);
        // Reverse-geocode for a friendly label
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`, {
          headers: { "Accept-Language": "pt-BR" },
        })
          .then((r) => r.json())
          .then((d: { display_name?: string }) => {
            if (d.display_name) setLabel(d.display_name);
          })
          .catch(() => {});
      },
      (err) => setError(err.code === 1 ? "Permissão de localização negada" : "Não foi possível obter a localização"),
      { timeout: 8000 }
    );
  }, []);

  const pickResult = (r: NominatimResult) => {
    setLat(parseFloat(r.lat));
    setLon(parseFloat(r.lon));
    setLabel(r.display_name);
    setResults([]);
    setQuery("");
  };

  const handleMapClick = useCallback((nextLat: number, nextLon: number) => {
    setLat(nextLat);
    setLon(nextLon);
    // Reverse geocode for label
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${nextLat}&lon=${nextLon}`, {
      headers: { "Accept-Language": "pt-BR" },
    })
      .then((r) => r.json())
      .then((d: { display_name?: string }) => {
        if (d.display_name) setLabel(d.display_name);
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    if (lat === null || lon === null) {
      setError("Selecione um ponto no mapa, busque um endereço ou use sua localização atual");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch("/api/user/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lon, label: label.trim() || null, timezone: tz }),
      });
      const saved = await res.json();
      if (!res.ok) {
        setError(saved.error || "Erro ao salvar");
        return;
      }
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!confirm("Remover localização salva?")) return;
    await fetch("/api/user/location", { method: "DELETE" });
    setLat(null);
    setLon(null);
    setLabel("");
    onSaved?.({ lat: null, lon: null, label: null, timezone: null, updated_at: null });
    onClose();
  };

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: "0.75rem",
          padding: "1.25rem",
          width: "100%",
          maxWidth: 720,
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <MapPin className="w-5 h-5" style={{ color: "var(--accent)" }} />
            Onde você mora
          </h2>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
          Esta localização é usada na previsão do tempo e nas mensagens proativas do OpenClaw (briefing matinal, alertas de chuva).
        </p>

        {/* Search */}
        <div style={{ position: "relative", marginBottom: "0.75rem" }}>
          <div style={{ position: "relative" }}>
            <Search
              className="w-4 h-4"
              style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }}
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar endereço, cidade, CEP..."
              style={{
                width: "100%",
                padding: "0.5rem 0.5rem 0.5rem 2rem",
                backgroundColor: "var(--card-elevated)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                color: "var(--text-primary)",
                fontSize: "0.875rem",
              }}
            />
          </div>
          {results.length > 0 && (
            <div
              style={{
                position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                zIndex: 10,
                maxHeight: 240,
                overflowY: "auto",
              }}
            >
              {results.map((r, i) => (
                <button
                  key={`${r.lat},${r.lon},${i}`}
                  onClick={() => pickResult(r)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "0.5rem 0.75rem",
                    background: "none",
                    border: "none",
                    borderBottom: i < results.length - 1 ? "1px solid var(--border)" : "none",
                    color: "var(--text-primary)",
                    fontSize: "0.825rem",
                    cursor: "pointer",
                  }}
                >
                  {r.display_name}
                </button>
              ))}
            </div>
          )}
          {searching && (
            <div style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: "0.7rem", color: "var(--text-muted)" }}>
              buscando...
            </div>
          )}
        </div>

        <button
          onClick={useCurrentLocation}
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.375rem",
            padding: "0.4rem 0.75rem",
            backgroundColor: "var(--card-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "0.5rem",
            color: "var(--text-secondary)",
            fontSize: "0.8rem",
            cursor: "pointer",
            marginBottom: "0.75rem",
          }}
        >
          <Crosshair className="w-3.5 h-3.5" />
          Usar minha localização atual
        </button>

        {/* Map */}
        <MapView lat={lat} lon={lon} onPick={handleMapClick} />

        {/* Selected */}
        {lat !== null && lon !== null && (
          <div
            style={{
              marginTop: "0.75rem",
              padding: "0.625rem 0.75rem",
              backgroundColor: "var(--card-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              fontSize: "0.825rem",
            }}
          >
            <div style={{ color: "var(--text-muted)", fontSize: "0.7rem", marginBottom: "0.25rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Selecionado
            </div>
            <div style={{ color: "var(--text-primary)", marginBottom: "0.375rem" }}>
              📍 {lat.toFixed(5)}, {lon.toFixed(5)}
            </div>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Nome amigável (ex: Goiânia, GO — Setor X)"
              style={{
                width: "100%",
                padding: "0.4rem 0.5rem",
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "0.375rem",
                color: "var(--text-primary)",
                fontSize: "0.8rem",
              }}
            />
          </div>
        )}

        {/* Morning briefing toggle */}
        <div
          style={{
            marginTop: "0.875rem",
            padding: "0.75rem",
            backgroundColor: "var(--card-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "0.5rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Sun className="w-4 h-4" style={{ color: "#f59e0b" }} />
              <div>
                <div style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--text-primary)" }}>
                  Briefing matinal 7h
                </div>
                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                  Telegram com clima, chuva e alertas — só dispara se houver algo relevante
                </div>
              </div>
            </div>
            <button
              onClick={toggleBriefing}
              disabled={briefingBusy || briefingStatus.loading || !briefingStatus.available}
              style={{
                padding: "0.4rem 0.875rem",
                backgroundColor: briefingStatus.installed ? "var(--card)" : "#f59e0b",
                border: briefingStatus.installed ? "1px solid var(--border)" : "none",
                borderRadius: "0.5rem",
                color: briefingStatus.installed ? "var(--text-secondary)" : "white",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: briefingBusy || !briefingStatus.available ? "not-allowed" : "pointer",
                opacity: briefingBusy || !briefingStatus.available ? 0.5 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {briefingStatus.loading ? "..." : briefingBusy ? "Aplicando..." : briefingStatus.installed ? "Desativar" : "Ativar"}
            </button>
          </div>
          {!briefingStatus.available && !briefingStatus.loading && (
            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              CLI <code>openclaw</code> não disponível neste host — briefing só pode ser ativado onde o gateway OpenClaw está instalado.
            </div>
          )}
          <button
            onClick={previewBriefing}
            disabled={previewing || lat === null}
            style={{
              display: "inline-flex", alignItems: "center", gap: "0.3rem",
              padding: "0.3rem 0.625rem",
              backgroundColor: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "0.375rem",
              color: "var(--text-muted)",
              fontSize: "0.725rem",
              cursor: previewing || lat === null ? "not-allowed" : "pointer",
              opacity: previewing || lat === null ? 0.5 : 1,
            }}
          >
            <Send className="w-3 h-3" />
            {previewing ? "Gerando..." : "Pré-visualizar mensagem"}
          </button>
          {preview && (
            <pre
              style={{
                marginTop: "0.5rem",
                padding: "0.5rem 0.625rem",
                backgroundColor: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: "0.375rem",
                color: "var(--text-secondary)",
                fontSize: "0.75rem",
                whiteSpace: "pre-wrap",
                fontFamily: "inherit",
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {preview.replace(/<[^>]+>/g, "")}
            </pre>
          )}
        </div>

        {error && (
          <div style={{ marginTop: "0.75rem", padding: "0.5rem 0.75rem", backgroundColor: "rgba(255,59,48,0.1)", border: "1px solid rgba(255,59,48,0.3)", borderRadius: "0.5rem", color: "#ff3b30", fontSize: "0.825rem" }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", justifyContent: "flex-end" }}>
          <button
            onClick={handleClear}
            style={{
              display: "inline-flex", alignItems: "center", gap: "0.375rem",
              padding: "0.5rem 0.875rem",
              backgroundColor: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              color: "var(--text-muted)",
              fontSize: "0.825rem",
              cursor: "pointer",
            }}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Limpar
          </button>
          <button
            onClick={handleSave}
            disabled={saving || lat === null}
            style={{
              display: "inline-flex", alignItems: "center", gap: "0.375rem",
              padding: "0.5rem 1rem",
              backgroundColor: "var(--accent)",
              border: "none",
              borderRadius: "0.5rem",
              color: "white",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: saving || lat === null ? "not-allowed" : "pointer",
              opacity: saving || lat === null ? 0.5 : 1,
            }}
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}
