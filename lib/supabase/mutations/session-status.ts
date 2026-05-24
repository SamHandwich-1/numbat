// lib/supabase/mutations/session-status.ts — worker-driven session-
// status transitions for Slice 4.
//
// recordDecision (lib/supabase/mutations/decisions.ts) owns the
// operator-driven transitions for review actions (approve / redirect /
// kill). This file owns the worker-driven transitions:
//
//   idle      → running         (worker starts the SDK session)
//   running   → awaiting_review (SDK returned success; diff captured)
//   running   → blocked         (SDK errored, or worker crashed)
//   idle/running → killing      (recordDecision's two-phase path —
//                                exposed here so other code paths can
//                                trigger killing without going through
//                                a decisions row, if ever needed)
//   killing   → killed          (worker's terminal write after SDK
//                                teardown completed)
//
// awaiting_review/blocked → killed directly is the no-live-worker
// flavour and lives in `transitionToKilledDirectly` — a separate
// helper kept distinct so the worker path and the operator path stay
// auditable and so the §0a-bis safety invariants don't get tangled.
//
// All helpers use an atomic guarded UPDATE pattern:
//   UPDATE sessions SET (...) WHERE id=$1 AND status IN ($expected, ...);
// then check whether a row was returned via .select('id'). If no row
// was returned (no error), the guard rejected — throw. This is the
// load-bearing safety net against the operator-interrupt-returns-
// success-result race: a session in 'killing' that produces a
// success-subtype result must NOT reach awaiting_review. The guard
// in transitionToAwaitingReview is what prevents it.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, SessionStatus } from "@/lib/types/db";
import {
  SessionLastError,
  WorktreeDiff,
  type SessionLastErrorT,
  type WorktreeDiffT,
} from "@/lib/types/jsonb";

// ─────────────────────────────────────────────────────────────────────
// Internal: atomic guarded UPDATE.
// ─────────────────────────────────────────────────────────────────────

type SessionUpdate = Partial<{
  status: SessionStatus;
  agent_session_id: string | null;
  worktree_path: string | null;
  last_error: SessionLastErrorT | null;
  diff: WorktreeDiffT | null;
  completed_at: string | null;
  current_step: string | null;
  updated_at: string;
}>;

/**
 * UPDATE sessions WHERE id=$1 AND status IN ($expectedStatuses).
 * Returns the row's id if the update affected a row, or null if the
 * guard rejected (status mismatch or row missing).
 *
 * The status guard runs IN the WHERE clause — atomic with the UPDATE.
 * Avoids the TOCTOU window of a load-then-check pattern.
 */
async function guardedUpdate(
  db: SupabaseClient<Database>,
  sessionId: string,
  expectedStatuses: readonly SessionStatus[],
  patch: SessionUpdate,
): Promise<{ matched: boolean; error: { message: string } | null }> {
  if (expectedStatuses.length === 0) {
    throw new Error("guardedUpdate: expectedStatuses must be non-empty");
  }
  const update = db.from("sessions").update(patch).eq("id", sessionId);
  const filtered =
    expectedStatuses.length === 1
      ? update.eq("status", expectedStatuses[0]!)
      : update.in("status", [...expectedStatuses]);
  const { data, error } = await filtered.select("id");
  if (error) return { matched: false, error };
  return { matched: (data ?? []).length > 0, error: null };
}

