"use client";

import { Dock, TopBar, StatusBar } from "@/components/AtlasDeck";
import { ToastProvider } from "@/components/Toast";
import { SetupGuard } from "@/components/setup/SetupGuard";
import { GatewayHealthBanner } from "@/components/GatewayHealthBanner";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <SetupGuard />
      <div className="atlasdeck-shell" style={{ minHeight: "100vh" }}>
        <Dock />
        <TopBar />

        <main
          style={{
            marginLeft: "68px", // Width of dock
            marginTop: "48px", // Height of top bar
            marginBottom: "32px", // Height of status bar
            minHeight: "calc(100vh - 48px - 32px)",
            padding: "24px",
          }}
        >
          {/* Health banner — invisible when everything's OK, becomes amber/red on
              degraded state. Lives above page content so it's visible regardless
              of which dashboard route the user is on. */}
          <GatewayHealthBanner />
          {children}
        </main>

        <StatusBar />
      </div>
    </ToastProvider>
  );
}
