-- Slice 5 step 1 — FK behaviour change on decisions + dismissed_at on sessions.
--
-- Two changes that travel together because they share the migration's mental
-- model (terminal-row lifecycle): decisions outlive their referents via
-- ON DELETE SET NULL + a payload snapshot, and dismissed_at gives terminal
-- session rows a soft-hide path so DELETE stays the rare/deliberate option.
--
-- Snapshot mechanism: the session_label / plan_label snapshot fields ride
-- inside the existing decisions.payload jsonb shape, not as new columns —
-- see docs/decisions/0009-slice-5-...md §A and "Step 0a schema audit" §A.
-- The schema-side migration here is only the FK behaviour change and the
-- dismissed_at column; the Zod discriminated union in lib/types/jsonb.ts
-- carries the rest in the same commit.
--
-- Constraint naming: Postgres auto-generates `<table>_<column>_fkey` for
-- inline FK declarations. Migration 0001 declared decisions.session_id and
-- decisions.plan_id inline, so the auto-names are decisions_session_id_fkey
-- and decisions_plan_id_fkey. Precedent in 0002 confirms the same pattern
-- (it dropped llm_calls_session_id_fkey by the equivalent auto-name). If a
-- name happens to be different on this DB, the DROP CONSTRAINT below fails
-- loudly with "constraint X does not exist" BEFORE any destructive change
-- runs — self-checking, no separate assertion block needed.

-- ───────────────────────────────────────────────────────────────────────
-- 1. decisions.session_id FK: NO ACTION → SET NULL.
--
--    The "Audit trail lives in the decisions table" rationale from
--    migration 0002's cascade rule (on llm_calls) is the inverse here:
--    decisions are the survival path, so SET NULL preserves the row while
--    making delete a one-step operation. Audit context is preserved via
--    the payload snapshot (Zod-extended in the same commit, not here).
-- ───────────────────────────────────────────────────────────────────────

alter table decisions
  drop constraint decisions_session_id_fkey,
  add constraint decisions_session_id_fkey
    foreign key (session_id) references sessions(id)
    on delete set null;

-- ───────────────────────────────────────────────────────────────────────
-- 2. decisions.plan_id FK: NO ACTION → SET NULL.
--
--    Symmetric with §1 above. Step 0a §C confirmed plan-side semantics
--    are not meaningfully different from session-side in live data (both
--    routine, both already exercise the NULL state), so the FK behaviour
--    is the same.
-- ───────────────────────────────────────────────────────────────────────

alter table decisions
  drop constraint decisions_plan_id_fkey,
  add constraint decisions_plan_id_fkey
    foreign key (plan_id) references plans(id)
    on delete set null;

-- ───────────────────────────────────────────────────────────────────────
-- 3. sessions.dismissed_at — soft-hide for terminal rows.
--
--    Nullable, no default. The Sessions list will default to filtering
--    `dismissed_at IS NULL`; toggling "show dismissed" removes the
--    filter. Un-dismiss is `UPDATE sessions SET dismissed_at = NULL`.
--    The session-detail route does NOT filter by dismissed_at — direct
--    URLs continue to work on dismissed rows.
--
--    Existing terminal rows (7 at audit time per Step 0a §D) receive
--    dismissed_at = NULL on add (Postgres default for a new nullable
--    column). No backfill — automatic backfill would silently hide rows
--    the operator might still care about; manual dismissal is the right
--    posture.
--
--    Column position: ADD COLUMN appends at the end of the table, so
--    dismissed_at lands after `diff jsonb` (the Slice 4 addition).
--    Cosmetic in \d output; Postgres column order has no behavioural
--    effect.
-- ───────────────────────────────────────────────────────────────────────

alter table sessions add column dismissed_at timestamptz;
