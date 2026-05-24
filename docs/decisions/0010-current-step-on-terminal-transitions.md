> File: docs/decisions/0010-current-step-on-terminal-transitions.md

## `sessions.current_step` — KEEP populated through terminal transitions, do not clear

> **Date:** 24 May 2026.
> **Type:** state-machine-semantic decision.
> **Subject:** Whether `sessions.current_step` should be explicitly cleared (set to `NULL`) when a session moves to a terminal state (`done`, `killed`, `blocked`), or preserved as a snapshot of the last in-flight activity at the moment of transition.

**What happened.** `sessions.current_step` is populated by the worker's `setCurrentStep` calls inside the Agent SDK message loop (`scripts/session-runner.ts`) — it captures the file path of the most recent Edit/Write/MultiEdit tool use. Per the Slice 4 close-out (`docs/decisions/0006-slice-4-close-out.md`, "Carried into Slice 5"), the column doesn't clear on terminal transitions — `transitionToBlocked`, `transitionToKilled`, and the `recordDecision` approve/kill paths all leave `current_step` at whatever value it held when the session crossed into terminal state. The 0006 entry flagged this for explicit Slice 5 resolution with a recommendation: **keep as forensic trail**. 0009 §sequencing step 2 picks the question up and instructs that the resolution be recorded as a numbered entry before implementation. This file is that record.

Two options were on the table.

- **2A — CLEAR on terminal.** Extend each transition wrapper (`transitionToBlocked`, `transitionToKilled`, `recordDecision`'s approve and kill branches, the worker's `finally`-block terminal write) to set `current_step = NULL` alongside the status flip. Cost: ~6 mutation sites updated; the visual surface (Sessions list, detail page) gets uniform "no step" treatment for terminal rows.

- **2B — KEEP, snapshot-style.** Leave `current_step` populated through terminal transitions. The column's semantics shift from *"what is the worker doing right now"* (live signal, while running) to *"what was the worker doing at the moment of transition"* (snapshot, once terminal). UI renders the value as historical context — *"died while editing `lib/foo.ts`"* — for blocked/killed rows. Implementation cost: zero, this is current behaviour; the decision is to ratify rather than change.

**Decision: 2B (KEEP).** Three reasons.

First, this aligns the column's behaviour with the broader Slice 5 pattern. Step 1 established `decisions.payload.session_label` / `plan_label` as snapshots-at-transition-time — values that *survive* the change in state and stay legible afterwards. `current_step` on terminal rows is the same shape of artefact: a snapshot of the last meaningful action, preserved against the entropy of the state machine moving forward. Clearing it would create an asymmetry — *"some snapshot fields survive transitions, others don't"* — that future readers would have to reason about for no payoff.

Second, the column's value at the moment of transition is the highest-signal forensic data point for a session that fails or is killed mid-work. An operator looking at a `blocked` row three days later wants to know *what was happening when this died*. `current_step` is the only field on the row that carries that signal — `last_error.message` records the failure mode but not the in-flight position; `agent_session_id` is opaque; `task` is the prompt the operator wrote, not the worker's actual position when things went sideways. Clearing the column would destroy the only narrative breadcrumb the row carries.

Third, the symmetry on the read side is already in place. The Sessions list and detail page render `current_step` whenever it's populated; no UI code changes if the value persists into terminal states. The session-status mutation tests (`lib/supabase/mutations/session-status.test.ts`) already verify `current_step` is *not* touched by `setCurrentStep` once status is `killing` or terminal (the silent no-op behaviour added in Slice 4). The read and write paths are both already aligned with the KEEP semantics; CLEAR would be the deviation.

**Implementation.** None required. This is the current behaviour. The decision is to ratify rather than change, and the value of this entry is the explicit record of the call so future readers don't re-litigate it. Two small touch-ups land alongside this entry to make the semantics discoverable from inside the code:

- A comment block on the `transitionToBlocked` / `transitionToKilled` / `recordDecision` mutation sites in `lib/supabase/mutations/session-status.ts` and `lib/supabase/mutations/decisions.ts` pointing at this file. One line each — *"current_step is deliberately NOT cleared on terminal transitions; see docs/decisions/0010-current-step-on-terminal-transitions.md."*
- A comment on the `current_step` column type in `lib/types/db.ts` naming the dual semantics ("live during running/idle; snapshot once terminal").

**Calibration takeaway.** This decision is small but it earns its own entry because the question recurs — *"should we clear this column on terminal transitions"* is a near-universal design question for any state machine with auxiliary observation columns, and the answer here (KEEP, snapshot-style) generalises beyond `current_step`. The broader pattern: **state-machine transitions should preserve in-flight observation data unless preservation would actively mislead.** `current_step` doesn't mislead — it's clearly historical once the row is terminal, the timestamp on `updated_at` disambiguates — so it stays. If a future column DID mislead when preserved (e.g. a "current connection health" boolean that reads true after the worker died), the answer would flip. The rule is a heuristic, not a blanket policy.

**Related entries:** [0006](0006-slice-4-close-out.md) (the Slice 4 close-out where this question was carried into Slice 5); [0007](0007-completed-at-semantics.md) (the analogous keep-semantics-stable decision on `completed_at`); [0009](0009-slice-5-operator-action-surface-session-lifecycle.md) (the Slice 5 plan whose §sequencing step 2 requested this record).
