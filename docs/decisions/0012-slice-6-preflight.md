# Slice 6 Pre-flight Verification Gate

> **Status:** AMBER overall. Two RED items, four AMBER items, four GREEN items. Plan amendments required in `docs/decisions/0013-slice-6-plan.md` before sub-slice 6a begins.
> **Date:** 25 May 2026.
> **What this file is:** Execution of the ten-item pre-flight verification gate defined in `0013-slice-6-plan.md` §7. Companion to that plan and to `0014-slice-6-dialectic.md` — all three files will be renumbered together (preflight first, plan second, dialectic third) once the plan amendments listed below are folded in.

This file captures what the codebase actually looks like on master today against the assumptions the Stage 1 draft made and the Stage 2 critique elevated. The point of the gate is to catch the assumption drift now — cheap — rather than during sub-slice 6c or 6d, where it would be painful.

---

## §1 · Summary table

| #  | Assumption                                                                                       | Status | Note                                                                                                                                                            |
|----|--------------------------------------------------------------------------------------------------|--------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1  | Last migration on master is `0011`.                                                              | AMBER  | Last is `0008_slice_5_dismiss_decision_types.sql`. Next migration takes number `0009`, not `0012`.                                                              |
| 2  | `scripts/session-runner.ts` has a clean post-`done` hook + session result includes message stream. | RED    | Worker exits at `awaiting_review`, not `done`; `done` is reached by operator approval elsewhere. SDK message stream is consumed in the for-await loop and **not** persisted — only diff + modelUsage + agent_session_id. |
| 3  | `ContextLoader.buildFor(projectId, 'session')` returns project bundle + spec + task + diff + Agent SDK message stream. | AMBER  | API signature matches and is enforced (`buildFor(projectId, 'session', sessionId)`). Return shape is currently a typed stub: `claudeMd`, `specs`, `recentDecisions`, `spec`, `priorDebrief` are all `null`/empty; only `skills` is populated. Filling these in is Slice 6 work, not a contract change. |
| 4  | `app/api/start-work/route.ts` + Bilby routing currently creates a session stub or nothing.        | GREEN  | Already creates a real plan stub via `lib/orchestration/create-plan.ts:createPlan` and redirects to `/plans/<id>`. Emits a `decisions` row of type `start_work` (not `create_plan`).                                                                |
| 5  | `lib/supabase/llm-calls.ts` exports `insertLlmCallsFromModelUsage` + no conflicting AI-SDK writer. | AMBER  | `insertLlmCallsFromModelUsage` exists ✓. An AI-SDK-direct writer also already exists as `insertLlmCallFromAiSdkResult` (note `Result` suffix) and is keyed on `plan_stage_id` only — no `session_id` support. Reusable for Slice 7 Bilby but needs a small extension for Slice 6's session-keyed debrief writes. |
| 6  | Diff & Review page renders a four-section mock from a fixture or hardcoded object.                | GREEN  | One production reference: `app/sessions/[sessionId]/page.tsx:35,89,144–156`. Mock data lives in `lib/mock/agent-sdk-output.ts` and is consumed via `getMockedOutputForSession`. `components/review/debrief-block.tsx` is the renderer; presentation-only. Seed fixtures in `lib/supabase/seed-mock-sessions.ts`. |
| 7  | Sessions surface realtime subscription pattern is reusable verbatim.                              | GREEN  | `components/sessions/session-list.tsx:44–82` uses `sb.channel('sessions:all').on('postgres_changes', …).subscribe()` with a `removeChannel` cleanup. Pattern is clean, isolated, and copyable for `plans` and `plan_stages`. |
| 8  | `plans` + `plan_stages` tables have the columns the plan assumed.                                | GREEN  | `plans`: id, project_id, title, brief, status, created_at, updated_at, spec_id — all present (`spec_id` added via trailing ALTER per circular FK). `plan_stages`: id, plan_id, stage_num, actor, action, llm_provider, model, content, duration_ms, created_at. The extra `actor` column (`opus`/`grok`/`claude_agent`) is a useful Slice 7 win — Bilby stages can record their authoring model without overloading `llm_provider`. |
| 9  | No existing `debriefs` table or conflicting `decisions.type` constraint.                          | RED    | No `debriefs` table ✓. **But** `decisions.type` was extended in `0005` (added `start_work`) and `0008` (added `dismiss`, `undismiss`). Current allowed set is 10 values; the plan's proposed migration in §5 drops three of them (`start_work`, `dismiss`, `undismiss`) when adding `create_plan`, which would invalidate every existing row of those types. |
| 10 | `lib/llm/pricing.ts` is empty, missing, or partially populated.                                   | AMBER  | File does not exist (matches the literal assumption). **But** the pricing logic — `PRICE_PER_MILLION` table (Opus 4.6/4.7 + Grok-4) and `computeCostUsd` — already lives in `lib/supabase/llm-calls.ts` with a dated "snapshot taken 22 May 2026" comment. The plan's instruction to "add Anthropic price constants to `lib/llm/pricing.ts`" would duplicate this. |

