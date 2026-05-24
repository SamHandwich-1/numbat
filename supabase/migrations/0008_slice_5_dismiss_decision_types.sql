-- Slice 5 step 4a: extend decisions.type to accept 'dismiss' and 'undismiss'.
--
-- Per docs/decisions/0009-slice-5-operator-action-surface-session-lifecycle.md
-- §B and §D, dismiss and un-dismiss are operator lifecycle actions surfaced
-- via the Slice 5 dismiss UI. Each emits a decisions row (per the brief's
-- "every operator action shows up in the audit log" framing), so the existing
-- type check constraint must widen to accept the two new values.
--
-- Same DROP + ADD CONSTRAINT pattern as migration 0005 (which added
-- 'start_work'). Idempotent on a clean DB because no existing row can hold
-- the new values yet — the constraint blocked them before this migration.

alter table decisions drop constraint decisions_type_check;

alter table decisions add constraint decisions_type_check
  check (type in (
    'approve',
    'redirect',
    'kill',
    'accept_critique',
    'reject_critique',
    'ship',
    'edit_spec',
    'start_work',
    'dismiss',
    'undismiss'
  ));
