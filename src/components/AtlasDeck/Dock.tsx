"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Monitor,
  FolderOpen,
  Brain,
  Bot,
  Building2,
  Activity,
  Clock,
  CalendarDays,
  Puzzle,
  DollarSign,
  Settings,
  History,
  MessageCircle,
  NotebookPen,
  FileCog,
  ShieldAlert,
  Users,
} from "lucide-react";

const dockItems = [
  { href: "/", label: "Dashboard", icon: Home },
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "/system", label: "Monitor do Sistema", icon: Monitor },
  { href: "/files", label: "Arquivos", icon: FolderOpen },
  { href: "/memory", label: "Memória", icon: Brain },
  { href: "/notes", label: "Notas", icon: NotebookPen },
  { href: "/agents", label: "Agentes", icon: Bot },
  { href: "/agent-instructions", label: "Instruções", icon: FileCog },
  { href: "/office", label: "Escritório", icon: Building2 },
  { href: "/activity", label: "Atividades", icon: Activity },
  { href: "/cron", label: "Tarefas Agendadas", icon: Clock },
  { href: "/calendar", label: "Calendário", icon: CalendarDays },
  { href: "/sessions", label: "Sessões", icon: History },
  { href: "/skills", label: "Habilidades", icon: Puzzle },
  { href: "/pentest", label: "Pentest", icon: ShieldAlert },
  { href: "/saas", label: "Clientes SaaS", icon: Users },
  { href: "/costs", label: "Custos & Análises", icon: DollarSign },
  { href: "/settings", label: "Configurações", icon: Settings },

];

interface DockProps {
  isMobile?: boolean;
  open?: boolean;
  onClose?: () => void;
}

export function Dock({ isMobile = false, open = false, onClose }: DockProps) {
  const pathname = usePathname();

  const isItemActive = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(href));

  // ----- Mobile: slide-in drawer with full labels -----
  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        <div
          onClick={onClose}
          aria-hidden={!open}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.55)",
            zIndex: 55,
            opacity: open ? 1 : 0,
            pointerEvents: open ? "auto" : "none",
            transition: "opacity 0.25s ease",
          }}
        />

        {/* Drawer */}
        <aside
          className="dock dock-drawer"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            bottom: 0,
            width: "min(80vw, 280px)",
            backgroundColor: "var(--surface)",
            borderRight: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            padding: "16px 12px",
            gap: "4px",
            zIndex: 60,
            transform: open ? "translateX(0)" : "translateX(-100%)",
            transition: "transform 0.25s ease",
            overflowY: "auto",
          }}
        >
          {/* Drawer header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "4px 8px 14px",
              marginBottom: "4px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <span style={{ fontSize: "22px" }}>🦞</span>
            <span
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: "16px",
                fontWeight: 700,
                color: "var(--text-primary)",
                letterSpacing: "-0.5px",
              }}
            >
              AtlasDeck
            </span>
          </div>

          {dockItems.map((item) => {
            const isActive = isItemActive(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                className="dock-drawer-item"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "14px",
                  padding: "12px 14px",
                  borderRadius: "10px",
                  backgroundColor: isActive ? "var(--accent-soft)" : "transparent",
                  textDecoration: "none",
                }}
              >
                <Icon
                  style={{
                    width: "22px",
                    height: "22px",
                    flexShrink: 0,
                    color: isActive ? "var(--accent)" : "var(--text-secondary)",
                    strokeWidth: isActive ? 2.5 : 2,
                  }}
                />
                <span
                  style={{
                    fontFamily: "var(--font-body)",
                    fontSize: "14px",
                    fontWeight: isActive ? 600 : 500,
                    color: isActive ? "var(--accent)" : "var(--text-primary)",
                  }}
                >
                  {item.label}
                </span>
              </Link>
            );
          })}
        </aside>
      </>
    );
  }

  // ----- Desktop: fixed vertical icon rail -----
  return (
    <aside
      className="dock"
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        bottom: 0,
        width: "68px",
        backgroundColor: "var(--surface)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "12px 6px",
        gap: "4px",
        zIndex: 50,
        overflowY: "auto",
      }}
    >
      {dockItems.map((item) => {
        const isActive = isItemActive(item.href);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            className="dock-item group relative"
            style={{
              width: "56px",
              height: "56px",
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "4px",
              borderRadius: "8px",
              backgroundColor: isActive ? "var(--accent-soft)" : "transparent",
              transition: "all 150ms ease",
              position: "relative",
              textDecoration: "none",
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.backgroundColor = "var(--surface-hover)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.backgroundColor = "transparent";
              }
            }}
          >
            {/* Icon */}
            <Icon
              style={{
                width: "22px",
                height: "22px",
                color: isActive ? "var(--accent)" : "var(--text-secondary)",
                strokeWidth: isActive ? 2.5 : 2,
              }}
            />

            {/* Label */}
            <span
              style={{
                fontFamily: "var(--font-body)",
                fontSize: "9px",
                fontWeight: isActive ? 600 : 500,
                color: isActive ? "var(--accent)" : "var(--text-muted)",
                textAlign: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "52px",
              }}
            >
              {item.label.split(" ")[0]}
            </span>

            {/* Tooltip - shown on hover via CSS */}
            <span
              className="absolute left-[72px] top-1/2 -translate-y-1/2 px-3 py-2 rounded-lg text-sm whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50"
              style={{
                backgroundColor: "var(--surface-elevated)",
                border: "1px solid var(--border)",
                color: "var(--text-primary)",
                fontSize: "12px",
                fontWeight: 500,
              }}
            >
              {item.label}
            </span>
          </Link>
        );
      })}
    </aside>
  );
}
