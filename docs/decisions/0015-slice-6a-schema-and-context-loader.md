## Slice 6 sub-slice 6a close-out — schema delta + ContextLoader fill-in

> **Status:** CLOSED.
> **Date:** 27 May 2026.
> **Type:** sub-slice close-out.
> **Parent:** [`0013-slice-6-plan.md`](0013-slice-6-plan.md) §4 sub-slice 6a.
> **Predecessor:** [`0014-slice-6-dialectic.md`](0014-slice-6-dialectic.md).
> **Successor:** TBD (`0016-slice-6b-...` when 6b lands).
> **Subject:** Schema delta for `debriefs` + ContextLoader fill-in. Closes the Slice 6 pre-flight gate ([`0012-slice-6-preflight.md`](0012-slice-6-preflight.md)) and the six sub-slice gates of 6a; unblocks 6b's Opus client + `llm_calls` writer work.

---

### §1 What shipped

Three discrete pieces of work, all riding the same six-gate sequence (drafted → applied → ContextLoader → Zod → quality → close-out). Each gate held a manual approval pause; no work crossed a gate boundary without sign-off.

**Migration 0009** ([`supabase/migrations/0009_debriefs.sql`](../../supabase/migrations/0009_debriefs.sql)) adds the `debriefs` table with the Stage 3 `debrief_type` discriminator and the forward-looking `plan_stage_id` foreign key, extends `decisions.type` to the 11-value set (the existing 10 from migration 0008 plus `create_plan`), and registers `debriefs` on the `supabase_realtime` publication. Four indexes cover the per-session, per-plan-stage, per-project, and per-type read paths the Diff & Review surface and the upcoming Bilby stages need. The migration carries an explicit `IF EXISTS` on the constraint drop (idempotent on a partially-applied DB) and a comment-block rollback recipe restoring the post-0008 10-value set — never the post-0001 7-value set, which would re-break every live `start_work` / `dismiss` / `undismiss` row.

**ContextLoader fill-in** ([`lib/orchestration/context.ts`](../../lib/orchestration/context.ts)) rewrites `ContextLoader.buildFor` from a stub-emitting helper into the real assembly point for LLM context. The six fields (`claudeMd`, `recentDecisions`, `specs`, `skills`, `spec`, `priorDebrief`) now return real data; the cross-project assertion runs serially before any data fan-out so a wrong `projectId` throws `ContextLoaderCrossProjectError` without leaking queries; the per-field loads run in one `Promise.all` so a session-scope build is one assert plus `max(load)` round trips. The session-row read was widened from `select('project_id')` to `select('project_id, spec_id')` and renamed to `loadAndAssertSession` — one fetch covers both the project-id check and the spec lookup. Project scope fills the three project-level fields symmetrically with session scope (the §3.5 decision in the plan); plan scope deliberately stays stub until Slice 7.

**Types + Zod.** [`lib/types/db.ts`](../../lib/types/db.ts) gains the `Debrief` row type, the `DebriefType` literal union (`'direct' | 'bilby_draft' | 'bilby_critique' | 'bilby_consider' | 'bilby_validate'`), the `debriefs` entry in `Database['public']['Tables']`, and the widening of `DecisionType` with `'create_plan'`. [`lib/types/jsonb.ts`](../../lib/types/jsonb.ts) gains the minimum-viable `create_plan` stub variant in `DecisionPayload`'s discriminated union (sub-slice 6g extends with `source` / `routed_to` / `matched_rule` / `reason` when wiring the call site). [`lib/types/debrief.ts`](../../lib/types/debrief.ts) is new — re-exports the existing `DebriefContent` from `jsonb.ts` as `DirectDebriefSchema` (no rename, no consumer churn; the §3.8 divergence decision), and exposes a `DebriefSchema` discriminated union keyed on `debrief_type` with the `direct` arm wired and the four `bilby_*` arms set to `z.never()` until Slice 7.

Eight unit tests in [`lib/orchestration/context.test.ts`](../../lib/orchestration/context.test.ts) cover the new behaviour (four updated existing assertions plus four new tests, including a fan-out regression guard that introspects the `vi.fn`-wrapped `from` spy to assert only the `sessions` table was queried before a cross-project throw).

---

### §2 Conventions established in this sub-slice

