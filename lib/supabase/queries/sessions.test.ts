import { afterEach, describe, expect, test } from "vitest";

// Live-DB test for the listSessions filter. Mirrors the cleanup +
// dynamic-import shape of lib/supabase/sessions.test.ts so the suite
// skips cleanly when env is missing and the next run starts from a
// clean slate.

const haveCreds =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!haveCreds)("listSessions (live DB)", () => {
  // Project deletion cascades to sessions, so wiping the projects
  // covers everything inserted under them.
  const insertedProjectIds: string[] = [];

  afterEach(async () => {
    if (insertedProjectIds.length === 0) return;
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { error } = await sbAdmin
      .from("projects")
      .delete()
      .in("id", insertedProjectIds);
    if (error) {
      console.error("queries/sessions.test cleanup failed:", error.message);
    }
    insertedProjectIds.length = 0;
  });

  test("filters by project short_code", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );
    const { listSessions } = await import("@/lib/supabase/queries/sessions");

    // Two fixture projects with distinct short_codes. Random suffix
    // avoids collision with the V1 seed (AO/WT/BB/NB) and any
    // concurrent test run. Prefixes T/O guarantee distinction even
    // under a full suffix collision.
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const targetCode = `T${suffix}`;
    const otherCode = `O${suffix}`;

    const targetId = await insertProjectFixture(sbAdmin, {
      short_code: targetCode,
    });
    insertedProjectIds.push(targetId);
    const otherId = await insertProjectFixture(sbAdmin, {
      short_code: otherCode,
    });
    insertedProjectIds.push(otherId);

    await insertSessionFixture(sbAdmin, {
      project_id: targetId,
      slice_name: `fixture-target-${suffix}`,
    });
    await insertSessionFixture(sbAdmin, {
      project_id: otherId,
      slice_name: `fixture-other-${suffix}`,
    });

    const { sessions } = await listSessions({ projectShortCode: targetCode });

    // Filter actually filters: every returned session belongs to the
    // target project, and the other-project fixture does not leak in.
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.project_id === targetId)).toBe(true);
    expect(sessions.some((s) => s.project_id === otherId)).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // Slice 5 step 4b — includeDismissed filter. Default behaviour hides
  // dismissed_at-populated rows; passing includeDismissed: true lifts
  // the filter (no IS NOT NULL — both visible).
  // ───────────────────────────────────────────────────────────────────

  test("default filter excludes dismissed sessions", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );
    const { listSessions } = await import("@/lib/supabase/queries/sessions");

    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const projectId = await insertProjectFixture(sbAdmin, {
      short_code: `D${suffix}`,
    });
    insertedProjectIds.push(projectId);

    const liveId = await insertSessionFixture(sbAdmin, {
      project_id: projectId,
      slice_name: `fixture-live-${suffix}`,
    });
    const dismissedId = await insertSessionFixture(sbAdmin, {
      project_id: projectId,
      slice_name: `fixture-dismissed-${suffix}`,
      status: "done",
      dismissed_at: new Date().toISOString(),
    });

    const { sessions } = await listSessions({
      projectShortCode: `D${suffix}`,
    });
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(dismissedId);
  });

  test("includeDismissed: true lifts the filter (both visible)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );
    const { listSessions } = await import("@/lib/supabase/queries/sessions");

    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const projectId = await insertProjectFixture(sbAdmin, {
      short_code: `I${suffix}`,
    });
    insertedProjectIds.push(projectId);

    const liveId = await insertSessionFixture(sbAdmin, {
      project_id: projectId,
      slice_name: `fixture-live-${suffix}`,
    });
    const dismissedId = await insertSessionFixture(sbAdmin, {
      project_id: projectId,
      slice_name: `fixture-dismissed-${suffix}`,
      status: "done",
      dismissed_at: new Date().toISOString(),
    });

    const { sessions } = await listSessions({
      projectShortCode: `I${suffix}`,
      includeDismissed: true,
    });
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain(liveId);
    expect(ids).toContain(dismissedId);
  });
});
