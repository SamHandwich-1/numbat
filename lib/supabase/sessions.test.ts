import { afterEach, describe, expect, test } from "vitest";
import { SessionLastError } from "@/lib/types/jsonb";
import type { SessionLastErrorT } from "@/lib/types/jsonb";

const haveCreds =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!haveCreds)("sessions round-trip (live DB)", () => {
  // Track every project this suite inserts so afterEach can wipe them.
  // Project deletion cascades to its sessions (and any llm_calls), so
  // one delete cleans up everything this test created.
  const insertedProjectIds: string[] = [];

  afterEach(async () => {
    if (insertedProjectIds.length === 0) return;
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { error } = await sbAdmin
      .from("projects")
      .delete()
      .in("id", insertedProjectIds);
    if (error) {
      console.error("sessions.test cleanup failed:", error.message);
    }
    insertedProjectIds.length = 0;
  });

  test("insert + query: typed client compiles, last_error survives Zod round-trip", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { insertProjectFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);

    const lastError: SessionLastErrorT = {
      message: "fixture: agent SDK subprocess crashed",
      source: "agent_sdk",
      occurred_at: new Date().toISOString(),
    };
    // Validate before insert (CLAUDE.md "Always" rule on jsonb).
    SessionLastError.parse(lastError);

    const { data: inserted, error: insertError } = await sbAdmin
      .from("sessions")
      .insert({
        project_id,
        slice_name: "fixture-sessions-roundtrip",
        task: "Round-trip a session row.",
        status: "blocked",
        worktree_path: null,
        current_step: null,
        blocking_reason: "fixture",
        spec_id: null,
        agent_session_id: null,
        last_error: lastError,
      })
      .select("*")
      .single();

    expect(insertError).toBeNull();
    expect(inserted).not.toBeNull();
    if (!inserted) throw new Error("inserted session was null");

    // Types compile: these field accesses use the row's typed shape.
    expect(inserted.project_id).toBe(project_id);
    expect(inserted.status).toBe("blocked");
    expect(inserted.last_error).toEqual(lastError);

    // Validate the retrieved last_error through Zod (round-trip integrity).
    const parsed = SessionLastError.parse(inserted.last_error);
    expect(parsed.message).toBe(lastError.message);
    expect(parsed.source).toBe("agent_sdk");

    // Re-query via the typed select path.
    const { data: requeried, error: requeryError } = await sbAdmin
      .from("sessions")
      .select("id, status, last_error")
      .eq("id", inserted.id)
      .single();

    expect(requeryError).toBeNull();
    expect(requeried?.id).toBe(inserted.id);
    expect(requeried?.status).toBe("blocked");
  });
});
