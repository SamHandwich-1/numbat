import type { SupabaseClient } from "@supabase/supabase-js";

import {
  transitionToKilledDirectly,
  transitionToKilling,
} from "@/lib/supabase/mutations/session-status";
import type { Database, Decision, SessionStatus } from "@/lib/types/db";
import {
  DecisionPayload,
  type DecisionPayloadT,
  type SessionLastErrorT,
} from "@/lib/types/jsonb";

// SYNC: the kill/approve/redirect AND dismiss/undismiss guards below
// mirror the rules in lib/orchestration/affordances.ts:deriveSessionAffordances.
// Two pairs:
//   - approve/redirect/kill (since step 3)
//   - dismiss/undismiss     (since step 4a)
// If either rule set changes here, the affordances helper must update
// in lock-step, and vice versa. The duplication is a deliberate scope
// concession in Slice 5 — consolidation (refactor recordDecision to
// consume the helper) is on the Slice 5 close-out's carried-forward
// list. Drift between the two is a UI/backend skew that's hard to
// debug; this comment exists to be a breadcrumb in code review.

// Operator actions that go through recordDecision:
//   review actions:    approve, redirect, kill (since Slice 3)
//   lifecycle actions: dismiss, undismiss      (since Slice 5 step 4a)
// All five share the same write shape: insert a decisions row, then
// apply the matching side-effect on sessions. recordDecision is the
// single entry point. start_work, accept_critique, etc. flow through
// their own helpers.
export type OperatorDecisionType =
  | "approve"
  | "redirect"
  | "kill"
  | "dismiss"
  | "undismiss";

export type RecordDecisionInput = {
  sessionId: string;
  type: OperatorDecisionType;
  payload: DecisionPayloadT;
  context?: string | null;
};

/**
 * Record an operator's decision (review or lifecycle) and apply the
 * matching session-row change in one helper.
 *
 * Status transitions and side-effects:
 *   approve   (awaiting_review)        → status='done', completed_at=now()
 *   redirect  (awaiting_review)        → session row UNCHANGED (plan §8 Q1 = A)
 *   kill      (idle | running)         → status='killing' (transient — worker
 *                                         writes terminal 'killed' on teardown)
 *   kill      (awaiting_review |       → status='killed' DIRECT, completed_at,
 *              blocked)                  last_error (no live worker to coord)
 *   kill      (killing | done |        → THROW (kill already in flight or terminal)
 *              killed)
 *   dismiss   (done | killed | blocked → dismissed_at=now() (UPDATE only; status
 *              with dismissed_at NULL)   unchanged)
 *   undismiss (any status with         → dismissed_at=NULL (UPDATE only; status
 *              dismissed_at NOT NULL)    unchanged)
 *
 * Two writes are non-atomic. Decision INSERT first (the audit log is
 * canonical even if the subsequent session UPDATE fails). If the
 * update fails after the decision lands, the session stays in its
 * prior state and the operator can retry. Single-operator V1
 * concession; matches the create-session.ts atomicity stance. The
 * dismiss/undismiss branches inherit this concession — failed UPDATE
 * means the operator re-clicks. Atomicity (Postgres function wrapping
 * both writes) is on the Slice 5 close-out's carried-forward list
 * for V2 router-training data integrity.
 *
 * Guards:
 *   - approve / redirect — session must be in 'awaiting_review'.
 *   - kill — session must NOT be terminal (done/killed) or already
 *     in-flight (killing). Valid source states: idle / running /
 *     awaiting_review / blocked.
 *   - dismiss — session must be terminal (done/killed/blocked) AND
 *     dismissed_at must be NULL.
 *   - undismiss — dismissed_at must be NOT NULL (any status).
 *   - DecisionPayload re-parsed defensively (route handler already
 *     parses; this is belt-and-braces).
 *   - payload.type must match the typed `type` field.
 */
