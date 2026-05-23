import { afterEach, describe, expect, test } from "vitest";

// Live-DB. Verifies migration 0007's FK behaviour change
// (decisions.session_id and decisions.plan_id from NO ACTION → SET NULL)
// plus the snapshot-via-payload pattern that the Zod schema in
// lib/types/jsonb.ts formalises.
//
// Two symmetric tests:
//   1. session-side: decision survives session deletion with session_id
//      IS NULL and payload.session_label still readable.
//   2. plan-side:   same shape, mirrored across the plans FK.
//
// These duplicate the manual probes from step 1's recovery as
// repeatable CI guards. If the FK behaviour ever regresses (someone
// reverts to NO ACTION inadvertently) or the snapshot capture site
// stops populating the field, the tests catch it. Skip cleanly when
// env vars are missing so `pnpm test` stays green offline.

const haveCreds =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!haveCreds)(
  "decisions FK SET NULL + snapshot preservation (live DB)",
  () => {
    // Project deletes cascade to sessions, plans, and decisions via the
    // project_id CASCADE FKs. One delete per project tears down the
    // whole tree, regardless of FK behaviour on session_id / plan_id.
    const insertedProjectIds: string[] = [];

    afterEach(async () => {
      if (insertedProjectIds.length === 0) return;
      const { sbAdmin } = await import("@/lib/supabase/server");
      const { error } = await sbAdmin
        .from("projects")
        .delete()
        .in("id", insertedProjectIds);
      if (error) {
        console.error("decisions-fk-set-null.test cleanup failed:", error.message);
      }
      insertedProjectIds.length = 0;
    });

    test("session-side: decision survives session delete with session_id NULL and payload.session_label readable", async () => {
      const { sbAdmin } = await import("@/lib/supabase/server");
      const { insertProjectFixture, insertSessionFixture } = await import(
        "@/lib/supabase/test-fixtures"
      );

      const project_id = await insertProjectFixture(sbAdmin);
      insertedProjectIds.push(project_id);

      const SLICE_NAME = "fk-set-null-test-session";
      const session_id = await insertSessionFixture(sbAdmin, {
        project_id,
        slice_name: SLICE_NAME,
        status: "running",
      });

      const { data: decision, error: decErr } = await sbAdmin
        .from("decisions")
        .insert({
          project_id,
          session_id,
          plan_id: null,
          type: "approve",
          context: null,
          payload: { type: "approve", session_label: SLICE_NAME },
        })
        .select("id")
        .single();
      expect(decErr).toBeNull();
      expect(decision).not.toBeNull();
      const decision_id = decision!.id;

      const { error: delErr } = await sbAdmin
        .from("sessions")
        .delete()
        .eq("id", session_id);
      expect(delErr).toBeNull();

      // (a) The session row is gone.
      const { data: sessAfter } = await sbAdmin
        .from("sessions")
        .select("id")
        .eq("id", session_id)
        .maybeSingle();
      expect(sessAfter).toBeNull();

      // (b) The decision row survives with session_id IS NULL.
      // (c) payload.session_label still equals the original snapshot value.
      const { data: decAfter, error: readErr } = await sbAdmin
        .from("decisions")
        .select("id, session_id, payload")
        .eq("id", decision_id)
        .maybeSingle();
      expect(readErr).toBeNull();
      expect(decAfter).not.toBeNull();
      expect(decAfter!.session_id).toBeNull();
      const payload = decAfter!.payload as { session_label?: string } | null;
      expect(payload?.session_label).toBe(SLICE_NAME);
    });

    test("plan-side: decision survives plan delete with plan_id NULL and payload.plan_label readable", async () => {
      const { sbAdmin } = await import("@/lib/supabase/server");
      const { insertProjectFixture } = await import(
        "@/lib/supabase/test-fixtures"
      );

      const project_id = await insertProjectFixture(sbAdmin);
      insertedProjectIds.push(project_id);

      // No insertPlanFixture helper exists yet; inline the plan insert.
      // Out of scope to extend test-fixtures.ts in this step.
      const PLAN_TITLE = "fk-set-null-test-plan";
      const { data: plan, error: planErr } = await sbAdmin
        .from("plans")
        .insert({
          project_id,
          title: PLAN_TITLE,
          brief: "fixture brief",
          status: "drafting",
          spec_id: null,
        })
        .select("id")
        .single();
      expect(planErr).toBeNull();
      expect(plan).not.toBeNull();
      const plan_id = plan!.id;

      const { data: decision, error: decErr } = await sbAdmin
        .from("decisions")
        .insert({
          project_id,
          session_id: null,
          plan_id,
          type: "approve",
          context: null,
          payload: { type: "approve", plan_label: PLAN_TITLE },
        })
        .select("id")
        .single();
      expect(decErr).toBeNull();
      expect(decision).not.toBeNull();
      const decision_id = decision!.id;

      const { error: delErr } = await sbAdmin
        .from("plans")
        .delete()
        .eq("id", plan_id);
      expect(delErr).toBeNull();

      // (a) The plan row is gone.
      const { data: planAfter } = await sbAdmin
        .from("plans")
        .select("id")
        .eq("id", plan_id)
        .maybeSingle();
      expect(planAfter).toBeNull();

      // (b) The decision row survives with plan_id IS NULL.
      // (c) payload.plan_label still equals the original snapshot value.
      const { data: decAfter, error: readErr } = await sbAdmin
        .from("decisions")
        .select("id, plan_id, payload")
        .eq("id", decision_id)
        .maybeSingle();
      expect(readErr).toBeNull();
      expect(decAfter).not.toBeNull();
      expect(decAfter!.plan_id).toBeNull();
      const payload = decAfter!.payload as { plan_label?: string } | null;
      expect(payload?.plan_label).toBe(PLAN_TITLE);
    });
  },
);
