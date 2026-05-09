# Numbat — Claude Code Brief

> **Status:** Final, post Stage 4 validation. READY to ship.
> **Dialectic trail:** `/docs/numbat-bootstrap-dialectic.md`.
> **Last revised:** 9 May 2026.

---

## 1 · Vision

**Numbat** is a single-operator control surface that orchestrates Claude Agent SDK sessions across multiple codebases, with a built-in cross-family LLM dialectic for strategic planning.

The thesis: trust Claude Agent SDK to execute (with review); use Opus + Grok to find gaps in plans *before* code is written. The multi-LLM stack earns its keep at planning, not execution. Make every gate visible and persistent — the decisions log is the seed of every future improvement.

The user (James) runs 5–10 parallel slices of work across 3–5 codebases at any time. Numbat reduces the cognitive load of holding all of them at once, while maintaining an educational debrief loop that turns every Claude Agent SDK interaction into a learning event.

---

## 2 · Naming lattice

- **Numbat** — the OS itself. Patient generalist. Carries an intentional ironic register (Australian slang for "idiot") — the system is designed knowing any one LLM is a bit of a numbat, which is why the dialectic exists.
- **Bilby** — the planning dialectic feature. Long ears, careful listener, builds elaborate burrows with multiple entrances and fallback paths.
- **Feathertail** — the execution/worktree layer. The smallest gliding mammal in the world; uses its tail as a mid-flight rudder for millimetre-precision steering.

These names appear consistently in the codebase: directory names, type names, UI labels, internal documentation. They are not decorative.

---

## 3 · Architecture summary

Five layers, top to bottom:

1. **Interface** — Next.js App Router. Sessions surface (control panel + Start Work input), Plans surface (thinking room), Diff & Review pane, Reply composer, cost badge.
2. **Orchestration** — four concrete components: Router (decides pipeline), State Custodian (owns canonical spec docs), Escalation Handler (retry / ask / kill), **ContextLoader** (assembles per-project context for every session and plan stage; named explicitly so the contract is clear before implementation).
3. **Pipelines** — Direct (Claude Agent SDK ⇄ Opus debrief) and Bilby (Opus draft → Grok critique → Opus considered → Grok validate → Claude Agent SDK → Grok output review → Opus debrief).
4. **Feathertail (execution)** — `@anthropic-ai/claude-agent-sdk` driving git worktrees / slices. One slice = one worktree = one session.
5. **Persistence** — Supabase Postgres for state (cloud), plus an `llm_calls` audit table and the decisions log as first-class artifacts.

A unified Sessions view shows all sessions across all projects; project chips and a Focus mode replace tabbed navigation.

---

## 4 · Runtime environment

Numbat is **local-first.** It runs on the developer's machine, not on Vercel.

- **The app:** `pnpm dev` (Next.js) on the local machine for V1. A Tauri/Electron wrapper for system-tray distribution is V2 territory.
- **State / realtime:** Supabase cloud. Network calls are fine; latency is acceptable.
- **Background jobs:** Spawned Node workers (`pnpm tsx scripts/session-runner.ts <session_id>`) per Claude Agent SDK session. No external job queue dependency in V1. Trigger.dev (self-hosted) or BullMQ may be added in V2 if scale demands.
- **Worktrees:** Stored at `~/numbat-worktrees/<project-slug>/<slice-name>/`. Auto-cleaned 24h after session reaches `done` or `killed` status (grace period for post-mortems). Branch collision check before creation.
- **Secrets:** `.env.local` only. Never committed.
- **Hosting summary:** No Vercel. No cloud function timeouts. The orchestrator runs where the repos live.

Why local-first: the Claude Agent SDK is local-execution-first by design — it needs filesystem, shell, git, and `claude` binary access in the developer's actual environment. Trying to drive it from Vercel would fail at the FS boundary. (This was the architecture-invalidating gap caught in stage 2 of the bootstrap dialectic.)

---

## 5 · V1 scope

### In scope (V1)

