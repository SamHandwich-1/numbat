> File: docs/decisions/0016-slice-6b-opus-client-and-llm-calls-extension.md

## Slice 6b close-out — Opus client (callOpusObject) + llm_calls writer extension

> **Status:** CLOSED.
> **Date:** 30 May 2026.
> **Type:** Sub-slice close-out.
> **Parent:** [`0013-slice-6-plan.md`](0013-slice-6-plan.md) §4 sub-slice 6b ("Opus client + llm_calls writer + prompt caching architecture").
> **Predecessor:** [`0015-slice-6a-schema-and-context-loader.md`](0015-slice-6a-schema-and-context-loader.md) (the immediate Slice 6 numbered work; 0017 is the parallel mid-slice side-task, not the sequential predecessor).
> **Successor:** TBD — Slice 6c (debrief generator at `lib/debrief/opus-debrief.ts`) when it lands.
> **Subject:** Two-function transition on [`lib/llm/opus.ts`](../../lib/llm/opus.ts) — `callOpusObject` ships as the structured-output, prompt-cached, structured-logged path used by Slice 6c's debrief generator and Slice 7's Bilby stages; `callOpus` retained with a deprecation header pointing to Slice 7's migration trigger. Widened [`lib/supabase/llm-calls.ts:insertLlmCallFromAiSdkResult`](../../lib/supabase/llm-calls.ts) accepts `session_id` alongside `plan_stage_id` (at-least-one-non-null contract) and returns `{ id: string }`. Eighteen new unit tests across the two paths (10 mocked-AI-SDK on `callOpusObject`, 8 mocked-Supabase on the widened writer). Commits: `aeb55bf` (Gate 2), `e2b5e26` (Gate 3), `6a00815` (Gate 4), plus the mid-slice RLS side-task commit `4f5f184` flagged as parallel work, not a 6b sub-gate.

---

### §1 · Original plan position

[`0013-slice-6-plan.md`](0013-slice-6-plan.md) §3.3 ("Shared Opus infrastructure") and §4 sub-slice 6b framed the work as **"one Opus client"** — a single function in `lib/llm/opus.ts` wrapping `@ai-sdk/anthropic` with a Zod schema, two-part prompts (stable prefix marked cache-eligible + per-call dynamic suffix), typed errors, and structured logging. The original Slice 6b proposal at the start of this sub-slice's first session (pre-Gate-1) reached the same target shape.

**The in-flight finding that widened the plan.** Step-1 reads of master surfaced that [`lib/llm/opus.ts`](../../lib/llm/opus.ts) already existed as a text-only spike helper (`callOpus({ prompt, timeoutMs })` returning text + usage), consumed by exactly one call site: [`scripts/bilby-dialectic.ts:37,601`](../../scripts/bilby-dialectic.ts) — the proto-Bilby spike that Slice 7 will replace. The "one Opus client" framing assumed greenfield; the actual file had a live consumer that the plan's intent ("Slice 6 only needs Anthropic per 0013 §2 'Out (deferred to Slice 7)'") would otherwise have broken.

The first proposal-stage move in 6b was therefore to widen the plan: **two functions during the Slice 6 → Slice 7 transition** — `callOpusObject` ships now with the full feature set; `callOpus` stays unchanged with a deprecation header naming Slice 7's `bilby-dialectic.ts` migration as the trigger for its deletion. This was approved at the proposal stage with explicit rationale (smaller blast radius; the spike file is about to die anyway; the deprecation comment makes the death scheduled rather than vague). §7 below names the trigger condition explicitly.

---

### §2 · What 6b actually shipped

Five sub-gates per the gate-by-gate approval cadence established in earlier slices. Each gate held a manual approval pause; no work crossed a gate boundary without sign-off.

