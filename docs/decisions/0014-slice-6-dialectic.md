# Slice 6 Dialectic — Plans Surface + Direct Pipeline

> The second four-stage Bilby-style dialectic preserved in Numbat's decisions log. Companion artifact to `0013-slice-6-plan.md` (both renumbered after the pre-flight audit).
>
> **Subject:** Slice 6 design — the Plans surface (UI shell that will host Bilby) and the Direct pipeline (Opus debrief generator wired to every live session).
> **Date:** 25 May 2026.
> **Final verdict:** READY. Integrated plan landed at `0013-slice-6-plan.md`.

---

## Why this artifact exists

Following the convention established in `0001-bootstrap-dialectic.md`. Every Bilby (or Bilby-shape) plan preserves all four stages of the dialectic as a single document. Three reasons:

1. **Audit trail.** Anyone — including future-James, future-Opus, future-Grok — can see what was caught, what was rejected with reasoning, what was added late, and what the validator confirmed. The plan makes more sense when you can see why each piece is shaped the way it is.
2. **Training signal.** Patterns in what Grok consistently catches that Opus misses (or vice versa) become visible over time. This data eventually trains the LLM-based router (V2). Slice 6's dialectic is the second data point — already a different pattern from `0001` (more operational catches; the cross-family critique surfaced different classes of gap when applied to engineering scope vs founding architecture).
3. **Quality calibration.** If a plan ships and ends up being wrong in production, you can walk back through the dialectic to see whether the gap was missed at draft, missed in critique, missed in consideration, or missed in validation. Each failure mode points to a different fix.

This artifact mirrors the bootstrap dialectic's structure: four labelled sections plus a Final Verdict and Meta-Observations block.

---

## Stage 1 — Opus draft

The original Slice 6 plan, drafted in a single Opus pass with no critique input.

**Canonical source:** `0013-slice-6-plan.md` §1 through §10 as drafted. The final plan file in this repo is the integrated post-dialectic version, so the pure Stage 1 text is not preserved separately — the dialectic resolutions are folded in.

**Outline of structure (Stage 1 as drafted):**
- §1 Framing · §2 Scope (in/out/non-goals) · §3 Recommendation on the split (Slice 6 vs Slice 7) · §4 Architecture (Direct pipeline · Plans surface · Shared Opus infrastructure · Layer mapping) · §5 Sub-slices (6a–6h) · §6 Data model deltas · §7 Acceptance criteria · §8 Open questions for Grok (Q1–Q11) · §9 What this slice unlocks · §10 Risk register.

**Decisions made at this stage:**
- Slice 6 splits from Slice 7 (Bilby gets its own slice). Eleven open questions surfaced for Grok validation in Stage 2.
- New `debriefs` table, one-to-many from sessions, with a `prompt_version` text column for forward-looking calibration.
- Debrief trigger inline in `session-runner.ts` (rejecting watcher and webhook alternatives).
- Shared `lib/llm/opus.ts` designed with Slice 7's needs in mind.
- Plans surface desktop-primary; sub-600px deferred.
- Cost table for AI SDK path lives in `lib/llm/pricing.ts` with Anthropic constants.
- Sub-slices 6a–6h, all sequential.
- Empty `DialecticTimeline` ships as a coherent empty state until Slice 7.

**Self-acknowledged limits at draft:** Q9 (Start Work current behaviour) flagged as needing codebase verification before merging. Q11 invited Grok to surface what wasn't accounted for.

**Length:** ~10 sections, ~500 lines. The Stage 1 draft contained no operational notes (missing-debrief recovery, RLS / realtime publication verification, structured logging, rollback SQL, Diff & Review audit step, ContextLoader contract verification) — all of which Stage 2 caught.

---

## Stage 2 — Grok critique

Cold cross-family critique. Grok received the full Stage 1 draft with explicit instruction to give a position on each of the eleven numbered questions, then surface what was missing.

**Preserved verbatim below.**

---

**Overall Assessment**

This is a high-quality, load-bearing plan. It correctly identifies Slice 6 as the inflection point where Numbat shifts from "session control panel" to "plan-thinking system." The decomposition into sub-slices (6a–6h) with explicit gates, the 12 measurable acceptance criteria, the risk register, and the deliberate forward-design of shared Opus infrastructure are all strong. The plan shows real engineering maturity: it treats empty states as first-class, accepts that Bilby deserves its own slice, and keeps the Direct pipeline additive rather than invasive.

It is **not** over-scoped for a single slice once split, but it is tight. The main weaknesses are (1) a handful of unstated assumptions about current codebase shape that could cause integration friction, (2) a couple of places where the plan is slightly optimistic about graceful degradation, and (3) a few missing operational/observability details that will matter once real Opus calls and realtime are live.

Below I give explicit positions on all eleven open questions, then the broader critique.

**Positions on the Eleven Open Questions (§8)**

