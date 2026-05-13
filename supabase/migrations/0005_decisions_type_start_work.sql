-- Slice 2b: Start Work emits a 'start_work' decisions row recording
-- the router's classification (routed_to, matched_rule, reason). Add
-- the new value to the type check constraint.
--
-- The original constraint in 0001_initial.sql is inline on the column,
-- so Postgres auto-named it `decisions_type_check` (table_column_check
-- pattern). Drop and re-add with the extended value list.

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
    'start_work'
  ));
