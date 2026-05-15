// Loads .env.local first; must come before any module that reads
// process.env at evaluation time (e.g. lib/supabase/server.ts).
import "@/lib/env";

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sbAdmin } from "@/lib/supabase/server";
import type { ProjectInsert } from "@/lib/types/db";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// Skill seeds per project slug. Slice 3 surfaces these as quick-move
// chips in the Reply composer. Idempotent insert: rows are added only
// if a (project_id, name) pair is not already present, so re-running
// the seed never duplicates or clobbers an existing skill row (and
// preserves any operator-accumulated `usage_count`).
//
// Templates are intentionally generic — they apply to any of the four
// canonical projects (Alice OS, Wedgetail, Bowerbird, Numbat) since
// V1 has no per-project domain context to specialise against.
const SKILL_SEEDS: Record<
  string,
  ReadonlyArray<{ name: string; description: string; prompt_template: string }>
> = {
  "alice-os": [
    {
      name: "Fix one typo",
      description: "Tightly-scoped single-typo fix",
      prompt_template:
        "Fix the single typo I'm pointing to. Don't touch anything else.",
    },
    {
      name: "Tighten copy",
      description: "Cut filler words, keep meaning intact",
      prompt_template:
        "Make this copy more direct. Cut filler words; keep the meaning intact.",
    },
    {
      name: "Extract helper",
      description: "Pull duplicated logic into a single helper",
      prompt_template:
        "Pull this duplicated logic into a single helper and update both call sites.",
    },
    {
      name: "Add Vitest test",
      description: "Write a single test for the function above",
      prompt_template:
        "Write a single Vitest test that exercises the function above. No mocks unless required.",
    },
  ],
  wedgetail: [
    {
      name: "Fix one typo",
      description: "Tightly-scoped single-typo fix",
      prompt_template:
        "Fix the single typo I'm pointing to. Don't touch anything else.",
    },
    {
      name: "Tighten copy",
      description: "Cut filler words, keep meaning intact",
      prompt_template:
        "Make this copy more direct. Cut filler words; keep the meaning intact.",
    },
    {
      name: "Clarify naming",
      description: "Rename for intent, not implementation",
      prompt_template:
        "Rename the identifier I'm pointing to so it describes intent rather than implementation.",
    },
    {
      name: "Add error handling",
      description: "Add a typed error path at the named boundary",
      prompt_template:
        "Add an explicit error path at the boundary I'm pointing to. Typed return over thrown exception per CLAUDE.md.",
    },
  ],
  bowerbird: [
    {
      name: "Fix one typo",
      description: "Tightly-scoped single-typo fix",
      prompt_template:
        "Fix the single typo I'm pointing to. Don't touch anything else.",
    },
    {
      name: "Extract helper",
      description: "Pull duplicated logic into a single helper",
      prompt_template:
        "Pull this duplicated logic into a single helper and update both call sites.",
    },
    {
      name: "Clarify naming",
      description: "Rename for intent, not implementation",
      prompt_template:
        "Rename the identifier I'm pointing to so it describes intent rather than implementation.",
    },
    {
      name: "Add Vitest test",
      description: "Write a single test for the function above",
      prompt_template:
        "Write a single Vitest test that exercises the function above. No mocks unless required.",
    },
  ],
  numbat: [
    {
      name: "Fix one typo",
      description: "Tightly-scoped single-typo fix",
      prompt_template:
        "Fix the single typo I'm pointing to. Don't touch anything else.",
    },
    {
      name: "Tighten copy",
      description: "Cut filler words, keep meaning intact",
      prompt_template:
        "Make this copy more direct. Cut filler words; keep the meaning intact.",
    },
    {
      name: "Add Vitest test",
      description: "Write a single test for the function above",
      prompt_template:
        "Write a single Vitest test that exercises the function above. No mocks unless required.",
    },
    {
      name: "Re-read CLAUDE.md",
      description: "Pull conventions back into the next change",
      prompt_template:
        "Re-read CLAUDE.md, then apply the conventions you previously skipped to the code you just wrote.",
    },
  ],
};

async function seedProjects(): Promise<void> {
  const projectsConfigPath = path.join(repoRoot, "config", "projects.json");
  const raw = readFileSync(projectsConfigPath, "utf8");
  const projects = JSON.parse(raw) as ProjectInsert[];

  // config/projects.json is canonical for repo_path values (forward-slash
  // paths chosen for cross-tool compatibility). No runtime overrides.

  const { data, error } = await sbAdmin
    .from("projects")
    .upsert(projects, { onConflict: "slug" })
    .select("slug, short_code, repo_path");

  if (error) {
    console.error("seed: failed to upsert projects:", error.message);
    process.exit(1);
  }

  console.log(`seed: upserted ${data?.length ?? 0} projects`);
  for (const row of data ?? []) {
    console.log(`  ${row.short_code} → ${row.slug}  (${row.repo_path})`);
  }
}

async function seedSkills(): Promise<void> {
  // Idempotent: for each project, fetch existing skill names, insert
  // only the rows whose names aren't already present. No unique
  // constraint on (project_id, name) — so this select-then-insert
  // dance is the cheapest correct strategy.
  let totalInserted = 0;
  for (const [slug, skills] of Object.entries(SKILL_SEEDS)) {
    const { data: project, error: projErr } = await sbAdmin
      .from("projects")
      .select("id, short_code")
      .eq("slug", slug)
      .maybeSingle();
    if (projErr) {
      console.error(`seed: project lookup ${slug} — ${projErr.message}`);
      process.exit(1);
    }
    if (!project) {
      console.warn(`seed: project ${slug} not found — skipping skills`);
      continue;
    }

    const { data: existing, error: existErr } = await sbAdmin
      .from("skills")
      .select("name")
      .eq("project_id", project.id);
    if (existErr) {
      console.error(
        `seed: skills lookup ${slug} — ${existErr.message}`,
      );
      process.exit(1);
    }
    const existingNames = new Set((existing ?? []).map((s) => s.name));
    const toInsert = skills.filter((s) => !existingNames.has(s.name));

    if (toInsert.length === 0) {
      console.log(`seed: skills for ${project.short_code} already present`);
      continue;
    }

    const rows = toInsert.map((s) => ({
      project_id: project.id,
      name: s.name,
      description: s.description,
      prompt_template: s.prompt_template,
    }));
    const { error: insErr } = await sbAdmin.from("skills").insert(rows);
    if (insErr) {
      console.error(
        `seed: insert skills ${slug} — ${insErr.message}`,
      );
      process.exit(1);
    }
    totalInserted += rows.length;
    console.log(
      `seed: inserted ${rows.length} skills for ${project.short_code}`,
    );
  }
  console.log(`seed: skill rows added: ${totalInserted}`);
}

async function main(): Promise<void> {
  await seedProjects();
  await seedSkills();
}

main().catch((err) => {
  console.error("seed: unexpected error", err);
  process.exit(1);
});
