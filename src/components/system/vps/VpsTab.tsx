"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { VpsHost } from "./types";
import { VpsList } from "./VpsList";
import { VpsDetail } from "./VpsDetail";
import { AddVpsModal } from "./AddVpsModal";

export function VpsTab({ initialVpsId }: { initialVpsId?: string | null }) {
  const [hosts, setHosts] = useState<VpsHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(initialVpsId ?? null);
  const [showAdd, setShowAdd] = useState(false);

  const fetchHosts = useCallback(async () => {
    try {
      const res = await fetch("/api/vps");
      if (res.ok) {
        const data = await res.json();
        setHosts(Array.isArray(data) ? data : []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHosts();
    const id = setInterval(fetchHosts, 10000);
    return () => clearInterval(id);
  }, [fetchHosts]);

  const selectedHost = selectedId ? hosts.find((h) => h.vps_id === selectedId) ?? null : null;

  if (selectedId && selectedHost) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => setSelectedId(null)}
          className="flex items-center gap-2 text-sm font-medium"
          style={{ color: "var(--text-secondary)" }}
        >
          <ArrowLeft className="w-4 h-4" />
          Voltar para a lista
        </button>
        <VpsDetail host={selectedHost} onChanged={fetchHosts} onDeleted={() => setSelectedId(null)} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <VpsList
        hosts={hosts}
        loading={loading}
        onSelect={(id) => setSelectedId(id)}
        onAdd={() => setShowAdd(true)}
      />
      {showAdd && (
        <AddVpsModal
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            fetchHosts();
          }}
        />
      )}
    </div>
  );
}
