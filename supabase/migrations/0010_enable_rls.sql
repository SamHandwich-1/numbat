-- supabase/migrations/0010_enable_rls.sql
--
-- Revises the brief's "RLS off in V1" position now that server-only DB
-- access has been the established pattern since Slice 1. Resolves the
-- Supabase Security Advisor's 9 "RLS Disabled" warnings.
-- See docs/decisions/0017-enable-rls-with-service-role-bypass.md.
--
-- Pre-flight probe (27 May 2026) confirmed publication membership and
-- the absence of dashboard drift; see the decision log for the full
-- audit trail.
--
-- Rollback (manual, dev only):
--   alter publication supabase_realtime drop table decisions;
--   drop policy if exists "anon realtime read" on public.sessions;
--   drop policy if exists "anon realtime read" on public.llm_calls;
--   drop policy if exists "anon realtime read" on public.plan_stages;
--   drop policy if exists "anon realtime read" on public.debriefs;
--   drop policy if exists "anon realtime read" on public.decisions;
--   alter table public.projects    disable row level security;
--   alter table public.sessions    disable row level security;
--   alter table public.plans       disable row level security;
--   alter table public.plan_stages disable row level security;
--   alter table public.decisions   disable row level security;
--   alter table public.llm_calls   disable row level security;
--   alter table public.specs       disable row level security;
--   alter table public.skills      disable row level security;
--   alter table public.debriefs    disable row level security;

-- 1. Enable RLS on every public table. service_role bypasses RLS by
--    definition (Supabase platform behaviour, not a policy decision) so
--    no policies are needed for server-side reads/writes via sbAdmin.
alter table public.projects    enable row level security;
alter table public.sessions    enable row level security;
alter table public.plans       enable row level security;
alter table public.plan_stages enable row level security;
alter table public.decisions   enable row level security;
alter table public.llm_calls   enable row level security;
alter table public.specs       enable row level security;
alter table public.skills      enable row level security;
alter table public.debriefs    enable row level security;

-- 2. Anon SELECT policies. These deliver postgres_changes events to
--    browser/anon-key subscribers; without them realtime channels
--    subscribe successfully but receive no payloads.
--
--    Coverage: all four currently-published tables plus decisions
--    (publication membership added in step 3 below for the kill
--    subscription).
--
--    using (true) is permissive — any anon caller reads every row.
--    Correct shape for single-operator V1 where the anon key is shared
--    by the operator's own browser, not the public web. If the brief
--    ever opens up multi-user, each policy tightens to e.g.
--    using (auth.uid() = user_id) — V2 question recorded in the
--    decision log.
create policy "anon realtime read" on public.sessions
  for select to anon using (true);
create policy "anon realtime read" on public.llm_calls
  for select to anon using (true);
create policy "anon realtime read" on public.plan_stages
  for select to anon using (true);
create policy "anon realtime read" on public.debriefs
  for select to anon using (true);
create policy "anon realtime read" on public.decisions
  for select to anon using (true);

-- 3. Add decisions to the realtime publication.
--    Enables the existing-but-no-op kill subscription in
--    scripts/session-runner.ts:297-326 for the first time since it was
--    written in Slice 4. Any behavioural surprises in the kill flow
--    that surface after this migration are attributable here. The
--    subscription handler itself is unchanged in this commit; if it
--    misbehaves now that events are flowing, that's a follow-up
--    sub-slice.
alter publication supabase_realtime add table public.decisions;
