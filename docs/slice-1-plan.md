# Slice 1 Plan — Schema + data layer

> **Status:** awaiting user review. No code written yet. Same gate as Slice 0:
> the user reviews this plan, signs off (or redirects), then implementation begins.
> **Source of truth:** `docs/numbat-brief-final.md` §7 (post Slice 0 edits) and §11 Slice 1 acceptance.
> **Prior-art:** `docs/sdk-spike.md` (the spike memo justifying the §7 column shape).

## Context

Slice 1 lays the foundation every later slice consumes: the Supabase
schema, the typed client, Zod validators for every `jsonb` field, the
`ContextLoader` skeleton, and the four-project seed. No UI, no Agent SDK
wiring yet — Slices 2 and 4 build on top of this.

Two things from the spike memo are now load-bearing in this slice:
1. The `llm_calls` columns landed in the brief (input/output/cache/cost_usd)
   need to flow through the migration, types, and Zod validators
   identically — no drift.
2. The fan-out rule (one `llm_calls` row per (session, model)) is enforced
   by a real test, not just a comment in the SQL file.

## Scope

**In:**
- Root scaffolding for the Numbat repo: `package.json`, `tsconfig.json`, `.env.local.example`.
- Single-file migration (`lib/supabase/migrations/0001_initial.sql`) covering all eight tables from brief §7.
- Supabase clients: anon (browser-safe) and service-role (server-only).
- Hand-written TypeScript types for every table (`lib/types/db.ts`).
- Zod schemas for every `jsonb` column, with explicit field shapes — no `z.unknown()`.
- `ContextLoader` skeleton in `lib/orchestration/context.ts`: class shape, project_id enforcement, cross-project read throw, typed stubs for `buildFor(projectId, scope)`.
- `config/projects.json` with four seed projects (DS, MH, AL, NB).
- `lib/supabase/seed.ts` — reads `config/projects.json` and inserts via service-role client.
- Vitest set up (brief §12 commits to vitest for unit tests).
- Three tests, all colocated next to source:
  - `lib/orchestration/context.test.ts` — cross-project read throws.
  - `lib/supabase/llm-calls.test.ts` — fan-out round-trip (see specifics §1).
  - `lib/supabase/sessions.test.ts` — round-trip a session insert + typed query.
- `pnpm db:push` and `pnpm db:seed` scripts that run against a real Postgres.

**Out (deferred):**
- Any Next.js app code (`app/`, `components/`). Slice 2 owns the first UI.
- The actual ContextLoader implementation (loading CLAUDE.md, specs, decisions). Stubs only.
- Realtime subscription wiring on the client. Slice 2 turns it on for the Sessions surface.
- Auth gate logic. `NUMBAT_AUTH_TOKEN` lands in `.env.local.example` but isn't checked anywhere yet.
- Agent SDK integration. Slice 4.
- Bilby prompts and AI-SDK provider wiring. Slice 5–6.
- ESLint config tuning. A minimal `.eslintrc` is fine; the first real lint errors will emerge in Slice 2.
- Generated types via `supabase gen types typescript`. Hand-written types are V1; we'll switch to generated when we have a stable cloud project to point at.

