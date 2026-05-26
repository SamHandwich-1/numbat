-- supabase/migrations/0009_debriefs.sql
--
-- Slice 6, sub-slice 6a — `debriefs` table (with `debrief_type` discriminator),
-- extension of `decisions.type` to include `create_plan`, and realtime
-- publication on `debriefs`. See docs/decisions/0013-slice-6-plan.md §5.
--
-- Pre-flight Item 9 (constraint-drift check) verified the live constraint on
-- 25 May 2026 against the cloud project. Live set is exactly the post-0008
-- 10-value set:
--   ('approve', 'redirect', 'kill',
--    'accept_critique', 'reject_critique',
--    'ship', 'edit_spec',
--    'start_work',
--    'dismiss', 'undismiss')
-- The new constraint is those 10 values plus 'create_plan' — 11 values total.
-- No values are silently dropped.
--
-- Rollback (manual, dev only):
--   alter publication supabase_realtime drop table debriefs;
--   drop table if exists debriefs;
--   alter table decisions drop constraint decisions_type_check;
--   alter table decisions add constraint decisions_type_check
--     check (type in ('approve', 'redirect', 'kill',
--                     'accept_critique', 'reject_critique',
--                     'ship', 'edit_spec',
--                     'start_work',
--                     'dismiss', 'undismiss'));
-- The rollback restores the post-0008 set (10 values), NOT the post-0001
-- set (7 values). Restoring the original Slice 1 set would re-break every
-- existing 'start_work' / 'dismiss' / 'undismiss' row. Pre-flight Item 9.

-- 1. Debriefs: one or more per session (or per plan_stage, in Slice 7).
--    debrief_type discriminates the content shape; the Zod schema in
--    application code is a discriminated union keyed on this column.
create table debriefs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  session_id uuid references sessions(id) on delete cascade,
  plan_stage_id uuid references plan_stages(id) on delete cascade,
  debrief_type text not null
    check (debrief_type in (
      'direct',
      'bilby_draft',
      'bilby_critique',
      'bilby_consider',
      'bilby_validate'
    )),
  content jsonb not null,                            -- Zod: discriminated by debrief_type
  llm_call_id uuid references llm_calls(id),         -- nullable: the call may have failed before write
  prompt_version text not null,                      -- e.g. 'v1' — for prompt evolution tracking
  duration_ms int,
  created_at timestamptz default now(),
  -- At least one of session_id or plan_stage_id must be set.
  constraint debriefs_target_check
    check (session_id is not null or plan_stage_id is not null)
);

create index debriefs_session_idx on debriefs(session_id, created_at desc);
create index debriefs_plan_stage_idx on debriefs(plan_stage_id, created_at desc);
create index debriefs_project_created_idx on debriefs(project_id, created_at desc);
create index debriefs_type_idx on debriefs(debrief_type);

-- 2. Decisions: extend type check constraint to include 'create_plan'.
--    The full set is the post-0008 set (10 values, after migrations
--    0005 added 'start_work' and 0008 added 'dismiss'/'undismiss')
--    plus the new 'create_plan' — 11 values total. Pre-flight Item 9
--    caught the earlier draft, which would have dropped three valid
--    values and invalidated every existing brief-submission and
--    dismiss/undismiss row.
alter table decisions drop constraint if exists decisions_type_check;
alter table decisions add constraint decisions_type_check
  check (type in (
    'approve', 'redirect', 'kill',
    'accept_critique', 'reject_critique',
    'ship', 'edit_spec',
    'start_work',
    'dismiss', 'undismiss',
    'create_plan'
  ));

-- 3. Realtime publication on debriefs.
alter publication supabase_realtime add table debriefs;
