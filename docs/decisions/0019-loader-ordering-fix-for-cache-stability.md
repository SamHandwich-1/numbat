> File: docs/decisions/0019-loader-ordering-fix-for-cache-stability.md

## Loader-ordering fix — `loadSpecs` non-deterministic order breaks prefix cache byte-stability

> **Status:** CLOSED.
> **Date:** 6 June 2026.
> **Type:** Defect fix (6a gap surfaced by 6c).
> **Parent:** None — defect fix, not a sub-slice. Closes the forward-pointer that [`0018-slice-6c-opus-debrief-generator.md`](0018-slice-6c-opus-debrief-generator.md) §7 left open.
> **Predecessor:** [`0018-slice-6c-opus-debrief-generator.md`](0018-slice-6c-opus-debrief-generator.md) (Slice 6c close-out; §7 named this gap and reserved the `0019-…` slot for the fix).
> **Successor:** TBD — `0020-…` reserved for the agent_session_id-null worker-bootstrap audit per [`0017-enable-rls-with-service-role-bypass.md`](0017-enable-rls-with-service-role-bypass.md) §10 and §5 (slot rearrangement recorded in 0018's commit `940153c`).
> **Subject:** One-line production change to [`lib/orchestration/context.ts:loadSpecs`](../../lib/orchestration/context.ts) — adds `.order("created_at", { ascending: false })` so the spec list rendered into the cache-stable prefix at `lib/llm/prompts/opus-debrief.ts:buildStablePrefix` is byte-stable across calls. One new mocked test in [`lib/orchestration/context.test.ts`](../../lib/orchestration/context.test.ts) locks both the determinism property (two seeded clients with the same logical content in different physical orders produce identical specs arrays) and the canonical-order semantic (newest first). Verified pre-fix-fail / post-fix-pass before the commit gate.

---

### §1 · The gap

[`lib/orchestration/context.ts:loadSpecs`](../../lib/orchestration/context.ts) at HEAD `940153c` (before this fix) ran `.from("specs").select("*").eq("project_id", projectId)` with no `ORDER BY`. Postgres makes no row-order guarantee on a `SELECT` without an explicit `ORDER BY` clause; two consecutive PostgREST calls against the same project can return the same rows in different physical orders.

`loadSpecs` feeds `ctx.specs` into [`buildStablePrefix`](../../lib/llm/prompts/opus-debrief.ts) at `lib/llm/prompts/opus-debrief.ts:65-72`, where each spec renders as `- ${spec.id} — ${spec.goal}` in the project bundle. The bundle is the cache-stable prefix passed to `callOpusObject` and marked cache-eligible via Anthropic's `cacheControl: { type: 'ephemeral' }` (5-min TTL). Cache hits require the prefix to be **byte-identical** across calls — any reordering of the spec list changes prefix bytes and the cache misses. For any project with ≥2 specs, hit rate would have been a coin flip even when the underlying data hadn't changed.

This is a **correctness defect** in the cache-stability invariant — not a tidy-up. The defect existed in [`0015-slice-6a-schema-and-context-loader.md`](0015-slice-6a-schema-and-context-loader.md)'s `loadSpecs` from the day 6a shipped; the snapshot tests added in 6c at [`lib/llm/prompts/opus-debrief.test.ts`](../../lib/llm/prompts/opus-debrief.test.ts) couldn't catch it because the snapshot fixture pre-orders its specs array. The gap surfaced during 6c's commit-gate review of ContextLoader ordering across the three prefix inputs — `recentDecisions` and `skills` were already deterministic; `loadSpecs` was the outlier.

---

### §2 · The fix

**Production change** at [`lib/orchestration/context.ts:loadSpecs`](../../lib/orchestration/context.ts) — one `.order(...)` chain added after `.eq(...)`:

```ts
private async loadSpecs(projectId: string): Promise<Spec[]> {
  const { data, error } = await this.db
    .from("specs")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });   // ← added
  if (error) { /* unchanged */ }
  return data ?? [];
}
```

Plus a 10-line comment block above the method explaining the cache-stability rationale and forward-pointing to this entry, so a future "simplify" pass can't strip the `ORDER BY` as redundant without reading this rationale first. The pre-existing `// No index on specs.project_id today …` comment is preserved unchanged — the seq-scan is fine and the new in-memory sort over the ≤10-row filtered result is negligible.

**Choice of column.** `created_at desc` matches the convention established by [`loadRecentDecisions`](../../lib/orchestration/context.ts) on `lib/orchestration/context.ts:265` and renders newest-first (more relevant specs surface higher in the prompt). `id` (uuid) is the alternative — also deterministic but semantically meaningless on a v4 random string; reserved for the tiebreaker case named in §4.

**Test** at [`lib/orchestration/context.test.ts`](../../lib/orchestration/context.test.ts) — one new mocked test, "specs are returned in deterministic created_at desc order regardless of physical insertion order." Two seeded `mockClient(...)` instances carry the same three specs in different physical orders (`[mid, old, new]` and `[new, mid, old]`); both run through `ContextLoader.buildFor(projectA, 'session', sessionInA)`. Two assertions:

1. `ids1.toEqual(ids2)` — the determinism property the cache actually depends on. Pre-fix returns physical order (different between the two seeded clients) and this assertion fails.
2. `ids1.toEqual([specNew.id, specMid.id, specOld.id])` — locks the canonical newest-first semantic so a future change to `ascending: true` breaks the test instead of silently shifting the prompt order.

The mock's `evaluate()` at `lib/orchestration/context.test.ts:44-62` implements `.order(col, { ascending })` faithfully (applies the sort to the in-memory rows), so a mocked test is the right scope — there's nothing here that needs a live Postgres exercise to assert. A live-DB test would only be re-asserting Postgres's own `ORDER BY` guarantee, which isn't ours to test.

**Pre-fix-fail / post-fix-pass verified.** Test was added to the test file BEFORE the production fix. `pnpm vitest run lib/orchestration/context.test.ts` against the unmodified `loadSpecs` produced the expected deep-equal failure on `ids1.toEqual(ids2)` with `ids1 = [a2, a1, a3]` and `ids2 = [a3, a2, a1]` (the two physical layouts). After adding `.order("created_at", { ascending: false })` to the production method, the same test passed — both clients returned `[a3, a2, a1]` (canonical newest-first), satisfying both assertions. File-scope test count: 8 → 9, all green in 5ms.

---

### §3 · Rejected alternatives

- **`.order('id', { ascending: true })` instead of `created_at desc`.** Considered for the bulletproof total-order property (uuid PK is always present and always unique, so no tiebreaker concern — see §4). **Rejected** for the default because (a) `id` is a v4 uuid — lexicographic order on a random string carries no semantic value, and (b) `created_at desc` matches the in-file convention `loadRecentDecisions` already uses, keeping ORDER BY columns consistent across the loader. Reserved as the bulletproof fallback if §4's same-tick tie ever surfaces a real cache miss in production.
- **Add a `specs_project_id_idx` migration to back the new ORDER BY.** Considered while reading the existing `// No index on specs.project_id today …` comment. **Rejected** because the comment's premise still holds — specs is a small table (<10 rows in dev across all projects) and the seq-scan cost is negligible. Adding `.order(...)` on the already-filtered ≤10-row result is an in-memory sort, not an index dependency. Revisit if specs growth ever pushes the table past O(100) rows per project.
- **Fold the fix into 6c's gate-1 commit retroactively (rebase `29b1792`).** Considered briefly. **Rejected** because (a) the gap is a 6a defect, not a 6c slip — `loadSpecs` had the same shape at 6a close-out and the snapshot pattern would not have caught it then either; (b) attribution stays cleaner with the defect fix as its own commit + decision log, per the convention from [`0017-enable-rls-with-service-role-bypass.md`](0017-enable-rls-with-service-role-bypass.md) §6 (2) ("mid-slice side-tasks get their own commit + decision log, never get bundled into the host sub-slice's commits"); (c) `29b1792` is already on `origin/master` — rebasing a pushed commit to add a one-line change is the wrong tool for this scope.
- **Stripping the in-method comment block as "obvious."** Considered. **Rejected** because the next operator looking at `loadSpecs` after a /simplify pass or a routine cleanup might see a single trailing `.order(...)` on a method that doesn't paginate and think it's vestigial. The 10-line comment block names the cache-stability invariant, links the consumer (`buildStablePrefix`), and forward-points to this entry. The cost of the comment is small; the cost of someone stripping the ORDER BY because they didn't know why it was there is a class of bug we just closed.

---

### §4 · Known limits — same-`created_at` tie risk

`created_at desc` is a deterministic total order only when no two specs in the same project share an identical `created_at` timestamp. The `specs.created_at` column is `timestamptz default now()` per migration 0001; if two specs are inserted in the same tick (e.g. a future bulk-import script, or a transaction-level coordinated write), the tie would reintroduce arbitrary order on just those rows — the rest of the spec list stays deterministic.

**Not worth fixing now.** Specs are hand-created via the State Custodian (max 10 rows in dev, single-operator), and no current code path inserts multiple specs in the same tick. The probability of a same-tick collision in V1 is effectively zero.

**The bulletproof total-order form is** `.order('created_at', { ascending: false }).order('id', { ascending: true })` — adds a uuid PK tiebreaker so ties on `created_at` resolve deterministically by `id` (lexicographic uuid order, which is meaningless but stable). If 6h ever surfaces an unexplained multi-spec cache miss on a project where `recentDecisions` and `skills` are both stable, this is the first place to look. The fix would be one extra chained `.order('id', { ascending: true })` line; trivial to apply.

---

### §5 · Trigger condition — 6h's first live cache observation

This fix **must land before 6h's first live cache observation.** Both 6b and 6c flag the dependency:

- [`0018-slice-6c-opus-debrief-generator.md`](0018-slice-6c-opus-debrief-generator.md) §7: "This fix MUST land before 6h's first live cache observation — the hit-rate measurement isn't meaningful against a non-deterministic substrate."
- [`0016-slice-6b-opus-client-and-llm-calls-extension.md`](0016-slice-6b-opus-client-and-llm-calls-extension.md) §10: "The 4096-token cache-payload watchpoint for Slice 6c … run two debriefs against the same project within the 5-minute TTL window, and check whether the second's `llm_calls` row has `cache_read_input_tokens > 0`."

Both checks happen during 6h. Without this fix, a missed cache hit could be attributed to either (a) the prefix being under the 4096-token tier minimum (the [`0016-…`](0016-slice-6b-opus-client-and-llm-calls-extension.md) §5(c) caveat), or (b) the loader's non-deterministic order — a confounded observation. Landing this fix first means any missed cache hit in 6h has exactly one suspect: the payload-size watchpoint. Clean attribution.

`0018-…` §7's forward-pointer is closed by this entry.

---

### §6 · CLAUDE.md + brief edits made alongside this entry

**None.** Three checks at the commit gate returned no surface that warranted an edit:

- CLAUDE.md "Always" section already names the prefix-cache convention indirectly via the existing 6b/6c references; adding "Always: ORDER BY on prefix-builder loaders" would be a single-instance codification, which the recurrence-before-codification rule from [`0018-slice-6c-opus-debrief-generator.md`](0018-slice-6c-opus-debrief-generator.md) §6 doesn't yet justify. If a third prefix-builder loader (Slice 7's Bilby stages share the same prefix shape) ever needs the same fix, that earns the CLAUDE.md "Always" bullet at the second-instance point.
- The "Never" section doesn't apply — there's no negative convention to record here ("Never SELECT without ORDER BY" is too broad; loaders for *display* tables routinely don't need ORDER BY).
- The brief at `docs/numbat-brief-final.md` doesn't reference ContextLoader internals.

---

### §7 · Gates closed (audit trail)

Single-step defect fix. Linear sequence:

- **Synthesis** — closed 3 June. Read the current `loadSpecs` and `loadRecentDecisions` verbatim, confirmed the in-file ORDER BY convention, identified that no existing test asserts spec ordering and that the mock harness at `lib/orchestration/context.test.ts:64-106` supports `.order(...)` faithfully (mocked test is sufficient; live-DB test would re-assert Postgres semantics not ours to test).
- **Test-first** — closed 6 June. Added the new test to `lib/orchestration/context.test.ts` BEFORE the production fix. `pnpm vitest run lib/orchestration/context.test.ts` against unmodified `loadSpecs` failed on the determinism assertion with `ids1 = [a2, a1, a3]` vs. `ids2 = [a3, a2, a1]` — the expected failure shape (non-deterministic across physical layouts, not compile or shape error).
- **Production fix** — closed 6 June. Added `.order("created_at", { ascending: false })` to `loadSpecs` + the 10-line cache-stability comment block above the method. Re-ran `pnpm vitest run lib/orchestration/context.test.ts` — 9 tests, all green in 5ms; both assertions in the new test passed.
- **Commit gate** — `pnpm typecheck && pnpm lint && pnpm test` (full suite, not the file-scoped run).
- **This entry** — closed 6 June.

Branch state at close-out: clean on master after the commit.

---

### §8 · Open follow-ups (not blocking 0019)

- **Same-`created_at` tiebreaker watchpoint.** §4. If 6h ever shows an unexplained multi-spec cache miss, add `.order('id', { ascending: true })` as the second `.order(...)` chain. Not actionable until 6h reveals the case.
- **Slice 7 prefix-builder pattern.** When Slice 7's Bilby stages ship, they reuse the same prefix shape from `buildStablePrefix`. If they introduce new loaders for plan-stage data, those loaders need the same ORDER BY discipline. A second instance of "prefix-builder loader missing ORDER BY" would earn the [`0018-slice-6c-opus-debrief-generator.md`](0018-slice-6c-opus-debrief-generator.md) §7 lesson its codification as a CLAUDE.md "Always" convention.
- **0018 §7's "convention worth carrying forward" downgrade ratified.** [`0018-slice-6c-opus-debrief-generator.md`](0018-slice-6c-opus-debrief-generator.md) §7's closing paragraph called the prefix-builder-loader-ORDER-BY check a "lesson worth carrying forward (not yet a codified convention — single instance)." 0019 is now the lock on that single instance; a second instance from Slice 7 would tip it into codification per the recurrence-before-codification rule.
