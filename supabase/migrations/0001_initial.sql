-- Numbat — initial schema.
-- Slice 1 (after Slice 0 SDK spike + brief revision).
-- Source of truth: docs/numbat-brief-final.md §7 (post-edit).
--
-- One migration file. Eight tables + indexes + realtime publication.
-- See "Circular FK" note below for why plans.spec_id is added via ALTER TABLE
-- at the bottom rather than declared inline.

create extension if not exists "pgcrypto";

-- ───────────────────────────────────────────────────────────────────────
-- 1. Projects: a codebase Numbat orchestrates against
-- ───────────────────────────────────────────────────────────────────────
create table projects (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  short_code text not null,            -- 'DS', 'MH', 'AL', 'NB'
  repo_path text not null,             -- absolute path on dev machine
  claude_md text,                      -- the project's CLAUDE.md content
  created_at timestamptz default now()
);

-- ───────────────────────────────────────────────────────────────────────
-- 2. Plans: a Bilby planning artifact in progress or complete.
--    Created here WITHOUT spec_id; that column is added at the bottom
--    via ALTER TABLE because of the circular FK with specs.
-- ───────────────────────────────────────────────────────────────────────
create table plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  title text not null,
  brief text not null,
  status text not null check (status in (
    'drafting', 'critiquing', 'considering', 'validating', 'ready', 'shipped', 'abandoned'
  )),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ───────────────────────────────────────────────────────────────────────
-- 3. Specs: the structured artifact produced by a plan (or written manually)
-- ───────────────────────────────────────────────────────────────────────
create table specs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  plan_id uuid references plans(id),
  goal text not null,
  out_of_scope text,
  files_affected jsonb,
  acceptance_criteria jsonb,
  open_questions jsonb,
  version int default 1,
  created_at timestamptz default now()
);

-- ───────────────────────────────────────────────────────────────────────
-- 4. Sessions: one Claude Agent SDK session running on one slice
-- ───────────────────────────────────────────────────────────────────────
create table sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  slice_name text not null,
  worktree_path text,
  task text not null,
  status text not null check (status in (
    'idle', 'planning', 'running', 'awaiting_review', 'blocked', 'done', 'killed'
  )),
  current_step text,
  blocking_reason text,
  spec_id uuid references specs(id),
  agent_session_id text,               -- handle for the Claude Agent SDK session
  last_error jsonb,                    -- structured error if blocked/killed
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);

create index sessions_project_status_idx on sessions(project_id, status);

-- ───────────────────────────────────────────────────────────────────────
-- 5. Plan stages: each step of the four-stage dialectic
-- ───────────────────────────────────────────────────────────────────────
create table plan_stages (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid references plans(id) on delete cascade,
  stage_num int not null,
  actor text not null check (actor in ('opus', 'grok', 'claude_agent')),
  action text not null check (action in (
    'draft', 'critique', 'consider', 'validate', 'execute', 'debrief'
  )),
  llm_provider text,                   -- 'anthropic', 'xai', 'agent_sdk'
  model text,                          -- 'claude-opus-4-7', 'grok-3', etc.
  content jsonb not null,
  duration_ms int,
  created_at timestamptz default now()
);

create index plan_stages_plan_idx on plan_stages(plan_id, stage_num);

-- ───────────────────────────────────────────────────────────────────────
-- 6. Decisions: the log of every meaningful human choice
-- ───────────────────────────────────────────────────────────────────────
create table decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  session_id uuid references sessions(id),
  plan_id uuid references plans(id),
  type text not null check (type in (
    'approve', 'redirect', 'kill', 'accept_critique', 'reject_critique', 'ship', 'edit_spec'
  )),
  context text,
  payload jsonb,
  created_at timestamptz default now()
);

create index decisions_project_idx on decisions(project_id, created_at desc);

-- ───────────────────────────────────────────────────────────────────────
-- 7. Skills: per-project quick-move templates
-- ───────────────────────────────────────────────────────────────────────
create table skills (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  name text not null,
  description text,
  prompt_template text not null,
  usage_count int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index skills_project_usage_idx on skills(project_id, usage_count desc);

-- ───────────────────────────────────────────────────────────────────────
-- 8. LLM calls: every API call to Opus, Grok, or the Agent SDK,
--    for cost and audit.
--
--    Fan-out rule: a single Claude Agent SDK session may invoke multiple
--    models internally (e.g. Haiku for routing + Opus for the response).
--    The SDK's `result.modelUsage` is a per-model dict keyed by model name.
--    Numbat writes ONE ROW PER (session, model) — N rows per session, all
--    sharing session_id. Their cost_usd values sum to result.total_cost_usd.
--    Bilby's direct Anthropic / xAI calls via the AI SDK are single-model
--    and produce one row each.
-- ───────────────────────────────────────────────────────────────────────
create table llm_calls (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  plan_stage_id uuid references plan_stages(id),
  session_id uuid references sessions(id),
  provider text not null check (provider in ('anthropic', 'xai', 'agent_sdk')),
  model text not null,
  prompt_hash text,                                   -- sha256 of the prompt; for dedupe and cache analysis
  input_tokens int not null,                          -- regular (non-cached) input tokens
  output_tokens int not null,
  cache_read_input_tokens int not null default 0,     -- prompt-cache hits, priced ~10% of input
  cache_creation_input_tokens int not null default 0, -- prompt-cache writes, priced ~125% of input
  duration_ms int,
  cost_usd numeric(10, 6) not null,                   -- USD with sub-cent precision; SDK pre-computes for Agent SDK
  error jsonb,                                        -- if the call failed
  created_at timestamptz default now()
);

create index llm_calls_project_created_idx on llm_calls(project_id, created_at desc);

-- ───────────────────────────────────────────────────────────────────────
-- Circular FK with specs — added after both tables exist.
-- See plan/§5 for the rationale (option a: trailing ALTER over DEFERRABLE).
-- ───────────────────────────────────────────────────────────────────────
alter table plans add column spec_id uuid references specs(id);

-- ───────────────────────────────────────────────────────────────────────
-- Realtime subscriptions (per brief §7 notes).
-- The Sessions surface and Cost badge consume these.
-- ───────────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table sessions;
alter publication supabase_realtime add table plan_stages;
alter publication supabase_realtime add table llm_calls;