---

## §2 · Details

### Item 1 — Migration number (AMBER)

**Found:** `ls supabase/migrations/` lists eight files, last is `0008_slice_5_dismiss_decision_types.sql`. The Stage 1 draft assumed the last migration was `0011` (the plan file uses `<NNNN>_debriefs.sql` as a placeholder but every reference to the predecessor numbering chain assumed three more Slice 5 migrations than actually shipped).

**Evidence:** `ls supabase/migrations/` returns `0001_initial.sql`, `0002_llm_calls_session_id_cascade.sql`, `0003_projects_chip_colours.sql`, `0004_cleanup_fixture_projects.sql`, `0005_decisions_type_start_work.sql`, `0006_slice4_status_killing_and_diff.sql`, `0007_slice_5_fk_set_null_and_dismissed_at.sql`, `0008_slice_5_dismiss_decision_types.sql`.

**Plan amendment:** In `0013-slice-6-plan.md`:
- §2 scope item 1: change "the draft used `0012`" parenthetical to "the draft assumed `0011`; master is at `0008`."
- §4 sub-slice 6a: the migration number is `0009`, not `0012`.
- §5 data model deltas SQL comment block: update the migration filename to `0009_debriefs.sql`.
- §7 item 1: text remains as a verification step but the post-gate result ("last migration on master is `0008`; new migration is `0009`") gets recorded here in this preflight file as the canonical answer.

### Item 2 — Session-runner hook point + message history (RED)

**Found two distinct problems:**

