# Slice 6 Plan — Plans Surface + Direct Pipeline

> **Status:** FINAL (post-dialectic). Pre-flight verification gate (§7) must execute before sub-slice 6a begins.
> **Date:** 25 May 2026.
> **Dialectic reference:** `docs/decisions/0014-slice-6-dialectic.md` (numbered alongside this file after pre-flight audit).
> **Predecessor:** `0011-slice-5-close-out.md` (operator action surface + session lifecycle, shipped 24 May 2026).

This is the integrated final plan. It folds the Stage 3 Opus Considered resolutions into the Stage 1 Opus Draft at the right places, so this document is the single source of truth for Slice 6 execution. The reasoning trail (what was caught, accepted, partially accepted, added) lives in the dialectic file.

---

## §1 · Framing

> Plan amended 25 May 2026 post-preflight; see `docs/decisions/0012-slice-6-preflight.md` §2 for the amendment audit trail.

Slice 6 is two distinct pieces of work that the brief paired together for a reason:

- **The Plans surface** — the UI shell that will eventually host Bilby. Plans index, plan detail, create-plan flow. Without this, Bilby has no room to live in.
- **The Direct pipeline** — the Opus debrief generator wired to the end of every live session, replacing the mock four-section debrief that Slice 3 introduced and Slice 4 has been showing against real session output.

The brief paired them because they share infrastructure: both are the first real production use of `lib/llm/opus.ts` via the Vercel AI SDK, both feed `llm_calls` and the cost badge, both need ContextLoader integration, both bring the Anthropic key into hot-path use. Doing them as one slice means setting up the shared infrastructure once.

**Resolved (Stage 1 open question — Bilby in Slice 6 vs Slice 7):** Bilby is split out to Slice 7. Slice 6 is the Plans surface + Direct pipeline; Slice 7 owns the four-stage dialectic itself. Reasoning is in the dialectic file (V1) — the short version is that Slice 6 is already substantial, Bilby's prompt iteration deserves its own slice, an empty Plans surface is a coherent shipping state ("the room is ready; the occupant arrives next slice"), and isolation of failure modes makes post-mortems cleaner. Grok confirmed the call in Stage 2; Opus confirmed in Stage 3; Grok stamped READY in Stage 4.

---

## §2 · Scope

**In:**

