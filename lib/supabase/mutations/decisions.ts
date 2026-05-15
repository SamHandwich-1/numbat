import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Decision } from "@/lib/types/db";
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
 * Status transitions (brief §11, Slice 3):
 *   approve  → status='done',   completed_at=now()
 *   kill     → status='killed', completed_at=now(), last_error populated
 *   redirect → session row unchanged (plan §8 Q1 = A)
 *
 * Two writes are non-atomic. Decision INSERT first (the audit log is
 * canonical even if the subsequent session UPDATE fails). If the
 * update fails after the decision lands, the session stays in
 * `awaiting_review` and the operator can retry. Single-operator V1
 * concession; matches the create-session.ts atomicity stance.
 *
 * Guards:
 *   - session must currently be in `awaiting_review` — review actions
 *     are only valid in this state. The UI never mounts ActionBar
 *     outside it; the throw is defence-in-depth against stale tabs
 *     and direct API calls.
 *   - DecisionPayload re-parsed inside this function. The route
 *     handler already parses; this is belt-and-braces in the spirit
 *     of llm-calls.ts:LlmCallError.parse.
 */
export async function recordDecision(
  db: SupabaseClient<Database>,
  input: RecordDecisionInput,
): Promise<Decision> {
  // Load the session — need project_id (FK on decisions) and status
  // (guard). Other columns aren't read here, but `last_error: null` is
  // implicit; the UPDATE branch sets it directly when needed.
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
  if (session.status !== "awaiting_review") {
    throw new Error(
      `recordDecision: session ${input.sessionId} is ${session.status}, ` +
        `not awaiting_review — review actions are only valid in awaiting_review`,
    );
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

  // Apply the session-status change. Redirect intentionally leaves the
  // row alone (plan §8 Q1 = A); Slice 4's worker flips status to
  // `running` when it picks up the latest redirect decision.
  const nowIso = new Date().toISOString();
  if (input.type === "approve") {
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
    // The discriminator guard above narrows parsedPayload to the kill
    // variant; the runtime assertion below is a redundant guard the
    // type system can't see through without a custom predicate.
    if (parsedPayload.type !== "kill") {
      throw new Error("recordDecision: kill payload narrow failed");
    }
    const lastError: SessionLastErrorT = {
      message: parsedPayload.reason,
      source: "operator",
      occurred_at: nowIso,
    };
    const { error } = await db
      .from("sessions")
      .update({
        status: "killed",
        completed_at: nowIso,
        updated_at: nowIso,
        last_error: lastError,
      })
      .eq("id", session.id);
    if (error) {
      throw new Error(`recordDecision: kill session update — ${error.message}`);
    }
  }
  // redirect: no session UPDATE.

  return decision;
}
