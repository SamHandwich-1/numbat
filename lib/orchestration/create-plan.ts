// Server-only helper for creating a plan stub + its triggering
// decisions row in one flow. Consumed by /api/start-work (Bilby
// branch, plan §4). No /api/plans endpoint in 2b — only consumer is
// /api/start-work, so symmetry with /api/sessions waits.
//
// Same atomicity caveat and bare-throw error pattern as
// create-session.ts (plan §5). Plan insert FIRST, decisions row
// SECOND.

import type { RouterDecision } from "@/lib/orchestration/router";
import { sbAdmin } from "@/lib/supabase/server";

export type CreatePlanInput = {
  projectId: string;
  brief: string;
  decision: RouterDecision;
};

export async function createPlan({
  projectId,
  brief,
  decision,
}: CreatePlanInput): Promise<{ id: string }> {
  // plan.title = brief.slice(0, 80) + (brief.length > 80 ? '…' : '')
  // Display string only — not a path component, not a stable ID.
  // Plans surface (slice 5) is free to re-derive or LLM-generate later.
  const title = brief.slice(0, 80) + (brief.length > 80 ? "…" : "");

  const { data: plan, error: planError } = await sbAdmin
    .from("plans")
    .insert({
      project_id: projectId,
      title,
      brief,
      status: "drafting",
      spec_id: null,
    })
    .select("id")
    .single();
  if (planError) throw planError;
  if (!plan) throw new Error("createPlan: insert returned no row");

  const { error: decisionError } = await sbAdmin.from("decisions").insert({
    project_id: projectId,
    session_id: null,
    plan_id: plan.id,
    type: "start_work",
    context: brief,
    payload: {
      type: "start_work",
      routed_to: decision.pipeline,
      matched_rule: decision.matched_rule,
      reason: decision.reason,
    },
  });
  if (decisionError) throw decisionError;

  return { id: plan.id };
}
