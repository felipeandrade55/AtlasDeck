/**
 * Next.js startup hook.
 *
 * ⚠️ The real bootstraps live in `src/instrumentation.ts` — Next.js loads
 * the instrumentation file next to the `app` dir (which is `src/app`), so
 * THIS root file is normally ignored. It once held its own (divergent)
 * copy of the bootstraps, which silently disabled the memory scheduler,
 * learner, openclaw config sweep/watcher, and boot MCP install whenever
 * Next picked the `src/` file instead.
 *
 * It now just re-exports the single source of truth so the two can never
 * drift again — and so whichever file Next resolves, the full set runs.
 */
export { register } from "./src/instrumentation";
