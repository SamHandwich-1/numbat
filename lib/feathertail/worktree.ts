// lib/feathertail/worktree.ts — worktree lifecycle for Slice 4's
// per-session execution environment.
//
// Conventions:
// - Worktrees live at `<worktreeRoot>/<projectSlug>/<sliceName>/`,
//   where `worktreeRoot` defaults to `~/numbat-worktrees`.
// - Branch name: `numbat/slice/<sliceName>` (Q1, confirmed in plan §9).
//   Slash-namespaced so the source repo's branch list stays legible.
// - Auto-cleanup: opportunistic at the top of every new worker run
//   (no cron infra in V1, per plan §4 + Q6).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/db";
import type { SessionLastErrorT } from "@/lib/types/jsonb";

const execFileP = promisify(execFile);

const KILLING_WATCHDOG_MS = 5 * 60 * 1000;        // 5 minutes
const WORKTREE_CLEANUP_MS = 24 * 60 * 60 * 1000;  // 24 hours

/**
 * Default worktree root: `~/numbat-worktrees`. Exposed so tests can
 * pass a temp dir as `worktreeRoot` instead of mutating the operator's
 * real worktree base.
 */
export function defaultWorktreeRoot(): string {
  return path.join(os.homedir(), "numbat-worktrees");
}

/**
 * Path to the per-worker log file for a worktree.
 *
 * Lives SIBLING to the worktree directory, not inside it. If the log
 * file lived inside the worktree it would appear in the agent's
 * `git status --porcelain -uall` as an untracked file and contaminate
 * the captured diff (manual-run #1 defect). Sibling placement means
 * git never sees it.
 *
 * Format: `<worktreePath>.log`. Example:
 *   worktreePath = ~/numbat-worktrees/numbat/fix-typo-a1b2c3
 *   log path     = ~/numbat-worktrees/numbat/fix-typo-a1b2c3.log
 *
 * Single source of truth — both the writer (scripts/session-runner.ts)
 * and the cleanup (cleanupStaleWorktrees below) derive the log path
 * from this helper. Keeping them paired prevents the "writer moved,
 * cleanup didn't" failure mode that orphans logs forever.
 */
export function workerLogPathFor(worktreePath: string): string {
  return path.join(
    path.dirname(worktreePath),
    `${path.basename(worktreePath)}.log`,
  );
}

/**
 * Pre-flight runtime check. Asserts the source repo path exists, is a
 * git repository, and has at least one commit. Mirrors the §0c
 * dev-time check; called by the worker before any worktree creation
 * so a misconfigured project_path produces a clean blocked-state
 * failure rather than a confusing `git worktree add` error.
 */
export async function assertSourceRepoUsable(repoPath: string): Promise<void> {
  try {
    await access(repoPath);
  } catch {
    throw new Error(
      `assertSourceRepoUsable: source repo path does not exist: ${repoPath}`,
    );
  }
  try {
    await execFileP("git", ["rev-parse", "--git-dir"], { cwd: repoPath });
  } catch {
    throw new Error(
      `assertSourceRepoUsable: path is not a git repository: ${repoPath}`,
    );
  }
  try {
    await execFileP("git", ["rev-parse", "HEAD"], { cwd: repoPath });
  } catch {
    throw new Error(
      `assertSourceRepoUsable: git repo has no HEAD commit: ${repoPath}`,
    );
  }
}

export type CreateWorktreeInput = {
  projectSlug: string;
  sliceName: string;
  sourceRepoPath: string;
  /** Defaults to `defaultWorktreeRoot()` (~/numbat-worktrees). */
  worktreeRoot?: string;
};

/**
 * Create a new worktree off the source repo's HEAD, on a fresh branch
 * named `numbat/slice/<sliceName>`. Returns the absolute worktree path.
 *
 * Throws on branch collision — if `numbat/slice/<sliceName>` already
 * exists, `git worktree add -b` fails. The worker catches and writes
 * status='blocked'. Covered by the unit test in worktree.test.ts.
 */
export async function createWorktree(
  input: CreateWorktreeInput,
): Promise<string> {
  const { projectSlug, sliceName, sourceRepoPath } = input;
  const worktreeRoot = input.worktreeRoot ?? defaultWorktreeRoot();
  const worktreePath = path.join(worktreeRoot, projectSlug, sliceName);

  // Ensure parent (~/numbat-worktrees/<slug>/) exists; git worktree add
  // creates the leaf directory itself.
  await mkdir(path.dirname(worktreePath), { recursive: true });

  const branchName = `numbat/slice/${sliceName}`;
  await execFileP(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, "HEAD"],
    { cwd: sourceRepoPath },
  );

  return worktreePath;
}

/**
 * Opportunistic cleanup of stale worktrees and their sibling log files.
 *
 * Runs at the top of every new worker invocation. Targets sessions
 * that are terminal (done/killed) and have a `worktree_path` set and
 * have been completed > 24h ago. For each:
 *   1. `git worktree remove --force <path>` from the source repo.
 *   2. `git branch -D numbat/slice/<sliceName>` (best-effort).
 *   3. unlink the per-worker log file at `workerLogPathFor(worktreePath)`
 *      — SIBLING to the worktree (e.g. `<worktreePath>.log`), not
 *      inside it (best-effort — file may have been manually removed).
 *   4. Clear sessions.worktree_path to mark the cleanup done.
 *
 * Returns the count of sessions whose worktrees were processed
 * (regardless of whether each individual cleanup step succeeded).
 */
