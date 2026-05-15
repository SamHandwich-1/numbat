import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Skill } from "@/lib/types/db";

/**
 * All skills for a single project, ordered by `usage_count` desc then
 * `name` asc. The Reply composer's quick-move chips render from this
 * list — most-used surfaces first, name as the tie-breaker.
 *
 * Takes the db client as an argument (rather than importing sbAdmin)
 * so callers can pass either the service-role client (server code) or
 * an injected mock (tests). Mirrors the test-fixtures.ts pattern.
 *
 * Project scoping: parameterised on `projectId`. Callers must obtain
 * the right project_id via ContextLoader, which is the single gate
 * that enforces (sessionId, projectId) alignment. This query alone
 * cannot leak across projects by construction.
 */
export async function listSkillsForProject(
  db: SupabaseClient<Database>,
  projectId: string,
): Promise<Skill[]> {
  const { data, error } = await db
    .from("skills")
    .select("*")
    .eq("project_id", projectId)
    .order("usage_count", { ascending: false })
    .order("name", { ascending: true });
  if (error) throw new Error(`listSkillsForProject: ${error.message}`);
  return data ?? [];
}
