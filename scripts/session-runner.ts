// scripts/session-runner.ts — Slice 4 worker.
//
// Spawned per session by /api/start-work (Direct path) via
// `pnpm tsx scripts/session-runner.ts <sessionId>`. Drives one Claude
// Agent SDK session against one git worktree, streams status updates
// to Supabase realtime, captures the diff on completion, fans out
// llm_calls, and propagates kill signals.
//
// State machine reference: docs/decisions/0006-slice-4-close-out.md
// will name the final shape; the live spec is plan §2 (two-phase
// kill) + §3 (worker lifecycle) in the Slice 4 plan.
//
// Reviewability targets — read these in this file:
//
//   (1) The kill handoff. On result/success the worker calls
//       transitionToAwaitingReview, which THROWS if status is 'killing'
//       (operator interrupt landed concurrently). The catch block
//       distinguishes that expected guard-mismatch throw from a real
//       SDK/worker fault by RE-READING the session's current status —
//       if it's 'killing' or 'killed', the throw is expected and we
//       fall through to finally. Else the throw is a fault and we
//       transitionToBlocked.
//
//   (2) The finally block. clearTimeout on the kill timer (without
//       it the 5s timer fires q.close() on an already-closed query),
//       removeChannel on the kill subscription, then transitionToKilled
//       IF status is still 'killing'. Idempotent.
//
//   (3) Top-level uncaughtException / unhandledRejection handlers
//       write status='blocked' with last_error.source='worker'.
//       Distinct from the watchdog's 'watchdog' source — see
//       lib/feathertail/worktree.ts:reapStaleKillingSessions.
//
//   (4) cleanupStaleWorktrees + reapStaleKillingSessions run at the
//       TOP of main(), before SDK session start.
//
//   (5) assertSourceRepoUsable before createWorktree. On bad repo:
//       clean 'blocked' transition with source='worker', not an
//       uncaught throw.

// Loads .env.local before any module that reads process.env at
// evaluation time. Must be the first import (same pattern as seed.ts).
import "@/lib/env";

import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";

import { captureDiff } from "@/lib/feathertail/diff";
import {
  extractToolUsePath,
  isResultError,
  isResultSuccess,
  startAgentSession,
} from "@/lib/feathertail/agent-sdk";
import {
  assertSourceRepoUsable,
  cleanupStaleWorktrees,
  createWorktree,
  reapStaleKillingSessions,
  workerLogPathFor,
} from "@/lib/feathertail/worktree";
import { sb } from "@/lib/supabase/client";
import { insertLlmCallsFromModelUsage } from "@/lib/supabase/llm-calls";
import {
  setCurrentStep,
  transitionToAwaitingReview,
  transitionToBlocked,
  transitionToKilled,
  transitionToRunning,
} from "@/lib/supabase/mutations/session-status";
import { sbAdmin } from "@/lib/supabase/server";
import type { SessionLastErrorT } from "@/lib/types/jsonb";

// ─────────────────────────────────────────────────────────────────────
// Argv parse — the only input.
// ─────────────────────────────────────────────────────────────────────

const rawArg = process.argv[2];
if (!rawArg) {
  process.stderr.write(
    "session-runner: missing argv[2] sessionId. Usage:\n" +
      "  pnpm tsx scripts/session-runner.ts <sessionId>\n",
  );
  process.exit(1);
}
// `rawArg` is string here, but the narrowing doesn't persist into the
// async closures below (process.exit() above is non-throwing as far as
// TS knows). Capture into a const after the guard.
const sessionId: string = rawArg;

// ─────────────────────────────────────────────────────────────────────
// Logging — switches from stderr to a per-worktree file once the
// worktree exists. Best-effort: append failures are swallowed because
// logging must never abort the worker's state-machine work.
// ─────────────────────────────────────────────────────────────────────

let logFilePath: string | null = null;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (logFilePath !== null) {
    void appendFile(logFilePath, line, "utf8").catch(() => {
      /* fail open */
    });
  } else {
    process.stderr.write(line);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Top-level fault handlers (reviewability #3). Anything that escapes
// main()'s try/catch lands here. Source is 'worker' (the worker process
// itself faulted), not 'agent_sdk' (SDK errored mid-iteration) and not
// 'watchdog' (kill stuck in 'killing' too long).
// ─────────────────────────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  void writeWorkerFault(err, "uncaughtException").finally(() => {
    process.exit(1);
  });
});

process.on("unhandledRejection", (err) => {
  void writeWorkerFault(err, "unhandledRejection").finally(() => {
    process.exit(1);
  });
});