**Q1 (Split decision)** — **Accept**.
Splitting is the right call. Slice 6 is already substantial (new table + trigger + ~9 components + two new route segments + verification across Diff & Review + Start Work changes). Adding the four-stage Bilby dialectic on top would create exactly the combinatorial verification surface you described. The empty Plans surface is **not** a smell — it is a coherent, shippable staging state ("the room is ready; the occupant arrives next slice"). Your argument about prompt iteration, isolation of failures, and matching Numbat's small-verifiable-unit principle is sound. The cost (one extra decisions entry, slightly more ceremony) is acceptable. The only real downside is context-switching for you; that is outweighed by cleaner post-mortems.

**Q2 (Debrief trigger location)** — **Accept**.
Inline in `session-runner.ts` is the correct choice. The worker already holds the full context (session result, message stream, diff, projectId). A separate watcher adds a second long-running process, subscription management, and a new failure mode (watcher dies while worker succeeds). The risk you flag — worker crashes after `done` but before debrief writes — is real but low-impact and recoverable (manual "regenerate" + nightly job, both deferred). The "fails open" posture is the right engineering stance here.

**Q3 (Debrief storage shape)** — **Accept**.
New `debriefs` table (one-to-many with `sessions`) is justified and the better long-term shape. The four-section content is structured enough to deserve its own table; redirects will legitimately produce multiple debriefs per session; history queries and "latest debrief" logic become trivial with an index. A `jsonb` column on `sessions` would pollute the core table, force awkward "latest" subqueries everywhere, and make the one-to-many nature implicit and fragile. Your decision to avoid a denormalised `debrief_id` pointer on `sessions` is also correct — single source of truth.

**Q4 (Shared Opus infrastructure)** — **Accept**.
Designing `lib/llm/opus.ts`, the `insertLlmCallFromAiSdk` writer, and the typed error shape with Slice 7 in mind is the right level of forward-look. The incremental cost is low (maybe 45–90 minutes) and the refactor tax later would be higher. This is not premature optimisation; it is interface design.

**Q5 (Prompt versioning column)** — **Accept**.
`prompt_version` is cheap insurance and worth adding now. Prompt iteration is inevitable (especially once Bilby lands and you start calibrating critique/consider prompts). Backfilling later is painful; a single text column costs nothing. This is not speculative bloat — it is targeted and directly supports the "calibration" use case the bootstrap dialectic cares about.

**Q6 (Empty DialecticTimeline)** — **Partial**.
The empty state is acceptable as a shipping state, but it should not be completely silent. Add a subtle, non-alarming placeholder such as:
> "Dialectic timeline will appear here once Bilby (Slice 7) runs. The 'Run Bilby' button is currently disabled."
A greyed-out button with a clear tooltip ("Available in Slice 7") is better than pure silence. Pure silence risks the surface looking half-finished during the (hopefully short) gap. This is a small polish item, not a blocker.

**Q7 (Mobile responsive on Plans surface)** — **Accept**.
Desktop-primary is the correct call. Planning work is deep, multi-hour, desk-bound activity. Sessions surface rightly held the 375 px line because review/approval often happens in transit. Plans can (and should) defer mobile below 600 px for V1 without guilt.

**Q8 (Cost table for AI SDK path)** — **Accept**.
A simple `lib/llm/pricing.ts` with Anthropic model constants is the right V1 level. Full provider-version handling (API-driven price tables, quarterly change detection, caching) is overkill until you actually see price changes or need multi-provider support. Add a comment block with "Last verified: 2026-05-XX, Anthropic pricing page" and a TODO for later. Monitor; do not over-engineer.

**Q9 (Start Work routing today)** — **Partial (verification required)**.
You correctly flagged this. The plan says "verify against the codebase before merging this draft." Do it immediately. The Slice 2 acceptance criteria language ("creates a session or plan stub") is ambiguous. Confirm the exact current behaviour in `app/api/start-work/route.ts` and whatever Bilby routing logic exists today. If it currently creates a session stub, the change to plan stub + redirect is a small but user-visible behaviour shift that needs explicit acceptance criteria and possibly a migration note for any in-flight sessions.

**Q10 (Slice ordering inside Slice 6)** — **Partial**.
Sequential with one gate per sub-slice is the right default for a load-bearing slice (matches the working pattern that has served you well). However, **6c (debrief generator)** and **6f (Plans index)** have zero code or data dependency and could safely run in parallel once 6b (Opus client) lands. That would shave a day or two off the critical path without increasing risk. Everything else must stay sequential (especially anything touching the worker or realtime).

**Q11 (Missing from this draft)** — **Reject (as "missing" claim) — the draft is already comprehensive, but here is the short list of genuine gaps I would add** (see detailed sections below).

**Key Gaps and Missing Elements**

1. **Explicit error-recovery story for missing debriefs**
   The plan says "manual regenerate deferred." That is fine for V1, but you need a one-line operational note: "If a session reaches `done` with no debrief after 5 minutes, the nightly job (or a manual psql script) will be added in a follow-up." Otherwise the "no debrief generated" state becomes a support ticket magnet.