**Non-goals:**
- Performance tuning. Indexes follow the brief; no extras invented.
- RLS. Brief §6 says "RLS off in V1; single-user." Migration sets `enable_row_level_security = off` (or simply doesn't enable it).
- Multi-environment migration management. One file, one push.

## Files to create

Listed in build order:

| # | Path | Notes |
|---|---|---|
| 1 | `package.json` | Root scripts: `db:push`, `db:seed`, `typecheck`, `test`, `test:watch`, `lint` (placeholder). Deps: `@supabase/supabase-js`, `zod`, `dotenv`. Dev: `typescript`, `tsx`, `vitest`, `@types/node`, `supabase` (CLI). |
| 2 | `tsconfig.json` | Strict mode, `paths: { "@/*": ["./*"] }`, ESNext modules. |
| 3 | `.env.local.example` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NUMBAT_AUTH_TOKEN`, `ANTHROPIC_API_KEY` (optional override; SDK uses ~/.claude creds by default). `NEXT_PUBLIC_` prefix on URL + anon key per Next.js convention — safe to expose, RLS protects the anon key. Service-role key has no prefix and stays server-only. |
| 4 | `lib/supabase/migrations/0001_initial.sql` | All 8 tables from brief §7 + indexes. Single canonical file. |
| 5 | `lib/types/jsonb.ts` | Zod schemas for every `jsonb` column (see specifics §4). |
| 6 | `lib/types/db.ts` | TypeScript table types — `Project`, `Session`, `Plan`, `PlanStage`, `Spec`, `Decision`, `Skill`, `LlmCall` — and the `Database` shape consumed by `createClient<Database>`. **Kept manually in sync with `0001_initial.sql`; migrate to `supabase gen types typescript` when the cloud project is stable** so future migrations don't let SQL and TS drift silently. |
| 7 | `lib/supabase/client.ts` | Anon-key client. Browser-safe. Throws if `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` missing. |
| 8 | `lib/supabase/server.ts` | Service-role client. Server-only (asserts on `typeof window === 'undefined'` at import). |
| 9 | `lib/orchestration/context.ts` | `ContextLoader` skeleton (see specifics §2). |
| 10 | `lib/orchestration/context.test.ts` | Throw test for cross-project read. |
| 11 | `lib/supabase/llm-calls.test.ts` | Fan-out round-trip (see specifics §1). |
| 12 | `lib/supabase/sessions.test.ts` | Plain round-trip; types compile. |
| 13 | `config/projects.json` | Four projects (see specifics §3). |
| 14 | `lib/supabase/seed.ts` | Reads config/projects.json, upserts via service-role client. |
| 15 | `vitest.config.ts` | Minimal — node environment, env vars from `.env.local`, test pattern matches `**/*.test.ts`. |
| 16 | `lib/supabase/llm-calls.ts` | Houses `insertLlmCallsFromModelUsage()` — the canonical fan-out insertion path used in §1's test now and by Slice 4's session worker later. |
| 17 | `lib/supabase/test-fixtures.ts` | Test-only helpers (`insertProjectFixture()`, `insertSessionFixture()`). Used by `llm-calls.test.ts` and `sessions.test.ts`. Not a production import; lives in `lib/supabase/` for proximity but excluded from production builds via `vitest.config.ts` test-file conventions. |

## Specifics (per the user's plan instructions)

### §1 — Fan-out test for `llm_calls`

`lib/supabase/llm-calls.test.ts`:

```typescript
test("fan-out: one Agent SDK session writes one llm_calls row per model; sums match total_cost_usd", async () => {
  const project_id = await insertProjectFixture();
  const session_id = await insertSessionFixture({ project_id });

  // Mock SDKResultSuccess.modelUsage shape: Haiku (router) + Opus (response).
  const modelUsage = {
    "claude-haiku-4-5-20251001": {
      inputTokens: 353, outputTokens: 13,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      costUSD: 0.000418,
    },
    "claude-opus-4-7[1m]": {
      inputTokens: 6, outputTokens: 6,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 12169,
      costUSD: 0.0762362,
    },
  };
  const total_cost_usd = 0.0766542; // SDK-reported

  // Fan-out insert: one row per model.
  await insertLlmCallsFromModelUsage({ project_id, session_id, modelUsage });

  // Round-trip: query and sum.
  const rows = await sb.from("llm_calls").select("*").eq("session_id", session_id);
  expect(rows.data).toHaveLength(2);
  const sum = rows.data!.reduce((acc, r) => acc + Number(r.cost_usd), 0);
  expect(sum).toBeCloseTo(total_cost_usd, 6);
});
```

**Helper signature.** `insertLlmCallsFromModelUsage({ project_id, session_id, modelUsage })` — the three required inputs. `project_id` is required (FK; brief §7). `provider` is hardcoded to `'agent_sdk'` *inside* the helper, not a parameter — there's no scenario where this code path writes anything else. `duration_ms`, `prompt_hash`, and `error` accept optional overrides for testing. The helper lives in `lib/supabase/llm-calls.ts` (file #16) and is reused by Slice 4's session worker when real sessions complete.

**Fixtures.** `insertProjectFixture()` and `insertSessionFixture({ project_id })` live in `lib/supabase/test-fixtures.ts` (file #17). They insert minimal rows satisfying NOT NULL constraints and return the new `id`.

### §2 — `ContextLoader` skeleton

`lib/orchestration/context.ts`:

```typescript
export type ContextScope = "project" | "session" | "plan";

export type ProjectContext = { /* CLAUDE.md, specs, skills, decisions — fields stubbed */ };
export type SessionContext = ProjectContext & { /* slice spec, prior debrief — stubbed */ };
export type PlanContext = ProjectContext & { /* brief, dialectic state — stubbed */ };

