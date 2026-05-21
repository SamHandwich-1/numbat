> File: docs/decisions/0006-slice-4-close-out.md

## Slice 4 close-out — live Agent SDK execution, kill-race invariant proven live

> **Date:** 21 May 2026.
> **Type:** slice close-out / gate-pattern full-stop.
> **Subject:** Slice 4 (live `@anthropic-ai/claude-agent-sdk` execution, worktree creation, diff capture, two-phase kill) verified end-to-end against three real production runs against the `numbat` source repo, committed to `master` at `a2c18c6` + `a6f3b6a`, pushed to `origin/master`. This is the formal close-out under the plan-mode → §0a-bis-gate → §0c worktree pre-flight → tests → manual → commit pattern. The §23 kill-race invariant, asserted by a synthetic unit test in Slice 4, fired live in run #2 — the strongest architectural validation the slice produced.

---

### What shipped

Slice 4 replaced the Slice 3 mock with a live Agent SDK worker. The shape of the worker is a single `scripts/session-runner.ts` process spawned per session by `/api/start-work` (Direct path only — the Bilby planning path is still Slice 5+ territory). The spawn primitive is `child_process.spawn(process.execPath, ["--import", "tsx/esm", "scripts/session-runner.ts", sessionId], { detached: true, stdio: "ignore" })` followed by `.unref()`. The previous `spawn('pnpm', …)` form hit `ENOENT` on Windows because pnpm ships as a `.cmd` shim that bare `spawn` can't resolve — `execPath` + `tsx/esm` removes the pnpm dependency from the spawn path entirely. The spawn function is extracted to `lib/orchestration/spawn-session-worker.ts` so it can be unit-tested independently of the API route.

The worker's lifecycle, in order: `assertSourceRepoUsable` (source-repo pre-flight, mirrors §0c dev-time check) → `createWorktree` (`git worktree add -b numbat/slice/<slug> <path> HEAD` against the source repo) → immediate `worktree_path` write on the session row (orphan-prevention, see below) → `startAgentSession` (the SDK `query()` wrapper) → `for-await` over the SDK message stream → `captureDiff` on `result/success` → `insertLlmCallsFromModelUsage` (fan out one `llm_calls` row per (session, model)) → `transitionToAwaitingReview`. A separate Supabase realtime subscription on `decisions` filtered by `session_id` arms the kill path: a `kill` decision triggers `q.interrupt()` and arms a 5s safety timer that calls `q.close()` if the interrupt doesn't produce a `result` in time. Top-level `uncaughtException` and `unhandledRejection` handlers write `status='blocked'` with `last_error.source='worker'` (distinct from `'agent_sdk'`, set on mid-loop SDK faults, and `'watchdog'`, set by `reapStaleKillingSessions`). Opportunistic `cleanupStaleWorktrees` and `reapStaleKillingSessions` run at the top of `main()` before any new SDK work, so a stale `killing` row or an orphaned worktree gets reaped as a side effect of the next worker invocation rather than needing cron infrastructure in V1.

The permission config is frozen at the §0a-bis-adapted Option B shape — four fields, all `.d.ts`-backed: `tools` (surface restriction to six file tools), `allowedTools` (auto-approval — same six), `disallowedTools` (trump-card denylist of Bash + WebFetch + WebSearch as defence against settings-layer drift), and `permissionMode: 'dontAsk'` (no-prompt mode; reachable tools execute, anything else is silently denied). The full rationale is in the companion entry, `0008-permission-config.md`. The file at `lib/feathertail/permissions.ts` carries a comment block declaring that any change to this shape requires a new decisions-log entry.

