import { useState, useEffect } from "react";

/**
 * Subscribe to a CSS media query and re-render when it changes.
 *
 * SSR-safe: returns `false` during server render and the first client paint,
 * then corrects on mount. Components that branch their layout on this should
 * treat `false` as the desktop default so the markup matches what the server
 * produced (avoids hydration mismatches).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);

    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** Mobile breakpoint — matches Tailwind's `md` (everything below 768px). */
export const MOBILE_BREAKPOINT = 768;

/** True when the viewport is narrower than the mobile breakpoint. */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}
