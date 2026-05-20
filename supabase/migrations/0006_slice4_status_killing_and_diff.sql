-- Slice 4 — two schema additions on the sessions table.
--
-- 1. Extend the sessions.status check constraint to include 'killing' —
--    the transient state between an operator's kill decision and the
--    worker's confirmed SDK teardown. See plan §2 (two-phase kill
--    resolution) and docs/decisions/0006-slice-4-close-out.md for the
--    rationale: the DB log should never lie about whether a paid SDK
--    process is still running.
--
-- 2. Add sessions.diff jsonb — the worker writes the parsed git-diff
--    output (from lib/feathertail/diff.ts) here on transition to
--    awaiting_review. The review page reads from this column instead
--    of calling git on every render. Shape validated against the
--    WorktreeDiff Zod schema in lib/types/jsonb.ts.
--
-- Postgres has no "modify constraint" — drop + recreate is the
-- standard pattern. Idempotent on a clean DB because no existing
-- row can hold the value 'killing' yet (the column didn't accept it
-- before this migration).

alter table sessions drop constraint sessions_status_check;

alter table sessions add constraint sessions_status_check
  check (status in (
    'idle', 'planning', 'running', 'awaiting_review',
    'blocked', 'done', 'killed', 'killing'
  ));

alter table sessions add column diff jsonb;