1. New `debriefs` table + migration `supabase/migrations/0009_debriefs.sql`. Pre-flight Item 1 confirmed master is at `0008_slice_5_dismiss_decision_types.sql`; this migration takes the next number (`0009`). The migration includes a `debrief_type` discriminator column (Stage 3 addition from Grok's suggestion — see §5).
2. `lib/debrief/opus-debrief.ts` — the Opus debrief generator. Takes a `session_id`, assembles context via `ContextLoader.buildFor(projectId, 'session')`, calls Opus with the four-section prompt template, validates the response via Zod, writes a `debriefs` row and a `llm_calls` row.
3. Wiring: when a session-runner worker reaches the result/success branch, it triggers the debrief generator before `transitionToAwaitingReview` (the worker transitions to `awaiting_review`, not `done` — pre-flight Item 2). Failure to generate a debrief does not regress the session (the loop fails open).
4. `app/(plans)/page.tsx` — Plans index, RSC, filter bar (project + status), realtime subscription on `plans` table.
5. `app/(plans)/[planId]/page.tsx` — Plan detail, RSC, realtime subscription on `plan_stages`. Renders `PlanHeader`, `BriefBlock`, `DialecticTimeline` (empty until Bilby), `SpecPreview` (empty until Bilby ships a spec), `OpenQuestions` (empty until Bilby).
6. `components/plans/*` — the components listed in §8 of the brief, built to render real or empty state cleanly. `ConsideredList`, `VerdictBanner`, `GapFinder` ship as components but their content is empty until Slice 7. `DialecticTimeline`'s empty state shows a non-alarming placeholder ("Dialectic timeline will appear here once Bilby (Slice 7) runs") with a greyed-out "Run Bilby" button tooltipped "Available in Slice 7" (Stage 3 partial accept on Q6).
7. Create-plan flow: a Server Action `createPlan({ projectId, title, brief })` that inserts a `plans` row with `status = 'drafting'`, redirects to the detail page. Invoked from a "New Plan" button on the Plans index AND from the existing Start Work surface when the router routes to Bilby.
8. Update the Bilby-path plan-creation flow. Pre-flight Item 4 confirmed `app/api/start-work/route.ts` already creates a real plan stub via `lib/orchestration/create-plan.ts:createPlan` and redirects to `/plans/<id>`. The current implementation emits a `decisions` row of type `start_work`; sub-slice 6g changes it to emit `create_plan` (which honestly names what happened — a plan was created — rather than what triggered it).
9. Cost badge already wired in Slice 2. Verify debrief llm_calls feed it via realtime. No code change expected — this is a verification step.
10. Tests: Vitest for the debrief generator (mock Opus client, assert Zod validation + DB row shape), Playwright happy-path for create-plan and Plans index navigation.

**Folded in from Stage 2/3 (the seven gap-accepts):**

- **Missing-debrief operational note.** If a session reaches `done` with no debrief after 5 minutes (worker crash, Opus down at session end), a follow-up slice will add either a nightly reconciliation job or a manual `pnpm tsx scripts/regenerate-debrief.ts <session_id>` script. Out of Slice 6 scope; flagged in the post-Slice-6 backlog and in §8 risk register.
- **Realtime publication verification.** Sub-slice 6a includes an explicit verification step: subscribe to `debriefs` from the client, insert from psql, assert the realtime event arrives. Same verification for the constraint change on `decisions` — confirm the new `create_plan` type passes the check constraint with a one-shot insert. RLS is off in V1 per the brief; the publication is the worry, not the policy.
- **Cost computation sketch.** Sub-slice 6b ships `insertLlmCallFromAiSdk` as a real function (signature in §3.3), not a stub. 6d and 6h verify end-to-end cost computation rather than assuming it.
- **Diff & Review audit step.** Sub-slice 6e begins with an explicit audit of all mock data references in the Diff & Review surface (components, fixtures, tests, storybook entries if any). The list goes into the 6e plan before code changes start. Catches the "I thought there was one mock, there were three" failure mode.
- **Observability logging.** `lib/llm/opus.ts` emits a structured log line per call with `{ request_id, model, prompt_hash, input_tokens, output_tokens, duration_ms, status }` at minimum. Use the existing logger; if none, introduce pino in 6b. Cheap now, impossible to retrofit cleanly once Slice 7 multiplies the call sites.
- **Rollback SQL.** The migration file opens with a comment block containing the inverse SQL (drop table, revert constraint, drop publication entry). V1 doesn't use migration versioning sophisticated enough to roll back via tooling, but the file contains the recipe. See §5.
- **ContextLoader contract verification.** Sub-slice 6a includes verification of the current shape of `ContextLoader.buildFor(projectId, 'session')`. If the Agent SDK message stream is not in the returned shape, that is a contract change to ContextLoader and either belongs in 6a or blocks the slice. Don't discover this in 6c.

**Out (deferred to Slice 7):**

- The Bilby dialectic itself (Opus draft → Grok critique → Opus considered → Grok validate).
- Spec generation from a shipped plan.
- The `GapFinder`, `ConsideredList`, `VerdictBanner` content (components ship empty).
- Grok client wiring (`lib/llm/grok.ts`). Slice 6 only needs Anthropic.

**Out (V2 or later):**

- LLM-based router.
- Cross-project plan signal.
- Plan export / decisions CLI extension to cover plans.
- Plan editing / re-running stages.
- Plans surface mobile responsive below 600px (acceptable to defer for V1; the Plans surface is desktop-primary by intent — Stage 2 confirmed on Q7).

**Non-goals:**

- Not building any UI affordance for "manually invoking Bilby" — that's Slice 7.
- Not changing the Direct path's session lifecycle (Slice 5 froze that). The debrief generator is additive, runs at the end, never blocks the session reaching `done`.

---

## §3 · Architecture

### §3.1 · The Direct pipeline (debrief generator)

The Direct pipeline today is half-built: Slice 4 wired the Agent SDK so sessions actually run, Slice 5 owns the operator lifecycle so the human can approve / redirect / kill. What's missing is the debrief — the Opus pass that summarises the session into the four-section format and stores it for the Diff & Review surface.

**Trigger.** Inside `scripts/session-runner.ts`, in the result/success branch: after `captureDiff` and `insertLlmCallsFromModelUsage`, before `transitionToAwaitingReview`. Slice 5 set the worker exit point at `awaiting_review` (pre-flight Item 2 confirmed). `done` is reached only later, via operator approval through the Slice 5 action surface — outside the worker entirely. Triggering before the status flip keeps the `awaiting_review` write atomic-from-the-UI's-point-of-view: by the time the realtime subscriber sees the status change, the debrief row is already in place (or a `no debrief generated` error row, per the failure-mode paragraph below).

Two alternatives considered and rejected:

- **A separate watcher process subscribed to `sessions` realtime.** Adds a second long-running process Numbat has to manage. Brittle if the watcher dies. The worker already has all the context (session_id, project_id, the full message stream) — making it own the debrief is local.
- **The Next.js server triggers the debrief on session status change via a webhook.** Couples the debrief to the web server's uptime. The worker already runs in its own process; debrief should too.

The trade-off with the worker-owns-it approach: a worker crash *after* the diff write but *before* the debrief write means the session reaches `awaiting_review` with no debrief. Recovery is in the operational backlog (see §2 fold-in and §8 R4). For Slice 6, missing debriefs surface as a small "no debrief generated" line in the Diff & Review UI rather than a blocking state.

**Context assembly.** Two sources, combined inside the debrief generator:

- **Project bundle and session metadata via `ContextLoader.buildFor(projectId, 'session', sessionId)`:** CLAUDE.md, last 30 decisions, active specs, skills, the session's spec (if any), the session's task description, the captured diff. Pre-flight Item 3 confirmed the API signature matches; sub-slice 6a fills in the currently-stubbed return fields (`claudeMd`, `specs`, `recentDecisions`, `spec`) with real reads.
- **Agent SDK assistant message stream via an in-memory accumulator in `scripts/session-runner.ts`:** the worker maintains a `messages: SDKMessage[]` array, pushing each message as it arrives in the for-await loop, and passes the array as a parameter to `generateDebrief(sessionId, messages)`. The messages are *not* persisted to the database — they are consumed in-memory and discarded with the worker process. This was the right shape to land on per pre-flight Item 2: persisting the full stream would require schema work (a `sessions.message_log jsonb` column) beyond Slice 6 scope, and the messages are only needed at the moment of debrief generation.

The Agent SDK's message stream is what the debrief actually summarises — the diff alone doesn't capture intent, the spec alone doesn't capture what actually happened.

**Debrief discriminator.** Each row carries a `debrief_type` (initially `'direct'`; Bilby stages in Slice 7 will write `'bilby_draft'`, `'bilby_critique'`, `'bilby_consider'`, `'bilby_validate'`). The four-section content shape is one discriminated variant; Slice 7's Bilby variants will be others. See §5 for the constraint definition.

**Opus call.** Through `lib/llm/opus.ts`. Vercel AI SDK with `generateObject`. Zod schema enforced at the SDK boundary:

```ts
const DirectDebriefSchema = z.object({
  what_we_did: z.string(),
  where_this_fits: z.string(),
  why_it_matters: z.string(),
  what_went_wrong_or_next: z.string(),
  new_concept: z.object({
    name: z.string(),
    definition: z.string(),
  }).optional(),
});
```

Prompt lives in `lib/llm/prompts/opus-debrief.ts`, versioned (initial version `v1`). Snapshot test ensures rendering stability.

**Timeout: 90s (override of the 60s default).** Stage 3 elevated this from the original 60s draft. Reasoning: the debrief runs *after* user-visible work is complete; the user is no longer watching, so a few extra seconds of background patience is free, and the original 60s would have produced an avoidable ~1–2% timeout rate. CLAUDE.md's resilience section is updated in the same sub-slice (6b) to reflect the override.

**Retry:** max 2, exponential backoff (1s, 2s). Unchanged from default.

**Persistence.** One `debriefs` row + one `llm_calls` row (single-model fan-out of 1). Both written from the worker. Supabase doesn't do cross-table transactions natively over PostgREST, so the worker writes `llm_calls` first and references it from `debriefs` via `llm_call_id`. If the second write fails, the orphaned `llm_calls` row is harmless (it's still an accurate accounting record).