2. **RLS policies and realtime publication details**
   The migration adds `debriefs` to the realtime publication, but there is no mention of the corresponding RLS policy (or confirmation that it inherits correctly from project membership). Same for the new `create_plan` decision type. This is an easy thing to miss and will break client subscriptions.

3. **Cost computation implementation detail**
   `insertLlmCallFromAiSdk` needs the actual lookup logic against `pricing.ts`. The plan assumes it will exist; it should be sketched (even as a one-function stub) in 6b so 6d/6h verification is possible.

4. **Diff & Review surface update scope (6e)**
   The plan says "update the existing Diff & Review page to read the latest debrief." You need to confirm there is no hard-coded mock data in multiple places (components, fixtures, tests). Otherwise the replacement will be incomplete.

5. **Observability / logging for Opus calls**
   The plan has good error typing but no mention of structured logging (request ID, prompt hash, latency histogram, token usage) that will be needed once real traffic hits. This is cheap to add in `lib/llm/opus.ts` now.

6. **Rollback / migration safety**
   No note on what to do if `0012_debriefs.sql` partially applies or if the decisions constraint change breaks an in-flight insert. Add a one-sentence "rollback: drop table + revert constraint" in the migration header.

7. **ContextLoader 'session' scope contract**
   The plan relies on it returning the Agent SDK message stream + diff + spec. This contract must be explicitly verified (or stubbed) in 6c. If the shape is wrong, the debrief quality collapses.

**Potential Break Points and Risks (what will actually break)**

- **Worker integration (6d)**: If `session-runner.ts` uses `process.exit()` or has complex finally/cleanup blocks that run after the status transition, the debrief call may be skipped. Verify the exact exit path.
- **Realtime on plan detail (6h test)**: Manual psql insert works in dev, but production RLS + publication rules may prevent the client subscription from seeing the new row. Test with a real authenticated client.
- **Start Work → plan stub change (Q9)**: If the current Bilby path already does something (even a no-op), changing it will affect any users who have bookmarked or scripted the flow.
- **Cost badge tick**: Depends on the `llm_calls` insert triggering the exact same realtime channel the badge already subscribes to. If the channel name or payload shape differs, the badge stays stale.
- **Migration sequence**: If master has already moved past 0011, the filename `0012_debriefs.sql` will be wrong and `db:push` will fail or create gaps.
- **Opus timeout/retry**: 60 s with max 2 retries is aggressive for a background worker. A single slow Anthropic response could make the whole debrief path feel unreliable.

**Assumptions About the Codebase That Must Be Verified Before Merging**

Flag these explicitly in the Stage 2 handoff:

- Last migration on master is exactly 0011 (or whatever number you choose).
- `scripts/session-runner.ts` has a clean post-`done` hook point and the session result object contains the full Agent SDK message history.
- `ContextLoader.buildFor(projectId, 'session')` already exists and returns (or can be made to return) the required shape without changing its public API.
- `app/api/start-work/route.ts` + Bilby routing logic currently creates a session stub (or nothing) for the Bilby path.
- `lib/supabase/llm-calls.ts` exports `insertLlmCallsFromModelUsage` and has no conflicting insert pattern.
- Diff & Review page currently renders a four-section mock from a fixture or hardcoded object.
- Realtime subscription pattern used in Sessions surface (thin client wrapper) can be copied verbatim.
- `plans` and `plan_stages` tables from Slice 1 have the columns assumed (status, brief, stage_num, action, etc.).
- No existing `debriefs` table or conflicting `decisions.type` constraint.
- `lib/llm/pricing.ts` is either empty or already partially populated.

**Specific Notes on Your Two Least-Confident Calls**

**Q1 (split)**: You are **not** overconfident here. The reasoning is tight. The only risk is that Slice 7 integration cost ends up higher than expected because the shared Opus client has subtle shape mismatches. Mitigate by having the 6b/6c author also sketch the four Bilby stage call sites (even as comments) so the interface is proven.

**Q3 (storage shape)**: You are also **not** overconfident. The new table is the correct relational choice. The only future-proofing item worth adding is a `debrief_type` column (enum: 'direct', 'bilby-draft', 'bilby-critique', etc.) so Slice 7 can reuse the same table without schema churn. Cheap to add now.

**Final Recommendation**

The plan is ready for Stage 2 with the additions above. Execute the verification steps for Q9 and the seven codebase assumptions first — they are the highest-leverage unknowns. Once those are green, the sub-slice sequence (with the minor parallel opportunity on 6c+6f) is executable.

This slice will genuinely move the needle: the learning loop becomes real, the Plans surface becomes a first-class citizen, and Bilby gets a clean home. Well done on the draft.

---

## Stage 3 — Opus considered

Opus's structured response: Accept / Reject / Partial / Add for each Grok point, with reasoning. Plus one new addition (prompt-caching architecture, A11) surfaced during consideration of two of Grok's gap items together.

**Preserved verbatim below.**

---

