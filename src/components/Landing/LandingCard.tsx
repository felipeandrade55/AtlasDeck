"use client";

import { useState } from "react";
import { ExternalLink, Copy, Check, Trash2, Clock } from "lucide-react";
import type { LandingPage } from "@/lib/landing-index";

interface LandingCardProps {
  page: LandingPage;
  onDelete?: (page: LandingPage) => void;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function LandingCard({ page, onDelete }: LandingCardProps) {
  const [copied, setCopied] = useState(false);

  const absoluteUrl =
    typeof window !== "undefined" ? `${window.location.origin}${page.url}` : page.url;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard indisponível */
    }
  };

  return (
    <div
      className="rounded-xl overflow-hidden flex flex-col transition-all hover:scale-[1.01]"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      {/* Miniatura: iframe da própria página escalado, sem interação */}
      <a
        href={page.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block relative"
        style={{ height: 180, backgroundColor: "var(--card-elevated)", overflow: "hidden" }}
        title={`Abrir ${page.title}`}
      >
        <iframe
          src={page.url}
          loading="lazy"
          sandbox="allow-same-origin"
          tabIndex={-1}
          aria-hidden="true"
          style={{
            width: "1280px",
            height: "800px",
            border: "none",
            transform: "scale(0.3125)",
            transformOrigin: "top left",
            pointerEvents: "none",
          }}
        />
        {/* camada para garantir que o clique vá pro link, não pro iframe */}
        <span className="absolute inset-0" />
      </a>

      <div className="p-3 flex flex-col gap-2 flex-1">
        <div className="flex items-start justify-between gap-2">
          <h3
            className="text-sm font-semibold leading-snug line-clamp-2"
            style={{ color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}
            title={page.title}
          >
            {page.title}
          </h3>
        </div>

        {page.description && (
          <p
            className="text-xs leading-relaxed line-clamp-2"
            style={{ color: "var(--text-secondary)" }}
            title={page.description}
          >
            {page.description}
          </p>
        )}

        <div
          className="text-[11px] flex items-center gap-1 mt-auto"
          style={{ color: "var(--text-muted)" }}
        >
          <Clock className="w-3 h-3" />
          {formatDate(page.modifiedAt)}
        </div>

        <div className="text-[11px] truncate" style={{ color: "var(--text-muted)" }} title={page.url}>
          {page.url}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <a
            href={page.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{ backgroundColor: "var(--accent)", color: "var(--text-primary)", textDecoration: "none" }}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Abrir
          </a>
          <button
            type="button"
            onClick={copyLink}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-secondary)" }}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "Copiado" : "Copiar link"}
          </button>
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(page)}
              className="ml-auto flex items-center justify-center p-1.5 rounded-lg transition-all"
              style={{ color: "var(--text-muted)" }}
              title="Excluir página"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
