// Server-only helper for creating a session row + its triggering
// decisions row in one flow. Consumed by /api/start-work (Direct
// branch, plan §4) and /api/sessions (lower-level Direct create,
// plan §4).
//
// Atomicity caveat: PostgREST doesn't expose multi-statement
// transactions. The session insert and the decisions insert are two
// HTTP calls — session FIRST, decision SECOND. If the decisions
// write fails, the session exists without a triggering decision
// (CLAUDE.md violation). Acceptable in V1 — orphans are detectable
// via `select s.id from sessions s left join decisions d on
// d.session_id = s.id where d.id is null`. Slice 2c revisits
// durability if real failures appear.
//
// Error pattern: bare throws after every Supabase call, no
// remapping. The route handler's try/catch is the single place that
// translates throws into HTTP 500 responses (plan §4).

import type { RouterDecision } from "@/lib/orchestration/router";
import { sbAdmin } from "@/lib/supabase/server";
import { randomSuffix, slugify } from "@/lib/util/slug";

export type CreateSessionInput = {
  projectId: string;
  brief: string;
  decision: RouterDecision;
};

export async function createSession({
  projectId,
  brief,
  decision,
}: CreateSessionInput): Promise<{ id: string }> {
  // slice_name = slugify(brief.slice(0, 60)) + '-' + 6-char random suffix
  // Example: "fix typo in footer" → "fix-typo-in-footer-a3f9k2"
  //
  // CONTRACT: slice 4 will consume slice_name as a worktree directory
  // segment (`~/numbat-worktrees/<project-slug>/<slice-name>/`). Any
  // future format change requires a data migration — existing
  // worktrees would be orphaned by a rename. Treat slice_name as a
  // stable identifier, not a display string.
  const slice_name = `${slugify(brief.slice(0, 60))}-${randomSuffix(6)}`;

  const { data: session, error: sessionError } = await sbAdmin
    .from("sessions")
    .insert({
      project_id: projectId,
      slice_name,
      task: brief,
      status: "idle",
      worktree_path: null,
      current_step: null,
      blocking_reason: null,
      spec_id: null,
      agent_session_id: null,
      last_error: null,
    })
    .select("id")
    .single();
  if (sessionError) throw sessionError;
  if (!session) throw new Error("createSession: insert returned no row");

  const { error: decisionError } = await sbAdmin.from("decisions").insert({
    project_id: projectId,
    session_id: session.id,
    plan_id: null,
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

  return { id: session.id };
}
