// Side-effect-only module. Imports of this file load .env.local into
// process.env *before* sibling imports that read it.
//
// ESM hoists imports in the order they appear. Importing this module
// first in seed.ts (or any other CLI entry point) ensures
// `process.env.NEXT_PUBLIC_SUPABASE_URL` etc. are populated by the time
// `lib/supabase/server.ts` is evaluated.
//
// Vitest reuses this same module via `vitest.setup.ts`.

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

config({ path: path.join(repoRoot, ".env.local") });
