# SDK Spike — 9 May 2026

> Slice 0 output. Half-day timebox. Throwaway scaffolding lives at `spike/`.
> Package under test: `@anthropic-ai/claude-agent-sdk@0.2.137` (claudeCodeVersion 2.1.137).

## Verdict

**PROCEED to Slice 1**, with three brief deviations folded in before the
schema migration ships. None invalidates the brief, but each is concrete
enough that we want it locked in writing before Slice 1 author starts.

The five brief assumptions hold in their essence: programmatic session start,
per-project `CLAUDE.md` delivery, kill propagation, and per-session token /
cost reporting all work as the brief described. The three deviations
concern the *shape* of two things — the `llm_calls` audit columns and the
diff-surfacing pipeline — and the *fan-out rule* for `llm_calls` insertion.

## What works

| Brief target | Verified | Concrete API reference |
|---|---|---|
| Programmatic session start, progress monitoring, output capture | ✓ (script 01) | `query({ prompt, options }) → Query`, where `Query extends AsyncGenerator<SDKMessage, void>`. Iterate with `for await`. |
| Per-project `CLAUDE.md` via `settingSources: ['project']` | ✓ (script 02) | `Options.settingSources?: ('user' \| 'project' \| 'local')[]`. With `['project']` the sentinel was returned verbatim; with `[]` the agent answered NONE. Isolation is airtight. |
| Diff capture (that the SDK *signals* file changes) | ✓ (script 03) | SDK emits `Edit`/`Write`/`MultiEdit` `tool_use` blocks (with `file_path`, `old_string`, `new_string`, `replace_all`). It does **not** emit patch hunks. The actual surfacing pipeline is a Feathertail design decision — see redesign #3. |
| Kill-signal propagation and cleanup | ✓ (script 04) | Two paths: `Query.interrupt()` (graceful — emits a `result` with `terminal_reason: 'aborted_streaming'` then throws) and `Query.close()` (forceful — generator returns silently, no result message). Also `Options.abortController?: AbortController`. |
| Token / cost reporting per session | ✓ (script 05) | Final `SDKResultSuccess` carries `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage`, and `modelUsage: Record<string, ModelUsage>` with per-model `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`, plus `session_id`. **The SDK pre-computes USD cost per model — Numbat does not need to maintain a price table for the Agent SDK path.** (Bilby's direct Anthropic / xAI calls via Vercel AI SDK still need one.) |

## What surprised us

1. **The SDK reuses Claude Code's bundled OAuth credentials automatically.**
   `~/.claude/.credentials.json` is read transparently — no `ANTHROPIC_API_KEY`
   in `.env.local` was needed. Numbat can let users authenticate via
   `claude login` once and not handle keys directly. (`.env.local` is still the
   override path if a user wants to scope a separate key.)

2. **`interrupt()` is the right kill primitive — `close()` is the fallback.**
   `interrupt()` lets us still receive the final `result` message (so the
   killed session's partial cost / tokens get logged correctly).
   `close()` terminates the subprocess hard and we lose the result event.
   Slice 4's kill flow should call `interrupt()` first, then `close()` after a
   short timeout if the generator hasn't returned.

3. **Permission prompts block tool use by default.** The very first run
   stalled on `"I need permission to read the file…"`. For real Numbat
   sessions inside an isolated worktree we'll set
   `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`
   (worktree is the sandbox). This matches the brief's spirit but should be
   stated explicitly in the Feathertail spec.

4. **Wall-clock vs `duration_ms`.** Script 05 saw 5.7s wall-clock for a 2.0s
   `duration_ms`. The ~3–4s gap is subprocess startup + IPC, observed
   consistently. Worth knowing for UI latency budgets — the Sessions surface
   should show "starting…" rather than "running" until the first `system/init`
   event.

5. **`enableFileCheckpointing` + `Query.rewindFiles()` exists.** The SDK can
   snapshot files at user-message boundaries and rewind them later, a
   built-in alternative to git-based undo. Interesting for a future
   "undo this turn" review affordance, but **V2** — V1 sticks with the
   git-worktree-as-source-of-truth model the brief specifies.

## What to redesign (before Slice 1)

Three concrete deviations from the brief. Each needs to land in Slice 1
rather than be discovered mid-implementation:

### 1. `llm_calls` token columns: brief has the wrong shape

The SDK breaks input tokens into three categories that price very
differently: regular input, cache reads (~10% of input price), and cache
creation (~125% of input price). The brief's `prompt_tokens` /
`completion_tokens` collapse them — cost cannot be reconciled from tokens
alone, and cache-effectiveness analysis (a Bilby calibration concern) is
impossible.

**Proposed column shape for `llm_calls` (replace the brief §7 columns):**

```sql
input_tokens                  int not null,
output_tokens                 int not null,
cache_read_input_tokens       int not null default 0,
cache_creation_input_tokens   int not null default 0,
cost_usd                      numeric(10, 6) not null,   -- replaces cost_cents
```

Notes:
- All four token columns are `not null` (default 0 for the cache columns).
  The SDK guarantees these on `SDKResultSuccess.modelUsage[model]`.
- `cost_usd numeric(10, 6)` (six decimal places, max $9999.999999) replaces
  `cost_cents`. The SDK reports cost as USD with sub-cent precision; rounding
  to cents in the schema discards information for short / cheap calls.
- `prompt_hash`, `error`, `provider`, `model`, `duration_ms`, `created_at`,
  the `project_id` / `session_id` / `plan_stage_id` FKs all stay as-is.

The cost badge (§5) and any future cost dashboard sum `cost_usd` directly.

### 2. `llm_calls` fan-out: one row per (session, model), not one per session

A single Agent SDK session uses multiple models internally — the trivial
"what is 2+2?" run in script 05 invoked both `claude-haiku-4-5-20251001`
(routing) and `claude-opus-4-7[1m]` (response), each with separate token
counts and costs. `result.modelUsage: Record<string, ModelUsage>` is keyed
by model.

**Insertion logic:** on session completion, iterate `result.modelUsage` and
write N rows sharing the same `session_id` and `agent_session_id`, one per
model key. Sum across rows in a session = `result.total_cost_usd`.

**Slice 1 acceptance update:** the round-trip test should insert two
`llm_calls` rows from one mock session result and verify the sum matches.

### 3. Diff surfacing: a Feathertail design decision, not a footnote

The brief implies the SDK surfaces structured diffs. It does not. The
options observed:

- `Edit` / `Write` / `MultiEdit` `tool_use` blocks during streaming —
  carry the agent's *intent* (`old_string` / `new_string`) but are not
  authoritative for final state. The agent may retry, overwrite, or undo.
- `SDKFilesPersistedEvent` (`type: 'system'`, `subtype: 'files_persisted'`) —
  filenames only, no patch text. Did **not** fire on a normal Edit-tool
  run in script 03; it appears to be a different persistence flow (likely
  tied to file checkpointing / sandbox snapshots). Not a reliable trigger
  for Numbat's review pipeline.

**Feathertail design (replaces the brief's implicit "the SDK surfaces
diffs" assumption):**

- Source of truth for the review patch is the worktree's filesystem, not
  the SDK event stream.
- On session transition to `awaiting_review`, Feathertail runs (inside
  the session's `cwd`):
  1. `git status --porcelain` — picks up untracked files the SDK created.
  2. `git diff` — full patch text for tracked-and-modified files.
  3. `git diff --stat` — file list with +/− counts for the Diff Preview's
     header strip.
- The streaming `tool_use` events are still useful for the in-progress
  "Editing src/foo.ts…" step indicator on the Sessions surface, but they
  are **not** persisted as the diff record.
- `lib/feathertail/diff.ts` (new file, not in brief §8) owns this
  pipeline. Returns a typed `WorktreeDiff` consumed by the Diff & Review
  pane.

## Notes for Feathertail (Slice 4)

- **Session-runner shape:** spawned worker calls `query({ prompt, options })`
  with `cwd` set to the worktree path and `settingSources: ['project']`.
  Iterates the AsyncGenerator, writes events to Supabase via realtime.
- **Kill flow:** parent process holds a reference to the `Query` returned by
  `query()`. On user-initiated kill, call `q.interrupt()`, then await up to
  5s for the `result` message; if not received, call `q.close()` and mark
  the session `killed` with `terminal_reason: 'forced'` synthesized.
- **Permissions:** worktree-scoped sessions run with
  `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`.
  Sandbox boundary = the worktree directory + `additionalDirectories` if
  ever needed (default: none).
- **Diff for review:** see redesign #3 — `lib/feathertail/diff.ts` owns
  the worktree-FS-as-source-of-truth pipeline.
- **Worktree caveat (untested in this spike):** the spike used plain
  `git init` only. `git worktree add` paths (detached HEAD, `.git` as a
  file rather than a directory, multiple worktrees pointing at the same
  repo, branch-collision behaviour) were NOT exercised. Slice 4 owns the
  proper verification.
- **Observed event types** to handle in `lib/feathertail/agent-sdk.ts`:
  `system/hook_started`, `system/hook_response`, `system/init`,
  `assistant`, `user`, `rate_limit_event`, `result/success`,
  `result/error_during_execution`. Multiple others exist in the SDK's
  union (`SDKMessage`) — we can ignore unrecognised types safely (they're
  observability noise, not state-machine state).

## Cost data shape

Reflects the redesigned columns from #1 and the fan-out rule from #2.

| `llm_calls` column | SDK source (observed) | Note |
|---|---|---|
| `provider` | `'agent_sdk'` (constant) | Set by Numbat. |
| `model` | key of `result.modelUsage` | One row per key (see redesign #2). |
| `input_tokens` | `result.modelUsage[model].inputTokens` | Regular (non-cached) input tokens. |
| `output_tokens` | `result.modelUsage[model].outputTokens` | |
| `cache_read_input_tokens` | `result.modelUsage[model].cacheReadInputTokens` | New column (redesign #1). Default 0. |
| `cache_creation_input_tokens` | `result.modelUsage[model].cacheCreationInputTokens` | New column (redesign #1). Default 0. |
| `cost_usd` | `result.modelUsage[model].costUSD` | `numeric(10,6)`. Replaces `cost_cents` (redesign #1). Sum across a session's rows = `result.total_cost_usd`. |
| `duration_ms` | `result.duration_ms` | Whole-session wall-clock from the CLI. The same value lands on every row from one session — acceptable for V1 since rows are per-model, not per-API-call. |
| `prompt_hash` | computed by Numbat | sha256 of the user prompt before sending. |
| `error` | from `result.subtype !== 'success'` plus `result.terminal_reason` and `result.errors[]` | On a thrown exception (e.g. after `interrupt()`), catch and synthesize. |
| (sessions.agent_session_id) | `result.session_id` | Brief schema column. |

## Open question to flag

The brief assumes one slice = one worktree = one session. Nothing in this
spike contradicts that, but the spike also didn't run two sessions
concurrently. The next concrete moment to validate concurrent-session
behaviour is Slice 4. If anything in Slice 4 surfaces friction (e.g.
shared state between simultaneous CLI subprocesses), we revisit.

## Spike artefacts

- Code: `spike/scripts/01-session-start.ts` … `05-cost.ts` (delete after sign-off).
- Target repo: `spike/target-repo/` (sealed throwaway, contains a sentinel CLAUDE.md).
- This memo: `docs/sdk-spike.md` (durable).
