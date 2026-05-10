// Slice 2a — seed plausible mock sessions across the four projects.
// Idempotent: before inserting, deletes rows where slice_name LIKE 'mock-%'
// (this script's prior outputs) or LIKE 'fixture-%' (slice 1 test crud).
// Re-running wipes only those; real sessions (slice 4+) won't match.
//
// Mock session #10 ("ship slice 2a (this!)") is a self-referential seed
// used during 2a development. Delete this row from the array once 2a
// ships and the self-reference is no longer accurate.
//
// Run via: pnpm db:seed:sessions

// Loads .env.local first; must come before any module that reads
// process.env at evaluation time (e.g. lib/supabase/server.ts).
import "@/lib/env";

import { sbAdmin } from "@/lib/supabase/server";
import type { SessionInsert, SessionStatus } from "@/lib/types/db";
import { SessionLastError, type SessionLastErrorT } from "@/lib/types/jsonb";
import type { ProjectShortCode } from "@/lib/types/ui";

const MARKER_PREFIX = "mock-";

// ────────────────────────────────────────────────────────────────────
// Timestamp helpers — produce a staggered set of updated_at values so
// the cards don't all timestamp-cluster. All values are in the past
// relative to script run time.
// ────────────────────────────────────────────────────────────────────
const now = Date.now();
const minutesAgo = (m: number): string =>
  new Date(now - m * 60_000).toISOString();
const hoursAgo = (h: number): string =>
  new Date(now - h * 3_600_000).toISOString();
const daysAgo = (d: number): string =>
  new Date(now - d * 86_400_000).toISOString();

// ────────────────────────────────────────────────────────────────────
// last_error JSONB for the two rows that have it. Validated through
// SessionLastError.parse() per CLAUDE.md "validate jsonb fields with
// Zod before insert". Throws synchronously if the shape drifts.
// ────────────────────────────────────────────────────────────────────
const blockedError: SessionLastErrorT = SessionLastError.parse({
  source: "agent_sdk",
  message:
    "Heuristic produced negative implied volatility on AAPL — needs human review",
  occurred_at: minutesAgo(8),
});

const killedError: SessionLastErrorT = SessionLastError.parse({
  source: "worker",
  message: "Graph render exceeded 30s budget; killed by user before retry",
  occurred_at: hoursAgo(4),
});

// ────────────────────────────────────────────────────────────────────
// The 12 mock rows. Order matches plan §7. Project lookup happens at
// runtime so the script doesn't bake project UUIDs.
// ────────────────────────────────────────────────────────────────────
type MockRow = {
  short_code: ProjectShortCode;
  slice_name: string;
  task: string;
  status: SessionStatus;
  updated_at: string;
  last_error?: SessionLastErrorT;
  completed_at?: string;
};

const MOCKS: readonly MockRow[] = [
  // AO — alice-os
  {
    short_code: "AO",
    slice_name: "mock-spirit-board-ui",
    task: "ship the spirit board UI",
    status: "running",
    updated_at: minutesAgo(0.5), // ~30s ago
  },
  {
    short_code: "AO",
    slice_name: "mock-debrief-pane",
    task: "build the debrief pane component",
    status: "awaiting_review",
    updated_at: minutesAgo(5),
  },
  {
    short_code: "AO",
    slice_name: "mock-router-rules",
    task: "draft the rules-based router",
    status: "idle",
    updated_at: hoursAgo(1),
  },
  // WT — wedgetail
  {
    short_code: "WT",
    slice_name: "mock-valuation-tweaks",
    task: "tweak the valuation heuristics",
    status: "blocked",
    updated_at: minutesAgo(8),
    last_error: blockedError,
  },
  {
    short_code: "WT",
    slice_name: "mock-csv-import",
    task: "land the CSV import path",
    status: "running",
    updated_at: minutesAgo(0.25), // ~15s ago
  },
  {
    short_code: "WT",
    slice_name: "mock-domain-rebrand",
    task: "rebrand domain.com.au copy",
    status: "done",
    updated_at: hoursAgo(2),
    completed_at: hoursAgo(2),
  },
  // BB — bowerbird
  {
    short_code: "BB",
    slice_name: "mock-spending-rollups",
    task: "wire monthly spending rollups",
    status: "awaiting_review",
    updated_at: minutesAgo(12),
  },
  {
    short_code: "BB",
    slice_name: "mock-allocation-spec",
    task: "spec the allocation engine",
    status: "planning",
    updated_at: minutesAgo(25),
  },
  {
    short_code: "BB",
    slice_name: "mock-broken-graph",
    task: "drop the broken graph view",
    status: "killed",
    updated_at: hoursAgo(4),
    last_error: killedError,
  },
  // NB — numbat
  {
    short_code: "NB",
    slice_name: "mock-sessions-surface",
    task: "ship slice 2a (this!)",
    status: "running",
    updated_at: minutesAgo(1),
  },
  {
    short_code: "NB",
    slice_name: "mock-bilby-prompts",
    task: "draft Bilby's first prompts",
    status: "idle",
    updated_at: hoursAgo(3),
  },
  {
    short_code: "NB",
    slice_name: "mock-schema-migration",
    task: "land slice 1 migration",
    status: "done",
    updated_at: daysAgo(1),
    completed_at: daysAgo(1),
  },
];