Two patterns codified across the slice that future sub-slices and slices should inherit.

**Three-place type sync: SQL constraint, TS union, Zod variant.** Discriminator columns (`decisions.type` today; future ones in the same shape) live in three places: the SQL `check` constraint that gates writes, the TypeScript literal-union type that gates code, and the Zod discriminated union that validates payloads. When a value joins or leaves any one of them, the other two go with it in the same change. The trigger for naming the principle was pre-flight Item 9: an earlier draft of migration 0009 would have dropped the post-0008 `dismiss` / `undismiss` values from the `decisions.type` constraint silently (the dialectic-era draft was keyed to the post-0005 8-value set, not the live post-0008 10-value set), invalidating every existing row. The convention sweeps that whole failure-mode class — any future "add a decision type" / "add a status" / "add an actor enum" change updates all three places together, and the live constraint is checked against the live state of the database (not against the assumed state from a planning doc) before the change is drafted. Sub-slice 6a applied the rule end-to-end: `create_plan` joined the SQL constraint, the `DecisionType` TS union, and the Zod `DecisionPayload` stub variant in a single coordinated change.

**Divergence from planning doc: `new_concept` shape.** The Stage 3-integrated plan in [`0013-slice-6-plan.md`](0013-slice-6-plan.md) §3.1 sketched `new_concept: z.object({ name: z.string(), definition: z.string() }).optional()` as part of the four-section Direct debrief schema. The codebase already had the shape under different field names: `lib/types/jsonb.ts:200-211`'s `DebriefNewConcept` uses `{ title, body }`, and `app/sessions/[sessionId]/page.tsx:152-156` renders against those exact names. The existing convention wins — the rename would have touched the live mock fixture, the existing snapshot test, the production page render, the rendered output, and `lib/mock/agent-sdk-output.ts:47`'s exported `MockedDebrief = DebriefContentT` for zero behavioural change. The Gate 4 `DirectDebriefSchema` is a re-export of the existing `DebriefContent` rather than a redefinition. The rule for future planning docs: consult the existing code shapes before sketching alternatives. Dialectic drafting against a memory of the schema rather than the live file is the failure mode; one extra grep at the start of Stage 1 would have caught it.

---

### §3 Pre-flight findings that shaped the implementation

[`0012-slice-6-preflight.md`](0012-slice-6-preflight.md) executed before 6a's first commit, returning 4 GREEN / 4 AMBER / 2 RED across the ten items. The six items that drove implementation choices are reproduced here as a working audit trail; the four GREEN items are recorded in 0013 §7.1 and didn't change the slice shape.

**Item 1 — migration number.** Master was at 0008 (not 0011 as the Stage 1 dialectic draft assumed; the dialectic was working from an outdated mental model of the migration count). New migration is 0009. The amendment is small in itself but motivated the broader pattern of verifying live-DB state before any planning document gets ratified — the Stage 1 audit error in the migration number was the most superficial of three live/assumed mismatches the gate caught.