export class ContextLoader {
  constructor(private readonly db: SupabaseClient<Database>) {}

  async buildFor(projectId: string, scope: "project"): Promise<ProjectContext>;
  async buildFor(projectId: string, scope: "session", sessionId: string): Promise<SessionContext>;
  async buildFor(projectId: string, scope: "plan", planId: string): Promise<PlanContext>;
  async buildFor(projectId: string, scope: ContextScope, secondaryId?: string): Promise<unknown> {
    await this.assertProjectMatch(projectId, scope, secondaryId);
    // V1 stub: return a typed empty shape. Slice 5+ wires the actual loaders.
    return this.emptyShapeFor(scope);
  }

  // Refuses cross-project reads. Confirmed by test.
  private async assertProjectMatch(projectId: string, scope: ContextScope, secondaryId?: string) {
    if (scope === "session" && secondaryId) {
      const { data } = await this.db.from("sessions").select("project_id").eq("id", secondaryId).single();
      if (data && data.project_id !== projectId) {
        throw new ContextLoaderCrossProjectError(projectId, data.project_id, "session", secondaryId);
      }
    }
    // …same shape for plan…
  }
}
```

Slice 1 test only asserts the throw. Stub bodies (`emptyShapeFor`) return a typed empty `ProjectContext` / `SessionContext` / `PlanContext`. The actual content-loading logic (CLAUDE.md, specs, decisions, brief, dialectic state) is Slice 5 / 6 territory.

### §3 — Project seed

`config/projects.json`:

```json
[
  { "slug": "departed-spirits", "name": "Departed Spirits", "short_code": "DS",
    "repo_path": "/path/to/departed-spirits/" },
  { "slug": "mens-health",      "name": "Men's Health",     "short_code": "MH",
    "repo_path": "/path/to/mens-health/" },
  { "slug": "aluna",            "name": "Aluna",            "short_code": "AL",
    "repo_path": "/path/to/aluna/" },
  { "slug": "numbat",           "name": "Numbat",           "short_code": "NB",
    "repo_path": "<absolute path to this repo>" }
]
```

`lib/supabase/seed.ts` reads this file, resolves the Numbat entry's
`repo_path` to `path.resolve(__dirname, "../..")` (i.e. the actual repo
root), upserts on `slug`. The other three entries use placeholder paths
that the user will edit before running their first session.

### §4 — Zod schemas for `jsonb` fields

Seven schemas in `lib/types/jsonb.ts`. Explicit shapes, no `z.unknown()`
shortcuts. Cover every `jsonb` column in the migration:
`sessions.last_error`, `specs.files_affected`, `specs.acceptance_criteria`,
`specs.open_questions`, `decisions.payload`, `llm_calls.error`,
`plan_stages.content`.

```typescript
// sessions.last_error
export const SessionLastError = z.object({
  message: z.string(),
  stack: z.string().optional(),
  source: z.enum(["agent_sdk", "worker", "supabase", "validation"]),
  occurred_at: z.string().datetime(),
});

// specs.files_affected
export const SpecFilesAffected = z.array(z.object({
  path: z.string(),
  status: z.enum(["created", "modified", "deleted", "renamed"]),
  rename_from: z.string().optional(),
}));

