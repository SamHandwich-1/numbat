import { afterEach, describe, expect, test } from "vitest";

// Live-DB. Skip cleanly when env vars are missing so `pnpm test` stays
// green offline. Mirrors the llm-calls.test.ts skip pattern.
const haveCreds =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!haveCreds)("recordDecision state-machine (live DB)", () => {
  // Project deletes cascade to sessions and decisions; one delete per
  // project tears down the tree the test created.
  const insertedProjectIds: string[] = [];

  afterEach(async () => {
    if (insertedProjectIds.length === 0) return;
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { error } = await sbAdmin
      .from("projects")
      .delete()
      .in("id", insertedProjectIds);
    if (error) {
      console.error("decisions.test cleanup failed:", error.message);
    }
    insertedProjectIds.length = 0;
  });

  test("approve flips status to done, sets completed_at, leaves last_error null", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "awaiting_review",
    });

    const decision = await recordDecision(sbAdmin, {
      sessionId: session_id,
      type: "approve",
      payload: { type: "approve", note: "lgtm" },
    });

    expect(decision.type).toBe("approve");
    expect(decision.session_id).toBe(session_id);
    expect(decision.project_id).toBe(project_id);
    // payload round-trips through jsonb intact
    expect((decision.payload as { note?: string }).note).toBe("lgtm");

    const { data: session } = await sbAdmin
      .from("sessions")
      .select("status, completed_at, last_error")
      .eq("id", session_id)
      .single();
    expect(session?.status).toBe("done");
    expect(session?.completed_at).not.toBeNull();
    expect(session?.last_error).toBeNull();
  });

  test("redirect leaves the session row unchanged (Q1 = A) and records reply_text", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "awaiting_review",
    });

    const reply = "use imperative voice in headings";
    const decision = await recordDecision(sbAdmin, {
      sessionId: session_id,
      type: "redirect",
      payload: { type: "redirect", reply_text: reply },
    });

    expect(decision.type).toBe("redirect");
    expect((decision.payload as { reply_text: string }).reply_text).toBe(reply);

    const { data: session } = await sbAdmin
      .from("sessions")
      .select("status, completed_at, last_error")
      .eq("id", session_id)
      .single();
    expect(session?.status).toBe("awaiting_review"); // unchanged
    expect(session?.completed_at).toBeNull();
    expect(session?.last_error).toBeNull();
  });

  test("kill flips status to killed, sets completed_at, populates last_error with source='operator'", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "awaiting_review",
    });

    const reason = "scope drift; restarting with a tighter brief";
    await recordDecision(sbAdmin, {
      sessionId: session_id,
      type: "kill",
      payload: { type: "kill", reason },
    });

    const { data: session } = await sbAdmin
      .from("sessions")
      .select("status, completed_at, last_error")
      .eq("id", session_id)
      .single();
    expect(session?.status).toBe("killed");
    expect(session?.completed_at).not.toBeNull();
    expect(session?.last_error).not.toBeNull();
    const lastError = session?.last_error as {
      message: string;
      source: string;
      occurred_at: string;
    };
    expect(lastError.message).toBe(reason);
    expect(lastError.source).toBe("operator");
    // Round-trips as a parseable ISO timestamp.
    expect(Number.isNaN(Date.parse(lastError.occurred_at))).toBe(false);
  });

  test("recordDecision throws against a session not in awaiting_review (approve guard)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "done", // already terminal — double-approve guard
    });

    await expect(
      recordDecision(sbAdmin, {
        sessionId: session_id,
        type: "approve",
        payload: { type: "approve" },
      }),
    ).rejects.toThrow(/awaiting_review/);
  });

  // ───────────────────────────────────────────────────────────────────
  // Slice 4 two-phase kill cases (plan §8d). Kill is now valid from
  // idle/running/awaiting_review/blocked with different outcomes:
  //   idle | running             → status='killing'  (transient)
  //   awaiting_review | blocked  → status='killed'   (direct)
  //   killing | done | killed    → throw
  // ───────────────────────────────────────────────────────────────────

  test("kill on idle → status='killing' (transient, live-worker path)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
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

    await recordDecision(sbAdmin, {
      sessionId: session_id,
      type: "kill",
      payload: { type: "kill", reason: "idle session, never started" },
    });

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, completed_at, last_error")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("killing");
    expect(row?.completed_at).toBeNull(); // worker writes completed_at on transitionToKilled
    expect((row?.last_error as { source: string }).source).toBe("operator");
  });

  test("kill on running → status='killing' (transient, live-worker path)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
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

    await recordDecision(sbAdmin, {
      sessionId: session_id,
      type: "kill",
      payload: { type: "kill", reason: "scope drift" },
    });

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, completed_at")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("killing");
    expect(row?.completed_at).toBeNull();
  });

  test("kill on awaiting_review → status='killed' DIRECT (no live worker)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "awaiting_review",
    });

    await recordDecision(sbAdmin, {
      sessionId: session_id,
      type: "kill",
      payload: { type: "kill", reason: "reviewed and rejected" },
    });

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, completed_at, last_error")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("killed");
    expect(row?.completed_at).not.toBeNull(); // direct terminal write
    expect((row?.last_error as { message: string }).message).toBe(
      "reviewed and rejected",
    );
  });

  test("kill on blocked → status='killed' DIRECT (no live worker)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "blocked",
    });

    await recordDecision(sbAdmin, {
      sessionId: session_id,
      type: "kill",
      payload: { type: "kill", reason: "clean up the blocked row" },
    });

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, completed_at")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("killed");
    expect(row?.completed_at).not.toBeNull();
  });

  test("kill on killing → throws (kill already in flight)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
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
      recordDecision(sbAdmin, {
        sessionId: session_id,
        type: "kill",
        payload: { type: "kill", reason: "double-kill" },
      }),
    ).rejects.toThrow(/kill not valid/);
  });

  test("kill on done → throws (terminal)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "done",
    });

    await expect(
      recordDecision(sbAdmin, {
        sessionId: session_id,
        type: "kill",
        payload: { type: "kill", reason: "x" },
      }),
    ).rejects.toThrow(/kill not valid/);
  });

  test("kill on killed → throws (terminal)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { recordDecision } = await import(
      "@/lib/supabase/mutations/decisions"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, {
      project_id,
      status: "killed",
    });

    await expect(
      recordDecision(sbAdmin, {
        sessionId: session_id,
        type: "kill",
        payload: { type: "kill", reason: "x" },
      }),
    ).rejects.toThrow(/kill not valid/);
  });
});
