import { afterEach, describe, expect, test } from "vitest";

// Live-DB integration for the Start Work data path. Pins:
//   1. createSession + createPlan each write BOTH artifact and
//      decisions rows in the same flow (CLAUDE.md "never ship a
//      session without a triggering decision").
//   2. The decisions row's payload validates against the
//      start_work zod variant — the two sides stay in sync.
//   3. The decisions_type_check constraint (migration 0005) accepts
//      'start_work' in production.
//
// Tests the HELPERS directly, not the route handlers. The HTTP
// layer is a thin wrapper verified by manual smoke (plan
// "Verification plan" steps 8–12); the helpers are where the
// two-step insert lives and where regressions would land.
//
// Project-cascade cleanup mirrors lib/supabase/queries/sessions.test.ts:
// deleting the fixture project drops its sessions, plans, and
// decisions via the on-delete-cascade FKs.

const haveCreds =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!haveCreds)("start-work helpers (live DB)", () => {
  const insertedProjectIds: string[] = [];

  afterEach(async () => {
    if (insertedProjectIds.length === 0) return;
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { error } = await sbAdmin
      .from("projects")
      .delete()
      .in("id", insertedProjectIds);
    if (error) {
      console.error("start-work.test cleanup failed:", error.message);
    }
    insertedProjectIds.length = 0;
  });

  test("createSession (Direct route): writes session + decisions row", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { insertProjectFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );
    const { createSession } = await import(
      "@/lib/orchestration/create-session"
    );
    const { route } = await import("@/lib/orchestration/router");
    const { DecisionPayload } = await import("@/lib/types/jsonb");

    const projectId = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(projectId);

    const brief = "fix typo in footer";
    const decision = route(brief);
    expect(decision.pipeline).toBe("direct");
    expect(decision.matched_rule).toBe("length_under_200");

    const { id } = await createSession({ projectId, brief, decision });

    // Session row: status='idle', task=brief, slice_name derived.
    const { data: session, error: sessionErr } = await sbAdmin
      .from("sessions")
      .select("id, project_id, status, task, slice_name")
      .eq("id", id)
      .single();
    expect(sessionErr).toBeNull();
    if (!session) throw new Error("session query returned null");
    expect(session.project_id).toBe(projectId);
    expect(session.status).toBe("idle");
    expect(session.task).toBe(brief);
    expect(session.slice_name).toMatch(/^fix-typo-in-footer-[a-z0-9]{6}$/);

    // Decisions row: start_work shape, session_id matches, plan_id null.
    const { data: decisions, error: decisionErr } = await sbAdmin
      .from("decisions")
      .select("type, session_id, plan_id, context, payload")
      .eq("session_id", id);
    expect(decisionErr).toBeNull();
    if (!decisions) throw new Error("decisions query returned null");
    expect(decisions).toHaveLength(1);
    const dRow = decisions[0]!;
    expect(dRow.type).toBe("start_work");
    expect(dRow.session_id).toBe(id);
    expect(dRow.plan_id).toBeNull();
    expect(dRow.context).toBe(brief);

    // Validate payload through the zod schema — confirms the
    // start_work variant landed as written, not just that some
    // jsonb stuck.
    const payload = DecisionPayload.parse(dRow.payload);
    expect(payload.type).toBe("start_work");
    if (payload.type === "start_work") {
      expect(payload.routed_to).toBe("direct");
      expect(payload.matched_rule).toBe("length_under_200");
      expect(payload.reason.length).toBeGreaterThan(0);
    }
  });

  test("createPlan (Bilby route): writes plan + decisions row", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { insertProjectFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );
    const { createPlan } = await import("@/lib/orchestration/create-plan");
    const { route } = await import("@/lib/orchestration/router");
    const { DecisionPayload } = await import("@/lib/types/jsonb");

    const projectId = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(projectId);

    // 250-char ambiguous brief: length≥200, no keyword, no '?'.
    // Hits rule 4 (default_bilby).
    const brief = "a ".repeat(125);
    expect(brief.length).toBe(250);
    const decision = route(brief);
    expect(decision.pipeline).toBe("bilby");
    expect(decision.matched_rule).toBe("default_bilby");

    const { id } = await createPlan({ projectId, brief, decision });

    // Plan row: status='drafting', brief stored verbatim, title
    // truncated per the §4 contract.
    const { data: plan, error: planErr } = await sbAdmin
      .from("plans")
      .select("id, project_id, status, brief, title")
      .eq("id", id)
      .single();
    expect(planErr).toBeNull();
    if (!plan) throw new Error("plan query returned null");
    expect(plan.project_id).toBe(projectId);
    expect(plan.status).toBe("drafting");
    expect(plan.brief).toBe(brief);
    // brief.length is 250 > 80, so the ellipsis trailer applies.
    expect(plan.title).toBe(brief.slice(0, 80) + "…");

    // Decisions row: start_work shape, plan_id matches, session_id null.
    const { data: decisions, error: decisionErr } = await sbAdmin
      .from("decisions")
      .select("type, session_id, plan_id, context, payload")
      .eq("plan_id", id);
    expect(decisionErr).toBeNull();
    if (!decisions) throw new Error("decisions query returned null");
    expect(decisions).toHaveLength(1);
    const dRow = decisions[0]!;
    expect(dRow.type).toBe("start_work");
    expect(dRow.session_id).toBeNull();
    expect(dRow.plan_id).toBe(id);
    expect(dRow.context).toBe(brief);

    const payload = DecisionPayload.parse(dRow.payload);
    expect(payload.type).toBe("start_work");
    if (payload.type === "start_work") {
      expect(payload.routed_to).toBe("bilby");
      expect(payload.matched_rule).toBe("default_bilby");
      expect(payload.reason.length).toBeGreaterThan(0);
    }
  });
});