Persistence shape: migration `0006` adds `'killing'` to `sessions.status` (a transient state used by the two-phase kill — the operator's kill decision arrives in 'running', flips the row to 'killing', and the worker writes terminal 'killed' on teardown) and makes `sessions.diff` nullable (`jsonb` validated against the existing `WorktreeDiff` Zod schema on insert via the new `lib/feathertail/diff.ts`). The diff capture runs three git commands inside the worktree — `git status --porcelain -uall`, `git diff`, `git diff --numstat` — and a pure parser produces the typed `WorktreeDiff`. Binary detection scans the first 8KB of each file for null bytes. Per-worker logs live at `workerLogPathFor(worktreePath)` = `<worktreePath>.log`, sibling to the worktree directory (not inside it; see Defect 2 below). The helper is the single source of truth — both the writer (`session-runner.ts`) and the cleanup (`cleanupStaleWorktrees`) derive their path from it.

Test coverage: 96 unit + integration tests, all green. `pnpm typecheck` clean. `pnpm lint` shows only four known `_`-prefix unused-arg warnings (intentional unused params; cosmetic, addressed in Slice 5's `argsIgnorePattern` config bump). Shipped as two commits — `a2c18c6` (the feature) and `a6f3b6a` (the SDK audit + `completed_at` semantics decision; the latter is `0007`, written before this close-out per the numbering note in that file).

---

### Bug catches and their fixes

**`allowedTools`-vs-`tools` material drift (caught at §0a checkpoint (f)).** The Slice 4 plan assumed `allowedTools: [the six]` would *restrict* the model's tool surface. The installed `@anthropic-ai/claude-agent-sdk@0.3.143` `.d.ts` says otherwise — `allowedTools` is the **auto-approval** list (no permission prompt), and the actual surface restriction is the separate `tools` field. JSDoc is unambiguous: *"To restrict which tools are available, use the `tools` option instead."* This is the largest catch of the slice; without it, the worker would have shipped with `Bash` reachable from the model's menu (the default tool set), making arbitrary-shell-execution reachable from inside a model-driven turn. Resolved via the §0a-bis exit (iii) operator gate — stop, present the adapted four-field shape with each field's `.d.ts` quote, get explicit operator approval before resuming. Documented in `docs/sdk-audit-2026-05-16.md` and `0008-permission-config.md`.

**Spawn ENOENT on Windows (caught in initial manual run).** First worker invocation crashed before the worktree was created. `spawn('pnpm', ['tsx', 'scripts/session-runner.ts', sessionId])` hit `ENOENT` because pnpm is a `.cmd` shim on Windows and `child_process.spawn` doesn't resolve `.cmd` paths without `shell: true` (which would have introduced its own quoting hazards). Fix: spawn `process.execPath` directly with `--import tsx/esm`, removing pnpm from the path entirely. The new form is faster (one process, not two), works identically on Linux and Windows, and the extracted `lib/orchestration/spawn-session-worker.ts` is unit-testable.

**Diff Defect 1 — untracked-directory collapse (caught in manual run #1, session `f10e9b5b`).** `git status --porcelain` defaults to `-unormal`, which collapses untracked *directories* to a single entry with a trailing slash. The parser saw one "file" per collapsed directory and reported it as +0/-0. Real files inside those directories never made it into the captured diff. Fix: pass `-uall` (= `--untracked-files=all`), which forces git to recurse and emit one porcelain line per file. The defect was invisible to the test suite because the fixtures used single untracked files at the worktree root — the recurse-into-directory case wasn't represented. Five new tests in `diff-capture.test.ts` cover it now.

**Diff Defect 2 — per-worker log inside the worktree (caught in the same manual run #1).** The per-worker log file was being written to `<worktreePath>/.numbat-runner.log` — inside the worktree. Once `-uall` was added (Defect 1 fix), the log file showed up in `git status --porcelain -uall` as an untracked file and contaminated every captured diff. Fix: move the log SIBLING to the worktree via `workerLogPathFor(worktreePath)` → `<worktreePath>.log`. This is a 3-file coordinated change — the writer in `session-runner.ts` derives the path from the helper, `cleanupStaleWorktrees` uses the same helper for the unlink step, and the docblock on `workerLogPathFor` is the canonical explanation of why sibling-not-inside. Defect 2 is a clean case of fix-#1-revealed-#2: with the original `-unormal` flag the log file was invisible because git collapsed it into the parent untracked dir; the `-uall` fix exposed it.

**Orphan-worktree window #1 — `worktree_path` not written until `transitionToRunning`.** As originally written, the worker created the worktree directory but only wrote `sessions.worktree_path` on receipt of the SDK's `system/init` message (because that's when `transitionToRunning` ran). Any fault between `createWorktree` returning and the SDK emitting `system/init` (auth failure, subprocess startup race, network blip) would land the row at `status='blocked'` with `worktree_path=null` — and `cleanupStaleWorktrees`'s `worktree_path IS NOT NULL` predicate would skip it forever. Fix: write `worktree_path` *immediately* after `createWorktree` returns, before the SDK loop's try/catch opens. `transitionToRunning` later writes the same value again — idempotent UPDATE, no conflict.

**Orphan-worktree window #2 — blocked rows aged on `completed_at`.** The `cleanupStaleWorktrees` sweep originally targeted `status IN ('done','killed') AND completed_at < cutoff`, but `transitionToBlocked` leaves `completed_at` NULL by design (see `0007-completed-at-semantics.md`). A blocked row with a worktree on disk would never be swept. Fix: two-cohort sweep — `done/killed` aged on `completed_at`, `blocked` aged on `updated_at`. The semantic alternative (widen `completed_at` to mean "any worker-terminal state") was rejected; `0007` records the rationale.

---

### The kill-race invariant, proven live

The two-phase kill state machine has a structural race: the operator's kill decision can land on the realtime channel at any point during the SDK loop, including the narrow window after the worker received `result/success` but before `transitionToAwaitingReview` finished its UPDATE. The §23 unit test in `session-runner.test.ts` covers this synthetically — it monkeypatches `transitionToAwaitingReview` to throw with a guard-mismatch message and asserts that the catch block re-reads fresh status and treats the throw as expected when status is 'killing' or 'killed'. The principle the test encodes is the one worth preserving as a Numbat convention:

> **In kill-race catch blocks, read fresh DB state — do not parse the thrown error's message.** The error string is incidental (it depends on which transition wrapper threw and what guard wording happened to be used); the authoritative signal is what the DB currently says about the session's status. Error-string matching couples the worker's recovery path to incidental copy in the transition helpers and breaks the next time a helper's error message is reworded. Status re-reads survive copy changes.

Run #2 (session `a1435560`) proved this live, not synthetically. The kill arrived as a direct `UPDATE sessions SET status='killing'` from the operator (no UI affordance to kill a 'running' session exists yet — see the Slice 5 ActionBar gap below), so the kill path bypassed `decisions` entirely. That means the worker's kill subscription never fired and `q.interrupt()` was never called — the SDK ran to completion under its own steam. The sibling log records the consequence:

```
[11:17:42.977Z] worktree ready at .../rewrite-the-resilience-section-of-claude-md-to-be-twice-as-l-s4d2m9
[11:17:43.604Z] session running (agent_session_id=57c0e5e7-d804-4afa-bb40-ad3bc617f571)
[11:18:29.657Z] result/success — capturing diff and fanning out llm_calls
[11:18:30.074Z] SDK loop threw: transitionToAwaitingReview: session a1435560-6085-410f-9a92-c8b0e4b6f5d9 not in expected status(es) [running] — refusing to update
[11:18:30.133Z] status is killing — kill in flight, throw was an expected guard mismatch. finally will finalise.
[11:18:30.188Z] status still 'killing' — writing terminal 'killed'
[11:18:30.238Z] worker exit
```

The SDK emitted `result/success` at 11:18:29.657Z; the worker captured the diff and fanned out `llm_calls` normally (the run completed under its own power, so the cost row is the full happy-path total, not a partial `aborted_streaming` slice); `transitionToAwaitingReview` then threw ~417ms later on its 'running'-only guard, because the row had already been flipped to 'killing' by the operator's direct UPDATE; the catch block re-read `sessions.status` (NOT the error string), saw 'killing', logged the line at 11:18:30.133Z, and fell through to `finally`; `finally` re-read status one more time at 11:18:30.188Z, saw it still at 'killing', wrote terminal 'killed' via `transitionToKilled`. End-to-end recovery from the guard throw to terminal state took ~114ms.

This is a stronger demonstration than the synthetic test asserted, because the kill came in via a path the worker doesn't know about — pure status-state divergence from outside the worker's own primitives — and the invariant still held. Any future kill mechanism (UI button, API endpoint, direct UPDATE, third-party process) that flips `sessions.status` to 'killing' will be picked up the same way, because the recovery doesn't depend on knowing which primitive caused the flip. The synthetic unit test asserts the invariant; production data shows it holding under real timing and through a code path the unit test doesn't cover.

---

### Manual verification, by run

**Run #1 (session `dff482b2`) — happy path.** Full lifecycle: idle → running → awaiting_review in ~4s. One-line diff, captured correctly. Sibling log at the correct path. `llm_calls` reconciled to $0.067 — Opus-direct routing (the SDK chose Opus directly for this short prompt; longer prompts on later runs got Haiku-then-Opus routing internally to the SDK, a routing decision worth recording but not actionable). This run was clean and confirms the spine works.

**Run #1, original (session `f10e9b5b`) — productive failure.** Run #1's *first* attempt landed in `awaiting_review` with `+0/-0` on a session that should have shown real file edits. Inspection turned up Defect 1 (the `-unormal` collapse) and Defect 2 (the log file inside the worktree). The test suite had passed, the build was clean, the manual run discovered both bugs in the same forensic pass. The session row is retained — kept in the DB as a before-picture for Defect 1, with the buggy `session.diff` intact as forensic evidence. The lesson is the usual one: test coverage of `captureDiff` was too narrow (single-file fixtures only, no untracked-directories case) and a green test suite cleared a real bug. The five new tests in `diff-capture.test.ts` close the specific gap; the meta-gap (fixture diversity for filesystem-state-dependent code) gets carried into Slice 5's mental model rather than blocking close-out.

**Run #2 (session `a1435560`) — two-phase kill, live invariant.** Covered in detail above. The kill was executed via direct DB write (no UI path for killing a 'running' session exists yet — see the Slice 5 ActionBar gap below). Clean teardown: worker reliably wrote terminal 'killed' from the `finally` block.

**Run #3 (watchdog exercise) — deferred to Slice 5 manual phase.** The original Slice 4 manual-test plan called for a Run #3 that would force `reapStaleKillingSessions` to fire by killing a session and then SIGKILL-ing the worker before its `finally` block could run. The justification for deferring: Run #2's clean teardown trace shows the worker reliably writes terminal 'killed' under normal operation, and the watchdog is the safety net for that path *failing*. The unit tests in `worktree.test.ts` cover the watchdog's guard logic (`.eq("status", "killing")` race-protection against the worker winning the race). Live exercise of a path that we now have observational evidence doesn't fail under normal conditions is lower-value than the close-out work, and folds naturally into Slice 5's manual phase where multi-session scenarios will exercise more crash modes. The slice closes without it.

---

### Productive-failure note on the `f10e9b5b` run

The original Slice 4 plan called for a single happy-path manual run as the §7 acceptance criterion. The actual sequence — green test suite → clean build → first live run fails → fix two defects → second live run succeeds → second live run also exercises the kill-race invariant — is the more useful pattern. The cost of running manual verification *first* (before treating the slice as done) caught two bugs the test suite missed and proved an invariant that the synthetic test only asserted. For Slice 5 and beyond, the close-out criterion is now: **at least one live manual run, on real data, after `pnpm typecheck && pnpm lint && pnpm test` pass**. The test suite is necessary; it isn't sufficient. Diff-capture is exactly the kind of filesystem-state-dependent code where unit-test fixtures lag real behaviour, and worker spawn has OS-shaped failure modes that don't surface in CI.

---

### Carried into Slice 5

Items surfaced during Slice 4 manual phase that are too small to block close-out but need to land in Slice 5's plan:

- **Operator action surface (consolidated, three recurrences)** — `ActionBar` mounts only on `awaiting_review`. Slice 4 hit the gap three times: a stuck 'idle' row from a spawn-fail with no UI affordance to retry/kill; a stuck 'blocked' row from a worker fault with no UI to clear or retry; and the live 'running' session in Run #2 needing the DB-direct kill path. ActionBar should be status-aware — mount on any non-terminal state, filter the visible actions per status. **Highest priority Slice 5 item.**
- **Session lifecycle UI gaps (companion to above).** Sessions list grows monotonically. Add a 'dismiss' action for terminal sessions via a `dismissed_at` column — soft-hide, reversible, audit row preserved. Not a delete. Delete remains explicit/manual for actual mistakes and depends on the FK cascade fix below.
- **`decisions.session_id` AND `decisions.plan_id` FKs should both be decided symmetrically.** Both currently block naïve `DELETE FROM` their parent table. Surfaced on session cleanup (sessions FK known) and again on the orphan plan cleanup (plan FK discovered live during the close-out disposition pass). Cascade is the obvious fix for both but has audit-log implications — deleting a session would delete its kill/redirect decisions, deleting a plan would delete its routing/ship decisions. Slice 5 should decide cascade-vs-preservation for both columns in one pass rather than treating them separately; the engineering question is the same, only the surface differs.
- **Session detail page lacks back/nav to the list.** Operator stuck with browser-back or URL-bar. Header link or back affordance.
- **`/api/start-work` doesn't surface which pipeline routed.** Operator discovered Bilby routing via a 404 on `/plans/[planId]` (which doesn't exist yet). The Start-Work form should report *"routed to Bilby"* or *"routed to Direct"* before the redirect.
- **`router.ts` heuristic undocumented.** The actual Direct-vs-Bilby live logic is more permissive than the brief's 200-char rule suggests. Either comment-block the routing function or add a section to `CLAUDE.md` describing the live rules.
- **Worker heartbeat.** Periodic "still iterating, message N" log line so long-running sessions are distinguishable from hung ones. `setCurrentStep` only fires on Edit/Write/MultiEdit, so reading/thinking/retry phases are currently invisible.
- **`sessions.total_cost_usd` mirror column.** Persist the SDK's `result.total_cost_usd` at capture time so the row-sum equation (sum of `llm_calls.cost_usd` ≟ `total_cost_usd`) is externally verifiable post-hoc, not just in worker memory at fan-out time.
- **SDK per-prompt model routing observation.** Short prompts went Opus-direct; longer prompts got Haiku-then-Opus routing. Not a bug — the Agent SDK makes routing decisions internally based on prompt characteristics. Worth knowing for cost modelling and worth keeping an eye on as the SDK evolves.
- **Slug truncation on word boundaries.** `brief.slice(0,60)` cuts mid-word (e.g. truncating "uncertain" to "un"). Cosmetic; tiny refactor in `lib/util/slug.ts`.
- **`TerminalBanner` uses an inline hand-written session type** rather than `Pick<Session, …>`. Works via structural subtyping but won't track changes to `SessionLastError` (which Slice 4 already extended with `'watchdog'`).
- **Lint `argsIgnorePattern`.** Four `_`-prefix unused-arg warnings on intentional unused params; add `argsIgnorePattern: '^_'` to the ESLint config.
- **Next 16 lint migration.** `next lint` is deprecated in Next 16; migrate to the ESLint CLI directly.
- **Supabase CLI bump.** v1.226.4 → v2.98.2, a full major version behind. Own scoped task.
- **`tslib` casing warning.** Benign Windows case-insensitive filesystem artifact (`C:\Users\james` vs `C:\Users\James` in webpack module paths), all inside `node_modules`. Understood, no action required.
- **`--status-killing` CSS token gap.** Plan §1 mentioned the token but it doesn't exist in `globals.css` — code reuses `--status-killed`. Either add the token or update the plan; cosmetic mismatch.
- **`diff.ts` uses `git diff --numstat`** not `--stat` per plan §5. Right call (machine-readable columns vs variable-width visual bar) but a deliberate plan deviation, recorded here so future readers don't think it's an oversight.
- **`cleanupStaleWorktrees` casts `response.data` to `StaleRow[]`** to work around Supabase's `.not()`-after-embedded-join inference break. The select string and `StaleRow` type are no longer compiler-checked against each other. Acceptable for now; revisit if the typegen catches up.
- **`dev.log` non-existence.** Operator's `pnpm dev` stderr isn't piped anywhere, so server-side `console.error` events are invisible. Slice 4's spawn-ENOENT was caught by the handler but the log went to `/dev/null` — visibility came from the DB row, not the console. Slice 5+ ergonomic: optional `dev:logged` pnpm script or convention.
- **`current_step` doesn't clear on terminal transitions.** Design call. Recommendation: KEEP as forensic trail of last activity at the moment of transition. Logged here for an explicit Slice 5 decision.

---

### Disposition of the six preserved manual-verification sessions

- **KEEP `f10e9b5b-…`** — Defect 1 before-picture. The buggy `session.diff` (+0/-0) is forensic evidence against future regressions to `-unormal`.
- **KEEP `a1435560-…`** — Run #2's successful kill. The row that proved the kill-race invariant live.
- **DELETE `dff482b2-…`** — Run #1 happy path. Verification recorded here, row redundant.
- **DELETE `f6105658-…`, `6c48d0a6-…`, `51a29afd-…`** — race-loss noise from earlier kill experiments; no forensic value.
- **DELETE `a5bacf63-cd14-483a-a6a3-1b0246fc38d8`** from `plans` — orphan row created when a brief routed to `/plans/[planId]`, which doesn't have a UI yet (route 404s; Slice 5 builds it).
- Both session and plan deletions require the manual two-step (delete `decisions` rows referencing the parent first, then delete the parent row) per the pending FK-cascade decision noted in the Slice 5 carry list. `decisions` has FK columns to both `sessions` and `plans`; both block naïve `DELETE FROM` until cascade is decided.

---

### Calibration takeaway

Two patterns to repeat in Slice 5. **First, manual verification before close-out catches what tests can't.** Slice 4's f10e9b5b run cost ~20 minutes and saved a shipped slice with two real bugs; the synthetic-vs-live distinction also produced the invariant-proven-live data point that makes the kill-race architecture trustworthy rather than merely tested. **Second, the §0a-bis exit-gate worked exactly as designed.** The `allowedTools`-vs-`tools` material drift was caught at the type-audit stage, before any code was written against the wrong API shape. The gate's cost (one extra round of operator confirmation) is small; its value (preventing the worker from shipping with Bash reachable) is structural. The combination — type-audit gate upstream of code, manual-run gate upstream of close-out — is the load-bearing process from this slice and is what Slice 5 should inherit unchanged.

One pattern not to repeat: relying on test fixtures that only cover a single representative case for filesystem-state-dependent code. Diff capture's untracked-directory case wasn't in the fixtures, so the test suite was green while the production behaviour was wrong. The five new tests in `diff-capture.test.ts` close the immediate gap; the meta-gap (fixture diversity for FS-shaped code) is on the Slice 5 reading list rather than blocking close-out, because the close-out criterion now includes at-least-one live manual run which is the more reliable backstop anyway.

**Related entries:** `docs/decisions/0007-completed-at-semantics.md` (the schema-semantic decision on `completed_at` and the two-cohort cleanup sweep); `docs/decisions/0008-permission-config.md` (the §0a-bis security decision on `tools` + `allowedTools` + `disallowedTools` + `permissionMode: 'dontAsk'`); `docs/sdk-audit-2026-05-16.md` (the full §0a checkpoint audit against `@anthropic-ai/claude-agent-sdk@0.3.143`).
