import { afterEach, describe, expect, test } from "vitest";

// Live-DB coverage for cleanupStaleWorktrees. The query is the
// load-bearing piece: it decides which rows get their worktree
// directories removed and their sibling `<sliceName>.log` files
// unlinked (per workerLogPathFor — log lives outside the worktree).
//
// The git/fs side-effects (git worktree remove, fs.unlink) are best-
// effort via .catch(() => {}) in the helper, so we can use fake
// worktree paths in the tests — the cleanup will silently fail on the
// disk side but the row UPDATE (worktree_path → null) still runs.
// That's what these tests assert: the QUERY selected the right rows
// and the row UPDATE actually fired.
//
// See docs/decisions/0007-completed-at-semantics.md for why blocked
// rows are aged on updated_at while done/killed rows are aged on
// completed_at — the asymmetry is deliberate and is tested directly
// in the "blocked → swept via updated_at" and the inverse cases below.

const haveCreds =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PAST_ISO = new Date(Date.now() - 2 * ONE_DAY_MS).toISOString();
const RECENT_ISO = new Date().toISOString();

describe.skipIf(!haveCreds)("cleanupStaleWorktrees (live DB)", () => {
  const insertedProjectIds: string[] = [];

  afterEach(async () => {
    if (insertedProjectIds.length === 0) return;
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { error } = await sbAdmin
      .from("projects")
      .delete()
      .in("id", insertedProjectIds);
    if (error) {
      console.error("cleanup.test cleanup failed:", error.message);
    }
    insertedProjectIds.length = 0;
  });

  // ───────────────────────────────────────────────────────────────────
  // Cohort 1: done / killed — aged on completed_at.
  // ───────────────────────────────────────────────────────────────────

  test("sweeps a 'done' session whose completed_at is older than the cutoff", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { cleanupStaleWorktrees } = await import(
      "@/lib/feathertail/worktree"
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
    // Age the row + give it a worktree_path (test-fixtures inserts
    // null by default).
    await sbAdmin
      .from("sessions")
      .update({
        worktree_path: "/fake/path/that/cleanup-fail-silent",
        completed_at: PAST_ISO,
        updated_at: PAST_ISO,
      })
      .eq("id", session_id);

    await cleanupStaleWorktrees(sbAdmin);

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("worktree_path")
      .eq("id", session_id)
      .single();
    expect(row?.worktree_path).toBeNull(); // cleanup cleared it
  });

  test("sweeps a 'killed' session whose completed_at is older than the cutoff", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { cleanupStaleWorktrees } = await import(
      "@/lib/feathertail/worktree"
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
    await sbAdmin
      .from("sessions")
      .update({
        worktree_path: "/fake/path/killed-fixture",
        completed_at: PAST_ISO,
        updated_at: PAST_ISO,
      })
      .eq("id", session_id);

    await cleanupStaleWorktrees(sbAdmin);

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("worktree_path")
      .eq("id", session_id)
      .single();
    expect(row?.worktree_path).toBeNull();
  });

  test("does NOT sweep a 'done' session whose completed_at is recent (within cutoff)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { cleanupStaleWorktrees } = await import(
      "@/lib/feathertail/worktree"
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
    await sbAdmin
      .from("sessions")
      .update({
        worktree_path: "/fake/path/recent-done",
        completed_at: RECENT_ISO,
        updated_at: RECENT_ISO,
      })
      .eq("id", session_id);

    await cleanupStaleWorktrees(sbAdmin);

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("worktree_path")
      .eq("id", session_id)
      .single();
    expect(row?.worktree_path).toBe("/fake/path/recent-done");
  });

  // ───────────────────────────────────────────────────────────────────
  // Cohort 2: blocked — aged on updated_at (NOT completed_at).
  // This is the asymmetry the decisions log 0007 entry locks in.
  // ───────────────────────────────────────────────────────────────────

  test("sweeps a 'blocked' session whose updated_at is older than the cutoff (completed_at NULL)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { cleanupStaleWorktrees } = await import(
      "@/lib/feathertail/worktree"
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
    // Critical: completed_at is NOT set. transitionToBlocked leaves
    // it null; the cleanup must rely on updated_at for this cohort.
    await sbAdmin
      .from("sessions")
      .update({
        worktree_path: "/fake/path/blocked-stale",
        updated_at: PAST_ISO,
        // completed_at deliberately not set — stays null
      })
      .eq("id", session_id);

    await cleanupStaleWorktrees(sbAdmin);

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("worktree_path, completed_at")
      .eq("id", session_id)
      .single();
    expect(row?.worktree_path).toBeNull();
    // completed_at should still be null — the cleanup mutation only
    // clears worktree_path, doesn't backfill completed_at.
    expect(row?.completed_at).toBeNull();
  });

  test("does NOT sweep a 'blocked' session whose updated_at is recent", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { cleanupStaleWorktrees } = await import(
      "@/lib/feathertail/worktree"
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
    await sbAdmin
      .from("sessions")
      .update({
        worktree_path: "/fake/path/blocked-recent",
        updated_at: RECENT_ISO,
      })
      .eq("id", session_id);

    await cleanupStaleWorktrees(sbAdmin);

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("worktree_path")
      .eq("id", session_id)
      .single();
    expect(row?.worktree_path).toBe("/fake/path/blocked-recent");
  });

  test("does NOT sweep a 'blocked' session whose worktree_path is NULL (pre-SDK blocked path)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { cleanupStaleWorktrees } = await import(
      "@/lib/feathertail/worktree"
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
    await sbAdmin
      .from("sessions")
      .update({
        // worktree_path stays null — represents the pre-SDK fault
        // path (assertSourceRepoUsable or createWorktree itself
        // failed, no disk artifact was ever created).
        updated_at: PAST_ISO,
      })
      .eq("id", session_id);

    const { removed } = await cleanupStaleWorktrees(sbAdmin);

    // Worktree_path stayed null — the cleanup didn't touch this row.
    // (removed count comes from the OTHER fixtures in the suite or 0
    // depending on parallelism; what matters is that this specific row
    // is unaffected.)
    void removed;
    const { data: row } = await sbAdmin
      .from("sessions")
      .select("status, worktree_path")
      .eq("id", session_id)
      .single();
    expect(row?.status).toBe("blocked");
    expect(row?.worktree_path).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────
  // Negative: non-terminal states never get swept, even with old
  // timestamps on either column.
  // ───────────────────────────────────────────────────────────────────

  test("does NOT sweep an 'awaiting_review' session even with old completed_at AND updated_at", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { cleanupStaleWorktrees } = await import(
      "@/lib/feathertail/worktree"
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
    await sbAdmin
      .from("sessions")
      .update({
        worktree_path: "/fake/path/awaiting-review",
        completed_at: PAST_ISO,
        updated_at: PAST_ISO,
      })
      .eq("id", session_id);

    await cleanupStaleWorktrees(sbAdmin);

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("worktree_path")
      .eq("id", session_id)
      .single();
    expect(row?.worktree_path).toBe("/fake/path/awaiting-review");
  });

  test("does NOT sweep a 'running' session with old timestamps (worker still owns it)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { cleanupStaleWorktrees } = await import(
      "@/lib/feathertail/worktree"
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
    await sbAdmin
      .from("sessions")
      .update({
        worktree_path: "/fake/path/running",
        updated_at: PAST_ISO,
      })
      .eq("id", session_id);

    await cleanupStaleWorktrees(sbAdmin);

    const { data: row } = await sbAdmin
      .from("sessions")
      .select("worktree_path")
      .eq("id", session_id)
      .single();
    expect(row?.worktree_path).toBe("/fake/path/running");
  });
});