async function main(): Promise<void> {
  // 1. Look up project IDs by short_code.
  const { data: projects, error: lookupError } = await sbAdmin
    .from("projects")
    .select("id, short_code");
  if (lookupError) {
    console.error(
      "seed-mock-sessions: failed to look up projects:",
      lookupError.message,
    );
    process.exit(1);
  }
  const projectIdByShortCode = new Map<string, string>();
  for (const p of projects ?? []) {
    projectIdByShortCode.set(p.short_code, p.id);
  }
  for (const code of ["AO", "WT", "BB", "NB"] as const) {
    if (!projectIdByShortCode.has(code)) {
      console.error(
        `seed-mock-sessions: project ${code} not found. Run 'pnpm db:seed' first.`,
      );
      process.exit(1);
    }
  }

  // 2. Wipe existing mock rows AND any leftover fixture rows from slice 1's
  //    tests. Both prefixes are isolated from real sessions — slice 4+
  //    won't use 'mock-' or 'fixture-' slice names.
  //
  //    Two-step because llm_calls.session_id is not ON DELETE CASCADE:
  //    find the doomed session IDs first, wipe their dependent llm_calls,
  //    then wipe the sessions themselves.
  const wipeFilter = `slice_name.like.${MARKER_PREFIX}%,slice_name.like.fixture-%`;
  const { data: doomed, error: findError } = await sbAdmin
    .from("sessions")
    .select("id")
    .or(wipeFilter);
  if (findError) {
    console.error(
      "seed-mock-sessions: failed to enumerate doomed sessions:",
      findError.message,
    );
    process.exit(1);
  }
  const doomedIds = (doomed ?? []).map((r) => r.id);
  if (doomedIds.length > 0) {
    const { error: deleteLlmError } = await sbAdmin
      .from("llm_calls")
      .delete()
      .in("session_id", doomedIds);
    if (deleteLlmError) {
      console.error(
        "seed-mock-sessions: failed to delete dependent llm_calls:",
        deleteLlmError.message,
      );
      process.exit(1);
    }
  }
  const { error: deleteError } = await sbAdmin
    .from("sessions")
    .delete()
    .or(wipeFilter);
  if (deleteError) {
    console.error(
      "seed-mock-sessions: failed to delete previous mocks:",
      deleteError.message,
    );
    process.exit(1);
  }

  // 3. Build inserts.
  const rows: SessionInsert[] = MOCKS.map((m) => {
    const project_id = projectIdByShortCode.get(m.short_code);
    if (!project_id) {
      throw new Error(`seed-mock-sessions: missing project ${m.short_code}`);
    }
    return {
      project_id,
      slice_name: m.slice_name,
      task: m.task,
      status: m.status,
      worktree_path: null,
      current_step: null,
      blocking_reason: null,
      spec_id: null,
      agent_session_id: null,
      last_error: m.last_error ?? null,
      updated_at: m.updated_at,
      completed_at: m.completed_at ?? null,
    };
  });

  // 4. Bulk insert.
  const { data: inserted, error: insertError } = await sbAdmin
    .from("sessions")
    .insert(rows)
    .select("id, slice_name, status");
  if (insertError) {
    console.error(
      "seed-mock-sessions: insert failed:",
      insertError.message,
    );
    process.exit(1);
  }

  console.log(
    `seed-mock-sessions: inserted ${inserted?.length ?? 0} mock sessions`,
  );
  for (const row of inserted ?? []) {
    console.log(`  ${row.status.padEnd(15)} ${row.slice_name}`);
  }
}

main().catch((err) => {
  console.error("seed-mock-sessions: unexpected error", err);
  process.exit(1);
});
