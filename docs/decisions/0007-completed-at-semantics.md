> File: docs/decisions/0007-completed-at-semantics.md

## `sessions.completed_at` — keep as "success/operator-terminated", not "any worker-terminal state"

> **Date:** 17 May 2026.
> **Type:** schema-semantic decision.
> **Subject:** Whether to widen the meaning of the `sessions.completed_at` column to cover `status='blocked'` rows, or keep its existing meaning and adjust downstream sweep queries.
>
> **Numbering note:** this entry is numbered `0007` rather than `0006` despite being written before the Slice 4 close-out (which is `0006-slice-4-close-out.md`). The Slice 4 plan and several Slice 4 code comments reference the close-out as `0006`; renumbering the close-out would have invalidated those references across plan/migration/code. The new entry moved instead. Entry numbers are sortable but not strictly chronological — the date at the top is canonical for ordering.

**What happened.** Slice 4's worker-driven status machine introduced a new orphan window: when `createWorktree` succeeds and the SDK loop later faults (or the worker crashes), the session row lands in `status='blocked'` with a worktree directory still on disk. The existing `cleanupStaleWorktrees` sweep targeted `status IN ('done','killed')` aged by `completed_at` — but `transitionToBlocked` leaves `completed_at` NULL, so blocked-with-worktree rows were never being cleaned.

The fix required extending the sweep to cover `blocked`. That raised a question: how should `blocked` rows be aged?

Two options were on the table:

- **2A — widen `completed_at` semantics.** Have `transitionToBlocked` also set `completed_at = now()`. The cleanup query becomes a single `.in("status", ["done","killed","blocked"])` with one `completed_at < cutoff` predicate. Cost: every reader of `completed_at` must henceforth understand that `NOT NULL` no longer implies success — it now means "reached any worker-terminal state, including failure."

- **2B — keep `completed_at` semantics stable.** Leave `completed_at` NULL on blocked rows. Sweep blocked rows against `updated_at` (which `transitionToBlocked` does set, guaranteed). Cost: the cleanup query has two cohorts — `done`/`killed` aged on `completed_at`, `blocked` aged on `updated_at`. Two PostgREST queries combined client-side rather than a single `.in()` + single predicate.

**Decision: 2B.** Audit-trail accuracy is a load-bearing project principle for Numbat — the decisions log and the `llm_calls` table are described in the brief as "the seed of every future calibration." Widening `completed_at`'s meaning silently is exactly the kind of slow-drift that breaks future readers, including the V2 router that will train on this data. A two-cohort sweep query is a few extra lines in one file; preserving the column's meaning is worth more than the brevity. The "completed_at NOT NULL ⇒ session ended successfully or by explicit operator decision" invariant survives this slice intact.

**Implementation:**

- `lib/feathertail/worktree.ts:cleanupStaleWorktrees` runs two queries against `sessions`:
  1. `status IN ('done','killed') AND completed_at < cutoff` — existing cohort, unchanged predicate.
  2. `status = 'blocked' AND updated_at < cutoff` — new cohort, aged on `updated_at`.
  Results are concatenated client-side. Both queries filter `worktree_path IS NOT NULL` so pre-SDK blocked paths (where no worktree was ever created) are skipped naturally.
- `transitionToBlocked` is unchanged. It continues to set `status`, `last_error`, `updated_at` — and explicitly does NOT touch `completed_at`.
- Test coverage in `lib/feathertail/cleanup.test.ts` includes the asymmetry directly: a blocked row with `completed_at = NULL` and old `updated_at` IS swept; a done row with old `completed_at` and recent `updated_at` IS also swept; an awaiting_review row with old timestamps on either column is NOT swept.

**Calibration takeaway.** A schema-semantic widening that looks like a one-line change ("just add 'blocked' to the .in()") is rarely actually one line — it propagates as an assumption-shift across every reader of the column. The cheaper fix in code-lines is usually the more expensive one in invariant-tracking. Worth pausing whenever a "minimal" diff touches an audit column's meaning.

**Related:** the second orphan window resolved alongside this decision (worktree directory created by `createWorktree` but `sessions.worktree_path` not written to until `transitionToRunning` runs on the SDK's init message) is a bug-class fix rather than a semantic decision; recorded in the Slice 4 close-out.