// specs.acceptance_criteria
export const SpecAcceptanceCriteria = z.array(z.object({
  id: z.string(),
  text: z.string(),
  satisfied: z.boolean().default(false),
}));

// specs.open_questions
export const SpecOpenQuestions = z.array(z.object({
  id: z.string(),
  question: z.string(),
  raised_at: z.string().datetime(),
  resolved: z.boolean().default(false),
  resolution: z.string().optional(),
}));

// decisions.payload — discriminated union by decision type
export const DecisionPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve"),         note: z.string().optional() }),
  z.object({ type: z.literal("redirect"),        reply_text: z.string() }),
  z.object({ type: z.literal("kill"),            reason: z.string() }),
  z.object({ type: z.literal("accept_critique"), critique_id: z.string() }),
  z.object({ type: z.literal("reject_critique"), critique_id: z.string(), reason: z.string() }),
  z.object({ type: z.literal("ship"),            spec_id: z.string() }),
  z.object({ type: z.literal("edit_spec"),       spec_id: z.string(), diff: z.string() }),
]);

// llm_calls.error — same shape as SessionLastError but with optional fields per the SDK error union
export const LlmCallError = z.object({
  message: z.string(),
  subtype: z.string().optional(),       // 'error_during_execution', 'error_max_turns', etc.
  terminal_reason: z.string().optional(),
  errors: z.array(z.string()).optional(),
});