function throwGuard(
  context: string,
  sessionId: string,
  expectedStatuses: readonly SessionStatus[],
): never {
  throw new Error(
    `${context}: session ${sessionId} not in expected status(es) [${expectedStatuses.join(
      ", ",
    )}] — refusing to update`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Public helpers.
// ─────────────────────────────────────────────────────────────────────

/**
 * idle → running. Worker calls this immediately after creating the
 * worktree and starting the SDK session.
 *
 * Throws on guard miss (status not 'idle').
 */
export async function transitionToRunning(
  db: SupabaseClient<Database>,
  sessionId: string,
  args: { agent_session_id: string; worktree_path: string },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { matched, error } = await guardedUpdate(db, sessionId, ["idle"], {
    status: "running",
    agent_session_id: args.agent_session_id,
    worktree_path: args.worktree_path,
    updated_at: nowIso,
  });
  if (error) throw new Error(`transitionToRunning: ${error.message}`);
  if (!matched) throwGuard("transitionToRunning", sessionId, ["idle"]);
}

/**
 * running → awaiting_review. Worker calls this on SDK result/success,
 * after captureDiff() and llm_calls fan-out.
 *
 * The guard is LOAD-BEARING: a session in 'killing' that produces a
 * success-subtype result (operator interrupt path per agent-sdk.ts
 * extractToolUsePath JSDoc) must NOT reach awaiting_review. Throws on
 * any non-'running' state — the worker's status-check loop is the only
 * place that decides to call this, and the helper enforces the
 * invariant atomically.
 */
export async function transitionToAwaitingReview(
  db: SupabaseClient<Database>,
  sessionId: string,
  args: { diff: WorktreeDiffT },
): Promise<void> {
  // Validate diff shape at the boundary. Cheap, surfaces drift.
  WorktreeDiff.parse(args.diff);

  const nowIso = new Date().toISOString();
  const { matched, error } = await guardedUpdate(db, sessionId, ["running"], {
    status: "awaiting_review",
    diff: args.diff,
    updated_at: nowIso,
  });
  if (error) throw new Error(`transitionToAwaitingReview: ${error.message}`);
  if (!matched) throwGuard("transitionToAwaitingReview", sessionId, ["running"]);
}

/**
 * idle | running | killing → blocked. Worker writes blocked when the
 * SDK errors during execution, or when the top-level uncaughtException
 * handler fires. Also reachable from `killing` if teardown itself
 * faults — the worker treats that as a stuck-then-faulted path.
 *
 * Validates last_error against the SessionLastError Zod schema.
 */
export async function transitionToBlocked(
  db: SupabaseClient<Database>,
  sessionId: string,
  args: { last_error: SessionLastErrorT },
): Promise<void> {
  SessionLastError.parse(args.last_error);
  const expected: SessionStatus[] = ["idle", "running", "killing"];
  const nowIso = new Date().toISOString();
  // current_step is deliberately NOT cleared here — snapshot-style
  // semantics per docs/decisions/0010-current-step-on-terminal-transitions.md.
  const { matched, error } = await guardedUpdate(db, sessionId, expected, {
    status: "blocked",
    last_error: args.last_error,
    updated_at: nowIso,
  });
  if (error) throw new Error(`transitionToBlocked: ${error.message}`);
  if (!matched) throwGuard("transitionToBlocked", sessionId, expected);
}

/**
 * idle | running → killing. Transient state — the worker will write
 * terminal 'killed' once SDK teardown completes (transitionToKilled).
 *
 * Called by recordDecision's kill branch for sessions with a live
 * worker. recordDecision exposes this path; this helper enables it.
 */
export async function transitionToKilling(
  db: SupabaseClient<Database>,
  sessionId: string,
  args: { last_error: SessionLastErrorT },
): Promise<void> {
  SessionLastError.parse(args.last_error);
  const expected: SessionStatus[] = ["idle", "running"];
  const nowIso = new Date().toISOString();
  const { matched, error } = await guardedUpdate(db, sessionId, expected, {
    status: "killing",
    last_error: args.last_error,
    updated_at: nowIso,
  });
  if (error) throw new Error(`transitionToKilling: ${error.message}`);
  if (!matched) throwGuard("transitionToKilling", sessionId, expected);
}

/**
 * killing → killed. Worker's terminal write after SDK teardown
 * completes.
 *
 * Guard is strictly 'killing' — this transition is ONLY called by the
 * worker. recordDecision's no-live-worker path (awaiting_review /
 * blocked → killed direct) uses `transitionToKilledDirectly` below.
 * Keeping them distinct preserves the audit trail: a 'killed' row
 * whose prior state was 'killing' tells us the worker confirmed
 * teardown; a 'killed' row whose prior state was 'awaiting_review'
 * or 'blocked' tells us the operator killed without a live worker.
 */
export async function transitionToKilled(
  db: SupabaseClient<Database>,
  sessionId: string,
): Promise<void> {
  const expected: SessionStatus[] = ["killing"];
  const nowIso = new Date().toISOString();
  // current_step is deliberately NOT cleared here — snapshot-style
  // semantics per docs/decisions/0010-current-step-on-terminal-transitions.md.
  const { matched, error } = await guardedUpdate(db, sessionId, expected, {
    status: "killed",
    completed_at: nowIso,
    updated_at: nowIso,
  });
  if (error) throw new Error(`transitionToKilled: ${error.message}`);
  if (!matched) throwGuard("transitionToKilled", sessionId, expected);
}

/**
 * awaiting_review | blocked → killed. The no-live-worker direct kill
 * path used by recordDecision when no SDK session is in flight to
 * coordinate teardown with.
 *
 * Sets last_error inline because there's no worker to flow that
 * through.
 */
export async function transitionToKilledDirectly(
  db: SupabaseClient<Database>,
  sessionId: string,
  args: { last_error: SessionLastErrorT },
): Promise<void> {
  SessionLastError.parse(args.last_error);
  const expected: SessionStatus[] = ["awaiting_review", "blocked"];
  const nowIso = new Date().toISOString();
  // current_step is deliberately NOT cleared here — snapshot-style
  // semantics per docs/decisions/0010-current-step-on-terminal-transitions.md.
  const { matched, error } = await guardedUpdate(db, sessionId, expected, {
    status: "killed",
    completed_at: nowIso,
    last_error: args.last_error,
    updated_at: nowIso,
  });
  if (error) throw new Error(`transitionToKilledDirectly: ${error.message}`);
  if (!matched) throwGuard("transitionToKilledDirectly", sessionId, expected);
}

/**
 * Set sessions.current_step opportunistically during streaming.
 *
 * UNLIKE the other helpers, this one silently no-ops on terminal /
 * killing / killed states rather than throwing. The worker streams
 * tool_use events on a separate code path from the kill subscription;
 * a late tool_use event arriving after the session has flipped to
 * 'killing' (or beyond) is a race we don't care about — silently
 * dropping the update is correct behaviour, not a programming bug.
 */
export async function setCurrentStep(
  db: SupabaseClient<Database>,
  sessionId: string,
  step: string | null,
): Promise<void> {
  const { error } = await db
    .from("sessions")
    .update({ current_step: step, updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .in("status", ["idle", "running"]);
  if (error) throw new Error(`setCurrentStep: ${error.message}`);
}
