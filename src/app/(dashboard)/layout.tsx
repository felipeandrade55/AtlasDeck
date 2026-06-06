"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Dock, TopBar, StatusBar } from "@/components/AtlasDeck";
import { ToastProvider } from "@/components/Toast";
import { SetupGuard } from "@/components/setup/SetupGuard";
import { GatewayHealthBanner } from "@/components/GatewayHealthBanner";
import { useIsMobile } from "@/hooks/useMediaQuery";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile drawer whenever the route changes (covers back/forward and
  // programmatic navigation; drawer links also close it on tap). Syncing UI to
  // the router here is intentional.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNavOpen(false);
  }, [pathname]);

  // Lock body scroll while the drawer is open on mobile.
  useEffect(() => {
    if (navOpen && isMobile) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [navOpen, isMobile]);

  return (
    <ToastProvider>
      <SetupGuard />
      <div className="atlasdeck-shell" style={{ minHeight: "100vh" }}>
        <Dock isMobile={isMobile} open={navOpen} onClose={() => setNavOpen(false)} />
        <TopBar isMobile={isMobile} onMenuClick={() => setNavOpen(true)} />

        <main
          style={{
            // Desktop: clear the fixed dock (68px) / top bar (48px) / status bar (32px).
            // Mobile: dock collapses to a drawer and the status bar hides, so only
            // the top bar reserves space and content runs full-width.
            marginLeft: isMobile ? 0 : "68px",
            marginTop: "48px",
            marginBottom: isMobile ? 0 : "32px",
            minHeight: isMobile ? "calc(100vh - 48px)" : "calc(100vh - 48px - 32px)",
            padding: isMobile ? "16px" : "24px",
            maxWidth: "100%",
            // On mobile, clip horizontal overflow so a stray wide child can't make
            // the whole page scroll sideways. `clip` (not `hidden`) avoids forcing
            // overflow-y:auto, which would break position:sticky. Desktop keeps the
            // default visible behaviour so inline popovers/menus aren't cut off.
            overflowX: isMobile ? "clip" : undefined,
          }}
        >
          {/* Health banner — invisible when everything's OK, becomes amber/red on
              degraded state. Lives above page content so it's visible regardless
              of which dashboard route the user is on. */}
          <GatewayHealthBanner />
          {children}
        </main>

        <StatusBar isMobile={isMobile} />
      </div>
    </ToastProvider>
  );
}