**Failure mode.** If the Opus call fails (timeout, 4xx, network exhausted after retries), the worker writes an `llm_calls` row with `error` populated and exits without writing a `debriefs` row. The Diff & Review UI shows "no debrief generated (last attempt: <error_kind>)" — the operator can still approve / redirect / kill. The loop fails open.

### §3.2 · The Plans surface

**Routing.** App Router segments under `app/(plans)/`. RSC by default. Realtime subscriptions client-side via thin client wrappers — same pattern as the Sessions surface.

**Plans index (`app/(plans)/page.tsx`).** Lists plans across all projects, default sort by `updated_at desc`. Filter bar uses URL search params (`?project=NB&status=drafting`), same pattern as Sessions. Each row: project chip, title, status pill (mapping `drafting → mint pulse`, `critiquing/considering/validating → amber pulse`, `ready → mint solid`, `shipped → dim`, `abandoned → coral`). Click → detail page.

A "New Plan" button at the top, opens a small modal with project selector + title + brief textarea, submits via Server Action.

**Plan detail (`app/(plans)/[planId]/page.tsx`).** Renders:

- `PlanHeader` — title, status, project chip, created/updated stamps.
- `BriefBlock` — the brief text, read-only in V1.
- `DialecticTimeline` — vertical timeline rendering `plan_stages` ordered by `stage_num`. Empty state (until Slice 7): the non-alarming placeholder ("Dialectic timeline will appear here once Bilby (Slice 7) runs") with a greyed-out "Run Bilby" button tooltipped "Available in Slice 7."
- `StageCard` — renders one `plan_stages` row, content shape varies by action (`draft`, `critique`, `consider`, `validate`, `execute`, `debrief`). Component is built but only the empty-state and the `draft` shape get exercised in Slice 6.
- `ConsideredList`, `VerdictBanner`, `GapFinder`, `OpenQuestions` — components stubbed, render empty state until Slice 7.
- `SpecPreview` — empty state until a plan ships a spec.

**Realtime.** Subscribe to `plans` (single row) and `plan_stages` (filtered by `plan_id`) so that when Slice 7's Bilby starts populating stages live, the timeline fills in without a refresh. Testing this in Slice 6 means manually inserting a `plan_stages` row from psql and watching the UI update — verification step in §6 acceptance.

**Create-plan flow.** Server Action `createPlan(formData)`:
1. Parse + Zod-validate input.
2. Insert into `plans` with `status = 'drafting'`, `brief = inputBrief`.
3. Insert a `decisions` row of type `create_plan` (new decision type — schema delta in §5).
4. Redirect to `/plans/<planId>`.

Triggered from two places: the "New Plan" button on the Plans index, and the existing Start Work surface when the router routes to Bilby (the change at that integration point is gated by pre-flight item 4).

### §3.3 · Shared Opus infrastructure

This is the part of Slice 6 that has to be designed with Slice 7 in mind. The debrief generator and the four Bilby stages all hit Opus through `lib/llm/opus.ts`. Slice 6 establishes:

