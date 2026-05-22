> File: docs/decisions/0009-slice-5-operator-action-surface-session-lifecycle.md

# Slice 5 — operator action surface + session lifecycle

> **Date:** 2026-05-22.
> **Type:** Bilby dialectic (four-stage, programmatic).
> **Subject:** Slice 5 — operator action surface + session lifecycle
> **Final verdict:** READY

---

## Stage 1 — Opus draft

> Model: `claude-opus-4-7`

# Slice 5 Plan — Operator Action Surface + Session Lifecycle

## Positions on A–E

### A. FK behaviour for `decisions.session_id` and `decisions.plan_id` → **PRESERVE (SET NULL)**

Cascade is the wrong call here, even though `llm_calls.session_id` cascades. Decisions are a different kind of record. `llm_calls` are mechanical artifacts of a session's existence — if the session is gone, the calls have no referent and no independent meaning. Decisions are *operator acts*: a kill, a redirect, a routing choice. The whole point of writing them down is that they survive the thing they were about. Deleting a session and silently erasing the record of why you killed it last week is the inverse of what an audit log is for.

The "manual two-step that bit three deletion paths" is a real pain, but the fix is `ON DELETE SET NULL` on both FKs plus a denormalized `decisions.session_label` / `decisions.plan_label` snapshot column captured at insert time, so a decision remains legible after its referent is gone. That's one migration, and it makes delete a one-step operation again *without* losing the trail.

This also reframes B and D: `dismissed_at` becomes the **default** terminal-row treatment, and `DELETE` becomes the rare, deliberate "I want this gone" path — where SET NULL preserves the decisions and the operator has already accepted that loss of context.

Uncertain: whether `session_label` should snapshot at decision-insert time or at session-delete time. Insert-time is simpler and matches "the decision was made about *this* session as it was then." Going with insert-time.

### B. Session lifecycle UI cohesion → **INDEPENDENT ADDITIONS, shared status-derivation helper**

The "coherent component family" pitch sounds right and is almost always wrong this early. Slice 5 doesn't yet know what V2 Focus-mode looks like; designing a family for a use case that hasn't been built once is the speculative-generality trap. Ship the ActionBar status-awareness and the dismiss action as independent additions to the existing structure, but extract a single shared `deriveSessionAffordances(session): SessionAffordances` helper that both consume. That gives you the refactor seam for V2 without paying the abstraction tax now.

### C. Action-availability matrix → **(ii) function over session, returning available actions**

Static config (i) fails the moment "kill requires worktree_path" lands — and it will, because the worker heartbeat work in the carry list will introduce more such rules. The discriminated-union exhaustiveness check (iii) is appealing but locks the matrix to `status` alone, which is exactly the thing (ii) avoids; it also fights TypeScript when an action depends on two fields.

Pick (ii): `getAvailableActions(session: Session): Action[]`. Pure function, easy to unit-test, contract explicitly names the case (per 0008). Pair it with a typed `Action` union so the *consumer* (ActionBar) still gets exhaustiveness on rendering. That's the same shared helper from B.

### D. `dismissed_at` scope → **(i) full implementation in Slice 5**

Column-only (ii) is the seductive middle option and it's wrong here because A's resolution makes dismissal *load-bearing*: if decisions preserve on delete and the operator now has a soft-hide alternative, the operator needs the soft-hide to actually exist or the Sessions list grows until Slice 6. The UI is small — a dismiss button on terminal rows, a "show dismissed" toggle on the list, an un-dismiss action. Reversibility is just `UPDATE sessions SET dismissed_at = NULL`. The audit preservation is automatic because nothing is deleted.

### E. router.ts documentation discipline → **(ii) live rules in a comment block on router.ts, brief stays aspirational, with a tripwire**

(i) treats the brief as canonical, which means every router tweak demands a brief edit — high friction, will be skipped, drift returns. (iii) is over-formal for what is often a one-line heuristic change. (ii) is what the codebase will actually do.

