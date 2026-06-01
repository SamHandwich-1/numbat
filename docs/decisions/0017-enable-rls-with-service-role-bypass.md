> File: docs/decisions/0017-enable-rls-with-service-role-bypass.md

## Enable RLS with service_role bypass + anon SELECT on realtime tables

> **Status:** CLOSED.
> **Date:** 29 May 2026.
> **Type:** Mid-slice side-task close-out (RLS policy revision); injected between Slice 6b gates 2 and 3.
> **Parent:** Side-task on the operator's prompt; not a Slice 6b sub-slice. The slice plan ([`0013-slice-6-plan.md`](0013-slice-6-plan.md)) is unchanged by this entry — Slice 6b's remaining gates (tests + close-out) resume after this entry lands.
> **Predecessor:** [`0015-slice-6a-schema-and-context-loader.md`](0015-slice-6a-schema-and-context-loader.md) (last entry in numerical order; the immediate Slice 6 work). The "RLS off in V1" position revised here was originally framed in [`docs/numbat-brief-final.md`](../numbat-brief-final.md) §6.
> **Successor:** TBD — `0020-...` if/when the agent_session_id-null worker-bootstrap finding (§5 below) gets its own close-out (slot bumped from the original `0018-...` when 0018 was taken by Slice 6c's close-out and 0019 was queued for the loader-ordering fix); `0016-slice-6b-...` remains reserved for 6b's eventual close-out per the slice plan's §4 sequencing.
> **Subject:** Enable RLS on all 9 public tables (service_role bypasses by Supabase platform behaviour); permissive `using (true)` anon SELECT policies on the 5 realtime-published tables (`sessions`, `llm_calls`, `plan_stages`, `debriefs`, `decisions`); add `decisions` to the `supabase_realtime` publication. Migration is [`supabase/migrations/0010_enable_rls.sql`](../../supabase/migrations/0010_enable_rls.sql), applied to the cloud DB on 2026-05-28.

---

### §1 · Original brief position

The brief and Slice 1 stance was **"RLS off in V1."** Recorded at [`docs/numbat-brief-final.md`](../numbat-brief-final.md) §6 Tech Stack: *"Supabase (Postgres + realtime subscriptions). RLS off in V1; single-user."* The rationale at the time, captured implicitly in the §11 single-operator framing, was that policy maintenance cost outweighed the threat surface when the only client was the operator's own browser holding the anon key. The "off" position was a deliberate V1 simplification, not an oversight — defended every time the topic surfaced in dialectics through Slice 5.

---

### §2 · Why revised now

Two converging forces, neither sufficient on its own but together leverage-positive:

**(a) Supabase Security Advisor noise.** The Advisor was raising **9 "RLS Disabled" errors + 3 "Sensitive Columns Exposed" warnings** — operational signal noise that obscures real misconfigurations when they eventually fire. Twelve standing alerts on a dashboard reduces the cost of ignoring the next one to zero; the next one might be the one that matters. Cleaning the surface is cheap once the underlying objection (policy maintenance) is gone.

**(b) Server-only DB access has been the de facto pattern since Slice 1.** Pre-flight grep (this entry's Step 1; results captured at the time) showed `lib/supabase/server.ts:4-9`'s `typeof window` guard enforces the server-only contract on `sbAdmin`, and the only browser-side uses of the anon-key `sb` client are **four realtime subscriptions** with no direct reads anywhere:

- `components/shared/cost-badge.tsx:23-49` — INSERT on `llm_calls` (cost badge ticks)
- `components/sessions/session-list.tsx:21-82` — `*` on `sessions` (session card list)
- `components/review/session-status-subscriber.tsx:16-42` — `*` filtered by `id=eq.${sessionId}` on `sessions` (detail page refresh)
- `scripts/session-runner.ts:297-326` — INSERT filtered by `session_id=eq.${sessionId}` on `decisions` (kill subscription)

No `.from(...).select(...)` chain in any `"use client"` component or page. The brief's "RLS off" position was sized for a hypothetical world where the browser did direct reads; the actual world has none. Cost of enabling RLS is now near-zero (service_role bypasses by platform behaviour; only realtime needs anon SELECT policies on 5 tables), so the noise-reduction win dominates.

---

### §3 · Chosen shape

**Migration:** [`supabase/migrations/0010_enable_rls.sql`](../../supabase/migrations/0010_enable_rls.sql) — applied to cloud DB on 2026-05-28. Three sections:

1. **`alter table … enable row level security` on all 9 public tables** — `projects`, `sessions`, `plans`, `plan_stages`, `decisions`, `llm_calls`, `specs`, `skills`, `debriefs`. No policies are needed for server-side reads/writes via `sbAdmin`; **service_role bypasses RLS by Supabase platform behaviour** (not a policy decision — verify against the Supabase docs for the platform contract).
2. **5 permissive `create policy "anon realtime read" … for select to anon using (true)` policies** on the 5 realtime-published tables: `sessions`, `llm_calls`, `plan_stages`, `debriefs`, `decisions`. Without these, anon-key subscribers can `subscribe()` successfully but receive zero payloads (RLS-enabled tables require the anon role to have SELECT permission on the rows for the realtime extension's `realtime.apply_rls()` filter to deliver events). The `using (true)` shape is permissive — every anon caller reads every row — which is correct for single-operator V1 where the anon key is shared by the operator's own browser, not the public web. **V2 tightening** (`using (auth.uid() = <owner_column>)` or similar) is captured in §7.
3. **`alter publication supabase_realtime add table public.decisions`** — captures the latent publication-membership gap surfaced by the pre-migration probe (see §5).

**Four tables intentionally have RLS enabled with NO anon policy:** `plans`, `projects`, `skills`, `specs`. These have no realtime subscribers, no anon access requirement; all reads and writes flow through RSC / Server Actions / scripts via `sbAdmin`, which bypasses RLS. The Supabase Security Advisor surfaces this as **INFO-level "RLS Enabled No Policy" notices on each of the four tables** — these are expected and document the deliberate server-only lockdown. **Future operators should NOT "fix" them by adding policies; the correct response is to leave them alone.** The convention is recorded in §6.

**INSERT / UPDATE / DELETE for anon: no policies, by intent.** Under RLS with no policy, anon writes are denied. service_role continues to bypass — and adding policies for service_role would be no-op noise (RLS doesn't apply to it). The browser is read-only-via-realtime by design.

**Rollback recipe** lives in the migration's comment block (five `drop policy` + one `alter publication drop table` + nine `disable row level security`). The rollback restores the post-0009 state, which is the correct revert target (every applied migration up to and including 0009 stays in place).

---

### §4 · Rejected alternatives

- **Minimal anon-SELECT scope (2 policies — `sessions` + `llm_calls` only).** Defers `plan_stages` (subscribed by Slice 6g) and `debriefs` (subscribed by Slice 6e) to those sub-slices on a "policy lives with its consumer" principle. **Rejected** because each deferral would be a 1-line migration on its own — pure overhead, no isolation benefit. The forward-looking 4-table coverage (plus `decisions`, see below) costs nothing today and removes a recurring micro-decision from each future realtime sub-slice's scope.
- **Restrictive policies — `using (auth.uid() = user_id)` shape now.** **Rejected** because Numbat has no user table, no auth model, no `user_id` columns. The shape is the V2 question (§7), not V1 work; introducing it speculatively would require schema additions for a hypothetical future scenario. Speculative-generality refusal per CLAUDE.md "Don't add features … beyond what the task requires."
- **Per-action policies on writes (INSERT / UPDATE / DELETE for anon).** **Rejected** because the browser is read-only by design — there's no use case for browser writes. Absence-of-policy denies writes for anon under RLS; that's the correct default.
- **Leave `decisions` off the publication.** **Rejected** — the pre-migration probe surfaced the kill-subscription no-op (§5) unambiguously. The fix is one SQL line and the migration is the right gate for it because policy membership and publication membership are the same change-set semantically. Folding it in means one cohesive close-out story rather than "we found the bug, we filed it, we did half the realtime work."

---

### §5 · Secondary catch — kill subscription has been silently no-op'd since Slice 4

**Probe.** The pre-migration check on 2026-05-27 against the live cloud DB ran:

```sql
select pubname, schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
```

Result: 4 tables — `debriefs`, `llm_calls`, `plan_stages`, `sessions`. **`decisions` was not on the publication.** Cross-checked against migration history: matches exactly. `0001_initial.sql:177-179` adds the original three, `0009_debriefs.sql:82` adds `debriefs`, no migration ever adds `decisions`. No dashboard drift to retro-capture.

**Finding.** The session-runner subscribes to `decisions` via `postgres_changes` at [`scripts/session-runner.ts:297-326`](../../scripts/session-runner.ts). With `decisions` off the publication, that subscription received no events. Cross-checking against [`0006-slice-4-close-out.md`](0006-slice-4-close-out.md) §"The kill-race invariant, proven live" lines 47-48: the only live kill exercise (Slice 4 Run #2) explicitly bypassed `decisions` via a direct `UPDATE sessions SET status='killing'`, so the kill subscription has never been observed firing in production. The kill flow still reached terminal state via the guard-mismatch recovery in `transitionToAwaitingReview`'s catch block — but `q.interrupt()` never got called and the operator paid for the full SDK run on every cancelled session. **Latent inefficiency, not a correctness bug.**

**Fix.** Migration 0010's step 3 adds `decisions` to the publication. Per the operator's hard constraint on this side-task: **zero changes to `scripts/session-runner.ts` in the same commit.** The subscription handler is untouched; if it misbehaves now that events are flowing, that's a follow-up sub-slice. The 4096-token-cache-style "land it carefully so the next operator can attribute behaviour cleanly" convention applies.

#### Smoke-test result (2026-05-28 → 2026-05-29)

Six-step smoke test executed end-to-end by the operator after `pnpm db:push` confirmed 0010 applied cleanly. Outcomes:

- **Step 1 — Sessions surface renders.** Green. RSC path through `sbAdmin` (service_role bypass) unaffected by the RLS enable, as expected.
- **Step 2 — Cost badge initial render.** Green. Server-side seed via `getTodayCostUsd` (also `sbAdmin`) unaffected.
- **Step 3 — Cost badge realtime tick on INSERT.** Green — a `$0.01` synthetic `llm_calls` INSERT from the SQL editor ticked the badge within ~1s. DELETE didn't tick, but that's the badge's INSERT-only subscription design ([`components/shared/cost-badge.tsx:33-43`](../../components/shared/cost-badge.tsx)), not an RLS issue.
- **Step 4 — Session detail page realtime refresh.** Green — DevTools Network tab showed the RSC request fire within ~1s of a Studio `UPDATE` on `sessions.updated_at`. The first observation came back as a false negative because the test session was in `status='killed'` and the changed field (`current_step`) is not rendered in that branch ([`app/sessions/[sessionId]/page.tsx`](../../app/sessions/%5BsessionId%5D/page.tsx) status-driven branching, comment lines 12-20); the killed-branch-doesn't-render-current_step confound was identified and corrected by switching to `updated_at` (rendered by `RelativeTime` in every branch). **Diagnostic lesson** worth carrying forward: when testing realtime delivery on a status-branched page, pick a column the rendered branch actually displays, or read the result from the Network tab rather than the visible UI. The component's `.subscribe()` is called without a status callback, so subscription success/failure is silent — Network-tab observation is the canonical signal.
- **Step 5 — Kill flow.** **DEFERRED.** The stuck-on-killing test session had `agent_session_id = null`, so `q.interrupt()` had no SDK handle to interrupt regardless of whether the subscription fired. This is a **separate worker-bootstrap bug** — the SDK's `system/init` message either didn't arrive or wasn't captured before the worker reached the kill subscription's awaiting state, leaving the row with `status='killing'` and `agent_session_id=null` indefinitely. **Independent of migration 0010.** The kill-subscription behaviour change from 0010 cannot be cleanly observed until the worker reliably populates `agent_session_id`. Follow-up sub-slice trigger: a worker-bootstrap audit covering the system/init capture path and the orphaned-`agent_session_id` race window. **Will be entered as `0020-…` when scoped** (slot bumped from the original `0018-…` when 0018 was taken by Slice 6c's close-out and 0019 was queued for the loader-ordering fix); for now it's a known open thread.
- **Step 6 — Supabase Security Advisor rerun.** Green:
  - **0 errors** (was 9 "RLS Disabled").
  - **0 warnings** (was 3 "Sensitive Columns Exposed" — all cleared automatically when RLS was enabled; no per-column policy fight needed, contrary to the original instruction's worst-case planning).
  - **4 INFO notices** — "RLS Enabled No Policy" on `plans`, `projects`, `skills`, `specs`. **Expected and documented** per §3; these are server-only tables with no realtime subscribers. The convention (don't add policies to silence INFO notices) is recorded in §6.

**Net.** Migration 0010's primary purpose — clear the 9 RLS-Disabled errors + 3 Sensitive-Columns warnings, keep the realtime chain working under the new policies — is **achieved**. The kill-subscription side benefit is **unobservable pending the §5 follow-up** and not regressed by anything in 0010.

---

### §6 · Conventions established

Three patterns codified in this entry; each one extends to future Numbat work.

**(1) Publication membership is source-controlled from this point forward.** Any future table that needs to be on `supabase_realtime` gets an explicit `alter publication supabase_realtime add table public.<name>;` in the migration that introduces the subscriber, never via the dashboard. The probe-against-`pg_publication_tables` (see §5 SQL) is the verification step before any migration that touches the realtime surface. If a probe ever surfaces a table on the publication that no migration owns, that drift gets captured in the same migration that's already touching the realtime layer — the "the right gate for the fix is the gate currently open" convention.

**(2) `scripts/_one-off-*.ts` scratch-script convention extends to dashboard SQL probes.** When a probe needs system-catalog access that PostgREST can't reach (e.g., `pg_publication_tables`), the dashboard SQL editor is the canonical execution path — matches the 6a Gate 2/3/4 precedents. Pasted result goes into the relevant decision log entry verbatim. The cost of this side-task's probe was ~10 seconds for the operator; the cost of the alternative (installing `pg` as a devDep to query system catalogs from a one-off script) was higher both immediately (~1 minute round-trip) and permanently (one more devDep to maintain). Default to the SQL editor unless the probe needs to run in a CI / automation context.

**(3) "RLS Enabled No Policy" INFO notices on intentionally server-only tables are expected and documented, not fixed by adding policies.** Adding a permissive policy to silence the linter weakens security — the absence-of-policy denial of anon access is the correct shape for tables that have no anon use case. The right response is to document the intent in the relevant decision log entry (this one, §3) and leave the INFO notice in place. The Supabase Security Advisor will continue to surface it; that's working as intended. If a future operator adds a policy to "clean up" an INFO notice without checking the table's anon-access shape, that's a regression. The four tables under this convention as of 0017 are `plans`, `projects`, `skills`, `specs`; any future server-only table joins the list and inherits the convention.

---

### §7 · V2 question — auth model and policy tightening

If Numbat ever opens to multiple operators (a hosted/multi-tenant deployment, or a team workflow), every `using (true)` policy in 0010 tightens to `using (auth.uid() = <owner_column>)` or similar. The trigger conditions:

- A user table is introduced (currently deferred per the "single hardcoded session token" pattern at CLAUDE.md "Single-operator assumptions").
- The brief's single-operator assumption is revised at the §1 / §11 level.
- A security review surfaces a concrete threat the current shape doesn't cover (e.g., the anon key leaks; the current shape gives the leaked key full read access to every session and llm_call).

Until then, the permissive shape is correct for single-operator V1. The migration's `using (true)` SQL is the minimum-change pivot point: a future migration replaces each policy in place without touching the ENABLE RLS or publication-membership layers. The convention to record at that point: each policy edit is paired with a schema delta adding the relevant ownership column (`user_id`, `created_by`, etc.), so the policy never references a column that doesn't exist.

The four server-only tables (`plans`, `projects`, `skills`, `specs`) stay policy-free even in a V2 multi-user world unless one of them gains a realtime subscriber. Their server-side access pattern doesn't change with multi-user; only the RSC / Server Action layer needs to start filtering by `auth.uid()` at the application layer.

---

### §8 · CLAUDE.md + brief edits made alongside this entry

Two co-committed edits:

- [`CLAUDE.md`](../../CLAUDE.md) §"Single-operator assumptions (V1)" — gains a new bullet capturing the RLS-on stance, the 5 realtime-published tables that have anon SELECT, the 4 server-only tables that don't, and a pointer to this entry.
- [`docs/numbat-brief-final.md`](../numbat-brief-final.md) §6 Tech Stack, line 102 — replaces the "RLS off in V1; single-user" suffix with the new RLS-on framing + pointer to this entry. The brief is the durable source-of-truth for the position; CLAUDE.md is the conventions-mirror for the session prompt.

Both edits keep the two surfaces in sync; the migration file itself carries the canonical SQL.

---

### §9 · Gates closed (audit trail)

This side-task ran as a single-gate task with explicit pauses between steps 1, 4, and 5 per the operator's framing.

- **Step 1 — pre-flight grep.** Closed 27 May. Four `sb` importers enumerated (cost-badge, session-list, session-status-subscriber, session-runner); all realtime-only, no `.from(...).select(...)` chains. `lib/supabase/server.ts` confirmed using `SUPABASE_SERVICE_ROLE_KEY` with `typeof window` guard. Three publication tables identified as needing anon SELECT (initial framing; revised to 5 after probe).
- **Step 1.5 — publication probe.** Closed 27 May via the dashboard SQL editor. Four tables on the publication (`debriefs`, `llm_calls`, `plan_stages`, `sessions`); `decisions` confirmed absent. Drove the §5 secondary catch.
- **Step 2 — migration draft.** Closed 28 May. 9 ENABLE RLS + 5 policies + 1 publication add; rollback comment block; per-section comments explaining intent. Approved as drafted with one amendment (the publication-add comment naming `scripts/session-runner.ts:297-326` as the latent no-op call site).
- **Step 3 — `pnpm db:push`.** Closed 28 May. Verbatim output recorded in side-task transcript; no errors; auto-accepted `[Y/n]` prompt due to `dotenv-cli` non-piping behaviour (consistent with the `0009_debriefs.sql` push pattern).
- **Step 4 — manual smoke test.** Closed 29 May. Six observable outcomes per §5; one DEFERRED on Step 5 (kill flow) with the agent_session_id-null finding folded into a follow-up sub-slice trigger.
- **Step 5 — decision log + doc edits + commit.** This entry. Single commit lands migration + decision log + CLAUDE.md edit + brief edit per the operator's plan.

---

### §10 · Open follow-ups (not blocking 0017)

- **Worker-bootstrap audit** — the `agent_session_id=null` race window for stuck-killing sessions, observed during Step 5 smoke test. Independent of 0010; needs scoping as its own sub-slice (`0020-…` when entered; slot bumped from the original `0018-…` when 0018 was taken by Slice 6c's close-out and 0019 was queued for the loader-ordering fix). Until that lands, the migration 0010 publication-add for `decisions` is functionally observable only by reading `scripts/session-runner.ts:297-326`'s log file output (`<worktreePath>.log`) for the line `kill decision received — interrupting SDK session` — which won't fire until the worker has a live SDK handle to interrupt.
- **`.subscribe()` status callbacks** — both [`components/review/session-status-subscriber.tsx:38`](../../components/review/session-status-subscriber.tsx) and [`scripts/session-runner.ts:326`](../../scripts/session-runner.ts) call `.subscribe()` without a status callback, silently swallowing subscription failures. Cost-badge has the same gap. Adding a single-line status callback per call site would surface RLS-policy denials, channel auth failures, and similar issues that today are indistinguishable from "subscribed cleanly, no events arriving." Defer until a real failure surfaces and demands the visibility; the 0010 smoke test passed without needing it.
- **Slice 6b's remaining gates** — Gates 3 (tests for `callOpusObject` + widened `insertLlmCallFromAiSdkResult`) and onward resume after this side-task commits. The 6b close-out at `0016-…` is unaffected by this entry beyond a one-sentence cross-reference in its §"Conventions established" section if any of 0017's three conventions become load-bearing in 6b.