# Slice 6 Plan — Stage 3 Opus Considered

> **Subject:** Structured response to Grok's Stage 2 critique.
> **Date:** 25 May 2026.
> **Format:** Accept / Reject / Partial / Add for each Grok point, with reasoning. Plus any additions Opus surfaces during consideration that weren't in the critique.
> **Posture:** Most of the critique lands. Two partial pushbacks. One reframe of an "accept" into a stronger position. One new addition.

## 1 · The numbered questions — Grok's positions and my reactions

**Q1 (split). Grok: accept. Opus: confirmed.** No daylight. The reasoning chain is mutually understood. Moving on.

**Q2 (debrief trigger). Grok: accept. Opus: confirmed.** Same.

**Q3 (debrief storage shape). Grok: accept, plus a suggested addition (`debrief_type` enum column). Opus: accept the addition.** This is the most valuable suggestion in the critique. Adding `debrief_type text not null check (debrief_type in ('direct', 'bilby_draft', 'bilby_critique', 'bilby_consider', 'bilby_validate'))` now lets Slice 7's Bilby stages write to the same table without a schema change. The four-section content shape doesn't fit Bilby stages perfectly — Bilby critiques aren't "what we did / where this fits" — but the *table* is reusable for any structured LLM output keyed to a session or plan. Two options:

- Option A: keep `debriefs` table, add `debrief_type` column, accept that Bilby's content jsonb will have a different Zod schema discriminated by `debrief_type`.
- Option B: rename the table now to something more general (`llm_outputs`?) and accept the slightly clunkier name.

I lean Option A. The name `debriefs` is already in CLAUDE.md and the project instructions as a first-class concept. Bilby stages happen to be persisted in the same table, but they're not debriefs and we shouldn't pretend they are at the type level. The discriminated union on `debrief_type` is the honest representation.

**Q4 (shared Opus infrastructure). Grok: accept. Opus: confirmed.** Grok also adds the suggestion that the 6b/6c author sketch the four Bilby stage call sites as comments to prove the interface. **Accept the sub-suggestion** — this is cheap and de-risks Slice 7. Add to sub-slice 6b acceptance: *"Comments in `lib/llm/opus.ts` show the four Bilby call sites (draft, critique, consider, validate) with their expected Zod schemas, even though they're not implemented. Confirms the client interface generalises."*

**Q5 (prompt versioning column). Grok: accept. Opus: confirmed.**

**Q6 (empty DialecticTimeline). Grok: partial — add a non-alarming placeholder with a greyed-out "Run Bilby (coming soon)" button. Opus: accept.** Pure silence is worse than honest empty state. Adopt Grok's suggested copy verbatim or close to it.

**Q7 (mobile responsive on Plans). Grok: accept. Opus: confirmed.**

**Q8 (cost table for AI SDK). Grok: accept, with "Last verified" comment and TODO. Opus: accept the sub-suggestion.** Add the dated comment block in `lib/llm/pricing.ts` and a TODO referencing a future "price-table refresh" follow-up. Cheap.

**Q9 (Start Work routing today). Grok: partial — verification required before merging. Opus: accept and elevate.** Grok is right that this is a verification step, not a design call. Elevating it to a **hard prerequisite for Slice 6 starting** — sub-slice 6a does not begin until the current behaviour of `app/api/start-work/route.ts` for the Bilby path is documented in a one-line decisions-log entry. If the current behaviour is "creates a session stub," the change to "creates a plan stub + redirects" is user-visible and needs to be called out in 6g's acceptance criteria. If the current behaviour is "throws / no-op / creates nothing useful," the change is purely additive and doesn't need migration ceremony.

**Q10 (sub-slice ordering — parallel opportunity on 6c + 6f). Grok: partial — 6c and 6f could run in parallel after 6b lands. Opus: partial accept, with caveat.** Grok is technically right that 6c (debrief generator) and 6f (Plans index) have no code or data dependency once 6b is done. But there's an *operator* dependency I want to preserve: I run one Claude Code session at a time on Numbat itself (eat-your-own-dogfood; Numbat is in the seeded projects list). Parallelising 6c and 6f means two simultaneous Claude Code sessions with their own debrief loops, and right now Slice 5 just shipped — I want one slice in flight at a time on the system that's being used to build itself until the cost dashboard and per-day budget are more mature.

So: **technical green light to parallelise; operational red light for now**. Keep sequential through Slice 6, revisit parallel execution as a working convention in a later slice once the cost ceiling is enforced. Note this explicitly in the final plan as a deliberate single-track choice.