**(a) Exit status.** The Stage 1 draft phrased the trigger as "when a session-runner worker exits cleanly with `status = done`, it triggers the debrief generator before exiting" (the plan's §2 item 3 and §3.1). The Slice 4 / Slice 5 worker does **not** transition to `done` — it transitions to `awaiting_review` and then exits. The `done` status is reached only after operator approval, which is recorded via a `decisions` row of type `approve` and a separate status transition handled outside `scripts/session-runner.ts` (see `lib/supabase/mutations/session-status.ts`, used by the operator action surface from Slice 5). The plan's parenthetical "(or `awaiting_review` — depending on what Slice 5 decided)" gestured at the right thing, but the resolution needs to be explicit.

**(b) Message stream is not persisted.** `scripts/session-runner.ts:342–442` consumes the Agent SDK message stream via `for await (const message of q)` and acts on each message (extract tool-use path for `current_step`, detect `system/init` for `agent_session_id`, detect `result/success` to capture diff + fan-out `llm_calls`, detect `result/error_*` to record the error). Only `modelUsage`, `duration_ms`, the diff, and `agent_session_id` are persisted. The assistant message bodies are dropped when the loop exits. Stage 1 §3.1 stated: "The Agent SDK's message stream is what the debrief actually summarises — the diff alone doesn't capture intent, the spec alone doesn't capture what actually happened. The Agent SDK already exposes message history via its session result; we hand it to Opus." That last sentence is wrong on the current codebase — there is no `session.result` object with full message history after the worker exits.

**Evidence:** `scripts/session-runner.ts:376–392` (result/success path: capture diff, fan out llm_calls, `transitionToAwaitingReview`, break — no message persistence); `lib/feathertail/agent-sdk.ts:11` (`Query` extends `AsyncGenerator<SDKMessage, void>` — messages are streamed, not collected).

**Plan amendment:** In `0013-slice-6-plan.md`:
- §2 scope item 3 + §3.1 trigger: change "exits cleanly with `status = done`" to "transitions to `awaiting_review`". The debrief generator is invoked **inside the worker's result/success branch, after the diff capture and llm_calls fan-out, before `transitionToAwaitingReview`** — or immediately after, accepting that the row briefly shows `awaiting_review` with no debrief while the call is in flight (which the Diff & Review surface already handles via the "Debrief generating…" empty state in §4 sub-slice 6e).
- §3.1 context assembly: drop the claim that ContextLoader returns the message stream. Either (i) the worker accumulates messages into a local array during the for-await loop and passes the array directly into `generateDebrief(session_id, messages)`; or (ii) the worker stores the assistant messages on a new `sessions.message_log jsonb` column (out of Slice 6 scope; would require a schema change) and the debrief generator reads them back. Option (i) is the minimal change — preferred. Update §3.1 to read: "Context assembly: project bundle (CLAUDE.md, last 30 decisions, active specs, skills) from `ContextLoader.buildFor(projectId, 'session', sessionId)`; spec + task from the session row; diff from the just-captured `session.diff`; **assistant message stream from the in-memory accumulator in `session-runner.ts`, passed as a parameter to `generateDebrief`**."
- §4 sub-slice 6c acceptance: `generateDebrief` takes `(sessionId, messages: SDKMessage[])` rather than just `sessionId`. The CLI script `pnpm tsx scripts/generate-debrief.ts <session_id>` either (a) is dropped from the slice, because there's no message stream to replay without a re-run, or (b) accepts a `--messages-file <path.jsonl>` argument for replay testing. Pick (b) for testability; capture the chosen variant in the 6c sub-slice plan.
- §4 sub-slice 6d wiring: the worker maintains a `messages: SDKMessage[] = []` array, pushes each message in the for-await loop, and passes it to `generateDebrief` immediately after `captureDiff` and `insertLlmCallsFromModelUsage`. Add a stress note: messages are memory-resident, so a very long session could be large. Stage 6 acceptance: confirm via a real run that the array size for a typical session stays under a few MB.
- §6 acceptance criterion 3: change "session reaches `done`" to "session reaches `awaiting_review`" for the debrief-presence check. Criterion 4 (failure path) is unchanged.

This is the most consequential plan amendment in the gate.

### Item 3 — ContextLoader contract (AMBER)

**Found:** The `ContextLoader` class in `lib/orchestration/context.ts` already exists with the exact public-API signature the plan assumed:

```ts
buildFor(projectId: string, scope: "session", sessionId: string): Promise<SessionContext>
```

The `SessionContext` type fields are typed correctly (`claudeMd: string | null`, `specs: readonly never[]`, `skills: readonly Skill[]`, `recentDecisions: readonly never[]`, `sessionId`, `spec: null`, `priorDebrief: null`). The cross-project assertion (`assertSessionInProject`) is in place and works. Only `skills` is actually populated from the database (Slice 3 wired this). The other fields are typed stubs awaiting Slice 5 / 6 fill-in — the file comment even says: `"V1 stubs. Slice 5 wires the rest of the loaders (claudeMd, specs, recentDecisions)."`

**Evidence:** `lib/orchestration/context.ts:76–198`.

**Plan amendment:** In `0013-slice-6-plan.md`:
- §3.1 context assembly: do not assume `ContextLoader` returns `claudeMd`, `specs`, `recentDecisions` populated. Sub-slice 6a (or a new 6a.1) must wire these. Concretely: read `projects.claude_md` for the project bundle's `claudeMd`; query `specs` filtered by `project_id` ordered by `created_at desc limit N`; query `decisions` for the project ordered by `created_at desc limit 30`. None of these are large lifts but they are real work, not pure verification.
- §3.3 ContextLoader integration: add an explicit sub-bullet listing the four loaders to be filled in (`claudeMd`, `specs`, `recentDecisions`, `spec` for the session) and confirm the type widening (e.g. `specs: readonly Spec[]`, `recentDecisions: readonly Decision[]`).
- The `priorDebrief: null` field will be filled in once `debriefs` exists — that part fits 6a cleanly.
- The `SessionContext` does **not** carry the message stream and should not be amended to — per Item 2, the messages flow through a different path (in-memory array passed from the worker).

This is AMBER not RED because the contract holds; what changes is the volume of fill-in work in sub-slice 6a.

### Item 4 — Start Work current behaviour (GREEN)

**Found:** `app/api/start-work/route.ts` is the orchestration entry. It validates the request, routes the brief via `lib/orchestration/router.ts`, and branches:

- `decision.pipeline === 'direct'` → `createSession({ projectId, brief, decision })` then `spawnSessionWorker(id)` then return `{ redirect_url: '/sessions/<id>' }`.
- otherwise (Bilby) → `createPlan({ projectId, brief, decision })` then return `{ redirect_url: '/plans/<id>' }`.

`createPlan` in `lib/orchestration/create-plan.ts` writes a real `plans` row with `status = 'drafting'`, `brief`, derived `title`, and emits a `decisions` row of type `start_work` (carrying the router's classification in `payload`).

**Evidence:** `app/api/start-work/route.ts:81–106`; `lib/orchestration/create-plan.ts:29–58`.

**Plan amendment:** None blocking. **One small design call to settle in the plan text** (will not break anything either way): the plan's §2 item 8 and §4 sub-slice 6g acceptance reference a new `create_plan` decision type for plans created from the "New Plan" button on the Plans index. The existing brief-triggered plan creation in Start Work uses `start_work`. The two paths are honestly different (brief-routed-to-Bilby vs operator-initiated-plan), so two decision types is defensible — but if reusing `start_work` keeps the audit log cleaner, that's also defensible. Recommend: **keep `create_plan` as a distinct type**, since the operator-initiated path has no router classification to record. Plan should be slightly amended to clarify the distinction:

- §2 item 7 (the Server Action): "Insert a `decisions` row of type `create_plan` carrying `{ source: 'plans_index' }` in the payload, distinct from `start_work` which is emitted from `/api/start-work` when a routed brief lands as a plan."

### Item 5 — llm_calls writer (AMBER)

**Found:** `lib/supabase/llm-calls.ts` already exports **both** `insertLlmCallsFromModelUsage` (Agent SDK fan-out path, used by `session-runner.ts`) **and** `insertLlmCallFromAiSdkResult` (AI-SDK direct path, single-row). The latter takes:

```ts
type InsertLlmCallFromAiSdkResultInput = {
  project_id: string;
  plan_stage_id: string;             // REQUIRED — no session_id
  provider: 'anthropic' | 'xai';
  model: string;
  usage: LanguageModelUsage;         // AI SDK v6 shape
  duration_ms: number;
  prompt_hash?: string | null;
  error?: LlmCallErrorT | null;
};
```

It computes cost locally via `computeCostUsd(model, usage)` against the in-file `PRICE_PER_MILLION` table. So most of the sub-slice 6b "Opus client + llm_calls writer" work is already done — except the function only supports `plan_stage_id` keying and explicitly sets `session_id: null` on insert (`lib/supabase/llm-calls.ts:215`).

**Evidence:** `lib/supabase/llm-calls.ts:7–95` (price table + `computeCostUsd`); `:129–171` (Agent SDK writer); `:173–233` (AI SDK writer).

**Plan amendment:** In `0013-slice-6-plan.md`:
- §3.3 shared Opus infrastructure: replace the "we add a sibling `insertLlmCallFromAiSdk(usage, cost)` for the single-model AI SDK path" with: "the existing `insertLlmCallFromAiSdkResult` in `lib/supabase/llm-calls.ts` is extended to accept either `session_id` or `plan_stage_id` (at-least-one constraint, matching the `debriefs` table's discriminator pattern). The function's return value is widened to `Promise<{ id: string }>` so the debrief writer can reference the row via `llm_call_id`."
- §3.3 cost computation block: drop the sketched `insertLlmCallFromAiSdk` signature and reference the existing function shape (with the `session_id?` / `plan_stage_id?` widening noted above).
- §4 sub-slice 6b: replace "Opus client + llm_calls writer" with "Opus client + llm_calls writer extension". The work is smaller: extend the existing function rather than write a new one.

### Item 6 — Diff & Review mock data (GREEN)

**Found:** Exactly one production code reference to the four-section mock: `app/sessions/[sessionId]/page.tsx:35` imports `getMockedOutputForSession` from `lib/mock/agent-sdk-output.ts`, calls it at `:89`, and renders the four `DebriefBlock`s at `:144–156`. The `DebriefBlock` component in `components/review/debrief-block.tsx` is presentation-only (`title` + `body` props, server component). The mock module is the canonical fixture. Seed sessions in `lib/supabase/seed-mock-sessions.ts` reference the same fixture for test data; those are intentional and acceptable to keep as test-time fixtures per the plan's §2 fold-in instruction.

**Evidence:** `app/sessions/[sessionId]/page.tsx:35,89,144–156`; `components/review/debrief-block.tsx`; `Grep -l 'debrief|fourSection|mock.debrief'` returned `tsconfig.tsbuildinfo`, `app/sessions/[sessionId]/page.tsx`, `lib/types/db.ts`, `lib/types/jsonb.ts`, `lib/types/jsonb.test.ts`, `components/review/debrief-block.tsx`, `lib/mock/agent-sdk-output.ts`, `lib/supabase/seed-mock-sessions.ts`. The non-test production hit set is small and the rendering path is clean.

**Plan amendment:** None. Sub-slice 6e's audit step (§2 fold-in, §4 sub-slice 6e first action) is still the right discipline — it's just expected to be short. Pre-record the result here: the audit will find one production read path (`app/sessions/[sessionId]/page.tsx`) and two test/fixture reads (`lib/supabase/seed-mock-sessions.ts`, `lib/mock/agent-sdk-output.ts` itself).

### Item 7 — Realtime subscription pattern (GREEN)

**Found:** `components/sessions/session-list.tsx:44–82` shows the canonical pattern: open a single `sb.channel('<name>')`, attach a `.on('postgres_changes', { event: '*', schema: 'public', table: '<table>' }, handler)`, call `.subscribe()`, and return a cleanup that calls `sb.removeChannel(channel)`. The pattern handles INSERT / UPDATE / DELETE cases inside the handler and is wired to `useState` + `useSearchParams` for derived filtering — exactly the shape the Plans surface needs.

**Evidence:** `components/sessions/session-list.tsx:44–82`. Several other components (`session-status-subscriber.tsx`, `cost-badge.tsx`, the kill subscription in `session-runner.ts:296–326`) follow the same shape, confirming it's a stable convention.

**Plan amendment:** None.

### Item 8 — plans + plan_stages schema (GREEN)

**Found:** `supabase/migrations/0001_initial.sql:29–39` (plans) and `:84–99` (plan_stages). Columns match the plan's assumptions. Notable extras:

- `plans.spec_id uuid references specs(id)` (added via trailing ALTER for the circular FK with `specs`). The plan didn't need this for Slice 6 but it's already there and harmless.
- `plan_stages.actor text check (actor in ('opus', 'grok', 'claude_agent'))`. The plan assumed `action` (`draft`, `critique`, `consider`, `validate`, `execute`, `debrief`) but the `actor` column adds an authorship dimension. Slice 7's Bilby will use it for free.

`plans.status` allowed values: `'drafting', 'critiquing', 'considering', 'validating', 'ready', 'shipped', 'abandoned'` — exactly the set the plan's status-pill mapping in §3.2 assumed.

**Evidence:** `supabase/migrations/0001_initial.sql:29–99`.

**Plan amendment:** None blocking. **One small addition worth recording for Slice 7:** mention the `plan_stages.actor` column in §3.2 / §3.4 layer mapping so it's visible when Bilby starts writing rows. Optional; not required for sub-slice 6a to start.

### Item 9 — No conflicts (RED)

**Found:** No `debriefs` table on master ✓. **But** the `decisions.type` check constraint has been extended twice since `0001_initial.sql`:

- `0005_decisions_type_start_work.sql` adds `'start_work'`.
- `0008_slice_5_dismiss_decision_types.sql` adds `'dismiss'` and `'undismiss'`.

Current allowed types (after `0008`): `'approve', 'redirect', 'kill', 'accept_critique', 'reject_critique', 'ship', 'edit_spec', 'start_work', 'dismiss', 'undismiss'` (10 values).

The plan's proposed migration in `0013-slice-6-plan.md` §5 writes:

```sql
alter table decisions add constraint decisions_type_check
  check (type in (
    'approve', 'redirect', 'kill',
    'accept_critique', 'reject_critique',
    'ship', 'edit_spec', 'create_plan'
  ));
```

This drops `'start_work'`, `'dismiss'`, and `'undismiss'` from the allowed set. Every existing row carrying one of those types — and there will be many (every brief submission and every dismiss/undismiss action since Slice 2b) — would fail the new check constraint, causing `ALTER TABLE … ADD CONSTRAINT` to error out. Even if the migration completed (e.g. `NOT VALID` then no `VALIDATE`), subsequent inserts of `'start_work'` from `/api/start-work` and `'dismiss'`/`'undismiss'` from the Slice 5 dismiss UI would fail.

**Evidence:** `supabase/migrations/0005_decisions_type_start_work.sql:11–20`; `supabase/migrations/0008_slice_5_dismiss_decision_types.sql:15–27`.

**Plan amendment (RED, must fix before migration runs):** In `0013-slice-6-plan.md` §5 the proposed migration body must include all current types plus `create_plan`. Concretely:

```sql
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
```

Same correction in the rollback SQL comment block: the inverse `ADD CONSTRAINT` must restore the **post-0008** set (10 values), not the post-0001 set (7 values). The plan's current rollback restores `'approve', 'redirect', 'kill', 'accept_critique', 'reject_critique', 'ship', 'edit_spec'` — also wrong, would re-break `start_work`, `dismiss`, `undismiss` on rollback.

This is a hard requirement before `0009_debriefs.sql` runs against any DB with real Slice 2b / 5 data.

### Item 10 — Pricing file state (AMBER)

**Found:** `lib/llm/pricing.ts` does not exist on master (matches the literal assumption). **But** the pricing logic the plan calls for already lives in `lib/supabase/llm-calls.ts:7–95`:

- A 40-line dated comment block explaining the snapshot (taken `22 May 2026`), the Anthropic tier note, and the xAI caching placeholder caveat.
- `PRICE_PER_MILLION: Record<string, PriceRow>` with rows for `claude-opus-4-7`, `claude-opus-4-6`, `grok-4-latest`, `grok-4`.
- `computeCostUsd(model, usage)` honouring `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` per the AI SDK v6 `LanguageModelUsage` shape.

The plan's instruction to "add Anthropic price constants to `lib/llm/pricing.ts`" (in §2 scope item, §3.3 shared infrastructure, §4 sub-slice 6a) would duplicate this.

**Evidence:** `lib/supabase/llm-calls.ts:7–95`.

**Plan amendment:** In `0013-slice-6-plan.md`:
- Decide between two options, then update the plan:
  - **Option A (recommended) — leave the pricing in place.** Drop the "add `lib/llm/pricing.ts`" line items from §2, §3.3, and §4 sub-slice 6a. Reference the existing location in `lib/supabase/llm-calls.ts`. The next price refresh updates that file's snapshot date. Minimal churn.
  - **Option B — move the pricing to a dedicated module.** Create `lib/llm/pricing.ts` and move `PRICE_PER_MILLION` + `computeCostUsd` there; have `lib/supabase/llm-calls.ts` import from it. Cleaner separation but a refactor for refactor's sake. Optional.
- Recommend Option A: the comment block in `lib/supabase/llm-calls.ts` is already strong, the function is co-located with its only caller, and the plan's V1 cost-table call-out was about *having* a maintained price table, not where it lives.
- The dated snapshot is already present (`22 May 2026`); update the TODO referenced in the Stage 3 considered response to point at the existing location.

---

## §3 · Verdict

**Plan amendments required before sub-slice 6a.** Two RED items (Item 2 — session-runner hook + message history; Item 9 — `decisions.type` constraint drift) materially affect the slice design and the migration safety. Four AMBER items (Items 1, 3, 5, 10) require smaller plan-text adjustments to align with what's already on master. Four GREEN items (Items 4, 6, 7, 8) confirm assumptions hold as stated.

**Operator to-do** before re-confirming and starting sub-slice 6a:

1. Update `docs/decisions/0013-slice-6-plan.md` in place to fold in all amendments listed in §2 above. Most are line-level edits in §2 scope, §3.1 / §3.3 architecture, §4 sub-slices 6a / 6b / 6c / 6d / 6g, §5 data model deltas (RED — fix the constraint), and §6 acceptance criterion 3.
2. Re-run this preflight verification (or read the diff and confirm) once the plan amendments land.
3. Renumber all three artifacts using the next three consecutive sequence numbers (see §4 below).
4. Begin sub-slice 6a from the amended plan.

If any amendment surfaces a deeper design question (especially the in-memory message stream / how-far-to-stretch-the-worker question from Item 2), surface it as a Stage 4 follow-up to the dialectic rather than silently absorbing it into the plan. The dialectic file (`0014-slice-6-dialectic.md`) has a meta-observations section that's the right place to record gaps the gate caught that the four-stage run missed.

---

## §4 · Renumbering note

Last decisions-log file on master is `0011-slice-5-close-out.md`. The three Slice 6 artifacts take the next three consecutive numbers:

| Placeholder filename                          | Renumber to                                                              | Order                  |
|-----------------------------------------------|--------------------------------------------------------------------------|------------------------|
| `0012-slice-6-preflight.md` (this file)       | `docs/decisions/0012-slice-6-preflight.md`                               | First — gate runs before the plan executes. |
| `0013-slice-6-plan.md`                        | `docs/decisions/0013-slice-6-plan.md`                                    | Second — the artifact the gate verifies and the slice executes from. |
| `0014-slice-6-dialectic.md`                   | `docs/decisions/0014-slice-6-dialectic.md`                               | Third — companion audit trail to the plan. |

Renumber **after** the plan amendments land, so the renamed `0013-slice-6-plan.md` is the corrected version. Update internal cross-references in all three files in the same commit (each currently uses `00XX-` placeholders for the others).
