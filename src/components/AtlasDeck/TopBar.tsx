"use client";

import { useState, useEffect, useRef } from "react";
import { Search, Bell, User, Command, LogOut, Settings, ChevronDown, HelpCircle, Menu } from "lucide-react";
import { GlobalSearch } from "@/components/GlobalSearch";
import { NotificationDropdown } from "@/components/NotificationDropdown";
import { useRouter } from "next/navigation";
import Link from "next/link";

const OWNER_NAME = process.env.NEXT_PUBLIC_OWNER_NAME ?? "Usuário";
const OWNER_INITIAL = OWNER_NAME.charAt(0).toUpperCase();

interface TopBarProps {
  isMobile?: boolean;
  onMenuClick?: () => void;
}

export function TopBar({ isMobile = false, onMenuClick }: TopBarProps) {
  const [showSearch, setShowSearch] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Command/Ctrl + K to open search
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowSearch(true);
      }
      // Escape to close search
      if (e.key === "Escape" && showSearch) {
        setShowSearch(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showSearch]);

  return (
    <>
      <div
        className="top-bar"
        style={{
          position: "fixed",
          top: 0,
          left: isMobile ? 0 : "68px", // Width of dock (collapses to a drawer on mobile)
          right: 0,
          height: "48px",
          backgroundColor: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: isMobile ? "0 12px" : "0 20px",
          gap: "8px",
          zIndex: 45,
        }}
      >
        {/* Left: hamburger (mobile) + Logo & Title */}
        <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
          {isMobile && (
            <button
              onClick={onMenuClick}
              aria-label="Abrir menu"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "36px",
                height: "36px",
                marginLeft: "-4px",
                borderRadius: "8px",
                background: "none",
                border: "none",
                color: "var(--text-primary)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <Menu style={{ width: "22px", height: "22px" }} />
            </button>
          )}
          <span style={{ fontSize: "20px" }}>🦞</span>
          <h1
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "16px",
              fontWeight: 700,
              color: "var(--text-primary)",
              letterSpacing: "-0.5px",
              whiteSpace: "nowrap",
            }}
          >
            AtlasDeck
          </h1>
          {/* Version Badge — hidden on mobile to save horizontal room */}
          {!isMobile && (
            <div
              style={{
                backgroundColor: "var(--accent-soft)",
                borderRadius: "4px",
                padding: "2px 8px",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "9px",
                  fontWeight: 700,
                  color: "var(--accent)",
                  letterSpacing: "1px",
                }}
              >
                v1.0
              </span>
            </div>
          )}
        </div>

        {/* Right: Search + Notifications + User */}
        <div className="flex items-center gap-3" style={{ flexShrink: 0 }}>
          {/* Search Box — full bar on desktop, icon-only on mobile */}
          <button
            onClick={() => setShowSearch(true)}
            aria-label="Buscar"
            className="flex items-center gap-2 transition-all"
            style={{
              width: isMobile ? "36px" : "240px",
              height: isMobile ? "36px" : "32px",
              justifyContent: isMobile ? "center" : "flex-start",
              backgroundColor: isMobile ? "transparent" : "var(--surface-elevated)",
              borderRadius: isMobile ? "8px" : "6px",
              padding: isMobile ? 0 : "0 12px",
              flexShrink: 0,
            }}
          >
            <Search
              className="flex-shrink-0"
              style={{
                width: isMobile ? "20px" : "16px",
                height: isMobile ? "20px" : "16px",
                color: "var(--text-muted)",
              }}
            />
            {!isMobile && (
              <span
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: "12px",
                  color: "var(--text-muted)",
                }}
              >
                Buscar... ⌘K
              </span>
            )}
          </button>

          {/* Help / Welcome guide — hidden on mobile to keep the header uncluttered */}
          {!isMobile && (
          <Link
            href="/welcome"
            aria-label="Guia de boas-vindas"
            title="Guia de boas-vindas — tour completo do sistema"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "32px",
              height: "32px",
              borderRadius: "6px",
              backgroundColor: "transparent",
              color: "var(--text-muted)",
              transition: "all 120ms ease",
              textDecoration: "none",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--surface-elevated)";
              e.currentTarget.style.color = "var(--accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <HelpCircle style={{ width: "18px", height: "18px" }} />
          </Link>
          )}

          {/* Notifications Dropdown */}
          <NotificationDropdown />

          {/* User Area */}
          <div ref={userMenuRef} style={{ position: "relative" }}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "4px 6px",
                borderRadius: "8px",
                backgroundColor: showUserMenu ? "var(--card-elevated)" : "transparent",
              }}
            >
              {/* Avatar */}
              <div
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "14px",
                  backgroundColor: "var(--accent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-heading)",
                    fontSize: "12px",
                    fontWeight: 700,
                    color: "var(--text-primary)",
                  }}
                >
                  {OWNER_INITIAL}
                </span>
              </div>
              {/* Name + chevron — hidden on mobile (avatar stays tappable) */}
              {!isMobile && (
                <>
                  <span
                    style={{
                      fontFamily: "var(--font-body)",
                      fontSize: "12px",
                      fontWeight: 500,
                      color: "var(--text-secondary)",
                    }}
                  >
                    {OWNER_NAME}
                  </span>
                  <ChevronDown
                    style={{
                      width: "12px",
                      height: "12px",
                      color: "var(--text-muted)",
                      transform: showUserMenu ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.15s",
                    }}
                  />
                </>
              )}
            </button>

            {/* Dropdown */}
            {showUserMenu && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 8px)",
                  right: 0,
                  minWidth: "180px",
                  backgroundColor: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: "10px",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  overflow: "hidden",
                  zIndex: 100,
                }}
              >
                {/* User info header */}
                <div
                  style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
                    {OWNER_NAME}
                  </div>
                  <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>
                    Administrador
                  </div>
                </div>

                {/* Menu items */}
                <div style={{ padding: "6px" }}>
                  <a
                    href="/settings"
                    onClick={() => setShowUserMenu(false)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      padding: "8px 10px",
                      borderRadius: "6px",
                      fontSize: "13px",
                      color: "var(--text-secondary)",
                      textDecoration: "none",
                      cursor: "pointer",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = "var(--card-elevated)")}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    <Settings style={{ width: "14px", height: "14px" }} />
                    Configurações
                  </a>

                  <button
                    onClick={handleLogout}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: "6px",
                      fontSize: "13px",
                      color: "var(--error)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = "rgba(255,59,48,0.08)")}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    <LogOut style={{ width: "14px", height: "14px" }} />
                    Sair
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Global Search Modal */}
      {showSearch && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.8)",
          }}
          onClick={() => setShowSearch(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "90%",
              maxWidth: "42rem",
            }}
          >
            <GlobalSearch />
          </div>
        </div>
      )}
    </>
  );
}