async function writeWorkerFault(err: unknown, kind: string): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  log(`worker fault (${kind}): ${message}`);
  const lastError: SessionLastErrorT = {
    message: `worker ${kind}: ${message}`,
    source: "worker",
    occurred_at: new Date().toISOString(),
  };
  // Best-effort — the process is dying. transitionToBlocked guards on
  // idle/running/killing so a session already in awaiting_review /
  // done / killed / blocked is left alone.
  await transitionToBlocked(sbAdmin, sessionId, {
    last_error: lastError,
  }).catch(() => {
    /* fail open — process is exiting anyway */
  });
}

// ─────────────────────────────────────────────────────────────────────
// Main.
// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Load the session row.
  const { data: session, error: sessionErr } = await sbAdmin
    .from("sessions")
    .select("id, project_id, slice_name, status, task")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionErr) {
    log(`session load failed: ${sessionErr.message}`);
    process.exit(1);
  }
  if (!session) {
    log(`session ${sessionId} not found`);
    process.exit(1);
  }
  if (session.status !== "idle") {
    // Worker should only ever be spawned against a fresh idle session.
    // If we land here, something already ran (manual rerun, double-spawn).
    log(`session ${sessionId} is ${session.status}, not idle — refusing to run`);
    process.exit(1);
  }

  // 2. Load the project for repo_path + slug.
  const { data: project, error: projectErr } = await sbAdmin
    .from("projects")
    .select("slug, repo_path")
    .eq("id", session.project_id)
    .maybeSingle();
  if (projectErr || !project) {
    const msg = projectErr?.message ?? "project not found";
    log(`project load failed: ${msg}`);
    await transitionToBlocked(sbAdmin, sessionId, {
      last_error: {
        message: `project load failed: ${msg}`,
        source: "worker",
        occurred_at: new Date().toISOString(),
      },
    }).catch(() => {
      /* best-effort */
    });
    process.exit(1);
  }

  // 3. Opportunistic cleanup (reviewability #4). Runs BEFORE SDK
  //    start so a stuck 'killing' row gets reaped and a stale worktree
  //    + its log file get removed alongside any new work this session
  //    will produce. Failures here are non-fatal — we log and proceed.
  await cleanupStaleWorktrees(sbAdmin).catch((err: unknown) => {
    log(`cleanupStaleWorktrees failed (non-fatal): ${describeError(err)}`);
  });
  await reapStaleKillingSessions(sbAdmin).catch((err: unknown) => {
    log(`reapStaleKillingSessions failed (non-fatal): ${describeError(err)}`);
  });

  // 4. Pre-flight: the source repo must exist, be a git repo, have
  //    HEAD (reviewability #5). On miss → clean blocked, no throw.
  try {
    await assertSourceRepoUsable(project.repo_path);
  } catch (err: unknown) {
    const msg = describeError(err);
    log(`source repo pre-flight failed: ${msg}`);
    await transitionToBlocked(sbAdmin, sessionId, {
      last_error: {
        message: `source repo unusable: ${msg}`,
        source: "worker",
        occurred_at: new Date().toISOString(),
      },
    });
    return;
  }

  // 5. Create the worktree. Branch collision and other git failures
  //    surface as throws → clean blocked.
  let worktreePath: string;
  try {
    worktreePath = await createWorktree({
      projectSlug: project.slug,
      sliceName: session.slice_name,
      sourceRepoPath: project.repo_path,
    });
  } catch (err: unknown) {
    const msg = describeError(err);
    log(`createWorktree failed: ${msg}`);
    await transitionToBlocked(sbAdmin, sessionId, {
      last_error: {
        message: `worktree create failed: ${msg}`,
        source: "worker",
        occurred_at: new Date().toISOString(),
      },
    });
    return;
  }

  // 6. Switch logging to the per-worker log file. The log lives
  //    SIBLING to the worktree (~/numbat-worktrees/<slug>/<slice>.log),
  //    NOT inside it — putting it inside contaminated captured diffs
  //    in manual-run #1 (the worker's own log appeared as an
  //    untracked file). See workerLogPathFor in lib/feathertail/
  //    worktree.ts for the single source of truth on the path. The
  //    file is unlinked by cleanupStaleWorktrees alongside the
  //    worktree directory.
  logFilePath = workerLogPathFor(worktreePath);
  log(`worktree ready at ${worktreePath}`);

  // 6b. Orphan-prevention (decisions log 0007 + Slice 4 close-out 0006).
  //     Write worktree_path on the session row IMMEDIATELY after
  //     createWorktree returns — BEFORE the SDK loop opens its
  //     try/catch/finally. Without this, a fault before the SDK
  //     emits its `system/init` message (auth failure, subprocess
  //     can't start, etc.) lands status='blocked' on a row whose
  //     worktree_path is still NULL — cleanupStaleWorktrees's
  //     `worktree_path IS NOT NULL` predicate would then skip it
  //     forever. transitionToRunning later writes worktree_path
  //     again with the same value (idempotent UPDATE, no conflict).
  const { error: pathErr } = await sbAdmin
    .from("sessions")
    .update({
      worktree_path: worktreePath,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (pathErr) {
    // Don't transitionToBlocked here — the worktree exists; the row
    // just lost its address. Log loudly and continue: if the worker
    // then completes successfully, transitionToRunning will fix the
    // row when it runs. If the worker faults before that, the row
    // ends up blocked with worktree_path=null and the operator has
    // to manually rm the worktree (extremely unlikely path —
    // requires a DB-side hiccup in the millisecond gap between two
    // adjacent queries against the same row).
    log(`failed to record worktree_path on session row: ${pathErr.message}`);
  }

  // 7. Set up the kill subscription. INSERTs to decisions filtered by
  //    this session_id; on a 'kill' decision arrival, interrupt the
  //    query and arm a 5s safety timer that close()s the subprocess
  //    if interrupt didn't return a result in time.
  const abortController = new AbortController();
  const q = startAgentSession({
    prompt: session.task,
    cwd: worktreePath,
    abortController,
  });

  let killTimeoutId: NodeJS.Timeout | null = null;
  const killChannel = sb
    .channel(`kill:${sessionId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "decisions",
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => {
        const type = (payload.new as { type?: string }).type;
        if (type !== "kill") return;
        log("kill decision received — interrupting SDK session");
        // interrupt() is async but we don't need to await — fire-and-
        // forget is the right semantics for an event handler. The
        // for-await loop will see the resulting `result` message.
        void q.interrupt().catch((err) => {
          log(`q.interrupt() rejected: ${describeError(err)}`);
        });
        // Safety timer: if interrupt() doesn't produce a result within
        // 5s, force-close the subprocess.
        killTimeoutId = setTimeout(() => {
          log("5s grace expired — calling q.close()");
          // close() is synchronous (returns void, per the §0a audit).
          q.close();
        }, 5_000);
      },
    )
    .subscribe();

  // Precompute prompt hash for llm_calls audit. Cheap and useful for
  // future dedup analysis.
  const promptHash = createHash("sha256").update(session.task).digest("hex");

  // 8. The SDK loop. Exits via:
  //    - result/success → transitionToAwaitingReview (may throw if
  //      operator killed concurrently; catch handles)
  //    - result/error_* → transitionToBlocked or transitionToKilled
  //      depending on whether kill is in flight
  //    - SDK exception → catch decides between expected-during-kill
  //      and genuine-fault (reviewability #1)
  try {
    let sdkSessionId: string | null = null;

    for await (const message of q) {
      // First message is typically system/init — capture session_id
      // and flip status to 'running'. This may arrive several seconds
      // after worker startup per the spike memo (subprocess startup
      // gap). Until then, status stays 'idle' and the UI shows the
      // NotReadyPlaceholder.
      if (
        sdkSessionId === null &&
        message.type === "system" &&
        (message as { subtype?: string }).subtype === "init"
      ) {
        const id = (message as { session_id?: string }).session_id;
        if (typeof id === "string" && id.length > 0) {
          sdkSessionId = id;
          await transitionToRunning(sbAdmin, sessionId, {
            agent_session_id: sdkSessionId,
            worktree_path: worktreePath,
          });
          log(`session running (agent_session_id=${sdkSessionId})`);
        }
      }

      // Opportunistic current_step update on tool-use events.
      // setCurrentStep silently no-ops if status has flipped to
      // killing/terminal — race-safe by design.
      const toolPath = extractToolUsePath(message);
      if (toolPath !== null) {
        await setCurrentStep(sbAdmin, sessionId, `Editing ${toolPath}`).catch(
          (err: unknown) => {
            log(`setCurrentStep failed (non-fatal): ${describeError(err)}`);
          },
        );
      }

      if (isResultSuccess(message)) {
        log("result/success — capturing diff and fanning out llm_calls");
        const diff = await captureDiff(worktreePath);
        await insertLlmCallsFromModelUsage(sbAdmin, {
          project_id: session.project_id,
          session_id: sessionId,
          modelUsage: message.modelUsage,
          duration_ms: message.duration_ms,
          prompt_hash: promptHash,
        });
        // ▶ KILL-RACE LANDING POINT. If recordDecision flipped status
        // to 'killing' while we were running, this throws with a
        // /running/ message (the guard in transitionToAwaitingReview).
        // The catch below handles it — see the status re-read.
        await transitionToAwaitingReview(sbAdmin, sessionId, { diff });
        log("session moved to awaiting_review");
        break;
      }

      if (isResultError(message)) {
        const errors =
          (message as { errors?: string[] }).errors ?? [];
        const errMsg = errors.length > 0 ? errors.join("; ") : "SDK error";
        const subtype = (message as { subtype?: string }).subtype;
        const terminalReason = (message as { terminal_reason?: string })
          .terminal_reason;
        log(
          `result/error (${subtype ?? "?"}, terminal_reason=${terminalReason ?? "?"})`,
        );
        // Capture partial cost even on error — modelUsage is on every
        // result variant. Operator interrupt path also lands here per
        // the spike memo ('aborted_streaming' terminal_reason).
        await insertLlmCallsFromModelUsage(sbAdmin, {
          project_id: session.project_id,
          session_id: sessionId,
          modelUsage: message.modelUsage,
          duration_ms: message.duration_ms,
          prompt_hash: promptHash,
          error: {
            message: errMsg,
            subtype,
            terminal_reason: terminalReason,
            errors,
          },
        }).catch((err: unknown) => {
          log(`insertLlmCallsFromModelUsage failed: ${describeError(err)}`);
        });
        // Status flip: if kill is in flight ('killing'), DON'T
        // transitionToBlocked — finally will write 'killed'. Else
        // transitionToBlocked. transitionToBlocked guards on
        // idle/running/killing; if status moved already, it throws
        // and we swallow.
        await transitionToBlocked(sbAdmin, sessionId, {
          last_error: {
            message: errMsg,
            source: "agent_sdk",
            occurred_at: new Date().toISOString(),
          },
        }).catch((err: unknown) => {
          // Guard mismatch OR genuine DB error. If kill is in flight
          // the finally block will write terminal 'killed'; if it's
          // already terminal, no further action needed.
          log(`transitionToBlocked rejected (likely kill-in-flight): ${describeError(err)}`);
        });
        break;
      }
    }
  } catch (err: unknown) {
    // Reviewability #1: distinguish expected-during-kill from genuine
    // fault by RE-READING current session status. A
    // transitionToAwaitingReview throw lands here when a kill landed
    // concurrently with result/success — status is 'killing' (or
    // 'killed' if a race lost), so the finally block already has
    // everything it needs.
    const errMsg = describeError(err);
    log(`SDK loop threw: ${errMsg}`);

    const { data: fresh } = await sbAdmin
      .from("sessions")
      .select("status")
      .eq("id", sessionId)
      .maybeSingle();
    const freshStatus = fresh?.status;

    if (freshStatus === "killing" || freshStatus === "killed") {
      log(
        `status is ${freshStatus} — kill in flight, throw was an expected ` +
          `guard mismatch. finally will finalise.`,
      );
      // Intentional fall-through to finally. No transitionToBlocked.
    } else if (freshStatus === "running" || freshStatus === "idle") {
      log("genuine SDK/worker fault — transitioning to blocked");
      await transitionToBlocked(sbAdmin, sessionId, {
        last_error: {
          message: errMsg,
          // source: 'agent_sdk' covers SDK iteration faults; if the
          // throw came from our own code mid-loop the boundary is
          // blurry, but the SDK loop is the spine of this function so
          // 'agent_sdk' is the honest first-approximation source.
          source: "agent_sdk",
          occurred_at: new Date().toISOString(),
        },
      }).catch((blockErr: unknown) => {
        log(`failed to transition to blocked: ${describeError(blockErr)}`);
      });
    } else {
      log(
        `status is ${freshStatus ?? "<unknown>"} — some other path already ` +
          `wrote a terminal state, leaving alone`,
      );
    }
  } finally {
    // Reviewability #2: idempotent cleanup. Runs on every exit path.
    if (killTimeoutId !== null) {
      clearTimeout(killTimeoutId);
    }
    await sb.removeChannel(killChannel).catch((err: unknown) => {
      log(`sb.removeChannel failed: ${describeError(err)}`);
    });

    // Two-phase kill finalisation. If status is still 'killing', the
    // worker is responsible for writing terminal 'killed'. Any other
    // status means someone else already finalised — leave alone.
    const { data: final } = await sbAdmin
      .from("sessions")
      .select("status")
      .eq("id", sessionId)
      .maybeSingle();
    if (final?.status === "killing") {
      log("status still 'killing' — writing terminal 'killed'");
      await transitionToKilled(sbAdmin, sessionId).catch((err: unknown) => {
        log(`transitionToKilled failed: ${describeError(err)}`);
      });
    }

    log("worker exit");
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err: unknown) => {
  // Last-ditch escape. main()'s own try/catch should have caught
  // everything; anything reaching here is a programming error.
  log(`main() rejected unexpectedly: ${describeError(err)}`);
  process.exit(1);
});
