import { afterEach, describe, expect, test } from "vitest";

import type { WorktreeDiffT } from "@/lib/types/jsonb";

// Live-DB. Skip cleanly when env vars are missing so `pnpm test` stays
// green offline. Mirrors decisions.test.ts pattern.
const haveCreds =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const SAMPLE_DIFF: WorktreeDiffT = {
  files: [
    {
      path: "src/foo.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      patch: null,
    },
  ],
  totals: { files_changed: 1, additions: 3, deletions: 1 },
};

describe.skipIf(!haveCreds)("session-status transitions (live DB)", () => {
  const insertedProjectIds: string[] = [];

  afterEach(async () => {
    if (insertedProjectIds.length === 0) return;
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { error } = await sbAdmin
      .from("projects")
      .delete()
      .in("id", insertedProjectIds);
    if (error) {
      console.error("session-status.test cleanup failed:", error.message);
    }
    insertedProjectIds.length = 0;
  });

  // ───────────────────────────────────────────────────────────────────
  // transitionToRunning (idle → running)
  // ───────────────────────────────────────────────────────────────────

  test("transitionToRunning flips idle → running and sets agent_session_id + worktree_path", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToRunning } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "idle",
    });

    await transitionToRunning(sbAdmin, session_id, {
      agent_session_id: "fixture-agent-session-id",
      worktree_path: "/tmp/fixture-worktree",
    });

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, agent_session_id, worktree_path")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("running");
    expect(row?.agent_session_id).toBe("fixture-agent-session-id");
    expect(row?.worktree_path).toBe("/tmp/fixture-worktree");
  });

  test("transitionToRunning throws when status is not idle", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToRunning } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "running",
    });

    await expect(
      transitionToRunning(sbAdmin, session_id, {
        agent_session_id: "x",
        worktree_path: "/tmp/x",
      }),
    ).rejects.toThrow(/idle/);
  });

  // ───────────────────────────────────────────────────────────────────
  // transitionToAwaitingReview (running → awaiting_review)
  // ───────────────────────────────────────────────────────────────────

  test("transitionToAwaitingReview flips running → awaiting_review and writes diff", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToAwaitingReview } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "running",
    });

    await transitionToAwaitingReview(sbAdmin, session_id, {
      diff: SAMPLE_DIFF,
    });

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, diff")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("awaiting_review");
    expect(row?.diff).toEqual(SAMPLE_DIFF);
  });

  // ▶ THE NAMED TEST — load-bearing for the two-phase kill invariant.
  // Per agent-sdk.ts:isResultError JSDoc, an operator interrupt can
  // return a `result` message that classifies as success. If the
  // worker called transitionToAwaitingReview on the back of that, a
  // killed session would silently reach awaiting_review. The guard
  // here is what prevents it.
  test("transitionToAwaitingReview rejects a session in 'killing' (kill-race invariant)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToAwaitingReview } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "killing",
    });

    await expect(
      transitionToAwaitingReview(sbAdmin, session_id, { diff: SAMPLE_DIFF }),
    ).rejects.toThrow(/running/);

    // Status must STAY 'killing' — no silent fallthrough into awaiting_review.
    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, diff")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("killing");
    expect(row?.diff).toBeNull();
  });

  test("transitionToAwaitingReview throws on idle, blocked, done, killed", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToAwaitingReview } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    for (const status of ["idle", "blocked", "done", "killed"] as const) {
      const session_id = await insertSessionFixture(sbAdmin, {
        project_id,
        status,
      });
      await expect(
        transitionToAwaitingReview(sbAdmin, session_id, { diff: SAMPLE_DIFF }),
      ).rejects.toThrow(/running/);
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // transitionToBlocked (idle | running | killing → blocked)
  // ───────────────────────────────────────────────────────────────────

  test("transitionToBlocked flips running → blocked, validates last_error, leaves completed_at NULL (decisions log 0007)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToBlocked } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "running",
    });

    await transitionToBlocked(sbAdmin, session_id, {
      last_error: {
        message: "SDK errored during execution",
        source: "agent_sdk",
        occurred_at: new Date().toISOString(),
      },
    });

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, last_error, completed_at")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("blocked");
    expect((row?.last_error as { source: string }).source).toBe("agent_sdk");
    // Decision 0007: completed_at semantics stay narrow. blocked rows
    // are aged on updated_at, not completed_at; transitionToBlocked
    // must leave completed_at NULL.
    expect(row?.completed_at).toBeNull();
  });

  test("transitionToBlocked throws on terminal (done, killed)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToBlocked } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    for (const status of ["done", "killed"] as const) {
      const session_id = await insertSessionFixture(sbAdmin, {
        project_id,
        status,
      });
      await expect(
        transitionToBlocked(sbAdmin, session_id, {
          last_error: {
            message: "x",
            source: "worker",
            occurred_at: new Date().toISOString(),
          },
        }),
      ).rejects.toThrow();
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // transitionToKilling (idle | running → killing)
  // ───────────────────────────────────────────────────────────────────

  test("transitionToKilling flips running → killing with last_error (operator source)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToKilling } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "running",
    });

    await transitionToKilling(sbAdmin, session_id, {
      last_error: {
        message: "operator requested kill",
        source: "operator",
        occurred_at: new Date().toISOString(),
      },
    });

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, last_error, completed_at")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("killing");
    expect((row?.last_error as { source: string }).source).toBe("operator");
    expect(row?.completed_at).toBeNull(); // transient — terminal write comes from transitionToKilled
  });

  test("transitionToKilling throws on awaiting_review, blocked, done, killed", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToKilling } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    for (const status of [
      "awaiting_review",
      "blocked",
      "done",
      "killed",
    ] as const) {
      const session_id = await insertSessionFixture(sbAdmin, {
        project_id,
        status,
      });
      await expect(
        transitionToKilling(sbAdmin, session_id, {
          last_error: {
            message: "x",
            source: "operator",
            occurred_at: new Date().toISOString(),
          },
        }),
      ).rejects.toThrow();
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // transitionToKilled (killing → killed)
  // ───────────────────────────────────────────────────────────────────

  test("transitionToKilled flips killing → killed and sets completed_at", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToKilled } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "killing",
    });

    await transitionToKilled(sbAdmin, session_id);

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, completed_at")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("killed");
    expect(row?.completed_at).not.toBeNull();
  });

  test("transitionToKilled throws on non-killing source states (running, awaiting_review, done)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { transitionToKilled } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    for (const status of ["running", "awaiting_review", "done"] as const) {
      const session_id = await insertSessionFixture(sbAdmin, {
        project_id,
        status,
      });
      await expect(transitionToKilled(sbAdmin, session_id)).rejects.toThrow(
        /killing/,
      );
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // setCurrentStep (silent no-op on terminal states)
  // ───────────────────────────────────────────────────────────────────

  test("setCurrentStep updates a running session", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { setCurrentStep } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "running",
    });

    await setCurrentStep(sbAdmin, session_id, "Editing src/foo.ts");

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("current_step")
      .eq("id", session_id)
      .single();
    expect(row?.current_step).toBe("Editing src/foo.ts");
  });

  test("setCurrentStep silently no-ops on terminal/killing states (no throw, no update)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { setCurrentStep } = await import(
      "@/lib/supabase/mutations/session-status"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    for (const status of [
      "killing",
      "killed",
      "done",
      "blocked",
      "awaiting_review",
    ] as const) {
      const session_id = await insertSessionFixture(sbAdmin, {
        project_id,
        status,
      });

      // No throw expected.
      await setCurrentStep(sbAdmin, session_id, "should-not-land");

      const { data: row } = await sbAdmin
        .from("sessions")
        .select("current_step")
        .eq("id", session_id)
        .single();
      expect(row?.current_step).toBeNull();
    }
  });
});