export async function cleanupStaleWorktrees(
  db: SupabaseClient<Database>,
): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - WORKTREE_CLEANUP_MS).toISOString();
  type StaleRow = {
    id: string;
    slice_name: string;
    worktree_path: string | null;
    projects: { repo_path: string };
  };

  // Two cohorts swept on different age columns. See
  // docs/decisions/0007-completed-at-semantics.md for the rationale —
  // we deliberately did not widen completed_at's meaning to cover
  // 'blocked', so blocked rows are aged on updated_at instead.
  //
  //   - done / killed  → completed_at < cutoff
  //     (set by transitionToKilled / transitionToKilledDirectly /
  //      recordDecision's approve path)
  //   - blocked        → updated_at < cutoff
  //     (transitionToBlocked sets updated_at; completed_at stays null)
  //
  // Two PostgREST queries instead of one nested-OR for readability.
  // The sessions table is small (single-operator) so cost is negligible.
  const responseTerminal = await db
    .from("sessions")
    .select("id, slice_name, worktree_path, projects!inner(repo_path)")
    .in("status", ["done", "killed"])
    .not("worktree_path", "is", null)
    .lt("completed_at", cutoff);
  if (responseTerminal.error) {
    throw new Error(
      `cleanupStaleWorktrees: terminal cohort — ${responseTerminal.error.message}`,
    );
  }

  const responseBlocked = await db
    .from("sessions")
    .select("id, slice_name, worktree_path, projects!inner(repo_path)")
    .eq("status", "blocked")
    .not("worktree_path", "is", null)
    .lt("updated_at", cutoff);
  if (responseBlocked.error) {
    throw new Error(
      `cleanupStaleWorktrees: blocked cohort — ${responseBlocked.error.message}`,
    );
  }

  const rows: StaleRow[] = [
    ...((responseTerminal.data ?? []) as unknown as StaleRow[]),
    ...((responseBlocked.data ?? []) as unknown as StaleRow[]),
  ];

  let removed = 0;
  for (const row of rows) {
    const worktreePath = row.worktree_path;
    const repoPath = row.projects?.repo_path;
    if (!worktreePath || !repoPath) continue;

    // 1. `git worktree remove --force <path>` — operates on the worktree
    //    by absolute path; works regardless of cwd, but pass cwd=repoPath
    //    for consistency with the source-repo context.
    await execFileP(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      { cwd: repoPath },
    ).catch((err: unknown) => {
      // Best-effort: the worktree may have been manually deleted, or
      // never created (race with crash). Continue.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`cleanupStaleWorktrees: remove ${worktreePath} — ${msg}`);
    });

    // 2. `git branch -D numbat/slice/<sliceName>` — best-effort, the
    //    branch may already be gone (operator cleanup, or `worktree
    //    remove` already deleted it).
    await execFileP(
      "git",
      ["branch", "-D", `numbat/slice/${row.slice_name}`],
      { cwd: repoPath },
    ).catch(() => {
      /* fail open */
    });

    // 3. unlink the per-worker log file. Lives SIBLING to the worktree
    //    (see workerLogPathFor docblock). For pre-fix legacy worktrees
    //    the log was inside the worktree dir — those are cleaned by the
    //    `git worktree remove --force` above which deletes the whole
    //    directory. New worktrees have the log here, sibling.
    await unlink(workerLogPathFor(worktreePath)).catch(() => {
      /* fail open — log may be gone or never existed */
    });

    // 4. Clear worktree_path so this row doesn't reappear in the next
    //    cleanup pass.
    await db
      .from("sessions")
      .update({ worktree_path: null })
      .eq("id", row.id);

    removed++;
  }

  return { removed };
}

/**
 * Watchdog for the two-phase kill state machine.
 *
 * Sweeps sessions stuck in `killing` for > 5 minutes — the worker may
 * have crashed during teardown, or the realtime kill event never
 * arrived. Writes terminal `killed` state with a synthesised
 * last_error of source='watchdog' (the additive enum value added in
 * Slice 4, see lib/types/jsonb.ts).
 *
 * Runs opportunistically at the top of every new worker invocation,
 * alongside cleanupStaleWorktrees.
 */
export async function reapStaleKillingSessions(
  db: SupabaseClient<Database>,
): Promise<{ reaped: number }> {
  const cutoff = new Date(Date.now() - KILLING_WATCHDOG_MS).toISOString();
  const { data, error } = await db
    .from("sessions")
    .select("id")
    .eq("status", "killing")
    .lt("updated_at", cutoff);
  if (error) {
    throw new Error(`reapStaleKillingSessions: query — ${error.message}`);
  }

  let reaped = 0;
  for (const row of data ?? []) {
    const nowIso = new Date().toISOString();
    const lastError: SessionLastErrorT = {
      message: "kill watchdog timeout — SDK teardown not confirmed",
      source: "watchdog",
      occurred_at: nowIso,
    };
    const { error: updErr } = await db
      .from("sessions")
      .update({
        status: "killed",
        completed_at: nowIso,
        updated_at: nowIso,
        last_error: lastError,
      })
      .eq("id", row.id)
      .eq("status", "killing"); // guard against race: don't overwrite if worker won

    if (updErr) {
      console.error(
        `reapStaleKillingSessions: update ${row.id} — ${updErr.message}`,
      );
      continue;
    }
    reaped++;
  }

  return { reaped };
}
