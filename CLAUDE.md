# Numbat — Repo Context

> Read by the Claude Agent SDK on every session via `settingSources: ['project']`.
> Companion docs: `docs/numbat-brief-final.md` (the full brief), `docs/numbat-bootstrap-dialectic.md` (decision history).

## What this is

A single-operator control surface that orchestrates Claude Agent SDK sessions across multiple codebases, with a built-in multi-LLM dialectic for strategic planning. Local-first; runs on the developer's machine.

## Naming

- **Numbat** — the OS (this codebase).
- **Bilby** — the planning dialectic feature (`lib/bilby/`).
- **Feathertail** — the execution/worktree layer (`lib/feathertail/`).

Use these names consistently in code, comments, and UI. They are not decorative.

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind · shadcn/ui · Supabase · Vercel AI SDK (Anthropic + xAI) · `@anthropic-ai/claude-agent-sdk`.

## Architecture

Five layers:

1. **Interface** (`app/`, `components/`)
2. **Orchestration** (`lib/orchestration/`) — Router, State Custodian, Escalation Handler, ContextLoader
3. **Pipelines** — Direct + Bilby
4. **Feathertail** (`lib/feathertail/`) — execution layer
5. **Persistence** — Supabase + `llm_calls` audit table + decisions log

## Runtime environment

- Local-first. Runs via `pnpm dev` on the dev machine.
- Supabase cloud for state.
- Background work: spawned Node workers per session (`scripts/session-runner.ts`). No external queue framework in V1.
- Worktrees live at `~/numbat-worktrees/<project-slug>/<slice-name>/`. Auto-cleaned 24h after session reaches `done` or `killed`.
- The Agent SDK reads each project's `CLAUDE.md` via `settingSources: ['project']`.

## Coding conventions

- TypeScript strict mode. No `any`. Prefer `unknown` + narrowing over casts.
- Server Components by default. Use `"use client"` only when interactivity demands it.
- Database access: only from server (RSC, route handlers, scripts/workers). Never from client.
- Imports: absolute via `@/`. Group: external → `@/lib` → `@/components` → relative.
- File names: kebab-case for routes, PascalCase for components, kebab-case for libs.
- Errors: typed error returns over thrown exceptions for expected failures. Throw only for genuine bugs.

## Always

- Run `pnpm typecheck` and `pnpm lint` before declaring a slice complete.
- Validate jsonb fields with Zod before insert.
- Use Supabase realtime for any UI showing session or plan state. Never poll.
- Log every LLM call to `llm_calls` (model, prompt hash, tokens, duration, cost, error).
- Load project context via `ContextLoader` at every session and plan-stage boundary. Never reach across projects.
- Apply migrations via `supabase/migrations/<NNNN>_<name>.sql` (Supabase CLI convention). One numbered SQL file per slice that touches the schema. `pnpm db:push` reads from there.
- For Agent SDK session results: fan out `llm_calls` one row per (session, model) via `lib/supabase/llm-calls.ts:insertLlmCallsFromModelUsage`. Trust the SDK's per-model `costUSD` and `total_cost_usd` — no maintained price table for the Agent SDK path. (Bilby's direct Anthropic / xAI calls via the AI SDK still need one.)
- For Tailwind v4 `@theme` tokens, use single-component names after the namespace (`--status-review`, not `--status-awaiting-review`). Tailwind v4's parser interprets a second hyphen after the namespace as a modifier separator — multi-hyphen tokens compile to nothing silently. Discovered during slice 2a step 5 visual check. The `STATUS_TO_TOKEN` map in `lib/types/ui.ts` isolates the workaround.

## Never

- Never commit secrets. `.env.local` and OS keychain only.
- Never hardcode model names; reference via `lib/llm/models.ts` constants.
- Never bypass the State Custodian to write to specs directly. All spec mutations go through `lib/orchestration/state-custodian.ts`.
- Never expose `service_role` Supabase key to the client. Anon key only on the browser.
- Never ship a session that hasn't recorded its triggering decision in the `decisions` table.
- Never share LLM history across projects. Each session and plan stage gets fresh context.
- Never reconstruct review diffs from SDK `tool_use` events alone — those are intent, not ground truth. Final diff = `git status --porcelain` + `git diff` inside the session's `cwd` (see `lib/feathertail/diff.ts`). `tool_use` events drive only the in-progress UI indicator.

## Resilience

- **LLM call timeouts:** Opus draft 90s · Grok critique 60s · Opus considered 90s · Grok validate 60s · Opus debrief 60s. Agent SDK sessions have no timeout (kill via signal only).
- **Retry:** Max 2 retries on network errors with exponential backoff (1s, 2s). No retry on 4xx responses.
- **Failure modes:** An LLM call failure writes a row to `llm_calls` with `error` populated and updates the parent session/plan status. The UI shows the error inline; the loop fails open (the user can redirect or kill).
- **Session worker crash:** The parent session row is marked `blocked` with `last_error` populated. The user is notified via realtime.

## Single-operator assumptions (V1)

- One user (James). Auth is a single hardcoded session token in `.env.local`. No user table, no roles.
- Project list seeded from `config/projects.json`. No admin UI in V1.
- `created_by` columns deferred. Migration to add later is a single ALTER TABLE per affected table — cheap. Adding speculatively now buys nothing.

## Design system

- **Display font:** Instrument Serif (italic).
- **Body / mono font:** JetBrains Mono.
- **Palette:** Defined as CSS variables in `app/globals.css`.
- **Status colours** are reserved: mint = running, amber = awaiting, coral = blocked, dim = idle.
- **Project chip colours** are a separate scale; one per project.
- **Dark mode by design.** Light mode is not a goal.

## When in doubt

Read the spec for the current slice. If the spec doesn't answer the question, surface it as an Open Question in the debrief rather than guessing.

If a Tailwind v4 utility class isn't applying or a `@theme` token isn't compiling, suspect the parser quirk first. Curl the compiled `_next/static/css/app/layout.css` and grep for the token — if it's missing, the name is the issue.