- **Gate 1 — SDK shape verification** (no commit; findings folded into Gate 2's commit message body). Two read-only checks: (a) cache-control SDK shape at `@ai-sdk/anthropic@3.0.78` — verified per-message breakpoint syntax (`providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`) matches the spec exactly, default TTL 5m, confirmed at both the schema declaration (`node_modules/@ai-sdk/anthropic/dist/index.d.ts:193-196`) and the docs file (`docs/05-anthropic.mdx:629-636`); (b) `bilby-dialectic.ts` back-compat for the planned writer widening — verified non-breaking on all three axes (`plan_stage_id` still provided, `session_id` defaults to null, return value already discarded). Plus the 4096-token cache-payload caveat surfaced as a third finding worth flagging at the call site (see §5).
- **Gate 2 — `callOpusObject` implementation + pino logging + deprecation of `callOpus`** (`aeb55bf`). `lib/llm/opus.ts` widened from the 80-line text-only spike to a 332-line module hosting both functions; CLAUDE.md "Resilience" line updated from `Opus debrief 60s` to `Opus debrief 90s`; parallel Bilby stub note added to `lib/llm/grok.ts`. Pino added as a runtime dependency (`pino@10.3.1`) via `pnpm add pino`. Four Bilby call-site stubs as comment blocks at the bottom of `opus.ts` confirm the interface generalises across the four Slice 7 stages (`draft`, `critique`, `consider`, `validate`).
- **Gate 3 — `lib/llm/opus.test.ts` × 10 tests** (`e2b5e26`). Mocked-AI-SDK coverage across happy-path Zod validation, validation-failure error surfacing, prompt-hash determinism + prefix-independence (load-bearing for the cache architecture), cache-control marker passing, typed error classification (4xx no-retry / 5xx retries-twice-via-fakeTimers / timeout / validation), structured log emission with all nine fields, and requestId echo + uuid fallback.
- **Gate 4 — widen `insertLlmCallFromAiSdkResult` + 8 mocked-Supabase tests** (`6a00815`). Eight signature/body changes to [`lib/supabase/llm-calls.ts`](../../lib/supabase/llm-calls.ts) per the gate spec: `plan_stage_id` becomes optional, `session_id` joins as optional, runtime check throws `"insertLlmCallFromAiSdkResult: at least one of plan_stage_id or session_id must be non-null"` before any other work, return type widens from `Promise<void>` to `Promise<{ id: string }>` (so Slice 6c's debrief writer can reference the row via `llm_call_id` on the `debriefs` row), insert chain becomes `.insert(row).select("id").single()`, hardcoded `session_id: null` dropped from the row literal, `PRICE_PER_MILLION` + `computeCostUsd` + `LlmCallError.parse` untouched per spec. Eight tests added to `lib/supabase/llm-calls.test.ts` (live-DB describe block untouched): session_id/plan_stage_id acceptance permutations × 3, both-null-throws-with-named-fields-error, returns-`{id}`-from-insert, cost-arithmetic with-and-without cache (10% cacheRead + 125% cacheWrite multipliers verified), unknown-model documented-not-endorsed silent zero with the `TODO(post-6b)` comment.
- **Gate 5 — this entry**.

**Parallel work that landed during 6b but did not pollute the 6b attribution.** A mid-slice RLS side-task was injected between Gates 2 and 3, prompted by the Supabase Security Advisor surface. It landed as commit `4f5f184` with its own decision log entry at [`0017-enable-rls-with-service-role-bypass.md`](0017-enable-rls-with-service-role-bypass.md) — migration `0010_enable_rls.sql` + CLAUDE.md + brief edits, all bundled in a single coherent commit separate from 6b's gate sequence. This entry includes the side-task in §9's audit trail for completeness but flags it as parallel, not a sub-gate. The convention worth carrying forward: mid-slice side-tasks get their own commit + decision log, never get bundled into the host sub-slice's commits — keeps attribution clean for both surfaces.

---

### §3 · Chosen shape

**Two-function transition on `lib/llm/opus.ts`.**

- **`callOpusObject<TSchema>`** — the structured-output path. Signature: `{ schema, stablePrefix, dynamicSuffix, timeoutMs, requestId? } → Promise<{ object, text, usage, finishReason, durationMs, model, promptHash, requestId }>`. Uses AI SDK v6 `generateObject` with a two-message array: system message containing `stablePrefix` marked cache-eligible via `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`, user message containing `dynamicSuffix`. `promptHash` is `sha256(dynamicSuffix).digest('hex').slice(0, 16)` — computed on the dynamic portion only so identical project bundles produce identical hashes (the load-bearing assertion behind the cache architecture). Retry: max 2 retries (3 attempts total) with 1s/2s exponential backoff on `http_5xx` / `network` / `unknown`; **no retry on `http_4xx` (caller bugs), `validation` (bad model output), or `timeout` (caller chose the budget)**. Six typed `OpusCallErrorKind` values; classify-error order matters — `abort.signal.aborted` wins first, then name-based detection for validation, then status-code-based for HTTP, then name-based for network/timeout, default `unknown`.
- **`callOpus`** (text-only, retained). Body unchanged from the pre-6b spike. Header gains an explicit deprecation comment naming Slice 7's `bilby-dialectic.ts` migration as the trigger for deletion. The two functions share no internal machinery in 6b — duplication is intentional and bounded (Slice 7 collapses).

**Pino as the structured-log transport.** Module-level `pino()` instance in `lib/llm/opus.ts`; private `logOpusCall(payload)` writes one JSON line per attempt (success or failure) with the nine fields from the slice plan §2 fold-in: `request_id, model, prompt_hash, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, status`. The transport choice (`pino` vs `console.error(JSON.stringify(...))`) was reopened at the Gate-2 proposal stage and resolved per §4 below.

**Widened `insertLlmCallFromAiSdkResult` writer.** `plan_stage_id` becomes optional; `session_id` joins as optional; runtime check enforces at-least-one-non-null with the exact error message `"insertLlmCallFromAiSdkResult: at least one of plan_stage_id or session_id must be non-null"`. Return type widens to `Promise<{ id: string }>` via `.insert(row).select("id").single()`. The contract pattern matches the `debriefs_target_check` constraint shape from migration 0009 (an `OR`-of-FKs that lets one writer feed both session-keyed and plan-stage-keyed callers). `PRICE_PER_MILLION`, `computeCostUsd`, `LlmCallError.parse` unchanged — same pricing snapshot date (22 May 2026), same 10% cacheRead / 125% cacheWrite arithmetic.

**Eighteen new unit tests.** Ten in `lib/llm/opus.test.ts` (Gate 3), eight in `lib/supabase/llm-calls.test.ts`'s new mocked describe block (Gate 4). Full suite went 184 → 192 across the slice with no regressions in the existing 184.

---

### §4 · Rejected alternatives

- **Immediate refactor of `callOpus` into `callOpusObject`.** Considered at the Gate 2 proposal stage. **Rejected** in favour of the two-function transition because: (a) `scripts/bilby-dialectic.ts` is the only consumer and is scheduled for deletion in Slice 7; refactoring its single import path inside 6b would mean editing the spike file's test suite (`scripts/bilby-dialectic.test.ts`) alongside it for zero behavioural benefit, since both file and test are headed for the bin; (b) the deprecation comment captures the scheduled-cleanup intent without diffuse churn; (c) the convention "soon-to-die paths get a header comment, not in-flight refactors" generalises cleanly to future Numbat work. The two-function transition is bounded — Slice 7 collapses it back to one function in the same commit that retires `bilby-dialectic.ts`.
- **`console.error(JSON.stringify(...))` instead of `pino` for structured logging.** Considered at the Gate 2 proposal stage; the field-shape contract (nine fields per call) is the load-bearing part and the transport is swappable. **Rejected** per the dialectic-era decision recorded in [`0013-slice-6-plan.md`](0013-slice-6-plan.md) §2 fold-in: "introduce pino in 6b if no logger exists." The dialectic had already considered the field-shape-vs-transport trade-off; the operator's call at the Gate 2 approval stage was to follow the plan, not to deviate mid-build on a sub-suggestion the dialectic had already resolved. Five-minute add — single dep (`pino@10.3.1`), single logger instance, single `logOpusCall` helper writing through it. The field shape stays as spec'd; transport is `pino`'s stdout JSON.
- **Collapsing Gates 3 and 4 into a single "tests gate."** Surfaced during the Gate 3 reply (the operator's "tests for callOpusObject + widened insertLlmCallFromAiSdkResult" framing). **Rejected** — kept separate per the original 6b proposal so each commit is a discrete unit of attribution (one function tested in one commit; the writer widening + its tests in another). The cost was one extra approval round-trip; the benefit was per-commit cleanliness in git history. Convention worth carrying forward: gates that mix surfaces (a code change in one file + tests in another) stay separate from gates that touch only one surface.
- **Single-component pricing table at `lib/llm/pricing.ts`.** Considered at the original 6b plan stage (pre-flight Item 10 of [`0012-slice-6-preflight.md`](0012-slice-6-preflight.md)). **Rejected** because `PRICE_PER_MILLION` already lived co-located with `computeCostUsd` in `lib/supabase/llm-calls.ts` (snapshot dated 22 May 2026), with cacheRead 10% / cacheWrite 125% pricing already wired. Extracting it to its own module would be pure code motion. The co-location is honest about who consumes the table; the snapshot date in the comment block is the staleness signal.

---

### §5 · Pre-flight findings (Gate 1 + slice-plan inheritance)

Three findings shaped 6b's execution. Two were Gate 1 verifications; one was a third caveat surfaced incidentally during the SDK shape read.

**(a) Cache-control SDK shape at `@ai-sdk/anthropic@3.0.78`.** Per-message breakpoint syntax matches the proposal exactly: `{ role: 'system', content: stablePrefix, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }`. Verified at `node_modules/@ai-sdk/anthropic/dist/index.d.ts:193-196` (the schema declaration: `cacheControl: { type: 'ephemeral', ttl?: '5m' | '1h' }`) and `node_modules/@ai-sdk/anthropic/docs/05-anthropic.mdx:629-636` (the per-message usage example). Default TTL is 5m — matches the slice plan's "5-minute TTL window" language. The SDK normalises cache fields into `LanguageModelUsage.inputTokenDetails.cacheReadTokens` / `cacheWriteTokens` which `computeCostUsd` already consumes — no contract change at the writer boundary. `generateObject` accepts the same `messages` shape as `generateText`, so the per-message providerOptions applies identically.

**(b) Back-compat at `scripts/bilby-dialectic.ts:679-687`.** The only existing call site of `insertLlmCallFromAiSdkResult` passes `plan_stage_id: stageInsert.data.id` (guaranteed non-null by the `if (stageInsert.error || !stageInsert.data) return null;` guard at lines 671-676), no `session_id`, ignores the return value. The Gate 4 widening was non-breaking on all three axes: the spike passes a non-null `plan_stage_id` (still satisfies the new at-least-one-non-null runtime check), the new optional `session_id` defaults to `null`, and the awaited return value continues to be discarded. Full-suite green run post-Gate-4 confirmed `scripts/bilby-dialectic.test.ts` did not regress.

**(c) 4096-token cache-payload caveat — surfaced during the (a) read.** Per `node_modules/@ai-sdk/anthropic/docs/05-anthropic.mdx:704-710`, Claude Opus 4.5+ tier (which includes Opus 4.7) **silently no-ops the cache breakpoint if the cached portion is under 4096 tokens** — no error, zero cache-creation tokens, just no caching. The stable prefix (CLAUDE.md + skills + 30 decisions + active specs) for a small project may sit under that threshold. A one-line caveat comment landed at the cache-control call site in `callOpusObject` (`lib/llm/opus.ts:115-121`) so the next operator looking at zero cache fields knows the first diagnosis is payload size, not header shape. This is a future smoke-test watchpoint for Slice 6c's debrief generator — see §10.

---

### §6 · Conventions established

Three patterns codified in this entry; each one earns naming because it's been observed at multiple instances.

**(1) Typed-runtime-guaranteed-boundary cast.** When code crosses from a strict-typed surface to a runtime-validated one, a single `as` cast at the boundary is correct — not a CLAUDE.md "No `any`" violation. Three instances during 6b earn the convention:

- [`lib/llm/opus.ts:152`](../../lib/llm/opus.ts) — `result.object as z.infer<TSchema>`. The AI SDK's `generateObject` returns `output<TSchema>` (its own inference shape); the wrapper exposes `z.infer<TSchema>` (Zod's standard inference). Equivalent at runtime (the SDK parses through the same Zod schema we passed) but TypeScript can't unify them without the assertion.
- [`lib/llm/opus.test.ts:78`](../../lib/llm/opus.test.ts) — the `okResult` mock builder casts to `Awaited<ReturnType<typeof generateObject>>`. The SDK's `GenerateObjectResult<unknown>` carries fields (`reasoning`, `warnings`, `request`, `response`, etc.) the wrapper never reads but strict typing demands.
- [`lib/supabase/llm-calls.test.ts`](../../lib/supabase/llm-calls.test.ts) `makeMockClient` — the mock client casts to `as unknown as SupabaseClient<Database>`. The mock implements only `.from(table).insert(row).select("id").single()` since that's the only chain the helper invokes; everything else on the real interface is unreachable from this helper.

The pattern: justify the cast in a one-line comment naming the type-system surface that can't bridge to the runtime guarantee. Three instances is enough to name; future Numbat work uses this convention rather than reinventing the justification each time.

**(2) Pino as the structured-log transport for the Opus path.** The Gate 2 instance establishes the transport choice; Slice 7's `callGrokObject` extends it through the same module-level logger pattern (write through one `pino()` instance, one private `logFn` per call site, identical nine-field payload shape). The convention prevents drift between Opus and Grok call-sites that future operators would otherwise resolve case-by-case. If a future slice introduces a third structured-log consumer (e.g., the debrief generator wants its own audit line), the extract-to-`lib/logger.ts` move ships with that slice — not speculatively now (CLAUDE.md "Don't add features … beyond what the task requires").

**(3) Cache-payload size before header shape (debugging convention).** Codified at [`lib/llm/opus.ts:115-121`](../../lib/llm/opus.ts) as an in-code comment so the next operator hitting zero cache fields across multiple runs knows the diagnostic order: payload-size check first (compare prefix length against the 4096-token tier minimum), header-shape check second (AI SDK version, providerOptions shape). Same shape as the diagnostic lesson codified in [`0017-enable-rls-with-service-role-bypass.md`](0017-enable-rls-with-service-role-bypass.md) §5's "pick a column the rendered branch actually displays, or read from the Network tab" lesson — both encode "the obvious diagnostic isn't always the right one" into an in-code or in-decision-log comment for the future-reader benefit.

---

### §7 · Near-term scheduled cleanup — `callOpus` collapse in Slice 7

Not actually a V2 question — a scheduled cleanup with a named trigger.

**Trigger condition.** Slice 7 migrates `scripts/bilby-dialectic.ts` off the text-only `callOpus` path. At that point `callOpus` + its deprecation header are deleted in the same commit. The two-function transition collapses to one function (`callOpusObject` only). The deprecation comment at [`lib/llm/opus.ts`](../../lib/llm/opus.ts) header explicitly names this trigger so the next operator reading the file sees the dead code's scheduled death.

The migration shape Slice 7 will perform: the proto-Bilby spike's four-stage dialectic (`draft` / `critique` / `consider` / `validate`) replaces text-in/text-out calls with `callOpusObject({ schema, stablePrefix, dynamicSuffix, timeoutMs })` invocations, one per stage. The schemas are already sketched as comment stubs at [`lib/llm/opus.ts:264-296`](../../lib/llm/opus.ts) (draft, consider) and at [`lib/llm/grok.ts`](../../lib/llm/grok.ts)'s parallel stubs (critique, validate). The schemas land for real in Slice 7; the comment stubs come out in the same commit that deletes `callOpus`.

The convention worth carrying forward: code marked for scheduled deletion gets a named trigger in the deprecation comment, not just "use the new function instead." A named trigger turns a vague intent into a checklist item for the slice that owns the cleanup.

---

### §8 · CLAUDE.md + brief edits made alongside this entry

**None.** A grep for `callOpus` against both [`CLAUDE.md`](../../CLAUDE.md) and [`docs/numbat-brief-final.md`](../numbat-brief-final.md) before this entry's commit returned zero matches in both files. Neither surface references the text-only spike helper by name — the convention point about scheduled deletion is internal to `lib/llm/opus.ts`'s header comment, not externalised to the brief or session prompt. Slice 7's collapse will not need a CLAUDE.md or brief edit either.

The CLAUDE.md edit from Gate 2 (Resilience line: `Opus debrief 60s` → `Opus debrief 90s`) landed in commit `aeb55bf` as part of the gate's bundle, not separately here — same pattern as 0017's CLAUDE.md edit landed in `4f5f184`. Each slice or sub-slice's edits to durable surfaces ride alongside the implementation commit that motivates them, not in the close-out.

---

### §9 · Gates closed (audit trail)

Five sub-gates plus the parallel side-task. Dates reflect the conversation-thread timeline (system date stamps captured at each gate close).

- **Gate 1 — SDK shape verification + bilby-dialectic.ts back-compat.** Closed 27 May. No standalone commit; findings folded into the Gate 2 commit message body as three paragraphs (cache-control shape verified, back-compat verified, 4096-token caveat surfaced). See §5.
- **Gate 2 — `callOpusObject` + pino + deprecation + Bilby stubs + CLAUDE.md 90s** (`aeb55bf`). Closed 27 May. Five files changed (+410/-14): `package.json` + `pnpm-lock.yaml` (`pino@10.3.1`), `lib/llm/opus.ts` (full rewrite preserving `callOpus` body verbatim), `lib/llm/grok.ts` (parallel Bilby stub appended), `CLAUDE.md` (Resilience line). Typecheck clean; lint clean (two pre-existing underscore-prefix warnings carry forward).
- **Parallel — RLS side-task close-out** (`4f5f184`). Closed 29 May per [`0017-enable-rls-with-service-role-bypass.md`](0017-enable-rls-with-service-role-bypass.md). Migration `0010_enable_rls.sql` + decision log 0017 + CLAUDE.md "Single-operator assumptions" bullet + `docs/numbat-brief-final.md` §6 line, all bundled in one commit. **Not a 6b sub-gate** — injected work that landed clean attribution by having its own commit + decision log. Listed here for the complete chronological record.
- **Gate 3 — `lib/llm/opus.test.ts` × 10 tests** (`e2b5e26`). Closed 29 May. Single file (+332 lines). 10/10 green; typecheck clean; lint clean. Full suite went from 174 pre-Gate-3 to 184 post-Gate-3 (+10 new tests, no regressions in the existing 174). The 192 figure after Gate 4 below = 184 + 8 mocked-Supabase tests.
- **Gate 4 — widen `insertLlmCallFromAiSdkResult` + 8 mocked tests** (`6a00815`). Closed 30 May. Two files changed (+205/-6): `lib/supabase/llm-calls.ts` (signature + body + return-type widening), `lib/supabase/llm-calls.test.ts` (8 mocked tests appended; live-DB describe untouched). Full suite 192 / 192 green; typecheck clean; lint clean.
- **Gate 5 — this entry**. Closed 30 May.

Branch state at close-out: four commits ahead of `origin/master` (`aeb55bf` Gate 2 → `4f5f184` side-task → `e2b5e26` Gate 3 → `6a00815` Gate 4), with this entry's commit as the fifth. The operator's stated plan: hold all five commits unpushed until close-out lands, then a single `git push` brings the whole sub-slice + side-task to origin as a coherent unit.

---

### §10 · Open follow-ups (not blocking 0016)

- **Unknown-model silent zero in `computeCostUsd`.** The `TODO(post-6b)` comment in test 8 of [`lib/supabase/llm-calls.test.ts`](../../lib/supabase/llm-calls.test.ts) is the in-code bookmark: *"unknown model should surface louder than silent zero — current behaviour documented here, not endorsed."* The current behaviour (`$0.000000` cost row, no throw) was chosen in the original Slice 2a pricing-table work as wrong-but-visible. The future fix would be to surface a louder signal (e.g., log a warning, or insert a sentinel `model` value the dashboard highlights). Defer until either a real Opus model bump arrives without a price-table update, or the dashboard surfaces a "this row reports zero cost" case that triggers a hunt. Not 6c-blocking.
- **4096-token cache-payload watchpoint for Slice 6c.** The §5(c) caveat will get its first live observation in Slice 6c's debrief generator. The smoke-test discipline: run two debriefs against the same project within the 5-minute TTL window, and check whether the second's `llm_calls` row has `cache_read_input_tokens > 0`. If the cache fields stay zero across multiple runs, **check payload size before debugging headers** (per the §6 convention) — the prefix may be too small to cache.
- **Cross-reference to 0017's worker-bootstrap finding.** Slice 6c depends on workers reliably producing session-linked `llm_calls` rows (the Gate 4 widening exists precisely so the debrief writer can reference an `llm_call_id` on the new `debriefs` row). The verbatim §10 line from [`0017-enable-rls-with-service-role-bypass.md`](0017-enable-rls-with-service-role-bypass.md):

  > **Worker-bootstrap audit** — the `agent_session_id=null` race window for stuck-killing sessions, observed during Step 5 smoke test. Independent of 0010; needs scoping as its own sub-slice (`0018-…` when entered). Until that lands, the migration 0010 publication-add for `decisions` is functionally observable only by reading `scripts/session-runner.ts:297-326`'s log file output (`<worktreePath>.log`) for the line `kill decision received — interrupting SDK session` — which won't fire until the worker has a live SDK handle to interrupt.

  The shared concern: an `agent_session_id`-null session may also produce `llm_calls` rows that don't link cleanly to either a session or a debrief, in which case 6c's debrief generator either falls back to whatever `session_id` was passed (still set even if `agent_session_id` is null) or surfaces the gap. Worth re-checking in 6c's first live exercise; flag here so the dependency chain stays visible.
- **`callOpus` deprecation collapse in Slice 7.** Per §7. Named trigger, named call site (`scripts/bilby-dialectic.ts`), same-commit deletion of `callOpus` + its deprecation header + the Bilby comment-stub `draft` / `consider` blocks at the bottom of `lib/llm/opus.ts`. Scheduled cleanup; not actually V2 scope.