The tripwire that makes (ii) work and not rot: a top-of-file comment block in `router.ts` titled `LIVE ROUTING RULES` with a `LAST VERIFIED: <date>` line, and a lint rule (or just a CI grep) that fails if `router.ts` has been modified in a commit that doesn't touch that comment block. Cheap, mechanical, can't be forgotten.

The brief's router section gets a one-line pointer: "Live rules: see router.ts header."

---

## Carry-list triage

Read against `docs/decisions/0006-slice-4-close-out.md` "Carried into Slice 5" — I'm working from the summary in the brief and flagging that the full list may contain items I'm mis-bucketing.

**In Slice 5 (spine + close adjacencies):**
- ActionBar status-awareness *(spine 1)*
- decisions FK behaviour *(spine 2, → SET NULL + label snapshots)*
- `dismissed_at` column + UI *(spine 3)*
- Session-detail back-nav to list *(spine 4)*
- `/api/start-work` returns routed pipeline in response *(tiny; the 404 surprise is the exact class of thing the slice is about)*
- router.ts `LIVE ROUTING RULES` comment block + tripwire *(decision E; defer the lint, ship the comment + a TODO)*
- Explicit decision on `current_step` clearing on terminal transitions *(decide, don't necessarily change — write the decision down)*

**Defer to Slice 6:**
- Worker heartbeat *(non-trivial; needs its own design pass; not blocking)*
- `sessions.total_cost_usd` mirror column *(reconciliation isn't the current pain)*
- Slug truncation mid-word fix *(cosmetic, low-friction workaround exists)*
- Bilby UI groundwork of any kind

**Reclassify as standing tech-debt (no slice):**
- ESLint `argsIgnorePattern` for `_`-prefix
- Next 16 lint migration
- Supabase CLI v1→v2 bump
- auto-mode permission rule for `git push origin master` *(this is config, not slice work — add it to the standing auto-mode rules file directly)*

Uncertain: the brief says "roughly twenty items" and lists ~ten. The other ten could shift any of the above. Triage as draft-only.

---

## Sequencing

The dependency graph forces most of this:

1. **Decision FK migration** (A). Lands first. Everything that follows assumes delete is a one-step op and decisions outlive their referents. Includes the `session_label` / `plan_label` snapshot columns and a backfill for existing rows.
2. **`current_step` terminal-clearing decision**. Written before any UI change reads `current_step`, because the ActionBar work touches it. Likely outcome: keep as forensic trail, document explicitly.
3. **`dismissed_at` column migration**. Schema-only step, before any UI consumes it.
4. **`deriveSessionAffordances` / `getAvailableActions` helper** (C). Pure logic, fully unit-testable, no UI yet. The shared seam for steps 5 and 6.
5. **ActionBar status-awareness** (spine 1). Consumes the helper.
6. **Dismiss UI** (spine 3, UI half). Consumes the helper. List gets a "show dismissed" toggle.
7. **Session-detail back-nav** (spine 4). Independent, can land anywhere after 1; put it here so the slice ends on the lowest-risk change.
8. **`/api/start-work` routed-pipeline-in-response**. Independent, parallelizable.
9. **router.ts comment block + brief pointer** (E). Last, because the router may be touched incidentally during 5/6/8 and you want the `LAST VERIFIED` date to reflect the slice's end state.

---

## Manual verification criterion

Per 0006's productive-failure rule, typecheck/lint/test passing is necessary but not sufficient. The slice ships when an operator can do the following against a live local DB, in one session, without console errors:

1. Start a session via the UI. Observe ActionBar mounts with the right actions for `running`/`planning`/whatever non-terminal status the session enters.
2. Kill the session via ActionBar. Confirm the kill decision row exists in `decisions` with a populated `session_label` snapshot.
3. Delete the session row directly (SQL or admin path). Confirm the decision row survives with `session_id = NULL` and `session_label` still readable.
4. Start a second session, let it reach terminal status, dismiss it from the list. Confirm it disappears from default list view, reappears under "show dismissed", and can be un-dismissed.
5. Navigate into a session detail page, use back-nav, land on the list with state intact (scroll position is a nice-to-have, not a blocker).
6. Hit `/api/start-work` with a prompt that routes to Bilby. Confirm the response body names the pipeline. No 404 surprises.

If any of 1–6 fails, the slice isn't done regardless of CI state.

---

## Bilby pass triggers during implementation

Slice 4 ran zero Bilby passes. Slice 5 is mostly mechanical once A–E are decided, so the default expectation is also zero. Specific things that *would* warrant a pass:

- The `session_label` snapshot approach turns out to be wrong on contact with the data — e.g. the operator wants the *current* label of a renamed-but-not-deleted session. That's a contested decision the spec didn't answer; Bilby it.
- `getAvailableActions` grows past ~6 conditional rules and starts feeling like a state machine. That's an architectural pivot (rules engine vs. state machine) and worth a pass before committing.
- The dismiss UI surfaces an unforeseen interaction with an in-flight session that finishes while dismissed. Edge-case behavior the brief doesn't cover.

Anything else stays in the operator / Claude-Code loop.

---

## Self-acknowledged limits

- **I have not read `docs/decisions/0006-slice-4-close-out.md` directly.** The brief warned me not to rely on its summary and I am partially relying on it. The carry-list triage should be re-checked against the actual file; items I called "reclassify as tech-debt" might have context that promotes them to Slice 5.
- **The `session_label` snapshot approach is a design call I'm making without seeing the current `decisions` schema.** If there's already a `context` JSON column or similar, the snapshot might belong there rather than as new columns. Verify before migration.
- **The router.ts tripwire's CI mechanism is hand-waved.** "A lint rule or a CI grep" — I don't know what this codebase's CI surface looks like. The comment block ships in Slice 5; the enforcement might slip to Slice 6 if it turns out to need real infrastructure.
- **The plan/decisions FK has the same shape of argument as session/decisions, and I applied A symmetrically (SET NULL for both), but plans may have different audit semantics I'm not seeing.** The brief says "one decision, both columns" — I've taken that as license to apply the same answer, but if plan-deletion is supposed to be rare and ceremonial in a way session-deletion isn't, cascade might be defensible for plans alone. Flagging.
- **I did not propose anything about ContextLoader.** The constraints forbid extending it, and nothing in the spine requires it. If the dismiss UI or ActionBar surfaces a need for it (e.g. context-aware action labels), that's a re-plan, not a Slice 5 addition.
- **No estimate of slice size.** Steps 1, 3, 5, 6 are each non-trivial. This may be a large slice. If it needs to split, the cleanest cut is after step 6: spine 1+3 in 5a, spine 4 + start-work + router doc in 5b. I'm not recommending the split yet, but flagging it as the prepared retreat.

---

## Stage 2 — Grok critique

> Model: `grok-4-latest`

**Headline catches**

- The draft's core FK proposal ("ON DELETE SET NULL on both FKs plus a denormalized `decisions.session_label` / `decisions.plan_label` snapshot column") is built on an unknown schema. Section "A. FK behaviour" and the self-acknowledged limits both admit the decisions table shape is unseen. A real migration here risks column-name collisions, existing JSON context already capturing the data, or partial backfill failures on rows with NULL session_id/plan_id already.

- The sequencing places the FK migration first but never checks the "read fresh DB state in catch blocks, not error strings" constraint from 0006 against the new delete path. Any code that does `DELETE FROM sessions` followed by a decision read in the same transaction now has a different contract; the draft never surfaces this.

- The router.ts tripwire ("lint rule or CI grep that fails if router.ts has been modified...") is invented without reference to the actual CI or lint setup. This directly contradicts the constraint "No new top-level architectural surfaces beyond what the carry list demands."

**Gaps vs. brief requirements**

- The brief mandates reading the full carry-list in `docs/decisions/0006-slice-4-close-out.md`. The draft explicitly works from the summary ("I'm working from the summary in the brief") and defers verification. This leaves at least the items the brief lists but the summary omits un-triaged.

- No sequencing or dependency call-out for the 0006 convention on fresh DB reads in catch blocks when any new mutation (dismiss, ActionBar kill, delete) is added.

- The verification criterion lists six operator actions but omits the prerequisite that typecheck/lint/test must pass first (per 0006). It also never names the exact UI entry point for "Start a session via the UI."

- Bilby pass triggers are defined, but the draft never states whether any of the spine items (especially the FK migration or `getAvailableActions`) would themselves trigger a Bilby pass under the criteria it just wrote.

**Missing pieces**

- No data shape or return type for `deriveSessionAffordances` / `getAvailableActions`. The draft says "typed `Action` union" but supplies neither the union nor how status + worktree_path + dismissed_at compose into it.

- No failure mode for the snapshot columns: what happens on decision insert if the referenced session is already soft-deleted, renamed, or has a NULL slug? The draft never defines the capture point relative to the new dismissed_at column.

- The "show dismissed" toggle and list query change are treated as trivial UI work. Missing: whether the list query must now filter `dismissed_at IS NULL` by default, how pagination interacts with the toggle, and whether the same filter must be applied in the session-detail route.

- No prerequisite check for existing sessions that are already terminal. Adding `dismissed_at` and changing FKs requires deciding whether historical terminal rows get `dismissed_at = NULL` or a backfilled timestamp.

**Overconfidence**

- "Decisions are *operator acts*: a kill, a redirect, a routing choice. The whole point of writing them down is that they survive..." asserts a semantic distinction from llm_calls without evidence from the current schema or usage. The draft later admits plans may have different semantics but still applies the same SET NULL rule.

- "The UI is small — a dismiss button on terminal rows, a 'show dismissed' toggle..." treats reversibility and list integration as negligible. This under-specifies the query layer change and the ActionBar's new status-aware mounting condition.

- The claim that `getAvailableActions` "pays for itself in the next two slices" is asserted without identifying which carry-list items in Slice 6 would actually consume the helper versus re-implementing the rules.

**Other issues**

- The draft chooses independent additions with a shared helper for B, but then makes that helper the single source of truth for C. This creates an implicit contract that the brief's "pick the option whose contract explicitly names your case" rule should have forced into the open earlier.

- Carry-list triage puts "Explicit decision on `current_step` clearing" into Slice 5 but never says where the decision is recorded (new decisions/ file? inline comment? 0006 update). This is exactly the kind of item the brief wants surfaced, not just listed.

- The plan never addresses whether the ActionBar mount condition ("any non-terminal session state") must also exclude rows where `dismissed_at IS NOT NULL`, creating an interaction between spine items 1 and 3 that the sequencing does not order.

**Verdict**

62% there. Fix the FK migration assumptions against the real schema, add the fresh-DB-state catch-block check to sequencing, and read the actual 0006 carry-list before the triage is usable.

---

## Stage 3 — Opus consider

> Model: `claude-opus-4-7`

## Dispositions

**Headline catches**

- *FK proposal built on unknown schema.* **ACCEPTED.** The migration design is contingent on what the `decisions` table actually contains. Revised plan moves a "schema audit" step ahead of step 1 in sequencing: read `decisions` schema, check for existing JSON context columns, count rows with already-NULL session_id/plan_id, before committing to new snapshot columns vs. extending an existing JSON field. The FK decision (SET NULL + preserve label) survives; the *shape* of the preservation is now an output of the audit, not a pre-decided column add.

- *Catch-block fresh-DB-read convention vs. new delete path.* **ACCEPTED.** Real omission. Added explicit sequencing item: every new mutation path introduced by the slice (ActionBar kill, dismiss, un-dismiss, delete-with-SET-NULL) is audited against the 0006 convention before that path's PR lands. Called out per-mutation in the sequencing section.

- *Router.ts tripwire invents CI surface.* **PARTIAL.** Agreed the lint/grep mechanism was hand-waved against unknown CI. Walking that back: ship only the `LIVE ROUTING RULES` comment block with `LAST VERIFIED:` date in Slice 5. The enforcement mechanism (lint rule, pre-commit hook, CI grep, or social) becomes a Slice 6 item with its own design pass. The brief's one-line pointer still lands. This is a smaller, honest version of E(ii).

**Gaps vs. brief requirements**

- *Working from summary, not the 0006 file.* **ACCEPTED.** Promoted to a hard prerequisite: the plan as written is provisional pending a read of `docs/decisions/0006-slice-4-close-out.md`. The triage section is now explicitly labelled "draft pending 0006 read" and the first sequencing item is "read 0006 in full, reconcile triage."

- *No catch-block convention call-out on new mutations.* **ACCEPTED.** See above; covered in the headline-catch disposition.

- *Verification omits the typecheck/lint/test prerequisite.* **ACCEPTED.** Added as step 0 of the manual verification list. Also added: the exact UI entry point for "start a session" (the prompt input on the Sessions list page — naming it explicitly so the criterion is reproducible).

- *Bilby triggers don't address whether spine items themselves trigger one.* **ACCEPTED.** Added a direct call: the FK migration is a Bilby trigger *if* the 0006 read or schema audit surfaces existing context-JSON usage that contradicts the snapshot-column design. `getAvailableActions` is *not* a Bilby trigger at design time; only if it grows past the threshold already named.

**Missing pieces**

- *No data shape for the affordances helper.* **ACCEPTED.** Added a sketch of the `Action` union and the helper signature to the C section. Not a full type definition — that's implementation — but enough to make the contract reviewable.

- *Snapshot capture-point failure modes.* **ACCEPTED.** Added explicit rules: snapshot captured at decision-insert time, reading whatever `slug`/`label` field exists on the session at that instant; if NULL, store NULL and let the decision row show `<unnamed session>` in UI. Renames after insert are not tracked — that's the trade-off and it's stated.

- *Dismiss UI / list query / pagination not specified.* **ACCEPTED.** Added a dedicated subsection: default list query becomes `WHERE dismissed_at IS NULL`, toggle flips to no-filter (not `IS NOT NULL` — operator wants to see everything when investigating), session-detail route does *not* filter by dismissed_at (direct URL access still works on dismissed sessions), pagination unchanged because the filter is at the SQL layer not the page layer.

- *Backfill decision for existing terminal rows.* **ACCEPTED.** Explicit: existing terminal rows get `dismissed_at = NULL` on migration. Operator dismisses them manually if desired. No automatic backfill — too easy to hide rows the operator still cares about.

**Overconfidence**

- *Semantic distinction between decisions and llm_calls asserted without evidence.* **PARTIAL.** The semantic argument stands — operator acts vs. mechanical artifacts is a real distinction and the brief itself frames decisions as audit material. What I'll concede: the *symmetric* application to plans was lazy. Revised to: SET NULL for `decisions.session_id`, SET NULL for `decisions.plan_id` as the default position, but the plan-side decision is flagged for explicit re-check during the schema audit. If plan deletion is genuinely ceremonial and rare in current usage, the cascade-vs-preserve trade may resolve differently for plans.

- *"UI is small."* **ACCEPTED.** Walked back. The list query change, the toggle state, the un-dismiss path, and the ActionBar mount condition's interaction with `dismissed_at` are now itemized rather than waved at.

- *"Pays for itself in the next two slices" unsupported.* **PARTIAL.** Fair on the unsupported claim. Revised framing: the helper pays for itself *in this slice* because both spine 1 and spine 3's UI consume it; Slice 6 payoff is speculative and shouldn't have been used as justification.

**Other issues**

- *B says independent additions, C makes the helper a single source of truth — implicit contract surfaced too late.* **ACCEPTED.** Real tension. Resolution: B and C are coherent if framed correctly. B is about *component structure* (no premature component family); C is about *logic centralisation* (one helper for action availability). Surfaced explicitly in the revised B section.

- *`current_step` decision — where is it recorded?* **ACCEPTED.** Specified: new entry in `docs/decisions/` (numbered after 0008, exact number TBD by what lands first). Inline comment in the relevant code points to the decision file.

- *ActionBar mount condition must also exclude `dismissed_at IS NOT NULL`.* **ACCEPTED.** Real interaction missed. Mount condition becomes: non-terminal status AND `dismissed_at IS NULL`. (A dismissed running session is a contradiction we shouldn't create, but if it exists, the ActionBar should still mount — flagged as edge case for verification.) Updated sequencing so spine 3's schema lands before spine 1's mount logic finalises.

## Additions

Two items emerged from the cumulative critique:

1. **Schema audit as a discrete pre-step.** The critique exposed that several decisions (FK preservation shape, snapshot column vs. JSON extension, backfill for existing rows) all depend on facts I don't have. Rather than treat the audit as implicit, it becomes step 0a of the slice: a short, time-boxed read of the `decisions`, `sessions`, and `plans` schemas plus a row-count check on existing NULL-FK and terminal-status rows. Output is a one-page note appended to the plan. This is cheap and it de-risks every subsequent migration choice.

2. **"Prepared retreat" gets a concrete trigger.** The original draft mentioned splitting the slice as a possibility. Adding a trigger: if the schema audit reveals the FK migration is non-trivial (e.g. existing data quality issues, decisions table is bigger than expected, plan-side FK has different semantics than session-side), split the slice at that point — spine 2 alone becomes 5a, the rest becomes 5b. The split decision happens at audit time, not at implementation time, so the slice doesn't half-ship.

## Considered plan

Structure unchanged from the original draft; deltas marked.

### Positions on A–E

- **A (FK behaviour): SET NULL on both, with snapshot preservation.** *Changed:* the snapshot mechanism (new columns vs. extending existing context JSON) is now an output of the schema audit, not pre-decided. The plan-side application is flagged for explicit re-check during the audit rather than asserted symmetrically.
- **B (lifecycle UI cohesion): independent additions, shared logic helper.** *Changed:* the B/C tension surfaced — B is about component structure, C is about logic centralisation, and they coexist coherently.
- **C (action-availability matrix): function over session.** *Changed:* added sketch of `Action` union and `getAvailableActions(session: Session): Action[]` signature. Removed the "pays for itself in next two slices" justification; the in-slice consumption by spine 1 + spine 3 is justification enough.
- **D (dismissed_at scope): full implementation.** *Changed:* dismiss UI now itemised — list-query filter, toggle behaviour, session-detail route unaffected, un-dismiss path, ActionBar mount condition interaction.
- **E (router.ts discipline): comment block only in Slice 5.** *Changed:* enforcement mechanism (lint/grep/hook) deferred to Slice 6. Only the `LIVE ROUTING RULES` block + `LAST VERIFIED` date ships now.

### Carry-list triage

*Changed:* explicitly labelled "draft pending 0006 read." The full read is sequencing step 0. Buckets (in / defer / tech-debt) unchanged in structure but treated as provisional.

### Sequencing

*New step 0:* read `docs/decisions/0006-slice-4-close-out.md` in full; reconcile triage.
*New step 0a:* schema audit of `decisions`, `sessions`, `plans`; row-count check on NULL-FK and terminal rows; output a one-page note.

Steps renumber:
1. Decision FK migration (shape determined by 0a). **Catch-block-convention audit on the new delete path.**
2. `current_step` terminal-clearing decision recorded in a new `docs/decisions/` entry.
3. `dismissed_at` column migration. Existing terminal rows backfill to NULL.
4. `deriveSessionAffordances` / `getAvailableActions` helper. Pure logic, unit-tested.
5. ActionBar status-awareness. **Mount condition: non-terminal AND `dismissed_at IS NULL`. Catch-block-convention audit on the kill mutation.**
6. Dismiss UI: button, list-query filter (default `dismissed_at IS NULL`), "show dismissed" toggle (no filter), un-dismiss action. **Catch-block-convention audit on dismiss/un-dismiss mutations.**
7. Session-detail back-nav.
8. `/api/start-work` returns routed pipeline name.
9. router.ts `LIVE ROUTING RULES` comment block + brief pointer.

*New decision gate after step 0a:* if the audit reveals FK migration is non-trivial, split into 5a (spine 2 alone) and 5b (rest).

### Manual verification criterion

*New step 0:* typecheck, lint, full test suite pass.
*Changed step 1:* names the UI entry point explicitly — prompt input on the Sessions list page.
Steps 1–6 otherwise unchanged.
*New step 7:* confirm a dismissed session is still reachable via direct URL to its detail page (regression check on the list-only filter).

### Bilby pass triggers

*Added:* the schema audit (step 0a) is itself a Bilby trigger *if* it reveals existing context-JSON usage on `decisions` that contradicts the snapshot-column design, or plan-side FK semantics meaningfully different from session-side. Other triggers unchanged.

### Self-acknowledged limits

*Removed:* the limit about not having read 0006 (now a sequencing prerequisite, not a limit).
*Removed:* the limit about the snapshot approach being a blind design call (now contingent on audit).
*Kept:* the router.ts CI mechanism is unknown (now resolved by deferring enforcement to Slice 6).
*Kept:* plan-side FK semantics may differ (now resolved into the audit).
*Kept:* no ContextLoader proposals.
*Kept:* slice-size flag and split-trigger; the trigger is now concrete (audit outcome) rather than vibe-based.

---

## Stage 4 — Grok validate

> Model: `grok-4-latest`

## Verdict
READY. All material critiques have been converted into concrete, sequenced work items with explicit verification hooks and a data-driven decision gate.

## Confirmed dispositions
- **Accepted critiques correctly addressed**: Schema audit promoted to step 0a with output note; catch-block convention audits added for every new mutation path; verification now starts with typecheck/lint/test and names the exact UI entry point; dismissed_at UI behaviour (list filter, toggle, direct-URL access, un-dismiss) fully itemised; Action union + `getAvailableActions` signature sketched; mount condition updated to `non-terminal AND dismissed_at IS NULL`; sequencing now enforces schema before ActionBar logic; backfill rule stated as explicit NULL; split trigger made concrete (audit outcome).
- **Rejected/partial critiques confirmed sound**: Router enforcement deferred to Slice 6 is the right scope reduction; plan-side FK re-check moved into the audit rather than asserted symmetrically; "pays for itself" justification replaced with in-slice consumption argument; component-structure vs. logic-centralisation tension surfaced explicitly in B/C.
- **No disagreed dispositions**: every acceptance has visible deltas in the plan rather than promises.

## Residual risks
- small: schema audit may still surface unexpected data volume or JSON usage that forces a 5a/5b split mid-slice.
- small: operator must remember to run the "show dismissed" toggle during verification to exercise the unfiltered path.
- medium: plan-side FK semantics remain an open variable until the audit; if they diverge sharply the SET NULL choice could be revisited without affecting the session side.

## Sign-off
Ship it. The plan now contains the missing schema prerequisite, the mutation audits, the explicit UI contracts, and the data-driven split gate; execute the audit first and let its output determine whether the slice stays whole or splits cleanly at spine 2.

---

## Meta-observations

<!-- add manually if patterns are worth recording. This section is a human
     curatorial layer — the bilby-dialectic.ts script deliberately leaves it
     empty. Add meta-observations only when a particular dialectic earned
     them (cross-family catches worth recording, calibration findings,
     surprising rejections, etc.). -->
