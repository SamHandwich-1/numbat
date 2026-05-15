# 002-grok-on-slice-3-plan

**Date:** 2026-05-14
**Subject:** Slice 3 plan (single-session review flow, mocked Agent SDK output). Plan held at `~/.claude/plans/tender-bubbling-sutherland.md`, promoted to `docs/slice-3-plan.md` on approval.
**Critic:** Grok 4.3 via xAI.
**Critic context:** The full Slice 3 plan only. NOT included: `docs/numbat-brief-final.md`, Slice 1 / Slice 2 outputs, `CLAUDE.md`, the bootstrap dialectic, the decisions log. Same context-starvation as entry 001 — flagged because it again explains what the critique missed rather than what it caught.
**Stage shape:** Single-stage critique. NOT a Bilby dialectic. One Grok pass on an already-single-pass-reviewed plan — i.e. cross-family critique applied to an execution slice, which is explicitly *outside* the two sanctioned Bilby moments (architectural pivot, V2 scope). Run deliberately as calibration, knowing it was off-pattern.

## Input

The full Slice 3 plan as approved at the first review gate: pre-flight gates, file-by-file change list, component tree, data flow (read / write / skills-via-ContextLoader), mock fixture shape, Zod schema additions, 375px mobile strategy, Vitest coverage, four open questions, constraints check, verification plan. Sent to Grok with a generic critique prompt: gaps, missing concerns, what will break, where the plan is overconfident.

## Output

Grok raised six refinements plus open-question endorsements, paraphrased one line each:

1. **Realtime channel cleanup.** Client islands opening a Supabase channel must tear down on unmount via `sb.removeChannel(channel)`.
2. **Non-`awaiting_review` states.** `page.tsx` should explicitly branch: `done`/`killed` → read-only debrief+diff with a banner; `idle`/`running`/etc → "not yet ready" placeholder; ActionBar never mounts outside `awaiting_review`.
3. **`recordDecision` guards.** Add a status guard before writes; surface the PostgREST error message inline; document the two-write non-atomicity.
4. **Optional `new_concept` handling.** `DebriefBlock` should gracefully omit the block when absent.
5. **Session-card link.** Use `next/link` with `prefetch={false}` — the detail page is "heavy with realtime."
6. **Skills chip UX.** After appending `prompt_template`, scroll the textarea to bottom and focus it.

Open questions: endorsed Option A for redirect behaviour, endorsed deferring `usage_count`, endorsed matching the existing route convention, endorsed deferring the debrief-persistence question. Overall verdict: "96% ship-ready," mock fixture and seeding "pixel-perfect."

## Verdict

1. **Realtime cleanup → VALID.** Real, folded into the plan. The plan mentioned channel lifecycle in the SessionStatusSubscriber rationale but never spelled out teardown; made explicit, matching the Slice 2 pattern.
2. **Non-`awaiting_review` states → VALID.** Partly already in the plan (§3a said "thin read-only view") but underspecified. Grok's explicit branch split was a genuine tightening; folded in.
3. **`recordDecision` guards → REJECTED (already present).** The status guard is in plan §3b verbatim; the non-atomicity note is in §3b. Grok re-described existing plan content as a new concern.
4. **Optional `new_concept` → REJECTED (already present).** §2 marks the block conditional; §5 has `.optional()`. Already specified.
5. **`prefetch={false}` → VALID, reasoning REJECTED.** Correct suggestion, wrong "why." Realtime subscriptions are client-side effects that mount only on navigation — prefetch doesn't touch them. The real reason: prefetch executes the detail-page RSC (`getSession` + `ContextLoader.buildFor` + skills query) per card. Folded in with corrected reasoning.
6. **Skills chip UX → NICE-TO-HAVE, accepted.** Real polish, cheap, on the core quick-move interaction. Folded in.

No item was architecture-invalidating. No item was a HALLUCINATION outright — but items 3 and 4 are the same failure class as entry 001's item 2: missing context (the plan alone, not the brief or prior slices) led Grok to flag as gaps things the plan already closed.

The defect Grok missed: the plan's skills seed referenced short codes that did not match the live `projects` table, and placed seed data in a migration file. Grok rated that seeding "pixel-perfect." The single-pass debrief review caught both. The mismatch was later confirmed by the Slice 3 §0a hard gate (see `docs/decisions/0003-v1-project-set-correction.md`).

## Signal-to-noise

3 valid / 0 hallucinated / 1 nice-to-have / 2 rejected-as-already-present / 0 architecture-invalidating — 4/6 actionable, but 0 of the 4 were defects; all were polish or explicitness. The one hard defect in the plan (seed short-code mismatch) was missed entirely and endorsed as "pixel-perfect."

## Calibration note

Entry 001 (Grok on the Slice 2a plan) called single-stage critique on an execution slice "marginal ROI." This run is the stronger negative data point: not marginal, but actively misleading. On a faithful, well-scoped build slice there is no soft premise for cross-family critique to catch — so the second perspective pattern-matches "looks complete," generates polish, and waves the one real defect through. The single-pass debrief review, working from full project context, caught the defect the dialectic missed.

This is the second consecutive entry confirming brief §10's prediction, now from the negative side: cross-family critique earns its keep on strategic/architectural artifacts where premises are still soft, not on execution slices where the design space is closed and the failure modes are concrete (a wrong short code, a misplaced file) rather than structural.

**Default V1 behaviour, reinforced:** do not run cross-family critique on slice plans. The two sanctioned Bilby moments stand — architectural pivot, V2 scope — and nothing else. The test suite and the slice's acceptance criteria are the critic at execution scope; a checklist-driven self-review outperforms a context-starved single-stage critique, faster and cheaper.

**Open hypothesis from entry 001, partially addressed:** 001 asked whether giving the critic full supporting context would cut the hallucination rate enough to make slice-level critique worthwhile. This run does not answer it — context was again withheld — but it raises the bar for the hypothesis: even if full context eliminated items 3 and 4, the run still produced zero defect catches and one false "pixel-perfect" on a real defect. Context starvation is not the only failure mode; the deeper issue is that an execution slice has little for critique to bite on. A future run *with* full context would still be worth doing as the clean comparison, but the expected ceiling is now lower.