- Multi-project Sessions surface with project chips, filter bar, Focus mode.
- **Start Work surface** at the top of the Sessions view: text input that, on submit, routes to either a Session (Direct path) or a Plan (Bilby path) via the router's rules.
- Diff & Review screen with structured Opus debrief (four-section format + optional "new concept").
- Reply & Redirect composer with project-aware quick-move chips (read from skills table).
- **Kill-in-progress mechanism** that propagates to the Agent SDK session and cleans up state.
- Plans surface designed and shipped (UI + data model). The four-stage dialectic itself implemented in slices 5–6.
- Direct pipeline working end-to-end (Claude Agent SDK ⇄ Opus debrief, no spec generation).
- Per-project context: each project has its own CLAUDE.md, spec docs, decisions log, skills library — assembled fresh by the ContextLoader at every session and plan-stage boundary.
- **Diff capture for review** uses `lib/feathertail/diff.ts` (`git status --porcelain` + `git diff` + `git diff --stat`, run inside the session's `cwd` post-session). SDK `tool_use` events drive the in-progress UI indicator only — they're not persisted as the diff record. `SDKFilesPersistedEvent` is documented but proved unreliable in the SDK spike, so we don't depend on it.
- Decisions log capturing every approve / redirect / kill, every spec accept/reject, every plan ship.
- Rules-based router with hard heuristic: if brief is under 200 chars or matches simple keywords (fix, typo, copy, style), default to Direct.
- **Cost badge** in the chrome bar showing today's $ spend, pulled from `llm_calls`. Full dashboard is V2.
- **Create flows:** UI for creating new sessions (slice 2) and new plans (slice 5).
- Single-user. No auth complexity. Hardcode James as the only operator; gate behind a simple session token.

### Explicitly out of scope (deferred to V2/V3)

- LLM-based router (V2; needs decisions-log data first).
- Hooks layer (V2; only build when friction shows up).
- Auto-skill generator (V3).
- Subagents inside Claude Agent SDK sessions (V3).
- Vector store / RAG retrieval (V3; only for the deepest planning loop).
- Pipeline visualiser UI (V3).
- Voice input for Start Work (Whisper API; V2).
- Cross-project decisions signal (V2; flagged via `cross_project: bool`).
- Full cost dashboard / export UI (V2).
- Multi-user / sharing / `created_by` columns (post-V3, may never need).
- Tauri/Electron wrapper (V2).

### Non-goals

- Not building a general-purpose AI tool. Built for one operator's specific workflow.
- Not competing with Cursor, Aider, or other coding agents — Numbat orchestrates *Claude Agent SDK*, doesn't replace it.
- Not a SaaS. Self-hosted, single-tenant, runs on the developer's machine.

---

## 6 · Tech stack

- **Frontend:** Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn/ui (Radix-based).
- **State + realtime:** Supabase (Postgres + realtime subscriptions). RLS off in V1; single-user.
- **Background workers:** Node child processes spawned per session (`scripts/session-runner.ts`). No external queue framework in V1.
- **LLM abstraction:** Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/xai`) for Opus and Grok. Clean streaming, tool calls, provider swap.
- **Claude Agent SDK:** `@anthropic-ai/claude-agent-sdk` (TypeScript). Bundles the Claude Code binary as an optional dependency; no separate Claude Code install required. CLAUDE.md delivery uses `settingSources: ['project']` per the SDK's filesystem-based configuration support. Cost data: `SDKResultSuccess` exposes `total_cost_usd` pre-computed plus per-model breakdown via `modelUsage`. We trust it; no maintained price table for the Agent SDK path. Bilby's direct Anthropic / xAI calls via the AI SDK do need a price table; that's deferred to the Bilby slice.
- **Hosting:** Local (the dev machine) for the app + workers. Supabase cloud for the database. No Vercel.
- **Typography (UI):** Instrument Serif (display), JetBrains Mono (body/labels). Match the design system from the mocks.
- **Design tokens:** Defined as CSS variables in `app/globals.css` matching the mock palette (mint `#7ed4c6`, amber `#e0a04b`, coral `#c87f7f`, Opus violet `#b094d6`, Grok yellow `#d6c890`, warm-dark `#0d0c0b`).

---

## 7 · Data model (Supabase / Postgres)

```sql
-- Projects: a codebase Numbat orchestrates against
create table projects (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  short_code text not null,            -- 'DS', 'MH', 'AL', 'NB'
  repo_path text not null,             -- absolute path on dev machine
  claude_md text,                      -- the project's CLAUDE.md content
  created_at timestamptz default now()
);

-- Sessions: one Claude Agent SDK session running on one slice
create table sessions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  slice_name text not null,
  worktree_path text,
  task text not null,
  status text not null,                -- enum: idle, planning, running, awaiting_review, blocked, done, killed
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

-- Plans: a Bilby planning artifact in progress or complete
create table plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  title text not null,
  brief text not null,
  status text not null,                -- enum: drafting, critiquing, considering, validating, ready, shipped, abandoned
  spec_id uuid references specs(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Plan stages: each step of the four-stage dialectic
create table plan_stages (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid references plans(id) on delete cascade,
  stage_num int not null,
  actor text not null,                 -- enum: opus, grok, claude_agent
  action text not null,                -- enum: draft, critique, consider, validate, execute, debrief
  llm_provider text,                   -- 'anthropic', 'xai', 'agent_sdk'
  model text,                          -- 'claude-opus-4-7', 'grok-3', etc.
  content jsonb not null,
  duration_ms int,
  created_at timestamptz default now()
);

create index plan_stages_plan_idx on plan_stages(plan_id, stage_num);

-- Specs: the structured artifact produced by a plan (or written manually)
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

-- Decisions: the log of every meaningful human choice
create table decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  session_id uuid references sessions(id),
  plan_id uuid references plans(id),
  type text not null,                  -- enum: approve, redirect, kill, accept_critique, reject_critique, ship, edit_spec
  context text,
  payload jsonb,
  created_at timestamptz default now()
);

create index decisions_project_idx on decisions(project_id, created_at desc);

-- Skills: per-project quick-move templates
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

-- LLM calls: every API call to Opus, Grok, or the Agent SDK, for cost and audit.
--
-- Fan-out rule: a single Claude Agent SDK session may invoke multiple models
-- internally (e.g. Haiku for routing + Opus for the response). The SDK's
-- `result.modelUsage` is a per-model dict keyed by model name. Numbat writes
-- ONE ROW PER (session, model) — N rows per session, all sharing session_id.
-- Their cost_usd values sum to result.total_cost_usd. Bilby's direct
-- Anthropic / xAI calls via the AI SDK are single-model and produce one row each.
create table llm_calls (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  plan_stage_id uuid references plan_stages(id),
  session_id uuid references sessions(id),
  provider text not null,                          -- 'anthropic', 'xai', 'agent_sdk'
  model text not null,
  prompt_hash text,                                -- sha256 of the prompt; for dedupe and cache analysis
  input_tokens int not null,                       -- regular (non-cached) input tokens
  output_tokens int not null,
  cache_read_input_tokens int not null default 0,  -- prompt-cache hits, priced ~10% of input
  cache_creation_input_tokens int not null default 0, -- prompt-cache writes, priced ~125% of input
  duration_ms int,
  cost_usd numeric(10, 6) not null,                -- USD with sub-cent precision; SDK pre-computes for Agent SDK calls
  error jsonb,                                     -- if the call failed
  created_at timestamptz default now()
);

create index llm_calls_project_created_idx on llm_calls(project_id, created_at desc);
```

Notes:
- Status fields use text + check constraints rather than Postgres enums (easier to evolve).
- All `jsonb` fields have validated TypeScript types via Zod schemas in `lib/types/`.
- Realtime subscriptions enabled on `sessions`, `plan_stages`, and `llm_calls` (for the cost badge).

---

## 8 · Project structure

```
numbat/
├── app/
│   ├── (sessions)/
│   │   ├── page.tsx              # Sessions surface — home + Start Work input
│   │   └── [sessionId]/
│   │       └── page.tsx          # Diff & Review + Reply
│   ├── (plans)/
│   │   ├── page.tsx              # Plans index
│   │   └── [planId]/
│   │       └── page.tsx          # Plan detail (Bilby dialectic view)
│   ├── api/
│   │   ├── sessions/             # CRUD + start/stop
│   │   ├── plans/                # CRUD + dialectic triggers
│   │   └── start-work/           # router endpoint for Start Work input
│   ├── globals.css               # design tokens
│   └── layout.tsx
├── components/
│   ├── sessions/
│   │   ├── SessionList.tsx
│   │   ├── SessionCard.tsx
│   │   ├── ProjectFilter.tsx
│   │   ├── StatusFilter.tsx
│   │   ├── FocusBanner.tsx
│   │   ├── ProjectChip.tsx
│   │   └── StartWorkInput.tsx
│   ├── review/
│   │   ├── DebriefBlock.tsx
│   │   ├── DiffPreview.tsx
│   │   ├── ActionBar.tsx
│   │   └── ReplyComposer.tsx
│   ├── plans/
│   │   ├── PlanHeader.tsx
│   │   ├── BriefBlock.tsx
│   │   ├── DialecticTimeline.tsx
│   │   ├── StageCard.tsx
│   │   ├── ConsideredList.tsx
│   │   ├── VerdictBanner.tsx
│   │   ├── SpecPreview.tsx
│   │   ├── GapFinder.tsx
│   │   └── OpenQuestions.tsx
│   ├── shared/
│   │   └── CostBadge.tsx
│   └── ui/                       # shadcn/ui primitives
├── lib/
│   ├── supabase/
│   │   ├── client.ts
│   │   ├── server.ts
│   │   └── migrations/
│   ├── feathertail/              # execution layer (worktrees + Agent SDK)
│   │   ├── worktree.ts           # git worktree create/list/cleanup
│   │   ├── agent-sdk.ts          # @anthropic-ai/claude-agent-sdk wrapper
│   │   └── session-runner.ts     # invoked by spawned worker
│   ├── bilby/                    # planning dialectic
│   │   ├── opus-draft.ts
│   │   ├── grok-critique.ts
│   │   ├── opus-consider.ts
│   │   ├── grok-validate.ts
│   │   └── orchestrator.ts
│   ├── llm/
│   │   ├── opus.ts               # Anthropic via AI SDK
│   │   ├── grok.ts               # xAI via AI SDK
│   │   ├── models.ts             # model name constants
│   │   └── prompts/              # versioned prompt templates
│   ├── orchestration/
│   │   ├── router.ts             # rules-based pipeline picker
│   │   ├── state-custodian.ts    # spec doc lifecycle
│   │   ├── escalation.ts
│   │   └── context.ts            # ContextLoader — per-project context assembly
│   ├── debrief/
│   │   └── opus-debrief.ts
│   └── types/
│       ├── db.ts
│       ├── plan.ts
│       └── session.ts
├── scripts/
│   ├── session-runner.ts         # spawned per session
│   └── export-decisions.ts       # CLI: pnpm export:decisions
├── docs/
│   └── numbat-bootstrap-dialectic.md
├── public/
├── CLAUDE.md
├── README.md
├── package.json
├── tsconfig.json
├── tailwind.config.ts
└── .env.example
```

---

## 9 · CLAUDE.md (for the Numbat repo itself)

> Save as `CLAUDE.md` in the repo root. The Claude Agent SDK reads it on every session via `settingSources: ['project']`.

```markdown
# Numbat — Repo Context

## What this is
A single-operator control surface that orchestrates Claude Agent SDK sessions across multiple codebases, with a built-in multi-LLM dialectic for strategic planning. Local-first; runs on the developer's machine.

## Naming
- **Numbat** — the OS (this codebase).
- **Bilby** — planning dialectic feature (`lib/bilby/`).
- **Feathertail** — execution/worktree layer (`lib/feathertail/`).
Use these names consistently in code, comments, and UI.

## Stack
Next.js 15 (App Router) · TypeScript · Tailwind · shadcn/ui · Supabase · Vercel AI SDK (Anthropic + xAI) · `@anthropic-ai/claude-agent-sdk`.

## Architecture
Five layers: Interface → Orchestration (Router, State Custodian, Escalation, ContextLoader) → Pipelines (Direct + Bilby) → Feathertail (execution) → Persistence.

## Runtime environment
- Local-first. Runs via `pnpm dev` on the dev machine.
- Supabase cloud for state.
- Background work: spawned Node workers per session (no external queue in V1).
- Worktrees live at `~/numbat-worktrees/<project-slug>/<slice-name>/`. Auto-cleaned 24h after session done/killed.
- The Agent SDK reads each project's `CLAUDE.md` via `settingSources: ['project']`.

## Coding conventions
- TypeScript strict mode. No `any`. Prefer `unknown` + narrowing.
- Server Components by default. `"use client"` only when interactivity demands it.
- Database access: only from server (RSC, route handlers, scripts/workers). Never from client.
- Imports: absolute via `@/`. Group: external → `@/lib` → `@/components` → relative.
- File names: kebab-case for routes, PascalCase for components, kebab-case for libs.
- Errors: typed error returns over thrown exceptions for expected failures. Throw only for genuine bugs.

## Always
- Run `pnpm typecheck` and `pnpm lint` before declaring a slice complete.
- Validate jsonb fields with Zod before insert.
- Use Supabase realtime for any UI showing session/plan state. Never poll.
- Log every LLM call to `llm_calls` (model, prompt hash, tokens, duration, cost, error).
- Load project context via `ContextLoader` at every session/plan-stage boundary. Never reach across projects.

## Never
- Never commit secrets. `.env.local` and OS keychain only.
- Never hardcode model names; reference via `lib/llm/models.ts`.
- Never bypass the State Custodian to write to specs directly.
- Never expose `service_role` Supabase key to the client.
- Never ship a session that hasn't recorded its triggering decision in the `decisions` table.
- Never share LLM history across projects. Each session/plan stage gets fresh context.

## Resilience
- LLM call timeouts: Opus draft 90s, Grok critique 60s, Opus considered 90s, Grok validate 60s, Opus debrief 60s. Agent SDK sessions: no timeout (kill via signal only).
- Retry: max 2 retries on network errors, exponential backoff (1s, 2s). No retry on 4xx.
- Failure modes: LLM call failure → row in `llm_calls` with `error` populated, status update on the parent session/plan. UI shows the error inline; the loop fails open (the user can redirect or kill).
- Session worker crash: parent session row marked `blocked` with `last_error`; user is notified via realtime.

## Single-operator assumptions (V1)
- One user (James). Auth = single hardcoded session token in `.env`. No user table.
- Project list seeded from `config/projects.json`. No admin UI in V1.
- `created_by` columns deferred. Migration to add later is cheap; speculative now.

## Design system reference
- Display font: Instrument Serif (italic).
- Body/mono font: JetBrains Mono.
- Palette: see `app/globals.css`. Status colours (mint = running, amber = awaiting, coral = blocked) are reserved; project chip colours are a separate scale.
- Dark mode by design; light mode is not a goal.

## When in doubt
Read the spec for the current slice. If it doesn't answer the question, surface it as an Open Question in the debrief rather than guessing.
```

---

## 10 · Project context loading (the ContextLoader contract)

Project context is a runtime concern, not just a data-model fact. Without explicit boundaries, signal from one project bleeds into another — brand voice rules from Departed Spirits influencing Men's Health work, decisions-log patterns from one codebase polluting the router for another. The `ContextLoader` (`lib/orchestration/context.ts`) is the single place that assembles context, and the contract is strict.

### Three scopes

**Project context = the bundle.**
- The project's `CLAUDE.md`.
- All active spec docs for the project.
- The project's skills library.
- The last 30 decisions log entries for the project.
- Cached at the project level. Invalidated on any write to project-scoped tables.

**Session context = bundle + slice-specific.**
- The project bundle.
- The slice's spec doc (if any).
- Any prior debrief from this slice.
- Loaded fresh into the Agent SDK at session start via `settingSources: ['project']` for `CLAUDE.md`, plus explicit prompt injection for the spec and prior debrief.
- Never reused across sessions, even within the same project.

**Plan context = bundle + brief + dialectic state.**
- When Opus drafts: bundle + the brief.
- When Grok critiques: bundle + brief + Opus's draft.
- When Opus considers: bundle + brief + draft + Grok's critique.
- When Grok validates: bundle + brief + considered response.
- Each stage assembles its own context fresh. Nothing carries forward implicitly.
- Other plans (past or in-flight) are never included.

### Defenses

**Structural** — the `project_id` foreign key on every relevant table. Already in the schema.

**Runtime** — `ContextLoader` is the *only* code path that assembles LLM context. It refuses (throws) if asked to read from another project's tables. Separate prompt-context-builders per project. Anthropic and xAI client instances are stateless and shared, but every call passes through `ContextLoader.buildFor(projectId, scope)` first.

### UI implication

When the user switches sessions, the "active project" is implicit (from the session's `project_id`). The Reply composer's quick-move chips swap, the breadcrumbs update, the chrome path changes. There is no explicit "load project" action — switching sessions *is* switching project context. This avoids menu-driven mode switching.

### Named risk (V2)

The decisions log is per-project, but Numbat may eventually want cross-project signal — "James tends to redirect with this kind of phrasing across all projects." V2 will add a `cross_project: bool` flag on `decisions` and a separate `ContextLoader.buildCrossProject()` method. V1 is per-project clean.

---

## 11 · First four slices

> Slice 0 must complete before Slice 1 starts.

### Slice 0 · Claude Agent SDK spike

**Goal:** Verify the SDK behaves as the brief assumes, before any Feathertail design is locked.

**Timebox:** Half a day, one engineer, no UI.

**Verifies:**
- Session start, progress monitoring, output capture work programmatically.
- Diff capture works (or how diffs are surfaced).
- `settingSources: ['project']` correctly delivers `CLAUDE.md` per project.
- Kill signal propagates to a running session and cleans up.
- Token / cost reporting available per session for `llm_calls` audit.

**Output:** A 1-page memo at `docs/sdk-spike.md`: *what works · what surprised us · what to redesign.*

If the memo reveals surprises, this brief is updated before Slice 1. If it confirms assumptions, Slice 1 proceeds.

### Slice 1 · Schema + data layer

**Goal:** All Supabase tables exist, all TypeScript types derived, Supabase client utilities work, projects seeded, `ContextLoader` skeleton in place.

**Files affected:**
- `lib/supabase/migrations/0001_initial.sql` — full schema from section 7.
- `lib/supabase/client.ts`, `lib/supabase/server.ts`.
- `lib/types/db.ts` — generated types.
- `lib/orchestration/context.ts` — `ContextLoader` class, methods stubbed but with `project_id` enforcement.
- `config/projects.json` — seed: Departed Spirits, Men's Health, Aluna, Numbat.
- `lib/supabase/seed.ts`.

**Acceptance:**
- `pnpm db:push` applies the migration cleanly.
- `pnpm db:seed` populates four projects with correct `short_code` (DS, MH, AL, NB).
- Round-trip: insert a session, query via typed client, types compile.
- All jsonb fields have matching Zod schemas in `lib/types/`.
- `ContextLoader.buildFor('project_a_id')` throws if asked to read project_b's tables.
- `llm_calls` insert + cost computation tested end-to-end.

### Slice 2 · Sessions surface (read-only, mock data) + Start Work + create session

**Goal:** Sessions UI from the mocks works end-to-end, reading from Supabase. Start Work input creates a session via the router. No Agent SDK integration yet.

**Files affected:**
- `app/(sessions)/page.tsx`.
- `components/sessions/*` including `StartWorkInput.tsx`.
- `app/api/start-work/route.ts` — calls `Router.decide()` and creates session or plan stub.
- `app/api/sessions/route.ts` — POST creates session row.
- `lib/orchestration/router.ts` — rules-based pipeline picker.
- `lib/supabase/queries/sessions.ts` — typed queries.
- `lib/supabase/seed-mock-sessions.ts` — plausible mock sessions across projects.
- `app/globals.css` — design tokens locked in.
- `components/shared/CostBadge.tsx` — wired to `llm_calls`.

**Acceptance:**
- Filter bar (project + status) works via URL search params.
- Focus mode dims off-project sessions; doesn't hide them.
- Status dots match the spec (mint pulses on running, amber awaiting, coral blocked, dim idle).
- Project chip shows correct short_code with correct colour.
- Mobile responsive: holds at 375px.
- Realtime subscription on `sessions` updates the list when a row changes.
- Start Work text input submits via a Server Action; router decides Direct vs Bilby; session or plan stub is created and the user navigates to it.
- Cost badge shows today's spend, updates via realtime.

### Slice 3 · Single session review flow (mocked Agent SDK)

**Goal:** Diff & Review + Reply composer work end-to-end on a session with mocked SDK output. Approve / Redirect / Kill write to `decisions`. Skills chips render from the project's skills library.

**Files affected:**
- `app/(sessions)/[sessionId]/page.tsx`.
- `components/review/*`.
- `lib/supabase/queries/sessions.ts` — single-session fetch with debrief + diff.
- `lib/supabase/queries/skills.ts` — read-only skill fetch for chips.
- `lib/supabase/mutations/decisions.ts`.
- `lib/mock/agent-sdk-output.ts` — fixture data.

**Acceptance:**
- Four-section debrief renders correctly (What we did · Where this fits · Why it matters · What went wrong / what's next).
- Optional "New concept" block renders when present.
- Diff preview shows file list with +/M/− markers and stats.
- Approve / Redirect / Kill each write a `decisions` row with correct type and context.
- Reply text captured into `decisions.payload.reply_text` on Redirect.
- After Approve → session status flips to `done`, `completed_at` set. After Kill → status flips to `killed`, `last_error` populated with reason.
- Quick-move chips render from the project's `skills` table (read-only; no creation).
- Mobile responsive: action bar collapses to vertical stack at 375px; debrief blocks scroll; composer takes full width.

### What's next (slices 4–6, not in this brief)

- **Slice 4:** Real Agent SDK integration. Replace mock output with live session runner driven by spawned `scripts/session-runner.ts` workers. Kill signal propagates to live sessions.
- **Slice 5:** Plans surface + Direct pipeline (Opus debrief generator hooked to real session output). Create-plan flow.
- **Slice 6:** Bilby — the four-stage dialectic. Opus draft / Grok critique / Opus considered / Grok validate. The Plans surface becomes the host.

---

## 12 · Testing strategy

Not full coverage. Only load-bearing logic.

**Vitest (unit)** — colocated `*.test.ts` next to source.
- `lib/orchestration/router.ts` — rules behave as specified for representative briefs.
- `lib/orchestration/state-custodian.ts` — the spec lifecycle state machine.
- `lib/orchestration/context.ts` — `ContextLoader` refuses cross-project reads.
- `lib/llm/prompts/*` — prompt template rendering with snapshot tests.
- `lib/feathertail/worktree.ts` — branch collision detection.

**Playwright (E2E)** — one happy-path per slice.
- Slice 2: open Sessions, filter to project, type a brief, see a new session created.
- Slice 3: open a session in awaiting_review, click Approve, see status flip to done.
- Slice 5+: walk a plan through the dialectic stages.

**Run on CI** before merge: `pnpm test:unit && pnpm test:e2e`. No coverage threshold; the test suite is intentionally thin.

---

## 13 · Open questions (need user's call)

Most prior open questions resolved by the dialectic. Remaining:

1. **Worktree storage location confirmed?** Default `~/numbat-worktrees/`. Override via env var if James prefers co-location with each repo.
2. **Grok API access procured.** xAI API key in `.env.local`, billing active, quota sufficient for dialectic load.
3. **Personality framing in prompts.** Test "you are Opus" vs personality-free in the first real Bilby run; commit to whichever produces more consistent output.
4. **Initial cost budget.** Set a per-day soft cap on LLM spend; cost badge turns amber at 80%, coral at 100%. What's the cap?

---

## 14 · How to use this brief

1. **Read it through once.** Don't act yet.
2. **Run Slice 0 spike.** Half-day timebox. Output the memo to `docs/sdk-spike.md`.
3. **Update this brief** if the spike reveals surprises. Otherwise, proceed to Slice 1.
4. **Build slices in order.** Each slice's acceptance criteria are the contract. Treat any new question as an Open Question for the spec rather than guessing.
5. **Preserve the dialectic record.** `/docs/numbat-bootstrap-dialectic.md` is the first entry in the decisions log. Future plans should follow the same four-stage pattern with the same artifact preservation — Numbat being built using Numbat's intended workflow.