**Item 2 — session-runner exit + SDK message stream.** The dialectic assumed the worker reached a clean `done` status before any debrief work could trigger. Live behaviour (per Slice 5's lifecycle change) has the worker exit at `awaiting_review`; the operator drives the `done` transition via the action surface. Separately, the Agent SDK message stream is not persisted — the worker consumes it in-flight in the `for await` loop and the messages are discarded with the worker process. 6a only widened the ContextLoader return shape to make room for these realities; the runtime stitching lives in 6c (`generateDebrief(sessionId, messages: SDKMessage[])` takes the in-memory accumulator as a parameter) and 6d (the worker maintains the accumulator and passes it). The schema impact on 6a was the `priorDebrief` field's existence: it had to exist by the end of 6a so 6c could rely on `ContextLoader.buildFor('session', ...).priorDebrief` rather than building its own query.

**Item 3 — ContextLoader contract.** The API signature `buildFor(projectId, scope, secondaryId)` already matched the dialectic's expectations; the return shape was the issue. Six fields were stubbed (`null`, `[]`, `readonly never[]`). 6a wired all six with real loaders behind a single Promise.all fan-out. The widening required adding `Debrief`, `Decision`, `Spec` to the imports and shifting two `readonly never[]` types to `readonly Decision[]` and `readonly Spec[]` respectively; the change rippled into [`lib/orchestration/context.test.ts`](../../lib/orchestration/context.test.ts) where the mock client grew a generic chain builder to support the new query shapes.

**Item 5 — `llm_calls` writer.** [`lib/supabase/llm-calls.ts`](../../lib/supabase/llm-calls.ts) already exports `insertLlmCallFromAiSdkResult`, but the current signature is `plan_stage_id`-only — no `session_id` accepted, no `id` returned. 6a deliberately did not widen this; the widening is a 6b deliverable (the debrief generator needs to reference the `llm_calls` row via `llm_call_id` on the `debriefs` row, which means the writer must return `{ id }` and accept either `plan_stage_id` or `session_id`). The pricing table (`PRICE_PER_MILLION`, `computeCostUsd`) lives in the same file and was untouched by 6a — pre-flight Item 10 closed that path with "no new pricing module".

**Item 9 — `decisions.type` constraint regression.** The dialectic-era draft of migration 0009 listed the new constraint as if it were the post-0005 8-value set (the Stage 1 dialectic assumed migration 0008 hadn't happened yet — same outdated-mental-model failure mode as Item 1, but with much higher blast radius). Applied as-drafted, it would have dropped `dismiss`, `undismiss`, and the live post-0007 / 0008 production reality from the constraint and invalidated every existing row that used those types. The pre-flight Item 9 named the regression and the response shaped the *Three-place type sync* convention in §2 above. The corrected constraint extends the post-0008 10-value set to 11 — verified against the live cloud DB before the migration was applied (the live constraint reproduced verbatim is in [`0013-slice-6-plan.md`](0013-slice-6-plan.md) §4 sub-slice 6a's *Pre-migration safety check*).

**Item 10 — pricing file state.** A new `lib/llm/pricing.ts` was sketched in the dialectic as the home for Anthropic / xAI cost constants. The pre-flight check found the constants already live in [`lib/supabase/llm-calls.ts`](../../lib/supabase/llm-calls.ts) as `PRICE_PER_MILLION` (snapshot dated 22 May 2026) alongside the `computeCostUsd` consumer, and the file already honours cache-read (10%) and cache-creation (125%) pricing — exactly what the dialectic assumed a new file would have to add. 6a created no new pricing module. The dated-comment refresh strategy applies if any entries change in 6b.

---

### §4 Findings during live verification

Two seed-data gaps surfaced during the Gate 3 live probe against the cloud DB (project NB / Numbat). Neither is a 6a code defect; both are recorded here so the next operator (or future-me) reading this doesn't mistake the surfaced nulls for loader bugs.

**`projects.claude_md` is null on all four seeded projects.** The column exists from migration 0001 — the seed at [`lib/supabase/seed.ts`](../../lib/supabase/seed.ts) simply never populated it. The live probe disambiguated "column null in seed" from "loader broke" by temporarily setting `projects.claude_md = 'gate-3-probe-string-25-may'`, running `ContextLoader.buildFor(projectId, 'session', sessionId)`, asserting `ctx.claudeMd` matched the probe string (it did — 26 chars round-tripped), then restoring `null`. The loader read path is verified correct; the gap is in the seed. **Future slice:** populate the four projects with their actual CLAUDE.md content (Numbat's lives at the repo root; the other three need their respective project repos consulted). Out of 6a's scope; not a blocker for 6b–6h.

**`sessions.spec_id` is null on every seeded session.** No spec-creation flow exists yet — that lands with Slice 7's ship-from-Bilby-plan. The conditional `spec` branch in `loadSessionContext` (`specId !== null ? this.loadSpec(specId) : Promise.resolve(null)`) could not be exercised against live data. Coverage falls on the unit test `loadAndAssertSession threads spec_id correctly to ctx.spec` (both branches: `spec_id=null` returns `ctx.spec=null` with the project-level specs query still running; `spec_id=X` returns `ctx.spec.id===X` matching by id, not just any project spec). **Future slice:** re-run the live probe with a spec'd session once Slice 7's ship lands. Same out-of-scope status as the claude_md gap.

---

### §5 Gates closed (audit trail)

- **Gate 0** (pre-flight verification) — closed 25 May via [`0012-slice-6-preflight.md`](0012-slice-6-preflight.md): 10-item audit; 4 GREEN, 4 AMBER, 2 RED; amendments folded into 0013 as §1 framing + §2 fold-ins + §4 sub-slice plans.
- **Gate 1** (migration draft) — approved 26 May. SQL mirrored §5 of the plan; `IF EXISTS` on constraint drop; rollback recipe verified against the post-0008 baseline.
- **Gate 2** (migration apply + verification) — closed 26 May. `pnpm db:push` clean; PostgREST probes confirmed `create_plan` / `dismiss` / `undismiss` / `approve` all return 201, sentinel `banana` returns 400 with PG error code 23514 (`decisions_type_check`), `debriefs` table reachable. Realtime delivery verified live via browser spot-check on the Sessions surface (status update visible within 1–2 s, no refresh); the Node-side realtime probe failed silently due to a Node 25 / `@supabase/realtime-js` / Windows interop quirk, noted but not blocking — browser is the production path.
- **Gate 3** (ContextLoader fill-in) — closed 27 May. Six fields wired; 8 unit tests pass against the new mock client; live probe round-trip green for all six fields against project NB / session `a1435560-6085-410f-9a92-c8b0e4b6f5d9`; cleanup verified via three post-probe SELECTs (probe-id debrief absent, `claude_md` restored to null, no stray `v0-probe` rows anywhere).
- **Gate 4** (Zod schema) — closed 27 May. `DirectDebriefSchema` re-exports existing `DebriefContent`; `DebriefSchema` discriminated union with `direct` arm wired and `bilby_*` arms set to `z.never()`. Schema validated against the Gate 3 probe content (`safeParse(probe).success === true`); `bilby_*` arms correctly reject (`success === false`).
- **Gate 5** (final quality) — closed 27 May. `pnpm typecheck` clean; `pnpm lint` clean of errors (two pre-existing underscore-prefixed unused-param warnings on `_session` and `_cols` carry forward unchanged).
- **Gate 6** (this entry) — closed 27 May.

---

### §6 What this unblocks

- **Sub-slice 6b** can write `lib/llm/opus.ts` (the Anthropic AI-SDK wrapper with the two-part prompt-caching structure) and widen `insertLlmCallFromAiSdkResult` to accept `session_id` and return `{ id }` — the row type, the database shape, and the writer's existing pricing logic are all in place.
- **Sub-slice 6c** can write `lib/debrief/opus-debrief.ts` exporting `generateDebrief(sessionId, messages: SDKMessage[])` — the ContextLoader returns the project bundle and prior debrief in the contract 6c needs, and `DirectDebriefSchema` validates the Opus response shape at the AI SDK boundary.
- **Sub-slice 6d** can wire the worker (`scripts/session-runner.ts`) with the in-memory `messages: SDKMessage[]` accumulator passed to `generateDebrief` between `captureDiff` and `transitionToAwaitingReview`.
- **All subsequent sub-slices** inherit the *three-place type sync* convention (§2) — any addition to `decisions.type`, any new discriminator column, any status-enum widening updates SQL + TS + Zod in the same change.

---

### §7 Open follow-ups (not blocking)

- Seed `projects.claude_md` for the four projects (AO, WT, BB, NB) with their actual CLAUDE.md content. The loader read path is verified correct; this is purely a seed-data follow-up. Out-of-scope for Slice 6.
- Re-run the live ContextLoader probe with a spec'd session once Slice 7's ship-from-Bilby-plan lands — the conditional `loadSpec` path needs at least one live exercise alongside the unit-test coverage already in place.
- Consider a CLAUDE.md note about the `scripts/_one-off-*.ts` scratch-script convention if more live probes accumulate. Three usages this slice (realtime publication probe in Gate 2; ContextLoader live probe in Gate 3; Zod schema-check in Gate 4); each was written, run, and deleted in the same gate. Worth codifying if a fourth lands.
- Investigate the Node 25 / `@supabase/realtime-js` / Windows WebSocket interop quirk if any future Node-side realtime check is needed. Low priority — the browser is the production realtime path and is verified working.
- Slice 7 replaces the `z.never()` content fields on the four `bilby_*` arms of `DebriefSchema` with real per-arm schemas (Bilby drafts, critiques, considered responses, validations). The discriminator exhaustiveness against `DebriefType` is already in place.
