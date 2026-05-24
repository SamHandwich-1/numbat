import { sbAdmin } from "@/lib/supabase/server";
import { melbourneTodayStartUtcIso } from "@/lib/time/melbourne";
import type { Project, Session } from "@/lib/types/db";
import type { SessionFilters } from "@/lib/types/ui";

// Embedded-join shape returned by listSessions's PostgREST query.
// `projects` is the FK target table; `!inner` makes the join non-null.
// Kept local to this file — embedding is a query-time concern, not part
// of the canonical Session row shape in lib/types/db.
type SessionWithProject = Session & { projects: Project };

// Re-export for server callers that prefer the queries-namespace.
// Client components must import directly from @/lib/time/melbourne —
// going through this file pulls lib/supabase/server.ts into the client
// bundle (its runtime browser guard then crashes module load).
export { melbourneTodayStartUtcIso };

/**
 * Sessions filtered + ordered. Splits the embedded `projects` join
 * out so callers receive { sessions: Session[]; projects: Project[] }
 * — the latter deduplicated and limited to projects represented in
 * the result set. Use `listProjects()` for the full project list
 * (e.g., the filter dropdown's options).
 */
export async function listSessions(
  filters: SessionFilters = {},
): Promise<{ sessions: Session[]; projects: Project[] }> {
  let q = sbAdmin
    .from("sessions")
    .select(
      "*, projects!inner(id, slug, name, short_code, repo_path, claude_md, created_at)",
    )
    .order("updated_at", { ascending: false });

  if (filters.status) q = q.eq("status", filters.status);
  if (filters.projectShortCode) {
    q = q.eq("projects.short_code", filters.projectShortCode);
  }
  // Slice 5: default hides dismissed rows. The "show dismissed" toggle
  // lifts the filter entirely (no `IS NOT NULL` — operator wants both
  // dismissed and non-dismissed visible when investigating, per
  // docs/decisions/0009-slice-5-...md Stage 3).
  if (!filters.includeDismissed) {
    q = q.is("dismissed_at", null);
  }

  const { data, error } = await q.returns<SessionWithProject[]>();
  if (error) throw new Error(`listSessions: ${error.message}`);

  const sessions: Session[] = [];
  const projectsById = new Map<string, Project>();
  // Pure-destructure pattern: stripping the embed field via spread
  // narrows the row back to Session without a cast. This is the
  // project's convention for embedded queries — re-use rather than
  // re-cast.
  for (const row of data ?? []) {
    const { projects, ...session } = row;
    sessions.push(session);
    if (!projectsById.has(projects.id)) {
      projectsById.set(projects.id, projects);
    }
  }
  return { sessions, projects: Array.from(projectsById.values()) };
}

/**
 * Single session row by id. Returns null when the row does not exist
 * (the caller can map to notFound() in an RSC). Throws on any other
 * Supabase error — same pattern as listSessions.
 *
 * Uses maybeSingle() rather than single(): a missing row is an
 * expected outcome (operator pastes a stale URL), not a query error.
 */
export async function getSession(id: string): Promise<Session | null> {
  const { data, error } = await sbAdmin
    .from("sessions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getSession: ${error.message}`);
  return data ?? null;
}

/**
 * All projects, sorted by name. Used by ProjectFilter (step 10) to
 * render the dropdown options.
 */
export async function listProjects(): Promise<Project[]> {
  const { data, error } = await sbAdmin
    .from("projects")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(`listProjects: ${error.message}`);
  return data ?? [];
}

/**
 * Sum of cost_usd across llm_calls created since today's local midnight
 * in Melbourne. Empty result returns 0 — llm_calls stays empty until
 * slice 4 produces real session results.
 *
 * cost_usd is numeric(10,6); postgrest delivers it as a string. The
 * conversion to Number happens at this boundary so callers get a real
 * number with sub-cent precision preserved (sub-cent loss across a
 * single day's worth of calls is well below JS Number's mantissa).
 */
export async function getTodayCostUsd(): Promise<number> {
  const startIso = melbourneTodayStartUtcIso();
  const { data, error } = await sbAdmin
    .from("llm_calls")
    .select("cost_usd")
    .gte("created_at", startIso);
  if (error) throw new Error(`getTodayCostUsd: ${error.message}`);
  return (data ?? []).reduce((acc, r) => acc + Number(r.cost_usd), 0);
}