**Q11 (what's missing). Grok: rejected the "missing" framing but listed seven genuine gaps. Opus: accept all seven.** Walking each one:

## 2 · The seven gaps Grok added — all accepted

**Gap 1 — Missing-debrief operational note.** Add a single line to the final plan: *"If a session reaches `done` with no debrief after 5 minutes (worker crash, Opus down at session end), a follow-up slice will add either a nightly reconciliation job or a manual `pnpm tsx scripts/regenerate-debrief.ts <session_id>` script. Not in Slice 6 scope; flagged for the post-Slice-6 backlog."* Belongs in §5 (sub-slices) under 6d acceptance, plus the risk register.

**Gap 2 — RLS policies and realtime publication details.** The brief deferred RLS in V1 ("RLS off in V1; single-user"), so RLS isn't the worry here — the worry is the realtime publication. Add to sub-slice 6a: explicit verification that `alter publication supabase_realtime add table debriefs;` actually publishes the table to the client, with a brief test step: subscribe from the client, insert from psql, assert the event arrives. Same verification for the constraint change on `decisions` — confirm the new `create_plan` type passes the check constraint with a one-shot insert.

**Gap 3 — Cost computation implementation detail.** Promote `insertLlmCallFromAiSdk` to a real function shape in sub-slice 6b, not just a stub. Sketch:

```ts
export async function insertLlmCallFromAiSdk(args: {
  projectId: string;
  sessionId?: string;
  planStageId?: string;
  provider: 'anthropic' | 'xai';
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  durationMs: number;
  promptHash: string;
  error?: { kind: string; message: string };
}): Promise<{ id: string }> {
  const cost = computeCostUsd(args.provider, args.model, args.usage);
  // insert and return
}
```

The point of sketching it now is so 6d can actually call it and 6h can verify the end-to-end cost computation, not just assume it works.

**Gap 4 — Diff & Review surface update scope.** Add to sub-slice 6e: *"Audit the current Diff & Review surface for all mock data references — components, fixtures, tests, storybook entries if any. List them in the sub-slice 6e plan before starting. Replace all of them or explicitly leave them as test-only fixtures."* This catches the "I thought there was one mock, there were three" failure mode.

**Gap 5 — Observability / logging for Opus calls.** Accept in full. Add to sub-slice 6b: structured logging in `lib/llm/opus.ts`, every call logging `{ request_id, model, prompt_hash, input_tokens, output_tokens, duration_ms, status }` at minimum. Use the existing logger (or pino if there isn't one yet — check during 6b). This is cheap to add now, impossible to retrofit cleanly once the call sites multiply in Slice 7.

**Gap 6 — Rollback / migration safety.** Accept. Add the rollback note as a comment block at the top of `0012_debriefs.sql`:

```sql
-- Rollback (manual, dev only):
--   drop table if exists debriefs;
--   alter table decisions drop constraint decisions_type_check;
--   alter table decisions add constraint decisions_type_check
--     check (type in ('approve', 'redirect', 'kill', 'accept_critique', 'reject_critique', 'ship', 'edit_spec'));
--   alter publication supabase_realtime drop table debriefs;
```

V1 doesn't use migration versioning sophisticated enough to roll back via tooling, but having the inverse SQL in the file is the minimum.

**Gap 7 — ContextLoader 'session' scope contract.** Accept and elevate. Add a sub-slice 6a.5 (or fold into 6a): explicitly verify the current shape of `ContextLoader.buildFor(projectId, 'session')`. If the Agent SDK message stream is not in the returned shape, that's a contract change to ContextLoader and either (a) belongs in 6a or (b) blocks the slice. Don't discover this in 6c.

## 3 · The break-point list — all accepted, with one elevation

Grok's six concrete break points are all valid. Most are folded into the sub-slice acceptance criteria above. Two warrant explicit elevation:

**Migration sequence (Grok's "migration sequence" point).** Promoted from a footnote to **sub-slice 6a's first acceptance criterion**: *"Run `ls supabase/migrations/ | tail -3` against master. Confirm the next migration number. Name the new migration `<NNNN>_debriefs.sql` using that number, not `0012`."* The draft assumed 0012; the actual number on master may have moved past that during Slice 5.

**Opus timeout for background work (Grok's "Opus timeout/retry" point).** This is a real concern I underweighted. CLAUDE.md sets Opus debrief at 60s. For a background worker that's already done its job and is just generating a summary, a slow Anthropic response shouldn't reduce confidence in the system. Two options:

- Option A: extend the debrief-specific timeout to 90s (matching Opus draft) since it's truly async from the user's POV.
- Option B: keep 60s, accept that ~1-2% of debriefs may time out, surface the timeout cleanly in the UI.

I lean A. Extend the debrief timeout to 90s in `lib/llm/opus.ts`'s call site and update CLAUDE.md's resilience section to match. The reasoning: debrief happens *after* the user-visible work is done. The user is no longer watching. A few extra seconds of background patience is free.

**Acceptance change for 6b:** debrief Opus call uses 90s timeout (override of default), not 60s. CLAUDE.md updated in same sub-slice.

## 4 · The codebase-assumption list — accepted as-is and elevated

Grok's ten-point assumption list is exactly what was missing from the draft. Adopt it verbatim as the "Pre-flight verification" section of the final plan, executed before sub-slice 6a begins. Each item gets a one-line verification step and a result captured in a single decisions-log entry (`<NNNN>-slice-6-preflight.md`). If any assumption is wrong, the plan updates before code is written.

The full list, repeated here for the artifact's completeness:

1. Last migration on master is exactly 0011 (or determine actual N).
2. `scripts/session-runner.ts` has a clean post-`done` hook point and the session result object contains the full Agent SDK message history.
3. `ContextLoader.buildFor(projectId, 'session')` already exists and returns (or can be made to return) the required shape without changing its public API.
4. `app/api/start-work/route.ts` + Bilby routing currently creates a session stub (or nothing) for the Bilby path.
5. `lib/supabase/llm-calls.ts` exports `insertLlmCallsFromModelUsage` and has no conflicting insert pattern.
6. Diff & Review page currently renders a four-section mock from a fixture or hardcoded object.
7. Realtime subscription pattern used in Sessions surface can be copied verbatim.
8. `plans` and `plan_stages` tables from Slice 1 have the columns assumed (status, brief, stage_num, action, etc.).
9. No existing `debriefs` table or conflicting `decisions.type` constraint.
10. `lib/llm/pricing.ts` is either empty or already partially populated.

## 5 · One addition Opus surfaces during consideration

Walking through Grok's gap-7 (the ContextLoader contract) and gap-3 (cost computation detail) together prompts an additional concern that wasn't in either the draft or the critique:

**A11 (new) — Prompt-hash collision and cache benefit visibility.** The `llm_calls.prompt_hash` column exists (per Slice 1's schema). For Anthropic prompt caching to actually help us, identical prompts need identical hashes — meaning the prompt-template renderer needs to be deterministic across calls. The debrief generator pulls in: CLAUDE.md, last 30 decisions, active specs, skills, the session's spec, the task, the diff, the message stream. Several of those (decisions, message stream) change between calls. The cacheable portion is CLAUDE.md + the project bundle's stable parts.

This matters because: (a) Anthropic prompt caching is expensive to set up wrong and very useful when set up right (10% read cost, 125% write cost, 5-minute TTL); (b) the system prompt + project bundle is exactly the right shape to cache; (c) if we don't think about this in Slice 6, we'll either over-cache (and pay the write penalty on every call) or under-cache (and waste tokens).

**My addition to Slice 6:** sub-slice 6b's Opus client wrapper builds prompts in two parts — a stable prefix (system prompt + project bundle, marked as cache-eligible via Anthropic's cache control headers in the AI SDK) and a per-call dynamic suffix. The `prompt_hash` is computed on the dynamic suffix only. The `cache_read_input_tokens` and `cache_creation_input_tokens` columns on `llm_calls` (already in the schema) get populated from the AI SDK response. Cost badge reads cost_usd which already reflects the cache pricing.

This isn't a huge addition — maybe two extra hours in 6b — but it sets the pattern Slice 7's four Bilby stages will inherit, where the project bundle is identical across all four stages and prompt caching genuinely saves money.

Flagging this so it doesn't slip through.

## 6 · Updated open questions for Grok's Stage 4 validate

Stage 4 should validate:

**V1 — The split decision** (Q1 in original draft). Confirmed by Grok; just needs the validate stamp.

**V2 — The `debrief_type` discriminator addition** (from Q3). Is this the right way to make the table reusable for Bilby stages, or should the table be renamed to `llm_outputs` or split into two tables (`debriefs` + `plan_stage_outputs`)?

**V3 — Single-track operational policy** (from Q10). Keeping Slice 6 sequential despite the technical green light to parallelise 6c + 6f. Is the "one Claude Code session at a time on Numbat itself" stance principled or paranoid?

**V4 — Debrief timeout extension to 90s** (from break-points). Right call, or should it stay at 60s with cleaner timeout UX?

**V5 — Prompt caching architecture** (new addition A11). Setting up the two-part prompt structure in Slice 6 to inherit through Slice 7 — right time, or over-engineering for a single call site?

**V6 — The pre-flight verification gate.** Is the 10-item codebase-assumption checklist the right shape, or should it be reduced to "the three things that, if wrong, change the plan"?

**Stage 4 prompt for Grok:** *Validate the considered response. Specifically: (1) confirm the rejections, partials, and additions are sound; (2) the prompt-caching addition (A11) was not in the critique and may be over-reach — is it the right call or scope creep; (3) the operational policy on parallelism (V3) — does that reasoning hold or am I being too cautious; (4) is the pre-flight verification gate the right shape. If all five additions and the seven gap-accepts are sound, stamp READY. Otherwise, flag what still needs to change.*

---

## Stage 4 — Grok validate

Grok received the considered response and the six specific scrutiny prompts (V1–V6). Final stamp: **READY**.

**Preserved verbatim below.**

---

**Stage 4 — Grok Validate**

I have reviewed the full Stage 3 Opus Considered response in detail. Below is my validation.

### 1. Confirmation of rejections, partials, and additions

All of them are sound.

- The seven gap-accepts (with elevations) are the correct response. Each one closes a real operational or integration hole that the original draft glossed over.
- The two partial pushbacks (Q6 empty-state copy, Q10 parallelism) are well-reasoned and the final decisions are sensible.
- The one reframe (Q9 Start Work verification elevated to hard prerequisite) is an improvement.
- The new additions (debrief_type discriminator, 90 s timeout, prompt-caching architecture in 6b, pre-flight gate, rollback SQL block, structured logging, Diff & Review audit step) are all net positive and correctly scoped.

No rejections were overturned incorrectly. The considered response is tighter and more complete than the draft.

### 2. Specific validation of the new items

**A11 — Prompt caching architecture (two-part prompt + cache control headers)**
**Right call, not scope creep.**

This is exactly the kind of forward design that justifies building the shared `lib/llm/opus.ts` infrastructure in Slice 6 rather than in Slice 7.

- The stable prefix (system prompt + project bundle) is identical across the four Bilby stages and the debrief. Caching it once in Slice 6 gives Slice 7 four free cache hits per plan run.
- The schema already has `cache_read_input_tokens` and `cache_creation_input_tokens` columns — this populates them correctly instead of leaving them as future debt.
- Two extra hours in 6b is trivial compared with the token savings (Anthropic's 10 % read / 125 % write pricing) and the architectural clarity it creates for every future LLM call site.
- It forces the prompt renderer to be deterministic on the cacheable portion, which is a good hygiene practice anyway.

This is high-leverage, low-cost, and perfectly timed. Strong accept.

**V3 — Single-track operational policy (keep 6c + 6f sequential despite technical independence)**
**Principled, not paranoid.**

Your reasoning holds. Numbat is the meta-system. Slice 5 just shipped. The cost dashboard and daily budget guardrails are still maturing. Running two simultaneous Claude Code sessions with their own full debrief loops would roughly double the meta-LLM spend during the most critical slice so far.

"Eat your own dogfood" works best when the system isn't simultaneously eating itself at double speed. The technical green light exists; the operational red light is the correct call at this maturity level. Revisit the convention once per-day budgets and cost attribution are stricter. Good decision.

**V2 — debrief_type discriminator (Option A)**
**Correct choice.**

Keep the table name `debriefs` and add the discriminator. The table is primarily a debrief store today; making it a generic `llm_outputs` table would be premature renaming. The discriminated union on `debrief_type` is the honest and future-proof representation. Bilby stages can write to the same table with their own Zod schemas. Clean.

**V4 — 90 s debrief timeout**
**Right call.**

Background work after the user-visible session has already completed should be patient. 60 s was the default; extending only the debrief path to 90 s (with the CLAUDE.md update) is the right nuance. The ~1–2 % timeout rate you would have accepted at 60 s is unnecessary friction.

**V6 — Pre-flight verification gate (10-item checklist)**
**Right shape.**

Ten items is not excessive when each is a one-line verification + single decisions-log entry. These are exactly the assumptions that have caused the most painful integration surprises in prior slices. Collapsing it to "the three things that would change the plan" would lose coverage on high-leverage items (ContextLoader contract, session-runner hook point, Start Work current behaviour, migration number). The gate is cheap (30–60 min) and high-signal. Perfect.

**V1 and V5** are already confirmed in the considered response.

### Final Stamp

**All seven gap-accepts are sound.**
**The five additions (including A11) are sound and correctly scoped.**
**The partials and rejections are sound.**
**The operational policy on parallelism is principled.**
**The pre-flight gate is the right shape.**

**READY**

The Stage 3 considered response is approved for production of the final plan document. You may now generate:

- `docs/decisions/0013-slice-6-plan.md` (the integrated final plan)
- `docs/decisions/0014-slice-6-dialectic.md` (the four-stage artifact preserving the full bootstrap-style record)

No further changes required. The plan is now tighter, safer, and better future-proofed than the original draft. Excellent dialectic.

---

## Final verdict

**READY.** The integrated final plan is at `0013-slice-6-plan.md` (renumbered to the next available sequence after the pre-flight audit). All seven Grok gap-accepts, five Stage 3 additions, two partial pushbacks, and one reframe folded in. The 10-item pre-flight verification gate executes before sub-slice 6a begins.

Sub-slice 6a does not begin until:

1. The pre-flight gate runs against the current master.
2. Both artifact files are renumbered using the next two consecutive sequence numbers in `docs/decisions/`.
3. A single decisions-log entry (`<NNNN>-slice-6-preflight.md`) captures the gate results.

---

## Meta-observations (for future Bilby calibration)

What the dialectic produced that a single Opus pass would not have:

1. **The `debrief_type` discriminator on the `debriefs` table** (from Grok's Q3 sub-suggestion). Stage 1 specified `debriefs` as a sessions-only table with one-to-many. Slice 7 would have hit this within hours: the four Bilby stages don't fit the "what we did / where this fits" four-section content shape, and the obvious workarounds (separate `plan_stage_outputs` table; jsonb-coerce Bilby content into the existing schema) both have higher costs than a single discriminator column. Grok caught it at draft time. ROI: high.
2. **The prompt-caching architecture in `lib/llm/opus.ts`** (Stage 3 addition A11, surfaced by Opus during consideration). Not in the Stage 1 draft, not in the Stage 2 critique. Emerged when Opus considered Grok's gap-3 (cost computation detail) and gap-7 (ContextLoader contract) in proximity and realised the prompt structure needed to be deterministic on the cacheable portion. Without the two-part prompt structure now, Slice 7's four Bilby stages would either (a) miss the cache entirely and overspend on tokens, or (b) need a refactor of the Opus client. ROI: moderate-to-high, depending on how heavy Bilby's token usage becomes.
3. **The 10-item pre-flight verification gate** (Grok's Stage 2 "codebase-assumption list," elevated in Stage 3 to a hard prerequisite). The Stage 1 draft had one verification flag (Q9). Grok widened that to ten items, several of which are higher-leverage than Q9 (the ContextLoader contract, the session-runner hook point, the migration number). Adopting these as a gate before sub-slice 6a means the painful integration surprises that bit earlier slices won't recur. ROI: very high if even one of the assumptions is wrong; medium-low if they all hold.
4. **The single-track operational policy nuance** (from Opus's partial pushback on Q10). Grok's "6c and 6f are parallelisable" was technically correct. Opus's partial pushback ("technical green light, operational red light because Numbat is eating itself and the cost ceiling is still maturing") wouldn't have surfaced in either a solo-Opus draft (would have stayed sequential without articulating why) or a Grok-only critique (would have said "go parallel"). The two perspectives in tension produced an explicit operational policy that future slices can revisit. ROI: medium — the value is in the documented reasoning, not the immediate sequencing choice.
5. **Seven smaller operational catches** (missing-debrief recovery, realtime publication verification, cost computation sketch, Diff & Review audit step, observability logging, rollback SQL, ContextLoader contract). Individually small; collectively they convert "writing code and hoping" into "verifying assumptions and then writing code." Another solo Opus pass might have caught two or three; cross-family critique reliably surfaces a different class of gap. Same pattern as the bootstrap dialectic, smaller in absolute terms but consistent.

What this calibrates for future Bilby runs:

- **Cross-family critique is most valuable on operational and integration concerns**, not just on architecture. The bootstrap dialectic caught an architecture-invalidating hosting model error (large, structural). This Slice 6 dialectic caught a different shape of gap: operational hygiene that a solo drafter assumes will get sorted out during implementation. Both classes matter; the dialectic surfaces both.
- **The "ADD" category is reproducible.** Opus considering Grok's points in proximity surfaces a new concern (A11 here, project loading/unloading in `0001`) that neither stage alone produces. This is the strongest argument for keeping the four-stage shape rather than collapsing to three.
- **Partial pushbacks are healthy.** Two in this dialectic (Q6 empty-state copy, Q10 parallelism). The dialectic system would be broken if every Grok point was accepted without nuance.
- **The validate stage matters.** Stage 4 confirmed the rejections, ratified the additions, and stamped READY. Without it, Stage 3 has implicit final say. Asymmetric-final-word is what makes principled disagreement possible.

**Estimated cost and latency of this dialectic run:**

- ~5 minutes of LLM time across the four stages (Opus draft ~90s · Grok critique ~60s · Opus considered ~90s · Grok validate ~60s, plus small framing/transition overhead).
- ~$3–5 estimated total cost (longer Opus draft and considered passes than `0001` due to richer Stage 1 content; Grok critique and validate roughly comparable). Tracked precisely once the cost badge populates from real `llm_calls` rows in Slice 6 itself.

### Pre-flight calibration (added 25 May 2026 post-gate)

The pre-flight gate caught two ground-truth issues that the four-stage dialectic missed: the `decisions.type` constraint regression (Item 9 — would have invalidated every existing `start_work` / `dismiss` / `undismiss` row) and the session-runner exit status + message persistence (Item 2 — worker exits at `awaiting_review` not `done`, and the SDK message stream is consumed in-flight and never persisted). Both stem from the same structural blindspot: Stages 1–4 reasoned from `numbat-brief-final.md` and `CLAUDE.md`, not from psql and `scripts/session-runner.ts`. Neither LLM, however thorough, has access to current master from documents alone. This is a calibration data point for future Bilby runs: ground-truth verification belongs in the workflow regardless of how rigorous the dialectic is upstream. The gate paid for itself on this slice — both RED items would have surfaced expensively during sub-slice 6a (migration failure on `pnpm db:push`) or sub-slice 6c (debrief generator returning nothing useful).

Worth it. The `debrief_type` catch alone would have cost half a day of refactor in Slice 7; the pre-flight gate is cheap insurance against any of ten integration assumptions being wrong. The dialectic earns its keep on a load-bearing slice. Track the same metrics for every future Bilby run to calibrate when the dialectic earns its keep vs when Direct is sufficient.
