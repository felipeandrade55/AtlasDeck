"use client";

/**
 * Client-side guard mounted inside the dashboard layout. Once on mount
 * (and on every pathname change) it asks /api/setup/status whether the
 * initial wizard is still pending; if so and the user isn't already at
 * /welcome, redirects them there. Renders nothing.
 */
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

export function SetupGuard() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === "/welcome") return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/setup/status", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const json = await res.json();
        if (!json?.setup?.completedAt) {
          router.replace("/welcome");
        }
      } catch {
        // network blip — let user keep browsing; next nav will recheck
      }
    })();
    return () => controller.abort();
  }, [pathname, router]);

  return null;
}
