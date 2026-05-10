# Slice 2a Plan — Sessions surface (read-only)

> **Status:** revised after first review; at the formal Ready-to-code gate.
> **Source of truth:** `docs/numbat-brief-final.md` §11 Slice 2 acceptance — minus Start Work, the router, and POST endpoints which the user has explicitly deferred to Slice 2b.
> **Style reference:** `docs/slice-1-plan.md`.
> **Revision history:** initial draft → user revisions (status colour rationale, 8.5 chip-preview gate, non-interactive Card, client.ts comment anchoring, explicit `.order`, V1 timezone caveat, mock #10 deletion note, dialectic-experiments housekeeping) → Ready-to-code gate → §2 update mid-build (two new bridge tokens + shadcn → Numbat mapping table after shadcn primitives landed).

## Context

Slice 2a is the first UI slice. It bootstraps Next.js 15 (App Router), Tailwind v4, shadcn/ui, the Instrument Serif + JetBrains Mono fonts, the design-token CSS variables, and the read-only Sessions surface from the mocks. The user split the original Slice 2 into 2a (read-only display + realtime + cost badge) and 2b (Start Work input, router, POST endpoints, server actions, auth-gate middleware). 2a's job is to stand up the Next.js skeleton cleanly so 2b can drop the input on top with no scaffolding work.

Three things from Slice 1 are now load-bearing:

1. The eight-table schema and typed clients exist. Sessions surface reads from them — no new tables, no new migrations.
2. The realtime publication on `sessions` and `llm_calls` is already enabled in `supabase/migrations/0001_initial.sql` (lines 177–179). 2a is the first consumer.
3. `cost_usd numeric(10,6)` comes back from postgrest as a JSON string, not a number — `LlmCall.cost_usd: string` in `lib/types/db.ts` already encodes this. The cost badge is the first reader that has to convert at the boundary.

User decisions confirmed before writing:
- Auth gate (`NUMBAT_AUTH_TOKEN` middleware) → defer to 2b.
- Tailwind v4 (CSS-first config in `globals.css`).
- shadcn/ui in 2a → install `Badge`, `Select`, `Card`.
- "Today's spend" → Melbourne local time (Australia/Melbourne).

## Scope

**In:**
- Next.js 15 (App Router) bootstrap: `next`, `react@19`, `react-dom@19`; `app/layout.tsx`, `app/page.tsx`, `next.config.mjs`, `next-env.d.ts`, `app/globals.css`.
- Tailwind v4 (CSS-first via `@theme` block in `globals.css`) + PostCSS.
- shadcn/ui initialised against the dark palette. Primitives in 2a: `Badge`, `Select`, `Card`. Defer `Button`, `Input`, `Textarea` to 2b.
- `app/(sessions)/page.tsx` — RSC, fetches initial sessions + projects, renders chrome.
- `components/sessions/session-list.tsx` — client wrapper; owns realtime subscription on `sessions`.
- `components/sessions/session-card.tsx` — pure presentational, server-renderable.
- `components/sessions/project-filter.tsx`, `components/sessions/status-filter.tsx` — client; mutate URL search params.
- `components/sessions/focus-banner.tsx` — client; reads/writes `?focus=<short_code>`.
- `components/sessions/project-chip.tsx` — server-renderable; renders the colored short_code chip.
- `components/shared/cost-badge.tsx` — client wrapper; owns realtime subscription on `llm_calls`.
- `lib/supabase/queries/sessions.ts` — server-only typed queries: `listSessions`, `listProjects`, `getTodayCostUsd`.
- `lib/supabase/seed-mock-sessions.ts` — idempotent script to populate plausible sessions across the four projects, hitting every status.
- `lib/types/ui.ts` — `SessionFilters` type and `PROJECT_CHIP_COLORS` constant keyed by `short_code`.
- `package.json` script additions: `dev`, `build`, `start`, real `lint` (replacing placeholder), `db:seed:sessions`.
- ESLint config (`eslint.config.mjs`) extending `next/core-web-vitals` and `next/typescript`. Includes `no-restricted-imports` rule blocking `@/lib/supabase/server` from `components/**/*.tsx`.
- One new test: `lib/supabase/queries/sessions.test.ts` — round-trip with filter (skipped when DB env missing, same gate as Slice 1's tests).
- Comment edit on `lib/supabase/client.ts` framing the realtime-only exception to the "DB access only from server" rule.

**Out (deferred to 2b):**
- `components/sessions/start-work-input.tsx`.
- `app/api/start-work/route.ts`, `app/api/sessions/route.ts`.
- `lib/orchestration/router.ts`.
- Any Server Action.
- `middleware.ts` for `NUMBAT_AUTH_TOKEN`.
- Single-session route `app/(sessions)/[sessionId]/page.tsx` — Slice 3.
- `components/review/*` and skills/decisions writes — Slice 3.

**Non-goals:**
- Light mode. Brief §6 + CLAUDE.md commit to dark-only.
- Playwright. Brief §12 puts E2E at slice level; first Playwright run lives in Slice 2b's happy path. Manual smoke-test only in 2a.
- Server-driven re-renders on filter change. Filters live in URL search params; the realtime-maintained client snapshot does the live filtering. Server round-trips on every filter click would race the realtime stream and waste work.
- Component-render unit tests. Brief §12 reserves vitest for "load-bearing logic."
- Mobile beyond 375px static layout. No drawer, no swipe gestures.

## Files to create / edit

Listed in build order. Existing files (`package.json`, `tsconfig.json`, `lib/supabase/*`, `lib/types/*`) are edited where noted.

| # | Path | Notes |
|---|---|---|
| 1 | `package.json` (edit) | Add deps: `next@^15`, `react@^19`, `react-dom@^19`, `clsx`, `tailwind-merge`. Add devDeps: `tailwindcss@^4`, `@tailwindcss/postcss@^4`, `postcss@^8`, `eslint@^9`, `eslint-config-next@^15`, `@types/react@^19`, `@types/react-dom@^19`. Add scripts: `dev`, `build`, `start`, `lint` (real `next lint`), `db:seed:sessions`. |
| 2 | `next.config.mjs` | `reactStrictMode: true`, `experimental: { typedRoutes: true }`. No image domains, no rewrites. |
| 3 | `next-env.d.ts` | Generated by `next dev` on first run; committed. |
| 4 | `tsconfig.json` (edit) | Add `"plugins": [{ "name": "next" }]`. Include `.next/types/**/*.ts` so generated route types resolve. Keep existing strict mode and `@/` alias. |
| 5 | `eslint.config.mjs` | `extends: ["next/core-web-vitals", "next/typescript"]`. `no-restricted-imports` flags `@/lib/supabase/server` from any `components/**/*.tsx`. |
| 6 | `postcss.config.mjs` | `{ plugins: { '@tailwindcss/postcss': {} } }`. |
| 7 | `app/globals.css` | Tailwind v4 import + `@theme` block with palette + status colors + project chip colors + font-family vars + mint pulse keyframes. See specifics §2. |
| 8 | `lib/utils.ts` | shadcn convention: `cn(...inputs)` via clsx + twMerge. |
| 9 | `components.json` | Generated by `pnpm dlx shadcn@latest init`. Style `default`, base color `neutral`, css variables yes, aliases mirror `@/`. |
| 10 | `components/ui/badge.tsx` | shadcn-generated. |
| 11 | `components/ui/select.tsx` | shadcn-generated. |
| 12 | `components/ui/card.tsx` | shadcn-generated. |
| 13 | `lib/types/ui.ts` | `SessionFilters` type. `PROJECT_CHIP_COLORS` map keyed by `short_code` ('AO', 'WT', 'BB', 'NB'). See specifics §2. |
| 14 | `app/layout.tsx` | Root layout. Loads Instrument Serif + JetBrains Mono via `next/font/google`. Sets `<html lang="en" class="dark">`, top bar with `<CostBadge initialUsd={...} />`, renders `{children}`. Cost badge lives here so it survives navigation. |
| 15 | `app/page.tsx` | `redirect('/sessions')`. |
| 16 | `lib/supabase/queries/sessions.ts` | Server-only. `listSessions(filters)`, `listProjects()`, `getTodayCostUsd()`. See specifics §6. |
| 17 | `lib/supabase/seed-mock-sessions.ts` | Idempotent. Deletes `where slice_name like 'mock-%'`, then inserts 12 mock sessions across all 4 projects, hitting every status. See specifics §7. |
| 18 | `components/shared/cost-badge.tsx` | `"use client"`. Subscribes to `llm_calls` realtime via anon `sb`. See specifics §8. |
| 19 | `components/sessions/project-chip.tsx` | Server-renderable. Reads `PROJECT_CHIP_COLORS[shortCode]`. |
| 20 | `components/sessions/session-card.tsx` | Server-renderable. Status dot from CSS var `--status-<status>`. Mint pulse class only when `running`. Shows `last_error.message` preview if blocked. |
| 21 | `components/sessions/project-filter.tsx` | `"use client"`. Reads `useSearchParams()`, writes `router.replace('?project=...')`. |
| 22 | `components/sessions/status-filter.tsx` | `"use client"`. Same shape, `?status=`. Options match `SessionStatus` enum. |
| 23 | `components/sessions/focus-banner.tsx` | `"use client"`. Reads `?focus=<short_code>`, dismissible "Clear focus" link. |
| 24 | `components/sessions/session-list.tsx` | `"use client"`. Realtime subscription on `sessions`. Holds live snapshot in `useState`. Applies filters from `useSearchParams()` on each render. |
| 25 | `app/(sessions)/page.tsx` | RSC. Reads `searchParams`, calls `listSessions`, `listProjects`, `getTodayCostUsd` in parallel. Composes filter bar, focus banner, `<SessionList>`. |
| 26 | `lib/supabase/queries/sessions.test.ts` | One test: `listSessions({ projectShortCode: 'NB' })` returns only NB sessions. Same `describe.skipIf(!hasEnv)` gate as Slice 1. |
| 27 | `lib/supabase/client.ts` (edit) | Add 3-line comment at the top framing the realtime-only client rule (see specifics §5). |

## Specifics

### §1 — Next.js bootstrap

**Versions.** Next 15 latest stable, React 19 latest stable, Tailwind 4 latest stable. Caret ranges (`^15`, `^19`, `^4`).

**`next.config.mjs` — minimal.** `reactStrictMode: true`, `typedRoutes: true`. No image domains, no rewrites, no headers. (Next 15.5 promoted `typedRoutes` out of `experimental`; the original draft used the experimental key.)

**Font loading via `next/font/google`.** `Instrument_Serif` (italic + normal, weight 400) and `JetBrains_Mono` (weights 400/500/700). next/font is configured with `variable: "--font-instrument-serif"` and `variable: "--font-jetbrains-mono"` (raw CSS variables set on `<html>`); `globals.css` `@theme` aliases these to `--font-display` and `--font-mono` (the Tailwind utility tokens). Distinct variable names on each end avoid a self-referential `var()` loop on `:root`. Self-hosted by `next/font` — no external CSS request, no FOUT.

**shadcn flow.** `pnpm dlx shadcn@latest init` after Tailwind is wired, then `pnpm dlx shadcn@latest add badge select card`. Generates `components.json`, `lib/utils.ts`, `components/ui/*`. Aliases match the project's `@/` path.

### §2 — Design tokens in `globals.css`

Tailwind v4 `@theme` block. Dark-only — no `.dark` class scoping needed.

**Palette** (CSS vars on `:root`):
- `--color-base: #0d0c0b;` warm-dark background
- `--color-fg: #ece5d8;` warm cream foreground (derived; pairs with the dark base)
- `--color-fg-dim: #6b6358;` for off-project dimmed cards in focus mode
- `--color-surface-raised: #1a1816;` slightly lighter warm tone for raised surfaces — filter pills, dropdowns, secondary badges
- `--color-border-hairline: #2a2622;` subtle warm border for inputs, separators, card edges
- `--color-destructive-action: #c46060;` intent-to-act red — kill buttons, destructive confirms (slice 3+). Distinct from `--color-coral` (blocked status) by saturation.
- `--color-mint: #7ed4c6;` running
- `--color-amber: #e0a04b;` awaiting
- `--color-coral: #c87f7f;` blocked
- `--color-opus: #b094d6;` Bilby/Opus accent (defined now; consumed in slices 5–6)
- `--color-grok: #d6c890;` (defined now; consumed in slices 5–6)

**Status mapping for all 7 statuses.** Brief specifies 4; the other 3 follow defensible defaults.

Status colours are reserved as attention signals. Mint = running (live), coral = blocked (needs you). Don't dilute by reusing for terminal states; terminal-success/failure should recede, not borrow signal colours. Opus violet stays reserved for the Bilby surface itself, not for sessions.

| status | dot color | note |
|---|---|---|
| `running` | `--color-mint` | pulses |
| `awaiting_review` | `--color-amber` | per brief |
| `blocked` | `--color-coral` | per brief |
| `idle` | `--color-fg-dim` | "dim idle" per brief |
| `planning` | `--color-fg-dim` | same as idle; user can't act on either |
| `done` | no dot | render a small ✓ glyph in `--color-fg-dim` instead |
| `killed` | no dot | render a small × glyph in `--color-fg-dim` instead |

Concrete vars: `--status-running`, `--status-review`, `--status-blocked`, `--status-idle`, `--status-planning`, `--status-done`, `--status-killed`.

**Token naming quirk (post-implementation finding).** Tailwind v4's `@theme` parser treats double-hyphens after the namespace prefix as modifier separators — the same pattern as `--text-2xl--line-height` being a sub-property of `--text-2xl`. As a result `--status-awaiting-review` compiled to nothing; the second hyphen made the parser silently drop the token. The fix is the shorter name `--status-review`. The DB enum value `awaiting_review` is bridged to it via the `STATUS_TO_TOKEN` map in `lib/types/ui.ts`. Do not rename `--status-review` back to `--status-awaiting-review` without re-testing compilation.

**Pulse animation** in `globals.css`:
```css
@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.status-dot--pulse { animation: status-pulse 1.6s ease-in-out infinite; }
```

**Project chip colors — TS constants in `lib/types/ui.ts`.** Project short_codes are data (sourced from `config/projects.json`); their associated chip color is a per-project attribute, not a global token. Storing in TS keeps the four entries versioned alongside the four projects that consume them. Distinct from reserved status colors and from Opus/Grok accents.

```ts
export const PROJECT_CHIP_COLORS: Record<string, { bg: string; fg: string }> = {
  AO: { bg: "#3b4a4f", fg: "#cfe6e8" },  // alice-os — desaturated teal
  WT: { bg: "#4a3a2c", fg: "#e6d3b8" },  // wedgetail — warm umber
  BB: { bg: "#3d3a4a", fg: "#cdc6e0" },  // bowerbird — dim plum
  NB: { bg: "#2c3e3a", fg: "#bcd0c7" },  // numbat — forest moss
};
```

**shadcn → Numbat token bridge.** shadcn's generated primitives (`badge.tsx`, `select.tsx`, `card.tsx`) reference Tailwind/shadcn-conventional tokens (`--color-primary`, `--color-card`, `--color-popover`, etc.) that aren't part of the brief's palette. The `@theme` block in `globals.css` aliases these to brief tokens via `var()` references — brief tokens are authoritative; shadcn tokens resolve to them. The two new raw tokens above (`--color-surface-raised`, `--color-border-hairline`) exist to satisfy this bridge — neither is in the brief, but both are standard "every dark UI needs these" surfaces. They are new public tokens, not just aliases.

| shadcn token | Numbat target | rationale |
|---|---|---|
| `--color-background` | `var(--color-base)` | warm-dark page bg |
| `--color-foreground` | `var(--color-fg)` | warm cream text |
| `--color-card` | `var(--color-surface-raised)` | cards have a subtle lift via the raised surface tone, separating them from page bg |
| `--color-card-foreground` | `var(--color-fg)` | |
| `--color-popover` | `var(--color-base)` | dropdown bg matches page bg |
| `--color-popover-foreground` | `var(--color-fg)` | |
| `--color-primary` | `var(--color-mint)` | mint is the primary attention colour (running + ring focus) |
| `--color-primary-foreground` | `var(--color-base)` | dark text on mint reads cleanly |
| `--color-secondary` | `var(--color-surface-raised)` | raised pills, secondary badges |
| `--color-secondary-foreground` | `var(--color-fg)` | |
| `--color-muted` | `var(--color-surface-raised)` | muted surfaces share the raised tone |
| `--color-muted-foreground` | `var(--color-fg-dim)` | dimmed text on muted surfaces |
| `--color-accent` | `var(--color-surface-raised)` | hover/focus surface in dropdowns |
| `--color-accent-foreground` | `var(--color-fg)` | |
| `--color-destructive` | `var(--color-destructive-action)` | intent-to-act red; same visual family as `--color-coral` but distinct shade (see rationale below) |
| `--color-destructive-foreground` | `var(--color-fg)` | |
| `--color-border` | `var(--color-border-hairline)` | card/separator edges |
| `--color-input` | `var(--color-border-hairline)` | input border matches general border |
| `--color-ring` | `var(--color-mint)` | focus ring uses primary attention colour |

Destructive and blocked share a visual family but are not the same colour — destructive is intent-to-act, blocked is needs-attention. Same family signals "concerning"; different shade preserves the distinction.

### §3 — Auth gate

Confirmed: defer to 2b. 2a is read-only with no writes to protect; 2b introduces the first mutations and is the natural slice to land middleware alongside the threat. No `middleware.ts` in this slice.

### §4 — Component hierarchy

```
app/layout.tsx                                (RSC)
├── <TopBar>                                  (RSC)
│   └── <CostBadge initialUsd={...} />        ("use client"; realtime on llm_calls)
└── {children}

app/(sessions)/page.tsx                       (RSC; reads searchParams)
├── parallel: listSessions(filters), listProjects(), getTodayCostUsd()
├── <FilterBar>
│   ├── <ProjectFilter projects={...} />      ("use client")
│   └── <StatusFilter />                      ("use client")
├── <FocusBanner />                           ("use client"; renders only if ?focus= present)
└── <SessionList                              ("use client"; realtime owner)
      initialSessions={...}
      projects={...} />
   └── <SessionCard ... />                    (presentational; ProjectChip nested)
```

**CostBadge in the layout, not the page.** Persistent chrome — when 2b/3 add `[sessionId]/page.tsx`, the cost badge stays mounted, keeping one realtime channel for the whole app session.

**Filter state.** URL search params are the single source of truth. RSC reads `searchParams.project`, `.status` for the initial fetch. Client `<SessionList>` reads the same `useSearchParams()` to filter its in-memory snapshot on each render. When realtime delivers a row, the snapshot updates and the next render re-applies filters. Filter mutations call `router.replace('?project=NB&status=running', { scroll: false })` — this re-runs the RSC and re-renders the client list; the two converge.

**Focus mode — URL search param `?focus=<short_code>`.** Shareable view, survives reload, composes with filter params. Off-project cards get `aria-disabled` and `opacity-50` rather than being filtered out.

### §5 — Realtime pattern

Server fetches initial; client subscribes via anon key. Inside `<SessionList>`:

```tsx
"use client";
import { sb } from "@/lib/supabase/client";
import { useEffect, useState } from "react";

export function SessionList({ initialSessions, projects }) {
  const [sessions, setSessions] = useState(initialSessions);
  useEffect(() => {
    const channel = sb
      .channel("sessions:all")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "sessions" },
        (payload) => setSessions(prev => applyChange(prev, payload)))
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, []);
  // …filter and map…
}
```

`applyChange` is a small pure helper handling INSERT/UPDATE/DELETE by `id`.

**Tension with "DB access only from server" — frame it as a narrow exception.** Edit `lib/supabase/client.ts` to add at the top:

```ts
// Browser-safe anon-key client. USE ONLY for realtime subscriptions.
// This is a deliberate narrow exception to CLAUDE.md's "DB access: only from
// server (RSC, route handlers, scripts/workers). Never from client." rule.
// Justified because RLS is off in V1 (brief §6) and the auth gate (Slice 2b
// middleware) keeps non-operators out of the page entirely.
//
// Initial reads happen on the server via lib/supabase/server.ts (sbAdmin).
// Mutations from the client are forbidden — use a Server Action instead.
// No from(...).select() or from(...).insert/update/delete() from the client. Ever.
```

The comment anchors the carve-out in the rule it's deviating from, so the exception is acknowledged rather than forgotten.

### §6 — Queries module

`lib/supabase/queries/sessions.ts`. Server-only. `sbAdmin` import asserts non-browser at evaluation time.

```ts
import { sbAdmin } from "@/lib/supabase/server";
import type { Project, Session } from "@/lib/types/db";
import type { SessionFilters } from "@/lib/types/ui";

export async function listSessions(
  filters: SessionFilters = {},
): Promise<{ sessions: Session[]; projects: Project[] }> {
  let q = sbAdmin
    .from("sessions")
    .select("*, projects!inner(id, slug, name, short_code, repo_path, claude_md, created_at)")
    .order("updated_at", { ascending: false });
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.projectShortCode) q = q.eq("projects.short_code", filters.projectShortCode);
  // …unwrap embedded join, return { sessions, projects }…
}

export async function listProjects(): Promise<Project[]> { /* … */ }

export async function getTodayCostUsd(): Promise<number> {
  // V1 single-operator assumption: "today" measured in Australia/Melbourne (the
  // operator's local day). Revisit when V2 introduces multi-user — each user's
  // "today" will be their own timezone.
  const startIso = melbourneTodayStartUtcIso();
  const { data, error } = await sbAdmin
    .from("llm_calls")
    .select("cost_usd")
    .gte("created_at", startIso);
  if (error) throw new Error(`getTodayCostUsd: ${error.message}`);
  return (data ?? []).reduce((acc, r) => acc + Number(r.cost_usd), 0);
  // Number(r.cost_usd) because numeric(10,6) is delivered as string.
}
```

`melbourneTodayStartUtcIso()` uses `Intl.DateTimeFormat` with `timeZone: 'Australia/Melbourne'` to compute local midnight, returns the equivalent UTC ISO string for the postgres comparison.

`listSessions` joins to `projects` (`select("*, projects!inner(...)")`) so a single round-trip filters by `short_code`. The function returns sessions and projects split out for the typed return; embedded join is unwrapped at the boundary.

### §7 — Mock seed script

`lib/supabase/seed-mock-sessions.ts`. Same shape as `lib/supabase/seed.ts`: imports `@/lib/env` first, uses `sbAdmin`, has `main()` with try/catch.

**File header comment must include:**
```ts
// Mock session #10 ("ship slice 2a (this!)") is a self-referential seed used
// during 2a development. Delete this row from the array once 2a ships and the
// self-reference is no longer accurate.
```

**Idempotency: marker prefix on `slice_name`.** All mock rows have `slice_name LIKE 'mock-%'`. Script first runs `delete from sessions where slice_name like 'mock-%'`, then inserts the fresh batch.

**12 sessions across 4 projects, every status hit:**

| # | project | status | slice_name | task |
|---|---|---|---|---|
| 1 | AO | running | mock-spirit-board-ui | "ship the spirit board UI" |
| 2 | AO | awaiting_review | mock-debrief-pane | "build the debrief pane component" |
| 3 | AO | idle | mock-router-rules | "draft the rules-based router" |
| 4 | WT | blocked | mock-valuation-tweaks | "tweak the valuation heuristics" (last_error populated) |
| 5 | WT | running | mock-csv-import | "land the CSV import path" |
| 6 | WT | done | mock-domain-rebrand | "rebrand domain.com.au copy" (completed_at set) |
| 7 | BB | awaiting_review | mock-spending-rollups | "wire monthly spending rollups" |
| 8 | BB | planning | mock-allocation-spec | "spec the allocation engine" |
| 9 | BB | killed | mock-broken-graph | "drop the broken graph view" (last_error populated) |
| 10 | NB | running | mock-sessions-surface | "ship slice 2a (this!)" |
| 11 | NB | idle | mock-bilby-prompts | "draft Bilby's first prompts" |
| 12 | NB | done | mock-schema-migration | "land slice 1 migration" (completed_at set) |

`last_error` for sessions 4 and 9 is built and validated through `SessionLastError.parse(...)` before insert — CLAUDE.md "Validate jsonb fields with Zod before insert."

Run via `pnpm db:seed:sessions`.

### §8 — Cost badge

```tsx
"use client";
import { sb } from "@/lib/supabase/client";
import { useEffect, useState } from "react";

export function CostBadge({ initialUsd }: { initialUsd: number }) {
  const [usd, setUsd] = useState(initialUsd);
  useEffect(() => {
    const channel = sb
      .channel("llm_calls:cost")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "llm_calls" },
        (payload) => {
          const row = payload.new as { cost_usd: string; created_at: string };
          if (isMelbourneToday(row.created_at)) {
            setUsd(prev => prev + Number(row.cost_usd));
          }
        })
      .subscribe();
    return () => { sb.removeChannel(channel); };
  }, []);
  return <span className="font-mono text-sm">${usd.toFixed(2)} today</span>;
}
```

`isMelbourneToday` compares the row's UTC timestamp against Melbourne midnight, mirroring `getTodayCostUsd`'s timezone logic.

The badge is plumbed and dormant until Slice 4 produces real `llm_calls` rows. Empty initial sum is `$0.00 today`.

### §9 — Mobile constraint (375px)

Tailwind responsive classes:
- Filter bar: `flex flex-wrap gap-2 sm:flex-nowrap`. At 375px the two filters wrap to two rows; ≥640px side-by-side.
- Session card: `flex flex-col gap-1`, `text-sm`. Project chip and status dot pin to the start; slice name and task wrap below.
- Cost badge: drops the "today" word below 480px.

**Test approach.** Manual: Chrome devtools, viewport 375×667 (iPhone SE), exercise filters, focus mode, status pulses. No visual regression in 2a.

### §10 — shadcn primitives

Install `Badge`, `Select`, `Card` via `pnpm dlx shadcn@latest add badge select card`. `Badge` powers status dots and the project chip (or wraps them — `<ProjectChip>` may be a thin wrapper around `<Badge>`). `Select` powers `<ProjectFilter>` and `<StatusFilter>` with Radix-backed keyboard nav. `Card` powers the `<SessionCard>` background, border, hover.

Card hover styles must be overridden in 2a. Session cards are NOT clickable in this slice — single-session route ships in slice 3. Override the Card primitive so SessionCard renders with `cursor-default`, no hover lift, no border-colour shift on hover, no underline-on-hover. Slice 3 will reintroduce the affordance when there's somewhere to navigate to.

Defer to 2b: `Button`, `Input`, `Textarea` (Start Work form).
Defer to slice 3: `Dialog`, `Toast` (kill confirm, decision feedback).

### §11 — Testing

**One new test.** `lib/supabase/queries/sessions.test.ts`:

```ts
describe.skipIf(!hasEnv())("listSessions", () => {
  it("filters by project short_code", async () => {
    // insertProjectFixture({ short_code: 'NB' }), insertSessionFixture(...)
    const { sessions } = await listSessions({ projectShortCode: "NB" });
    expect(sessions.every(s => /* belongs to NB */)).toBe(true);
  });
});
```

Uses `lib/supabase/test-fixtures.ts` from Slice 1 (`insertProjectFixture`, `insertSessionFixture`). Same `describe.skipIf` env gate.

**No render tests.** Brief §12: vitest is for "load-bearing logic." `<SessionCard>` is pure presentational; a snapshot would tie tests to copy. First render test arrives in 2b once the StatusFilter dropdown has interactivity worth asserting.

**No `getTodayCostUsd` test in 2a.** The function would mock so much of postgrest that it's just asserting the mock. First test arrives in slice 4 when real `llm_calls` data exists end-to-end.

## Acceptance criteria mapping (brief §11)

| Criterion | Satisfied by |
|---|---|
| Filter bar (project + status) works via URL search params | `<ProjectFilter>`, `<StatusFilter>` writing `?project=`, `?status=`; `app/(sessions)/page.tsx` reading from `searchParams` |
| Focus mode dims off-project sessions; doesn't hide them | `<SessionList>` applies `dimmed` to `<SessionCard>` based on `?focus=`; render uses `opacity-50` |
| Status dots match the spec (mint pulses on running, amber awaiting, coral blocked, dim idle) | `<SessionCard>` reads `status`, applies `--status-*` CSS var; `running` adds `.status-dot--pulse` |
| Project chip shows correct short_code with correct colour | `<ProjectChip>` reads `PROJECT_CHIP_COLORS[shortCode]` |
| Mobile responsive: holds at 375px | Tailwind responsive classes; manually verified |
| Realtime subscription on `sessions` updates the list | `<SessionList>` `useEffect` channel on `postgres_changes` for `table=sessions`, all events |
| Cost badge shows today's spend, updates via realtime | `<CostBadge>` initial via `getTodayCostUsd()` from RSC; client subscribes to `llm_calls` INSERTs |

Out of scope in 2a (covered by 2b): Start Work text input, Server Action, router decision, session/plan stub creation and navigation.

## Verification plan

1. `pnpm install` succeeds with new deps.
2. `pnpm typecheck` passes (strict mode, no `any`, including `app/`/`components/`).
3. `pnpm lint` (real `next lint`) passes. `no-restricted-imports` blocks `@/lib/supabase/server` from any client component.
4. `pnpm db:seed:sessions` populates 12 mock sessions across the four projects, hitting every status.
5. `pnpm test` runs the existing 6 tests plus `queries/sessions.test.ts` — 7 passing.
6. `pnpm dev` boots; navigate to `http://localhost:3000`:
   - Lands on `/sessions`.
   - Top bar shows "$0.00 today".
   - Sessions render in a list, ordered by `updated_at` desc.
   - One running session has a mint dot that pulses.
   - One blocked session has a coral dot, shows the `last_error.message` preview.
   - Click ProjectFilter → "BB". URL becomes `?project=BB`. Only BB sessions render.
   - Click StatusFilter → "awaiting_review". URL adds `&status=awaiting_review`. List narrows.
   - Set `?focus=NB` in the URL bar manually. Banner appears: "Focused on Numbat · clear focus". Off-project cards dim (50%).
   - Click "clear focus". Banner disappears.
7. Realtime smoke (sessions): with the dev server running, `update sessions set status = 'blocked' where slice_name = 'mock-spirit-board-ui'` via Supabase SQL editor. The card flips to coral within ~1s without reload.
8. Realtime smoke (cost): with the dev server running, insert a row into `llm_calls` with `cost_usd = 0.50` and `created_at = now()` (and a valid `project_id`/`provider`/`model`). Cost badge ticks up by $0.50 without reload.
9. Mobile: Chrome devtools, viewport 375×667. Filters wrap; cards remain readable; cost badge collapses.

## Order of work

Bootstrap before data, scaffold before realtime:

1. `package.json` edit, `next.config.mjs`, `tsconfig.json` tweak, `eslint.config.mjs`, `postcss.config.mjs`, `next-env.d.ts`. `pnpm install`.
2. shadcn init + add `badge`, `select`, `card`.
3. `app/globals.css` design tokens + Tailwind import + `@theme` block.
4. `lib/types/ui.ts` chip color map.
5. `app/layout.tsx` + fonts + top bar with placeholder `<CostBadge initialUsd={0} />`.
6. `app/page.tsx` redirect.
7. `lib/supabase/queries/sessions.ts`.
8. `lib/supabase/seed-mock-sessions.ts` + run `pnpm db:seed:sessions`.
8.5. **Project chip preview gate.** Render the four chips (AO/WT/BB/NB) on the warm-dark base, side by side, with their short codes. Pause for user review of the chip colours before building `project-chip.tsx` or any session card. Adjustments go into `lib/types/ui.ts` at this step, not retroactively after cards are built.
9. `components/sessions/project-chip.tsx`, `session-card.tsx`.
10. `components/sessions/project-filter.tsx`, `status-filter.tsx`, `focus-banner.tsx`.
11. `components/sessions/session-list.tsx` (realtime owner). Cleanup: `useEffect` must return `() => sb.removeChannel(channel)` to prevent dev-server hot-reload channel leaks.
12. `app/(sessions)/page.tsx` (RSC composes everything).
13. Wire `getTodayCostUsd()` into the layout, replacing the placeholder zero.
14. `components/shared/cost-badge.tsx` realtime subscription. Same cleanup pattern: return `() => sb.removeChannel(channel)`.
15. Edit `lib/supabase/client.ts` with the realtime-only comment.
16. `lib/supabase/queries/sessions.test.ts`.
17. Manual verification per the plan above.

Steps 1–6 are pure scaffolding (no DB needed). Step 8 produces the first visible data; running it as soon as it exists shortens the feedback loop on every step that follows.

## Pre-build housekeeping

Before slice 2a build starts, create the dialectic experiments log:

```
docs/dialectic-experiments/
docs/dialectic-experiments/README.md
docs/dialectic-experiments/001-grok-on-slice-2a-plan.md
```

`README.md` explains:
- **Purpose:** calibration data for V2's LLM-based router; signal-to-noise on partial dialectic runs.
- **When to add an entry:** any time a non-Bilby LLM critique runs on Numbat artifacts (slice plans, brief revisions, code reviews, prompt drafts).
- **Append-only:** never edit entries after the fact, even if the verdict turns out wrong; followups go in new files (e.g. `001-followup-YYYY-MM.md`).
- **Numbering:** three-digit zero-padded for sort stability through entry 999.

Each entry follows this structure:

```
# [number]-[short-slug]
**Date:** [YYYY-MM-DD]
**Subject:** [what was critiqued]
**Critic:** [model + provider]
**Critic context:** [what the critic was given access to]
**Stage shape:** [single-stage critique / two-stage / etc — distinguish from full Bilby]

## Input
## Output
## Verdict (per-item: VALID / NICE-TO-HAVE / REJECTED / HALLUCINATED)
## Signal-to-noise (one-line summary)
## Calibration note
```

Populate `001-grok-on-slice-2a-plan.md` with:
- **Subject:** this slice 2a plan.
- **Critic:** Grok 4.3 via xAI.
- **Critic context:** full slice 2a plan only (no brief, no slice 1 outputs, no CLAUDE.md). NOTE EXPLICITLY — explains the hallucination on item 2.
- **Stage shape:** single-stage critique (NOT a Bilby dialectic; full Bilby is four stages).
- **Output:** paraphrase the seven items Grok raised.
- **Verdict:**
  1. Realtime cleanup → VALID — folded into plan.
  2. Project short_code mismatch → HALLUCINATED — confused historical dialectic doc with current state.
  3. Loading skeleton → NICE-TO-HAVE — rejected as premature polish.
  4. Graceful error handling → NICE-TO-HAVE — rejected; toast not until slice 3.
  5. Explicit ordering → VALID — folded into plan.
  6. Cost badge UPDATE subscription → REJECTED — edge case for non-existent V1 feature.
  7. Tailwind/shadcn pinning note → REJECTED — documentation noise.
- **Signal-to-noise:** "2 valid / 1 hallucinated / 2 nice-to-haves / 2 rejected / 0 architecture-invalidating — 2/7 actionable on an execution-slice plan".
- **Calibration note:** bootstrap dialectic on a brief caught one architecture-invalidating gap and ~8 material gaps with 2 false positives. This run on an execution-slice plan caught zero architecture-level issues, two minor real catches, and produced one hallucination. Confirms brief §10 prediction: cross-family critique earns its keep on strategic/architectural artifacts, not on execution slices with explicit acceptance criteria. Default V1 behaviour: don't run cross-family critique on slice plans. Save dialectic for V2 scope, architectural pivots, and bootstrap-equivalent moments.

Pre-build housekeeping comes BEFORE step 1 of the order of work above. The dialectic-experiments folder must exist and be populated before any code is written.

## Critical files for implementation

The five most load-bearing files for the implementer:

- `app/globals.css` — design tokens, status colors, pulse keyframes, project-chip color references.
- `app/(sessions)/page.tsx` — RSC entry; orchestrates initial fetch, filter bar, focus banner, list.
- `components/sessions/session-list.tsx` — realtime subscription owner; the boundary between server-fetched initial state and live state.
- `lib/supabase/queries/sessions.ts` — the three server-only query functions every consumer in 2a/2b/3 reuses.
- `lib/supabase/seed-mock-sessions.ts` — the only thing that puts visible data on screen until slice 4 ships real sessions.
