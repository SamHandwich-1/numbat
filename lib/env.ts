// Side-effect-only loader + validated env export. Imports of this file
// load .env.local into process.env *before* sibling imports that read it.
//
// ESM hoists imports in the order they appear. Importing this module
// first in seed.ts (or any other CLI entry point) ensures
// `process.env.NEXT_PUBLIC_SUPABASE_URL` etc. are populated by the time
// `lib/supabase/server.ts` is evaluated.
//
// Vitest reuses this same module via `vitest.setup.ts`.
//
// The `env` export below adds zod validation on top of the dotenv load.
// Module load crashes if any required var is missing or malformed —
// preferred over silent degradation at request time. Existing
// process.env.X reads in lib/supabase/* keep working unchanged; the
// zod parse is the single bottleneck that establishes the invariants.
// New code (slice 2b+ middleware, route handlers) should import `env`
// rather than reading process.env directly.

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

config({ path: path.join(repoRoot, ".env.local") });

const EnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  NUMBAT_AUTH_TOKEN: z.string().min(16),
});

export const env = EnvSchema.parse(process.env);
