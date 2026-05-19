"use client";

import { useEffect, useState } from "react";
import { DollarSign, AlertTriangle } from "lucide-react";
import Link from "next/link";

interface CostSummary {
  today: number;
  thisMonth: number;
  budget: number;
}

export function CostWidget() {
  const [data, setData] = useState<CostSummary | null>(null);

  const load = () => {
    fetch('/api/costs')
      .then(r => r.json())
      .then(d => {
        if (d.error) return;
        setData({ today: d.today ?? 0, thisMonth: d.thisMonth ?? 0, budget: d.budget ?? 100 });
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;

  const pct = Math.min((data.thisMonth / data.budget) * 100, 100);
  const barColor = pct < 60 ? 'var(--success)' : pct < 85 ? 'var(--warning)' : 'var(--error)';

  return (
    <Link
      href="/costs"
      className="flex items-center gap-3 md:gap-4 px-4 py-3 rounded-xl transition-all hover:opacity-90"
      style={{
        backgroundColor: 'var(--card)',
        border: '1px solid var(--border)',
        textDecoration: 'none',
      }}
    >
      <DollarSign className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />

      <div className="flex items-center gap-1.5">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Hoje:</span>
        <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
          ${data.today.toFixed(2)}
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Este mês:</span>
        <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
          ${data.thisMonth.toFixed(2)}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-1">
        <span className="text-xs hidden sm:inline" style={{ color: 'var(--text-muted)' }}>Orçamento:</span>
        <div
          className="flex-1 h-1.5 rounded-full overflow-hidden"
          style={{ backgroundColor: 'var(--card-elevated)', maxWidth: '120px' }}
        >
          <div
            className="h-full transition-all duration-500"
            style={{ width: `${pct}%`, backgroundColor: barColor }}
          />
        </div>
        <span className="text-xs font-semibold" style={{ color: barColor }}>
          {pct.toFixed(0)}%
        </span>
        {pct >= 80 && (
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--error)' }} />
        )}
      </div>

      <span className="text-xs ml-auto flex-shrink-0" style={{ color: 'var(--accent)' }}>
        Ver custos →
      </span>
    </Link>
  );
}
