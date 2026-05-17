# 003-grok-on-slice-4-plan

**Date:** 2026-05-16
**Subject:** Slice 4 plan (live Agent SDK execution, Option A — real diff, mocked debrief). Plan held at `~/.claude/plans/`, pending promotion to `docs/slice-4-plan.md` on approval.
**Critic:** Grok 4.3 via xAI.
**Critic context:** The full Slice 4 plan only. NOT included: `docs/numbat-brief-final.md`, `docs/sdk-spike.md`, the Slice 1–3 outputs, `CLAUDE.md`, the decisions log, the migration history. Third consecutive entry with the same context starvation as 001 and 002 — and, as in those, the missing context explains what the critique missed.
**Stage shape:** Single-stage critique. NOT a Bilby dialectic. One Grok pass on an already-single-pass-reviewed plan. The third consecutive instance of cross-family critique applied to an execution slice — explicitly outside the two sanctioned Bilby moments (architectural pivot, V2 scope). Run knowing it was off-pattern.

## Input

The full Slice 4 plan as drafted in Plan Mode and already reviewed single-pass (debrief partner): three §0 pre-flight gates (SDK install + audit, mock-seeder collision, worktree existence), worker lifecycle + state machine, kill propagation via the decisions table, worktree management, diff capture, the sessions.diff migration, Vitest coverage, six open questions, close-out plan, verification plan. Sent to Grok with a generic critique prompt: gaps, missing concerns, what will break, where the plan is overconfident.

## Output

Grok raised six refinements plus open-question endorsements, paraphrased one line each:

1. **Kill-handler setTimeout leak.** The `setTimeout(() => q.close(), 5000)` inside the kill subscription handler can leak if the channel is removed before it fires; store the id, clear it in `finally`.
2. **Worktree log-file cleanup.** `cleanupStaleWorktrees` should also `fs.unlink` the per-worktree `.numbat-runner.log` so the 24h cleanup promise is complete.
3. **Branch-collision error message.** Surface the exact existing branch name in `last_error.message` so the operator knows what to delete.
4. **SDK audit output format.** Write the §0a audit result to a dated `docs/sdk-audit-YYYY-MM-DD.md` as a canonical record.
5. **Worker env precedence.** Document that `ANTHROPIC_API_KEY`, if set, takes precedence over `~/.claude/.credentials.json`.
6. **Idle-placeholder copy.** Reword the `idle`-status placeholder to explain the worker is starting and what to do if it stalls.

Open questions: endorsed all six recommendations as the plan proposed them (Q1 branch naming, Q2 CLAUDE.md non-blocking, Q3 per-worktree log, Q4 retry deferred, Q5 redirect-resume deferred, Q6 opportunistic cleanup). Overall verdict: "94% ship-ready," "no critical gaps," "exceptional — the most production-grade slice yet," "safe to execute even though it spawns processes and writes to the filesystem."

## Verdict

1. **setTimeout leak → NICE-TO-HAVE, accepted.** Real, tiny, one-line fix. Folded into the corrections.
2. **Worktree log cleanup → NICE-TO-HAVE, accepted.** Real — closes the 24h-cleanup promise. Folded in.
3. **Branch-collision message → NICE-TO-HAVE, accepted.** Reasonable polish. Folded in.
4. **Dated SDK audit doc → VALID.** Genuinely good hygiene — a dated audit record prevents "we audited it once" drift. Folded in.
5. **Env precedence doc → NICE-TO-HAVE, accepted.** Harmless documentation.
6. **Placeholder copy → NICE-TO-HAVE, accepted.** Cosmetic.

No item raised was a defect. All six were polish or documentation.

The four real defects in the plan — caught by the single-pass review, missed entirely by Grok:

