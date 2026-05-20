/**
 * Next.js startup hook. Runs once per server process.
 *
 * Used to boot the memory subsystem scheduler (extraction, injection,
 * housekeeping). Safe to no-op in non-Node runtimes.
 *
 * See: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { startMemoryScheduler } = await import("@/lib/memory-scheduler");
    startMemoryScheduler();
  } catch (err) {
    console.warn("[instrumentation] failed to start memory scheduler:", err);
  }
}
