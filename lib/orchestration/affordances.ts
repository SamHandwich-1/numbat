// lib/orchestration/affordances.ts — pure logic for "what operator
// actions are valid on this session given its current status +
// dismissed_at." Slice 5 spine 1 (ActionBar status-awareness) and
// spine 3 (Dismiss UI) both consume this helper; see 0009 §B/§C for
// the design call.
//
// SYNC: this helper enumerates rules for TWO pairs of operator actions
// that mirror guards in lib/supabase/mutations/decisions.ts:recordDecision:
//   - approve/redirect/kill (since step 3)
//   - dismiss/undismiss     (since step 4a)
// If either rule set changes here, recordDecision must update in
// lock-step, and vice versa. The duplication is a deliberate scope
// concession in Slice 5 — consolidation (refactor recordDecision to
// consume this helper) is on the Slice 5 close-out's carried-forward
// list. Drift between the two is a UI/backend skew that's hard to
// debug; this comment exists to be a breadcrumb in code review.

import type { Session } from "@/lib/types/db";

export type SessionAffordances = {
  approve: boolean;
  redirect: boolean;
  kill: boolean;
  dismiss: boolean;
  undismiss: boolean;
};

/**
 * What operator actions are valid on a given session.
 *
 * Pure function over (status, dismissed_at) — no DB, no UI. The input
 * is narrowed to `Pick<Session, "status" | "dismissed_at">` to document
 * the read surface; callers passing a full Session still type-check via
 * structural subtyping.
 *
 * Rule sources (kept in lock-step per SYNC comment above):
 *   - approve / redirect — `recordDecision` guard (awaiting_review only)
 *   - kill               — `recordDecision` guard (idle/running/
 *                          awaiting_review/blocked)
 *   - dismiss            — 0009 §D (terminal cohort: done/killed/
 *                          blocked, with dismissed_at IS NULL)
 *   - undismiss          — 0009 §D (status-agnostic; dismissed_at
 *                          IS NOT NULL)
 *
 * `killing` and `planning` return all-false until their flows define
 * operator actions. `killing` is transient (worker mid-teardown);
 * `planning` is reserved for Bilby flows that don't ship in Slice 5.
 */
export function deriveSessionAffordances(
  session: Pick<Session, "status" | "dismissed_at">,
): SessionAffordances {
  const { status, dismissed_at } = session;
  const isDismissed = dismissed_at !== null;

  const isAwaitingReview = status === "awaiting_review";
  const canKill =
    status === "idle" ||
    status === "running" ||
    status === "awaiting_review" ||
    status === "blocked";
  const canDismiss =
    !isDismissed &&
    (status === "done" || status === "killed" || status === "blocked");

  return {
    approve: isAwaitingReview,
    redirect: isAwaitingReview,
    kill: canKill,
    dismiss: canDismiss,
    undismiss: isDismissed,
  };
}
