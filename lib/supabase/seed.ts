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

async function main(): Promise<void> {
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

main().catch((err) => {
  console.error("seed: unexpected error", err);
  process.exit(1);
});