// plan_stages.content — discriminated union by action.
// Permissive stub shapes for V1; Slice 6 (Bilby) tightens each variant
// when the dialectic prompts are written. Goal here is the file
// structure exists so Slice 6 doesn't retrofit and so Slice 1 satisfies
// CLAUDE.md "Always" rule (Zod on every jsonb before insert).
export const PlanStageContent = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft"),    markdown: z.string() }),
  z.object({ action: z.literal("critique"), markdown: z.string() }),
  z.object({ action: z.literal("consider"), markdown: z.string() }),
  z.object({ action: z.literal("validate"), markdown: z.string() }),
  z.object({ action: z.literal("execute"),  markdown: z.string() }),
  z.object({ action: z.literal("debrief"),  markdown: z.string() }),
]);
```

Each schema is exported and used at every `insert`/`update` site.
Zod-to-TS types are re-exported from `lib/types/db.ts` so tables can use
them as field types.

### §5 — Migration file

`lib/supabase/migrations/0001_initial.sql`. Single file. Contents = brief
§7 (post-edit) with one structural change required by the schema itself
(see "Circular FK" below).

**Circular FK resolution.** Brief §7 has `plans.spec_id` → `specs(id)` AND
`specs.plan_id` → `plans(id)`. Neither table can be created first with both
FKs intact. Two valid resolutions:

- **(a) ALTER at the end** — create `plans` *without* `spec_id`, create
  `specs` *with* `plan_id` referencing `plans`, then
  `ALTER TABLE plans ADD COLUMN spec_id uuid references specs(id);` at
  the bottom of the same migration file.
- **(b) DEFERRABLE INITIALLY DEFERRED** — declare both FKs deferrable so
  the constraint check runs at COMMIT inside a transaction.

**Picked: (a).** Reasoning: each Supabase migration is a self-contained
DDL script and explicit DDL ordering reads more clearly to a future
migration author than a `DEFERRABLE` qualifier they have to interpret.
The trailing `ALTER TABLE` carries an inline SQL comment
(`-- Circular FK with specs — added after both tables exist.`) which
doubles as durable documentation of the constraint topology. We reserve
`DEFERRABLE INITIALLY DEFERRED` for cases where two-phase commit
semantics are needed at *insert* time, which they're not here.

**Table creation order (revised):**
`projects` → `plans` (without `spec_id`) → `specs` (with `plan_id` FK) →
`sessions` (FK to `specs`) → `plan_stages` (FK to `plans`) → `decisions`
(FKs to all) → `skills` → `llm_calls` (FKs to `plan_stages`, `sessions`)
→ `ALTER TABLE plans ADD COLUMN spec_id uuid references specs(id);`.

All indexes from brief §7 are included unchanged.

The fan-out comment block above `llm_calls` is reproduced verbatim from
the brief — it's a load-bearing comment that explains the test in §1.

## Decision — Supabase access

**Resolved:** new Supabase cloud project named `numbat`, region Sydney
(closest to Melbourne). Free tier. User creates the project at
supabase.com and provides three env vars:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

**Why a new project rather than reusing an existing one:** Numbat's data
model (sessions, plans, decisions, llm_calls) doesn't overlap with any
sibling codebase (Departed Spirits, Men's Health, Aluna, wedgetail), so
sharing buys nothing and creates shared migration risk. Free tier is
sufficient.

**Why cloud rather than Docker:** brief §4 + §6 commit Supabase cloud as
V1. Local-first applies to the *application* (no Vercel) but state lives
in the cloud DB.

**Convention:**
- `.env.local.example` is committed; `.env.local` is gitignored.
- `supabase link --project-ref <ref>` runs once, locally; the project ref
  goes into `supabase/config.toml` (committed) but the keys never do.

**Implementation gating:**
- The 80% offline portion (root scaffolding, migration SQL, types,
  ContextLoader stub + its mocked test, Zod schemas) proceeds **without**
  the Supabase project existing yet.
- The acceptance runs (`pnpm db:push`, `pnpm db:seed`, the fan-out
  round-trip test, the sessions round-trip test) gate on the user
  providing the three env vars.

## Convention — slice plans live in `docs/`

Confirmed: durable docs go in `docs/`. Bootstrap dialectic, brief, spike
memo, and slice plans all live there. Future slices follow the pattern
`docs/slice-N-plan.md` (or `docs/slice-N-<short-name>-plan.md` if a
slice's scope wants disambiguation).

## Verification plan

End-to-end, after implementation:

1. `pnpm install` succeeds.
2. `pnpm typecheck` passes (strict mode, no `any`).
3. `pnpm db:push` applies `0001_initial.sql` cleanly against the chosen
   Supabase instance. Re-running is a no-op (or produces a clean error
   about the migration already being applied — Supabase CLI handles this).
4. `pnpm db:seed` upserts four rows in `projects` with short_codes
   `DS`, `MH`, `AL`, `NB`.
5. `pnpm test` runs the three vitest files:
   - **context.test.ts** — `ContextLoader.buildFor(A, 'session', sessionInB)` throws `ContextLoaderCrossProjectError` containing both project ids.
   - **llm-calls.test.ts** — fan-out round-trip: insert two rows from a single mock `modelUsage`, query, sum `cost_usd`, assert it equals the synthetic `total_cost_usd` to within `1e-6`.
   - **sessions.test.ts** — insert a `Session`, query via typed client, types compile (no `as any`), `last_error` validates through Zod when populated.
6. Spot-check: every Zod schema in `lib/types/jsonb.ts` is imported by at
   least one insert/update site (no orphan validators).

## Order of work

To minimise blocked time on the Supabase decision:

1. Root scaffolding (`package.json`, `tsconfig.json`, `.env.local.example`, `vitest.config.ts`).
2. Migration SQL + Zod schemas + DB types — all pure files, no DB needed.
3. Supabase clients + ContextLoader skeleton + cross-project test.
   - The ContextLoader test can run with a mocked Supabase client; it
     doesn't need a live DB. Slice 1 partly verifiable offline.
4. Pause for Supabase decision (if not already resolved).
5. `lib/supabase/llm-calls.ts` + fan-out test.
6. `config/projects.json` + `seed.ts` + `sessions.test.ts`.
7. `pnpm db:push` and `pnpm db:seed` final acceptance run.

## Critical files (canonical references the implementation reuses)

- `docs/numbat-brief-final.md` §7 — the schema source of truth.
- `docs/numbat-brief-final.md` §11 Slice 1 — acceptance criteria.
- `docs/sdk-spike.md` "Cost data shape" table — column-to-source mapping
  for the Slice 4 worker (referenced by `lib/supabase/llm-calls.ts`).
- `CLAUDE.md` `## Always` and `## Never` — coding rules every file follows.
