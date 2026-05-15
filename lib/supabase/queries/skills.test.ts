import { afterEach, describe, expect, test } from "vitest";

// Live-DB. Skip cleanly when env vars are missing so `pnpm test` stays
// green offline. Mirrors the llm-calls.test.ts skip pattern.
const haveCreds =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!haveCreds)("listSkillsForProject (live DB)", () => {
  // Project deletes cascade to skills (FK ON DELETE CASCADE), so wiping
  // these project rows after each test cleans up the whole tree.
  const insertedProjectIds: string[] = [];

  afterEach(async () => {
    if (insertedProjectIds.length === 0) return;
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { error } = await sbAdmin
      .from("projects")
      .delete()
      .in("id", insertedProjectIds);
    if (error) {
      console.error("skills.test cleanup failed:", error.message);
    }
    insertedProjectIds.length = 0;
  });

  test("returns only the rows belonging to the requested project_id", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { insertProjectFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );
    const { listSkillsForProject } = await import(
      "@/lib/supabase/queries/skills"
    );

    const projectA = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(projectA);
    const projectB = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(projectB);

    const { error: insertError } = await sbAdmin.from("skills").insert([
      {
        project_id: projectA,
        name: "Skill A",
        description: null,
        prompt_template: "template A",
      },
      {
        project_id: projectB,
        name: "Skill B",
        description: null,
        prompt_template: "template B",
      },
    ]);
    expect(insertError).toBeNull();

    const skillsA = await listSkillsForProject(sbAdmin, projectA);
    const skillsB = await listSkillsForProject(sbAdmin, projectB);

    expect(skillsA).toHaveLength(1);
    const a = skillsA[0];
    expect(a?.name).toBe("Skill A");
    expect(a?.project_id).toBe(projectA);

    expect(skillsB).toHaveLength(1);
    const b = skillsB[0];
    expect(b?.name).toBe("Skill B");
    expect(b?.project_id).toBe(projectB);
  });

  test("returns empty array for an unknown project_id (not an error)", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { listSkillsForProject } = await import(
      "@/lib/supabase/queries/skills"
    );
    // A valid uuid that does not exist in projects. No FK violation
    // because we are reading, not writing.
    const skills = await listSkillsForProject(
      sbAdmin,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(skills).toEqual([]);
  });

  test("orders by usage_count desc, name asc", async () => {
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { insertProjectFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );
    const { listSkillsForProject } = await import(
      "@/lib/supabase/queries/skills"
    );

    const projectId = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(projectId);

    const { error } = await sbAdmin.from("skills").insert([
      // Same usage_count, different names — tie-breaks on name asc.
      {
        project_id: projectId,
        name: "Bravo",
        description: null,
        prompt_template: "b",
        usage_count: 0,
      },
      {
        project_id: projectId,
        name: "Alpha",
        description: null,
        prompt_template: "a",
        usage_count: 0,
      },
      {
        project_id: projectId,
        name: "Charlie",
        description: null,
        prompt_template: "c",
        usage_count: 5,
      },
    ]);
    expect(error).toBeNull();

    const skills = await listSkillsForProject(sbAdmin, projectId);
    expect(skills.map((s) => s.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
  });
});
