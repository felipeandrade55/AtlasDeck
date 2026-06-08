"use client";

/**
 * Standalone fullscreen memory graph — "modo TV".
 *
 * Deliberately lives OUTSIDE the (dashboard) route group, so it inherits only
 * the root layout: no dock, no top bar, no status bar — just the graph filling
 * the whole screen. Offers the browser's native Fullscreen API (hides the
 * browser chrome on a TV) and auto-hides the floating controls after a few
 * seconds of inactivity for an ambient feel.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Maximize2, Minimize2 } from "lucide-react";
import { MemoryGraphView } from "@/components/graph/MemoryGraphView";
import { GRAPH_BG } from "@/lib/graph-theme";

const HIDE_AFTER_MS = 3000;

export default function GraphFullscreenPage() {
  const [isNativeFs, setIsNativeFs] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleNativeFs = useCallback(() => {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  // Track native fullscreen state to swap the icon/label.
  useEffect(() => {
    const onChange = () => setIsNativeFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Auto-hide controls after inactivity; any input brings them back.
  useEffect(() => {
    const wake = () => {
      setControlsHidden(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setControlsHidden(true), HIDE_AFTER_MS);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("touchstart", wake);
    window.addEventListener("keydown", wake);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("touchstart", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  const btnStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    height: 34,
    padding: "0 13px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    backgroundColor: "rgba(26,26,26,0.85)",
    backdropFilter: "blur(8px)",
    color: "var(--text-secondary)",
    fontSize: 12,
    fontWeight: 600,
    textDecoration: "none",
    cursor: "pointer",
  };

  const rightActions = (
    <>
      <button type="button" onClick={toggleNativeFs} style={btnStyle}>
        {isNativeFs ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        {isNativeFs ? "Sair" : "Tela cheia"}
      </button>
      <Link href="/memory" style={btnStyle}>
        <ArrowLeft size={14} />
        Voltar
      </Link>
    </>
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        backgroundColor: GRAPH_BG,
        overflow: "hidden",
      }}
    >
      <MemoryGraphView
        fullscreen
        rightActions={rightActions}
        controlsHidden={controlsHidden}
      />
    </div>
  );
}
