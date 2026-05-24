import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, SessionStatus } from "@/lib/types/db";

// Fixtures take the db client as their first arg (rather than importing
// the singleton) so the test files can stay decoupled from env loading
// and skip cleanly when credentials are missing.

export async function insertProjectFixture(
  db: SupabaseClient<Database>,
  overrides: Partial<{
    slug: string;
    name: string;
    short_code: string;
    repo_path: string;
    chip_bg: string;
    chip_fg: string;
  }> = {},
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const { data, error } = await db
    .from("projects")
    .insert({
      slug: overrides.slug ?? `fixture-${suffix}`,
      name: overrides.name ?? `Fixture ${suffix}`,
      short_code: overrides.short_code ?? "FX",
      repo_path: overrides.repo_path ?? `/fixtures/${suffix}`,
      claude_md: null,
      // Placeholder greys — these rows aren't part of the V1 project
      // set; matches the migration 0003 fallback for non-canonical rows.
      chip_bg: overrides.chip_bg ?? "#333333",
      chip_fg: overrides.chip_fg ?? "#999999",
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertProjectFixture: ${error.message}`);
  if (!data) throw new Error("insertProjectFixture: no data returned");
  return data.id;
}

export async function insertSessionFixture(
  db: SupabaseClient<Database>,
  args: { project_id: string } & Partial<{
    slice_name: string;
    task: string;
    status: SessionStatus;
    dismissed_at: string | null;
  }>,
): Promise<string> {
  const { data, error } = await db
    .from("sessions")
    .insert({
      project_id: args.project_id,
      slice_name: args.slice_name ?? "fixture-slice",
      task: args.task ?? "fixture task",
      status: args.status ?? "running",
      worktree_path: null,
      current_step: null,
      blocking_reason: null,
      spec_id: null,
      agent_session_id: null,
      last_error: null,
      dismissed_at: args.dismissed_at ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertSessionFixture: ${error.message}`);
  if (!data) throw new Error("insertSessionFixture: no data returned");
  return data.id;
}