- **One Opus client (`lib/llm/opus.ts`).** Wraps `@ai-sdk/anthropic`, reads model name from `lib/llm/models.ts`, takes a Zod schema and a prompt, returns validated output + token usage + duration. Comments at the call-site stubs show the four Bilby stage call sites (draft, critique, consider, validate) with their expected Zod schemas, even though they're not implemented in this slice. Confirms the client interface generalises (Stage 3 accept of Grok's sub-suggestion on Q4).
- **Two-part prompt structure with Anthropic prompt caching.** The Opus client wrapper builds prompts in two parts:
  - **Stable prefix** = system prompt + the project bundle (CLAUDE.md, active specs, skills, last 30 decisions). Marked as cache-eligible via the AI SDK's cache-control mechanism so Anthropic caches it for the 5-minute TTL window.
  - **Per-call dynamic suffix** = the session-specific or stage-specific content (task description, diff, message stream for debrief; brief and prior stages for Bilby).
  - The `prompt_hash` on `llm_calls` is computed on the dynamic suffix only — identical project bundles must not produce different hashes.
  - The AI SDK response populates `cache_read_input_tokens` and `cache_creation_input_tokens` on the `llm_calls` row (columns already exist in the Slice 1 schema). Cost computation reflects the 10% read / 125% write pricing.

  Rationale: the four Bilby stages share an identical project bundle. Caching it once in Slice 6 gives Slice 7 four free cache hits per plan run. Setting this up now also forces the prompt renderer to be deterministic on the cacheable portion — good hygiene regardless. Stage 3 addition A11; Stage 4 strongly confirmed as right-time, low-cost, high-leverage.

- **Standardised error handling.** Typed errors for timeout / 4xx / 5xx / validation failure.

- **Structured logging.** Per the §2 fold-in: every call logs `{ request_id, model, prompt_hash, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, status }` at minimum.

- **One `llm_calls` writer for the AI SDK path — already exists.** Pre-flight Item 5 confirmed `lib/supabase/llm-calls.ts` already exports `insertLlmCallFromAiSdkResult`, alongside the Agent SDK fan-out path's `insertLlmCallsFromModelUsage`. The existing function is currently `plan_stage_id`-only (no `session_id` support); sub-slice 6b widens its `InsertLlmCallFromAiSdkResultInput` signature to accept either `plan_stage_id` or `session_id` (at-least-one-non-null, matching the `debriefs` table's discriminator pattern), and widens the return type to `Promise<{ id: string }>` so the debrief writer can reference the row via `llm_call_id`. The internal cost computation (`computeCostUsd` against the in-file `PRICE_PER_MILLION` table) is reused unchanged.

- **Pricing table — already in place.** Pre-flight Item 10 confirmed `PRICE_PER_MILLION` and `computeCostUsd` already live in `lib/supabase/llm-calls.ts` (snapshot dated 22 May 2026) with rows for `claude-opus-4-7`, `claude-opus-4-6`, `grok-4-latest`, `grok-4`. Sub-slice 6b extends entries only if the debrief generator uses an Opus model not in the table, and bumps the snapshot date if any entries change. No new `lib/llm/pricing.ts` file is created — the existing co-location with `insertLlmCallsFromModelUsage` is honest about who consumes the table.

- **ContextLoader integration.** Verified for `'session'` scope by pre-flight gate item 3. `'plan_stage'` scope is stubbed in this slice and implemented in Slice 7.

### §3.4 · Architectural layer mapping

For the five-layer model in CLAUDE.md:

- **Interface:** Plans index, Plan detail, create-plan modal, "no debrief" surface in Diff & Review.
- **Orchestration:** ContextLoader's `'session'` scope return shape verified; `'plan_stage'` scope stub added.
- **Pipelines:** Direct pipeline completes (Agent SDK → debrief generator → debrief row). Bilby pipeline scaffolding exists but doesn't execute.
- **Feathertail:** `session-runner.ts` gains the debrief invocation at the end of its lifecycle.
- **Persistence:** `debriefs` table added (with `debrief_type` discriminator); one new decision type (`create_plan`). Price table for Anthropic and xAI models already lives in `lib/supabase/llm-calls.ts` (`PRICE_PER_MILLION` + `computeCostUsd`, snapshot 22 May 2026); sub-slice 6b extends entries if any Opus model used by the debrief generator is missing.

---

## §4 · Sub-slices

Slice 6 splits into eight sub-slices, executed **sequentially** with one gate per sub-slice. The pattern matches earlier slices.

**Operational note on parallelism.** Sub-slices 6c (debrief generator) and 6f (Plans index) have zero code or data dependency once 6b lands. They are technically parallelisable in separate Claude Code sessions. Stage 3 deliberately keeps them sequential anyway: Numbat is the meta-system, the cost dashboard and per-day budget guardrails are still maturing, and running two simultaneous Claude Code sessions with their own debrief loops would roughly double the meta-LLM spend during the most critical slice so far. Single-track for this slice; revisit the convention as a working pattern once daily-budget enforcement is stricter. Stage 4 stamp: "principled, not paranoid."

### 6a — Schema delta, ContextLoader fill-in, and pre-flight gate close-out

