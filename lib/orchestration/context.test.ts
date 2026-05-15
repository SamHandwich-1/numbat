import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Skill } from "@/lib/types/db";
import {
  ContextLoader,
  ContextLoaderCrossProjectError,
} from "@/lib/orchestration/context";

// Minimal mock supporting the two query shapes ContextLoader uses:
//   1. from(table).select(cols).eq(col, id).single()
//        — assertSessionInProject / assertPlanInProject
//   2. from('skills').select('*').eq('project_id', X).order().order()
//        — listSkillsForProject; chain is thenable (await resolves to
//        { data, error })
function mockClient(
  opts: {
    singles?: Record<string, { project_id: string }>;
    skills?: Skill[];
  } = {},
): SupabaseClient<Database> {
  const singles = opts.singles ?? {};
  const allSkills = opts.skills ?? [];

  // PostgrestFilterBuilder analogue for the skills query — both `eq()`
  // and `order()` return the same chain; `await` is wired via `then`
  // (PromiseLike) so `await q.eq().order().order()` resolves.
  function skillsChain(filterProjectId: string | null) {
    const filtered =
      filterProjectId === null
        ? allSkills
        : allSkills.filter((s) => s.project_id === filterProjectId);
    const chain = {
      eq: (col: string, val: string) =>
        col === "project_id" ? skillsChain(val) : skillsChain(filterProjectId),
      order: (_col: string, _opts?: unknown) => chain,
      then: <T>(onFulfilled: (v: { data: Skill[]; error: null }) => T) =>
        Promise.resolve({ data: filtered, error: null }).then(onFulfilled),
    };
    return chain;
  }

  const from = vi.fn((table: string) => ({
    select: (_cols?: string) => {
      if (table === "skills") return skillsChain(null);
      return {
        eq: (_col: string, id: string) => ({
          single: async () => {
            const row = singles[`${table}:${id}`];
            if (!row) {
              return { data: null, error: { message: "not found" } as const };
            }
            return { data: row, error: null };
          },
        }),
      };
    },
  }));
  return { from } as unknown as SupabaseClient<Database>;
}

const projectA = "00000000-0000-0000-0000-0000000000a1";
const projectB = "00000000-0000-0000-0000-0000000000b1";
const sessionInB = "00000000-0000-0000-0000-000000000111";
const sessionInA = "00000000-0000-0000-0000-000000000112";
const planInB = "00000000-0000-0000-0000-000000000211";

const skillInA: Skill = {
  id: "00000000-0000-0000-0000-000000000301",
  project_id: projectA,
  name: "Fix typo",
  description: null,
  prompt_template: "Fix the typo in the line below.",
  usage_count: 0,
  created_at: "2026-05-14T00:00:00Z",
  updated_at: "2026-05-14T00:00:00Z",
};
const skillInB: Skill = {
  ...skillInA,
  id: "00000000-0000-0000-0000-000000000302",
  project_id: projectB,
  name: "Rename clearly",
};

describe("ContextLoader cross-project enforcement", () => {
  it("throws ContextLoaderCrossProjectError when a session belongs to a different project", async () => {
    const db = mockClient({
      singles: { [`sessions:${sessionInB}`]: { project_id: projectB } },
      // Skills from BOTH projects in the pool — the assertion must
      // throw before the skills load runs, so neither leaks in.
      skills: [skillInA, skillInB],
    });
    const loader = new ContextLoader(db);

    await expect(loader.buildFor(projectA, "session", sessionInB)).rejects.toBeInstanceOf(
      ContextLoaderCrossProjectError,
    );

    try {
      await loader.buildFor(projectA, "session", sessionInB);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ContextLoaderCrossProjectError);
      const err = e as ContextLoaderCrossProjectError;
      expect(err.requestedProjectId).toBe(projectA);
      expect(err.actualProjectId).toBe(projectB);
      expect(err.scope).toBe("session");
      expect(err.secondaryId).toBe(sessionInB);
      expect(err.message).toContain(projectA);
      expect(err.message).toContain(projectB);
    }
  });

  it("throws when a plan belongs to a different project", async () => {
    const db = mockClient({
      singles: { [`plans:${planInB}`]: { project_id: projectB } },
    });
    const loader = new ContextLoader(db);

    await expect(loader.buildFor(projectA, "plan", planInB)).rejects.toBeInstanceOf(
      ContextLoaderCrossProjectError,
    );
  });

  it("returns a SessionContext with the project's skills populated when project matches", async () => {
    const db = mockClient({
      singles: { [`sessions:${sessionInA}`]: { project_id: projectA } },
      skills: [skillInA, skillInB],
    });
    const loader = new ContextLoader(db);
    const ctx = await loader.buildFor(projectA, "session", sessionInA);
    expect(ctx.projectId).toBe(projectA);
    expect(ctx.sessionId).toBe(sessionInA);
    // V1 stub: spec / priorDebrief / specs / recentDecisions are empty.
    expect(ctx.spec).toBeNull();
    expect(ctx.priorDebrief).toBeNull();
    expect(ctx.specs).toEqual([]);
    expect(ctx.recentDecisions).toEqual([]);
    // Slice 3: skills now actually fetched. Only the project-A skill
    // is returned — project-B's skill in the same pool is excluded by
    // the WHERE clause.
    expect(ctx.skills).toHaveLength(1);
    const first = ctx.skills[0];
    expect(first?.name).toBe("Fix typo");
    expect(first?.project_id).toBe(projectA);
  });

  it("returns a typed ProjectContext for the project scope (no secondary id)", async () => {
    const db = mockClient();
    const loader = new ContextLoader(db);
    const ctx = await loader.buildFor(projectA, "project");
    expect(ctx.projectId).toBe(projectA);
    expect(ctx.claudeMd).toBeNull();
    expect(ctx.specs).toEqual([]);
    // Project scope still returns empty skills (Slice 5 fills this in).
    expect(ctx.skills).toEqual([]);
  });
});
