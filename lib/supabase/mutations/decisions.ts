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

// The subset of DecisionType this mutation handles. start_work,
// accept_critique, etc. flow through their own helpers.
export type ReviewDecisionType = "approve" | "redirect" | "kill";

export type RecordDecisionInput = {
  sessionId: string;
  type: ReviewDecisionType;
  payload: DecisionPayloadT;
  context?: string | null;
};

/**
 * Record an operator's review decision (Approve / Redirect / Kill)
 * and apply the matching session-status change in one helper.
 *
 * Status transitions (plan §2, two-phase kill):
 *   approve  (awaiting_review)  → status='done',   completed_at=now()
 *   redirect (awaiting_review)  → session row UNCHANGED (plan §8 Q1 = A)
 *   kill     (idle | running)   → status='killing' (transient — worker
 *                                  writes terminal 'killed' on teardown)
 *   kill     (awaiting_review |
 *             blocked)          → status='killed' DIRECT, completed_at,
 *                                  last_error (no live worker to coord)
 *   kill     (killing | done |
 *             killed)           → THROW (kill already in flight or terminal)
 *
 * Two writes are non-atomic. Decision INSERT first (the audit log is
 * canonical even if the subsequent session UPDATE fails). If the
 * update fails after the decision lands, the session stays in its
 * prior state and the operator can retry. Single-operator V1
 * concession; matches the create-session.ts atomicity stance.
 *
 * Guards:
 *   - approve / redirect — session must be in 'awaiting_review'.
 *   - kill — session must NOT be terminal (done/killed) or already
 *     in-flight (killing). Valid source states: idle / running /
 *     awaiting_review / blocked.
 *   - DecisionPayload re-parsed defensively (route handler already
 *     parses; this is belt-and-braces).
 *   - payload.type must match the typed `type` field.
 */
export async function recordDecision(
  db: SupabaseClient<Database>,
  input: RecordDecisionInput,
): Promise<Decision> {
  // Load the session — need project_id (FK on decisions) and status
  // (guard).
  const { data: session, error: sessionError } = await db
    .from("sessions")
    .select("id, project_id, status")
    .eq("id", input.sessionId)
    .maybeSingle();
  if (sessionError) {
    throw new Error(`recordDecision: load session — ${sessionError.message}`);
  }
  if (!session) {
    throw new Error(`recordDecision: session ${input.sessionId} not found`);
  }

  // Type-specific status guards. Approve / Redirect require
  // awaiting_review; Kill is valid on any non-terminal-non-in-flight
  // state. Throws keep the message containing 'awaiting_review' for
  // the approve/redirect paths (existing test expectations).
  if (input.type === "approve" || input.type === "redirect") {
    if (session.status !== "awaiting_review") {
      throw new Error(
        `recordDecision: ${input.type} requires status awaiting_review, ` +
          `got ${session.status}`,
      );
    }
  } else {
    // input.type === "kill"
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
  }
  // redirect: no session UPDATE (plan §8 Q1 = A).

  return decision;
}