- The pre-flight gate has already run; its result lives in `0012-slice-6-preflight.md`. 6a inherits the amendments folded into this plan from the gate output.
- The new migration is `supabase/migrations/0009_debriefs.sql` (pre-flight Item 1 confirmed master is at `0008`).
- **Pre-migration safety check (from pre-flight Item 9).** Before running `pnpm db:push`, query the current `decisions.type` check constraint definition (`\d+ decisions` in psql) and confirm the new constraint in §5 includes every value present in the live constraint plus `'create_plan'`. No values may be silently dropped. The current live set after `0008` is: `approve`, `redirect`, `kill`, `accept_critique`, `reject_critique`, `ship`, `edit_spec`, `start_work`, `dismiss`, `undismiss`. The new set must be those ten plus `create_plan`.
- Apply migration on a fresh DB: `debriefs` table (with `debrief_type` discriminator), `decisions.type` constraint extended for `create_plan` (full 11-value list), realtime publication entry for `debriefs`. See §5.
- Verify the realtime publication and constraint change with the live tests in §2 fold-in (subscribe + psql insert + assert event; one-shot insert against the new constraint type).
- **ContextLoader fill-in (from pre-flight Item 3).** Verify each return field of `ContextLoader.buildFor(projectId, 'session', sessionId)` is populated with real data: `claudeMd` (read from `projects.claude_md`), `recentDecisions` (query `decisions` for the project ordered by `created_at desc limit 30`), `specs` (query `specs` filtered by `project_id`), `skills` (already populated by Slice 3), `spec` (the session's spec, if any), `priorDebrief` (latest `debriefs` row for the session, after the table exists). The session's `task` and `diff` come from the session row directly and are passed alongside the context object, not through the loader. If any field is stubbed (null or empty), implement the fill-in here. The slice cannot proceed to 6c until all session-scope fields return real content for a real session.
- Hand-written TypeScript types for `debriefs`. Zod schemas for `debriefs.content` per `debrief_type` (only `'direct'` populated; the others sketched as type stubs with TODO references to Slice 7).
- `pnpm db:push` clean, `pnpm typecheck` and `pnpm lint` clean.
- Single decisions-log entry on completion.

### 6b — Opus client + llm_calls writer + prompt caching architecture

- `lib/llm/opus.ts` wrapping `@ai-sdk/anthropic` with the two-part prompt structure (stable prefix marked cache-eligible; per-call dynamic suffix).
- Standardised typed errors; structured logging (`{ request_id, model, prompt_hash, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, status }`).
- Bilby call-site stubs as comments with their expected Zod schemas (draft, critique, consider, validate) — confirms the interface generalises.
- Widen the existing `insertLlmCallFromAiSdkResult` in `lib/supabase/llm-calls.ts` to accept `session_id` alongside `plan_stage_id` (at least one of the two must be non-null) and to return `Promise<{ id: string }>` so the debrief writer can reference the row via `llm_call_id`. The existing `computeCostUsd` in the same file already honours cache-read (10%) and cache-creation (125%) pricing — no new pricing module is created. Pre-flight Item 5 + Item 10 captured the existing-shape rationale.
- Verify `PRICE_PER_MILLION` in `lib/supabase/llm-calls.ts` has entries for every Opus model used by the debrief generator; extend if missing. Bump the `Last verified: <date>` snapshot in that file's comment block to today's date if any entries change.
- CLAUDE.md resilience section updated: debrief Opus call uses 90s timeout (override of 60s default).
- Vitest unit tests with mocked AI SDK: prompt-hash determinism on the dynamic suffix, cache-eligible flag on the prefix, error typing, cost computation against the price table.
- Round-trip test: call Opus on a test prompt, get validated output, write `llm_calls` row, query it back, confirm cache fields populated.
- No UI change.

### 6c — Debrief generator

- `lib/debrief/opus-debrief.ts` exporting `generateDebrief(sessionId: string, messages: SDKMessage[])`. The `messages` array is the in-memory assistant-message stream from `scripts/session-runner.ts` (see §3.1 context assembly; pre-flight Item 2). The function pulls the rest of the context via `ContextLoader.buildFor(projectId, 'session', sessionId)`, calls Opus (via `lib/llm/opus.ts`), writes the `llm_calls` row first, then the `debriefs` row with `debrief_type = 'direct'` and a reference to the call.
- Standalone CLI: `pnpm tsx scripts/generate-debrief.ts <session_id> --messages-file <path.jsonl>` for replay testing. The CLI cannot reconstruct a live SDK message stream without re-running the session; the `--messages-file` argument lets the operator pass a captured JSONL of the original stream. Tests in 6h dump the stream to a JSONL alongside the worker log so replay is possible.
- Verified against a real completed session from Slice 4 / 5 (via a captured message JSONL).
- No worker integration yet.
- Vitest unit tests: Zod validation of the four-section content, prompt template snapshot, DB row shape.

### 6d — Wire to session-runner

- `scripts/session-runner.ts` maintains an in-memory accumulator of SDK assistant messages (`messages: SDKMessage[] = []`) across the streaming lifecycle (pushed inside the existing `for await (const message of q)` loop). The accumulator is passed to `generateDebrief(sessionId, messages)` immediately after the diff capture (`captureDiff`) and `llm_calls` fan-out (`insertLlmCallsFromModelUsage`), and before `transitionToAwaitingReview`. Pre-flight Item 2 captured the rationale; the accumulator is consumed in-memory and discarded with the worker process (no schema change for a `sessions.message_log` column in Slice 6).
- Failure path (Opus down / timeout) does not prevent the session from reaching `awaiting_review`. The worker proceeds through the status transition; the failure shows up as an `llm_calls` row with `error` and no `debriefs` row.
- Kill-race recovery convention from CLAUDE.md applies to the debrief code path too: catch blocks re-read fresh DB state, never parse error messages.
- Acceptance: launch a real Agent SDK session, watch the debrief appear in the DB before (or alongside) the status flip to `awaiting_review`.
- Memory note: confirm via a real run that the accumulator size for a typical session stays under a few MB. Stress test: a long-running session producing hundreds of tool-use messages.
- The "missing-debrief operational note" is the recovery story for the post-diff-pre-debrief crash window (see §2, §8 R4).

### 6e — Diff & Review surface reads debriefs

- First action: **audit** the current Diff & Review surface for all mock data references — components, fixtures, tests, storybook entries. List them in the 6e sub-plan before code changes start (Stage 2 gap-4).
- Replace fixture reads with live reads from `debriefs` (latest per session via `ORDER BY created_at DESC LIMIT 1` filtered by `session_id`).
- Empty-state UI when no debrief exists yet ("Debrief generating…" with realtime subscription on `debriefs` filtered by session_id) OR ("No debrief generated — last attempt: <error_kind>") when an `llm_calls` row with `error` exists for that session.
- Test mocks may remain; production code paths must not reach for fixtures.
- This is the moment Slice 3's mock four-section debrief gets replaced by the live one.

### 6f — Plans index

- `app/(plans)/page.tsx` + filter bar + realtime subscription on `plans`.
- Read-only; no create yet.
- Empty state if no plans exist.
- Top nav gets a "Plans" tab alongside "Sessions."
- URL params drive filtering, same pattern as Sessions.

### 6g — Plan detail + create-plan flow

- `app/(plans)/[planId]/page.tsx` with all the components rendering (empty state for the ones that need Bilby).
- `DialecticTimeline` empty state with the non-alarming placeholder + greyed-out "Run Bilby (coming soon)" button.
- Realtime subscription on `plan_stages` filtered by `plan_id`.
- Create-plan Server Action `createPlan(formData)`:
  1. Zod-validate.
  2. Insert `plans` row (`status = 'drafting'`).
  3. Insert `decisions` row of type `create_plan`.
  4. Redirect to `/plans/<planId>`.
- Update `lib/orchestration/create-plan.ts` to emit a `decisions` row of type `create_plan`, replacing the current `start_work`. The decision row describes what happened (a plan was created), not what triggered it (a Start Work submission). Pre-flight Item 4 captured the existing behaviour; this is a small but user-visible change in the audit log shape.
- The "New Plan" button on the Plans index (Slice 6's new entry point) uses the same `createPlan` helper, so both paths emit `create_plan`. Distinguishing the two — Start Work submission vs operator-initiated — happens via `payload` shape rather than a separate decision type.

### 6h — End-to-end verification

- Run a real Direct session start-to-finish, watch the debrief appear, watch the cost badge tick (including correct attribution of cache-read vs cache-creation tokens once a second session is run within the 5-minute window).
- Manually create a plan, see it on the index, open the detail, insert a fake `plan_stages` row from psql, watch the timeline update via realtime.
- Playwright happy-path tests for create-plan and debrief presence on a completed session.
- One decisions-log entry closing out the slice.

Each sub-slice gets its own Claude Code session, its own debrief, its own decisions entry. The pattern is: gate after every sub-slice, no parallel work within Slice 6.

---

## §5 · Data model deltas

```sql
-- supabase/migrations/0009_debriefs.sql
--
-- Rollback (manual, dev only):
--   alter publication supabase_realtime drop table debriefs;
--   drop table if exists debriefs;
--   alter table decisions drop constraint decisions_type_check;
--   alter table decisions add constraint decisions_type_check
--     check (type in ('approve', 'redirect', 'kill',
--                     'accept_critique', 'reject_critique',
--                     'ship', 'edit_spec',
--                     'start_work',
--                     'dismiss', 'undismiss'));
-- The rollback restores the post-0008 set (10 values), NOT the post-0001
-- set (7 values). Restoring the original Slice 1 set would re-break every
-- existing 'start_work' / 'dismiss' / 'undismiss' row. Pre-flight Item 9.

-- 1. Debriefs: one or more per session (or per plan_stage, in Slice 7).
--    debrief_type discriminates the content shape; the Zod schema in
--    application code is a discriminated union keyed on this column.
create table debriefs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  session_id uuid references sessions(id) on delete cascade,
  plan_stage_id uuid references plan_stages(id) on delete cascade,
  debrief_type text not null
    check (debrief_type in (
      'direct',
      'bilby_draft',
      'bilby_critique',
      'bilby_consider',
      'bilby_validate'
    )),
  content jsonb not null,                            -- Zod: discriminated by debrief_type
  llm_call_id uuid references llm_calls(id),         -- nullable: the call may have failed before write
  prompt_version text not null,                      -- e.g. 'v1' — for prompt evolution tracking
  duration_ms int,
  created_at timestamptz default now(),
  -- At least one of session_id or plan_stage_id must be set.
  constraint debriefs_target_check
    check (session_id is not null or plan_stage_id is not null)
);

create index debriefs_session_idx on debriefs(session_id, created_at desc);
create index debriefs_plan_stage_idx on debriefs(plan_stage_id, created_at desc);
create index debriefs_project_created_idx on debriefs(project_id, created_at desc);
create index debriefs_type_idx on debriefs(debrief_type);

-- 2. Decisions: extend type check constraint to include 'create_plan'.
--    The full set is the post-0008 set (10 values, after migrations
--    0005 added 'start_work' and 0008 added 'dismiss'/'undismiss')
--    plus the new 'create_plan' — 11 values total. Pre-flight Item 9
--    caught the earlier draft, which would have dropped three valid
--    values and invalidated every existing brief-submission and
--    dismiss/undismiss row.
alter table decisions drop constraint if exists decisions_type_check;
alter table decisions add constraint decisions_type_check
  check (type in (
    'approve', 'redirect', 'kill',
    'accept_critique', 'reject_critique',
    'ship', 'edit_spec',
    'start_work',
    'dismiss', 'undismiss',
    'create_plan'
  ));

-- 3. Realtime publication on debriefs.
alter publication supabase_realtime add table debriefs;
```

**Notes:**

- `debrief_type` is the Stage 3 addition that makes the table reusable for Slice 7's Bilby stages without a schema change. The table keeps the name `debriefs` (not `llm_outputs`) because debriefs are the primary use today; the discriminated union is the honest representation. Stage 4 confirmed Option A.
- `plan_stage_id` is added alongside `session_id` (both nullable, at-least-one-required) so the same table holds both Direct debriefs (keyed to a session) and future Bilby stage outputs (keyed to a plan stage). Slice 6 only writes session-keyed rows.
- `prompt_version` is the cheap forward-look for calibration once Slice 7 starts iterating on prompts (Stage 2 confirmed on Q5).
- No `debrief_id` foreign key on `sessions`. The relationship is one-session-to-many-debriefs; "latest debrief" is `ORDER BY created_at DESC LIMIT 1`. Avoid two sources of truth.
- No schema change to `plans` or `plan_stages`. The Slice 1 tables are sufficient.

---

## §6 · Acceptance criteria

The slice is shippable when:

1. `pnpm db:push` applies the new migration cleanly on a fresh DB.
2. `pnpm typecheck` and `pnpm lint` pass.
3. Launching a real Direct session via Start Work → the session runs → the worker writes a `debriefs` row (with `debrief_type = 'direct'`) before flipping the session to `awaiting_review` → the Diff & Review surface shows the four-section debrief from that row (not from mock data) → an `llm_calls` row exists for the Opus call, with cache-read / cache-creation tokens populated → the cost badge ticks up. The brief window where the row is `awaiting_review` with no debrief yet (Opus call in flight) renders as 6e's "Debrief generating…" empty state and resolves via realtime when the row arrives.
4. Opus debrief generation failing (simulated via injected error) does not prevent the session from reaching `done`. The Diff & Review UI shows a "no debrief generated" state with the error kind visible.
5. The Plans index loads, lists plans (seed at least three for testing across the four projects), filters work via URL params.
6. "New Plan" creates a `plans` row + `decisions` row of type `create_plan` and redirects to the detail page.
7. Plan detail loads, renders all components in their correct empty state (including the non-alarming `DialecticTimeline` placeholder + greyed-out "Run Bilby" button).
8. Inserting a `plan_stages` row from psql causes the `DialecticTimeline` to update via realtime without a page refresh.
9. Start Work surface, when routed to Bilby, creates a plan stub (not a session stub) and navigates to it.
10. Vitest unit tests pass: debrief Zod schema, prompt template snapshot, llm_calls writer for AI SDK path, prompt-hash determinism on the dynamic suffix.
11. Playwright happy-path tests pass: create-plan, Plans index navigation, debrief presence on a completed session.
12. Decisions log has entries for each sub-slice (9 entries total: the pre-flight close-out plus 6a through 6h).

Not shippable until all 12 are green.

---

## §7 · Pre-flight verification gate

Executed before sub-slice 6a begins (or as the first action of 6a, with results captured in `<NNNN>-slice-6-preflight.md`). Each item is a one-line verification. If any assumption is wrong, the plan updates before code is written. The gate is the Stage 2 / Stage 3 addition that closes the most leverage-heavy unknowns in the plan — Stage 4 stamp: "ten items is not excessive when each is a one-line verification + single decisions-log entry."

1. **Migration number.** Last migration on master is exactly `0011` (the draft assumed `0012`). If master has moved past, the new migration takes the next number.
2. **Session-runner hook point.** `scripts/session-runner.ts` has a clean post-`done` hook point and the session result object contains the full Agent SDK message history. If the exit path uses `process.exit()` or has finally-blocks that bypass the new code, 6d's design changes.
3. **ContextLoader contract.** `ContextLoader.buildFor(projectId, 'session')` already exists and returns (or can be made to return without changing the public API) the shape required by the debrief generator (project bundle + spec + task + diff + Agent SDK message stream).
4. **Start Work current behaviour.** `app/api/start-work/route.ts` + Bilby routing currently creates a session stub, a plan stub, nothing, or throws. The 6g acceptance criteria adjust accordingly.
5. **llm_calls writer.** `lib/supabase/llm-calls.ts` exports `insertLlmCallsFromModelUsage` and has no conflicting insert pattern that would shadow the new `insertLlmCallFromAiSdk`.
6. **Diff & Review mock data.** Diff & Review page currently renders a four-section mock from a fixture or hardcoded object. The audit in 6e enumerates all references; the gate confirms one mock reference exists in production code today.
7. **Realtime subscription pattern.** The thin client wrapper used in the Sessions surface for realtime can be copied verbatim for `plans` and `plan_stages`.
8. **Plans + plan_stages schema.** `plans` and `plan_stages` tables from Slice 1 have the columns assumed (`plans`: id, project_id, title, brief, status, created_at, updated_at; `plan_stages`: id, plan_id, stage_num, action, content, llm_provider, model, created_at).
9. **No conflicts.** No existing `debriefs` table or conflicting `decisions.type` constraint that would block the migration.
10. **Pricing file state.** `lib/llm/pricing.ts` is either empty, missing, or only partially populated. If it already holds different price constants, the dated-comment refresh strategy applies; if not, 6a creates it fresh.

The gate is cheap (30–60 minutes) and high-signal. Run it before any code lands.

### §7.1 · Post-preflight confirmations

The gate ran on 25 May 2026. Full results live in `0012-slice-6-preflight.md`. Four items came back GREEN against master and are recorded here for the slice's own audit trail:

- **Item 4 — Start Work flow.** `app/api/start-work/route.ts` already creates a real plan stub via `lib/orchestration/create-plan.ts:createPlan` and redirects to `/plans/<id>`. The current decision-type emit is `start_work`; sub-slice 6g switches it to `create_plan` (see §4 / 6g).
- **Item 6 — Diff & Review mock.** A single production read path: `app/sessions/[sessionId]/page.tsx:35,89,144–156` consumes `getMockedOutputForSession` from `lib/mock/agent-sdk-output.ts`. The 6e audit confirms this is the only production source; seed fixtures in `lib/supabase/seed-mock-sessions.ts` stay as test-time fixtures.
- **Item 7 — Realtime pattern.** `components/sessions/session-list.tsx:44–82` (channel + `on postgres_changes` + `removeChannel` cleanup) is the canonical shape, copyable verbatim for `plans` and `plan_stages` realtime subscriptions in 6f and 6g.
- **Item 8 — `plans` / `plan_stages` schema.** All assumed columns are present. Bonus: `plan_stages.actor` (`opus` / `grok` / `claude_agent`) exists and is useful for Slice 7 Bilby stage authorship — Slice 6 doesn't write to it, but Slice 7 can without a schema change.

---

## §8 · Risk register

- **R1 — Anthropic key in hot path.** Until Slice 6, the Anthropic key has only been used by the Agent SDK (via the SDK's own auth). Slice 6 starts using it directly via the AI SDK. Verify rate-limit headroom, billing alerts, key rotation procedure. Not a blocker; an operational note.
- **R2 — Worker process gains a new responsibility.** The session-runner worker, which Slice 4 / 5 worked hard to stabilise, gains the debrief invocation. The kill-race recovery convention in CLAUDE.md (re-read fresh DB state, never parse error messages) applies to the new debrief code path too. Worth a careful read of the existing worker before adding to it (and `process.exit` / finally-block behaviour is pre-flight item 2).
- **R3 — Empty Plans surface ships before Bilby exists.** If Slice 6 ships and Slice 7 is delayed, James spends time with a Plans surface that doesn't do anything. Mitigation: Slice 7 follows Slice 6 directly with no other slices interleaved. The non-alarming `DialecticTimeline` placeholder ("…once Bilby (Slice 7) runs") makes the temporary state honest rather than broken-looking.
- **R4 — Missing-debrief reconciliation (new, from Stage 2 gap-1).** Worker crash after a session reaches `done` but before the debrief writes leaves the session with no debrief. The Diff & Review UI handles this gracefully ("no debrief generated"), but there is no automatic recovery in Slice 6. Operational note: if a session reaches `done` with no debrief after 5 minutes, a follow-up slice will add either a nightly reconciliation job or a manual `pnpm tsx scripts/regenerate-debrief.ts <session_id>` script. Out of Slice 6 scope.
- **R5 — Cache-control header behaviour drift.** The two-part prompt structure depends on the AI SDK exposing Anthropic's cache-control mechanism in a stable shape. If the SDK changes the surface, the cache-read / cache-creation token counts on `llm_calls` go to zero and cost computation silently overcounts. Mitigation: the structured log line includes `cache_read_tokens` and `cache_creation_tokens`; a missing or zeroed value across multiple consecutive calls is the alarm. Verification in 6h includes running two sessions within the 5-minute TTL window and confirming the second hits cache.

---

## §9 · What this slice unlocks

Once Slice 6 ships, the system has:

- **A live debrief loop.** Every Agent SDK session ends with an Opus-generated four-section debrief, persisted, cost-tracked, available in the UI. The learning loop the brief promises in §1 finally exists.
- **The Plans surface.** Even empty, it's the room Bilby will live in. The data model already supports plans (since Slice 1) — Slice 6 makes them visible and creatable.
- **The shared Opus infrastructure.** Slice 7 inherits a working `lib/llm/opus.ts` (with prompt caching wired and Bilby call sites already commented in), a working `llm_calls` writer for AI SDK calls, a working price table, a working cost badge that ticks on every call. The two-part prompt structure means Slice 7's four Bilby stages get cache hits on the shared project bundle from the start.
- **One new pattern:** components that ship in their empty state, ready to render real content when a future slice provides it. The `DialecticTimeline` is the canonical example. This pattern matters because Slice 7's Bilby implementation can be entirely backend work — the UI is already there.
- **A reusable debrief table.** With `debrief_type` discriminating the content shape, Slice 7's Bilby stages persist into the same `debriefs` table without a schema change. The dialectic audit trail lives in the same place as the Direct debriefs.