- **Kill-channel race (architectural).** The plan's §3b flips `sessions.status` to `killed` before the worker has stopped the live SDK session, leaving a window where the DB reports a terminated session while a real, paid SDK process keeps running. Grok did not see it — and worse, refinement 1 touches the *exact code block where the race lives* (the kill handler's `setTimeout`) and flagged a timeout-leak tidiness issue while the architectural race on the adjacent lines went unremarked.
- **Unbounded filesystem access (security).** The plan set `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`, justified as "the worktree is the sandbox." A git worktree is not a sandbox — it is a normal directory with full filesystem and shell access to the dev machine. Grok did not flag this. It actively endorsed the framing, calling the slice "safe to execute even though it spawns processes and writes to the filesystem" and praising "the clean separation of concerns."
- **Missing §0a checkpoint.** The audit gate verified five SDK surfaces but not the `query()` options-object shape, which the worker depends on to compile. Missed.
- **Migration number collision.** The plan named the migration `0006_sessions_diff.sql`; `0006` was already consumed three sessions earlier. Missed.

## Signal-to-noise

0 valid defect catches / 0 hallucinated / 4 nice-to-have / 0 rejected / 0 architecture-invalidating — 6/6 items actionable as polish, 0 of 6 a defect. Of the four real defects in the plan (one architectural, one security, two mechanical), Grok caught zero and rated the plan "exceptional, 94% ship-ready, safe to execute."

## Calibration note

Third consecutive entry, third consecutive confirmation — and the sharpest negative result of the three. 001 (Slice 2a plan) found single-stage critique on an execution slice "marginal." 002 (Slice 3 plan) found it "actively misleading" — it endorsed the plan's one hard defect as "pixel-perfect." This run is worse than 002: 002's miss was silence on a defect; this run produced *active false reassurance on a security model*. Calling an unbounded-filesystem-access design "safe to execute" is not merely an unhelpful review — it is a hazard, because a reviewer trusted at face value would have green-lit it.

The mechanism is now clearly established across three runs. Grok reviews the plan *as a document*. A well-written plan reads as complete, so the critique pattern-matches "thorough → praise → suggest polish." The defects that matter on an execution slice are not visible in the document: the kill race appears only when the *temporal* sequence of two writes is traced against a live process; the permission issue appears only if one knows a worktree is not a containment boundary; the migration collision appears only if one remembers what `0006` was used for three sessions ago. None is catchable by reading the plan well. All three require project context and adversarial tracing — exactly what cross-family critique on an isolated artifact cannot supply.

**Default V1 behaviour, now settled, not provisional:** do not run cross-family critique on slice plans. Three runs, three confirmations — this is no longer a hypothesis under test. The single-pass debrief review, working from full project context, caught every defect in all three slices that Grok missed. The test suite, the slice acceptance criteria, and a context-rich single-pass review are the correct critics at execution scope. The two sanctioned Bilby moments stand and are the *only* sanctioned moments: before an architectural pivot, before V2 scope.

**Note on the genuine architectural questions in this slice.** The kill-channel race and the permission model are real architectural decisions — the two weightiest in Slice 4. The lesson here is not that they didn't deserve scrutiny; it is that a single-stage drive-by Grok read of the whole plan is the wrong instrument for them. If, after the revised plan, either decision remains unresolved, the correct response is a *full four-stage Bilby dialectic* scoped narrowly to that one decision (Opus drafts the kill model → Grok critiques → Opus considers → Grok validates) — the sanctioned use of cross-family critique. A whole-plan single-pass critique is not a substitute for it and, on this evidence, not worth running at all.

**Open hypothesis from 001, now effectively closed.** 001 asked whether full supporting context would lift slice-level critique to worthwhile. Across three runs the answer has hardened: context starvation is real but not the primary failure mode. Even granting that full context might have surfaced the migration collision and the §0a gap, it would not reliably surface the kill race or the permission issue — those are adversarial-tracing problems, not lookup problems. The deeper finding is that an execution slice, by construction, has little for cross-family critique to bite on: the design space is closed, the premises are concrete, and the failure modes are mechanical or sequential rather than structural. The hypothesis does not need another test run. It needs to be marked closed.