export async function recordDecision(
  db: SupabaseClient<Database>,
  input: RecordDecisionInput,
): Promise<Decision> {
  // Load the session — need project_id (FK on decisions), status
  // (review/kill guards), and dismissed_at (dismiss/undismiss guards).
  const { data: session, error: sessionError } = await db
    .from("sessions")
    .select("id, project_id, status, dismissed_at")
    .eq("id", input.sessionId)
    .maybeSingle();
  if (sessionError) {
    throw new Error(`recordDecision: load session — ${sessionError.message}`);
  }
  if (!session) {
    throw new Error(`recordDecision: session ${input.sessionId} not found`);
  }

  // Type-specific guards. Approve / Redirect require awaiting_review;
  // Kill is valid on any non-terminal-non-in-flight state; Dismiss is
  // valid on terminal rows that aren't yet dismissed; Undismiss is
  // valid on any dismissed row. Throws keep the message wording
  // tested by existing/new test expectations.
  if (input.type === "approve" || input.type === "redirect") {
    if (session.status !== "awaiting_review") {
      throw new Error(
        `recordDecision: ${input.type} requires status awaiting_review, ` +
          `got ${session.status}`,
      );
    }
  } else if (input.type === "kill") {
    const validKillStates: SessionStatus[] = [
      "idle",
      "running",
      "awaiting_review",
      "blocked",
    ];
    if (!validKillStates.includes(session.status as SessionStatus)) {
      throw new Error(
        `recordDecision: kill not valid from status ${session.status} ` +
          `(must be one of ${validKillStates.join(", ")})`,
      );
    }
  } else if (input.type === "dismiss") {
    const validDismissStates: SessionStatus[] = ["done", "killed", "blocked"];
    if (!validDismissStates.includes(session.status as SessionStatus)) {
      throw new Error(
        `recordDecision: dismiss not valid from status ${session.status} ` +
          `(must be one of ${validDismissStates.join(", ")})`,
      );
    }
    if (session.dismissed_at !== null) {
      throw new Error(
        `recordDecision: dismiss requires dismissed_at IS NULL, ` +
          `but session is already dismissed`,
      );
    }
  } else {
    // input.type === "undismiss"
    if (session.dismissed_at === null) {
      throw new Error(
        `recordDecision: undismiss requires dismissed_at IS NOT NULL, ` +
          `but session is not dismissed`,
      );
    }
  }

  // Re-parse the payload through the canonical Zod schema.
  const parsedPayload = DecisionPayload.parse(input.payload);
  // Discriminator must match the typed `type` field. Catches a route
  // handler that built `{ type: 'kill', payload: { type: 'approve', … } }`.
  if (parsedPayload.type !== input.type) {
    throw new Error(
      `recordDecision: payload.type (${parsedPayload.type}) ` +
        `does not match type field (${input.type})`,
    );
  }

  // Audit log first — see header comment for why.
  const { data: decision, error: decisionError } = await db
    .from("decisions")
    .insert({
      project_id: session.project_id,
      session_id: session.id,
      plan_id: null,
      type: input.type,
      context: input.context ?? null,
      payload: parsedPayload,
    })
    .select("*")
    .single();
  if (decisionError) {
    throw new Error(`recordDecision: insert decision — ${decisionError.message}`);
  }
  if (!decision) {
    throw new Error("recordDecision: insert decision returned no row");
  }

  // Apply the session-status change.
  const nowIso = new Date().toISOString();
  if (input.type === "approve") {
    // current_step is deliberately NOT cleared on the done transition —
    // snapshot-style semantics per docs/decisions/0010-current-step-on-terminal-transitions.md.
    const { error } = await db
      .from("sessions")
      .update({
        status: "done",
        completed_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", session.id);
    if (error) {
      throw new Error(`recordDecision: approve session update — ${error.message}`);
    }
  } else if (input.type === "kill") {
    if (parsedPayload.type !== "kill") {
      throw new Error("recordDecision: kill payload narrow failed");
    }
    const lastError: SessionLastErrorT = {
      message: parsedPayload.reason,
      source: "operator",
      occurred_at: nowIso,
    };

    // current_step is deliberately NOT cleared by either branch below —
    // snapshot-style semantics per docs/decisions/0010-current-step-on-terminal-transitions.md.
    // The transitionToKilling / transitionToKilledDirectly helpers
    // preserve current_step in their own UPDATE statements.
    // Two-phase kill (plan §2): branch on current status.
    if (session.status === "idle" || session.status === "running") {
      // Live worker — write transient 'killing'. Worker tears down
      // SDK and writes terminal 'killed' on completion.
      await transitionToKilling(db, session.id, { last_error: lastError });
    } else {
      // status === 'awaiting_review' || 'blocked' (guarded above).
      // No live worker — write terminal 'killed' directly.
      await transitionToKilledDirectly(db, session.id, {
        last_error: lastError,
      });
    }
  } else if (input.type === "dismiss") {
    // status unchanged; only dismissed_at flips. current_step preserved
    // (the row is already terminal so snapshot semantics apply).
    const { error } = await db
      .from("sessions")
      .update({
        dismissed_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", session.id);
    if (error) {
      throw new Error(`recordDecision: dismiss session update — ${error.message}`);
    }
  } else if (input.type === "undismiss") {
    // Reverse of dismiss. status unchanged.
    const { error } = await db
      .from("sessions")
      .update({
        dismissed_at: null,
        updated_at: nowIso,
      })
      .eq("id", session.id);
    if (error) {
      throw new Error(`recordDecision: undismiss session update — ${error.message}`);
    }
  }
  // redirect: no session UPDATE (plan §8 Q1 = A).

  return decision;
}
