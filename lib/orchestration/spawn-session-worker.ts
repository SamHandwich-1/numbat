// lib/orchestration/spawn-session-worker.ts — fire-and-forget spawn
// of the Slice 4 worker (scripts/session-runner.ts) for a freshly-
// created Direct session.
//
// Extracted from app/api/start-work/route.ts in Slice 4 manual-run #1
// triage (see docs/decisions/0006-slice-4-close-out.md for the
// full diagnostic). Keeping the spawn in its own module makes the
// unit test (spawn-error → transitionToBlocked) importable without
// dragging in Next.js machinery.
//
// SPAWN INVOCATION — Option C from the triage report:
//
//   spawn(
//     process.execPath,                              // C:\Program Files\nodejs\node.exe — a real binary
//     ["--import", "tsx/esm", "scripts/session-runner.ts", sessionId],
//     { cwd, detached, stdio: 'ignore', env }
//   )
//
// We deliberately DO NOT spawn `pnpm` or `tsx` directly. On Windows,
// both are `.cmd` shell-script shims (no `.exe` form), and Node's
// `child_process.spawn` does NOT resolve `.cmd` shims without
// `shell: true` — which we explicitly avoid because it broadens the
// execution model and triggers Node 25's DEP0190 deprecation warning.
//
// `process.execPath` is the currently-running Node binary, guaranteed
// to be a real executable on every platform (`.exe` on Windows, ELF on
// macOS/Linux). The `--import tsx/esm` flag activates tsx's loader
// hook for the spawned process, which (verified) resolves the project's
// tsconfig.json `paths` aliases (`@/*` → repo-root) the same way the
// tsx CLI does. tsx is in `devDependencies`; pnpm is no longer a
// runtime dependency of this spawn path.
//
// On a spawn 'error' event (ENOENT or other pre-fork failure), we
// transition the session to `status='blocked'` with `source: 'worker'`
// so the operator sees the failure in the UI rather than a silently-
// stuck 'idle' session. The earlier visibility bug (manual-run #1) was
// that ENOENT was only console.error'd to an uncaptured stderr; the
// DB write is the load-bearing visibility signal.

import { spawn } from "node:child_process";

import { transitionToBlocked } from "@/lib/supabase/mutations/session-status";
import { sbAdmin } from "@/lib/supabase/server";

export function spawnSessionWorker(sessionId: string): void {
  const worker = spawn(
    process.execPath,
    ["--import", "tsx/esm", "scripts/session-runner.ts", sessionId],
    {
      cwd: process.cwd(), // Next.js runs from the numbat repo root
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  worker.once("error", (err: Error) => {
    void handleSpawnError(sessionId, err);
  });
  worker.unref();
}

/**
 * Handle a spawn 'error' event. Exported for unit-testing; not
 * intended for direct callers (use spawnSessionWorker as the entry
 * point). The route handler has already returned by the time this
 * fires, so the only ways to surface the failure to the operator are
 * (a) a DB write the realtime subscriber will pick up — the load-
 * bearing signal — and (b) console.error for anyone tailing the dev
 * server. Both happen here.
 */
export async function handleSpawnError(
  sessionId: string,
  err: Error,
): Promise<void> {
  console.error(
    `start-work: worker spawn failed for session ${sessionId}: ${err.message}`,
  );
  // transitionToBlocked guards on idle/running/killing — won't overwrite
  // a session that's already moved past those. At spawn-error time the
  // session is necessarily still in 'idle' (the worker never ran), so
  // the guard accepts.
  try {
    await transitionToBlocked(sbAdmin, sessionId, {
      last_error: {
        message: `worker spawn failed: ${err.message}`,
        source: "worker",
        occurred_at: new Date().toISOString(),
      },
    });
  } catch (dbErr: unknown) {
    // If the DB write itself fails — extremely unlikely — we've already
    // logged the spawn failure. Nothing more to do; the session stays
    // in 'idle' which is the very state we were trying to escape. Log
    // both failures so future-us sees them.
    console.error(
      `start-work: also failed to mark session ${sessionId} as blocked: ${dbErr instanceof Error ? dbErr.message : dbErr}`,
    );
  }
}
