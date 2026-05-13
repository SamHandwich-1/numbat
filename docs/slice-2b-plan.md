# Slice 2b Plan — Start Work + Router (write path)

> **Status:** revision 2, ready for implementation. Incorporates user feedback (auth scope clarification, vague-verb removal) and Grok critique pass (slice_name/title contracts, error-passthrough pattern, localStorage cleanup).
> **Source of truth:** `docs/numbat-brief-final.md` §5 (routing), §6 (Direct vs Bilby pipelines), §11 Slice 2 acceptance — minus the 2a-completed read-only display.
> **Style reference:** `docs/slice-2a-plan.md`.

## Context

Slice 2a closed with the Sessions surface as a read-only view powered by realtime. 2b adds the **write path**: a Start Work text input that lets the operator submit a brief, a rules-based Router that decides Direct vs Bilby, and the POST endpoints that create the resulting session or plan stub. After 2b the operator can type a brief, get routed, and see the artifact appear in the appropriate list — but the artifact itself stays inert until slice 4 (Direct execution) or slice 5/6 (Bilby stages).

Three things from earlier slices are load-bearing:

1. The Sessions surface auto-updates via realtime when a new session row is INSERTed (slice 2a step 11) — so a Direct-routed Start Work shows up in the list within ~1s of submit, no refresh.
2. The decisions table (slice 1) has been waiting for its first writers. Every Start Work submission lands one row per CLAUDE.md ("Never ship a session that hasn't recorded its triggering decision").
3. The cost badge starts ticking once any LLM call lands; 2b's router is rules-based and calls no LLM, so the badge stays at $0.00 until slice 4.

The auth gate (`NUMBAT_AUTH_TOKEN` middleware) was deferred from 2a §3 to 2b on the rationale that 2a was read-only with nothing to protect; 2b introduces the first mutations and is the natural slice to land middleware alongside the threat. That carry-over is honoured here.

## Scope

**In:**
- `lib/orchestration/router.ts` — pure rules-based pipeline picker; deterministic, no I/O.
- `lib/orchestration/router.test.ts` — vitest coverage of every rule + boundary case.
- `lib/orchestration/create-session.ts` — server-only helper. INSERTs into `sessions` (status='idle') AND writes the triggering `decisions` row. Reused by /api/start-work (Direct branch) and /api/sessions.
- `lib/orchestration/create-plan.ts` — server-only helper. INSERTs into `plans` (status='drafting') AND writes the triggering `decisions` row. Reused by /api/start-work (Bilby branch). No /api/plans endpoint in 2b; only consumer is /api/start-work — symmetry can wait.
- `app/api/start-work/route.ts` — POST handler. Auth check, validate body, run Router, branch into createSession or createPlan, return `{ pipeline, matched_rule, redirect_url }`.
- `app/api/sessions/route.ts` — POST handler. Auth check, validate body, delegate to createSession. Reserved for slice 3+ callers (e.g., "retry session") that don't need router involvement.
- `middleware.ts` — `NUMBAT_AUTH_TOKEN` cookie gate. 302 to `/login` on miss. Excludes `/login`, `/_next/*`, `/favicon.ico`.
- `app/login/page.tsx` — minimal `?token=…` → set-cookie → redirect to `/sessions`.
- `lib/env.ts` (edit) — extend with zod schema; export typed `env` object. Required vars crash module load on absence.
- `components/ui/button.tsx`, `input.tsx`, `textarea.tsx` — shadcn primitives deferred from 2a.
- `components/sessions/start-work-input.tsx` — multi-line autoresize Textarea + project Select + submit Button. URL nav after success.
- `app/sessions/page.tsx` (edit) — mount StartWorkInput above the filter bar; pass `projects` prop.
- `lib/orchestration/start-work.test.ts` — single live-DB integration test covering the Direct + Bilby branches.

**Out (deferred):**
- `app/sessions/[sessionId]/page.tsx` — Slice 3. Direct-routed nav lands on this; until slice 3 ships, the destination is a 404 (see Open Question 2).
- `app/plans/[planId]/page.tsx` — Slice 5. Bilby-routed nav lands here; same 404 caveat.
- Live Agent SDK execution on the created session — Slice 4.
- Bilby stages actually running — Slice 6.
- LLM-based router — V2; needs decisions-log data first (brief §5).
- Plans surface (lists, filters, realtime) — Slice 5.
- Conversational redirect UI (operator override of the router) — Slice 3 (lives on the session/plan detail pages).
- `/api/plans` — see Open Question 3.
- Logout / token rotation flow — V2 concern.

**Non-goals:**
- Optimistic UI on the form. Submit blocks until the redirect; the form stays mounted with a "Routing…" state. Optimistic feels nice but masks router latency feedback that's useful for V2 calibration.
- Multi-project session-create in one submit. One brief = one artifact.
- Toast / notification UI for success. The redirect IS the feedback.
- Recovery from a half-failed submit (decisions row written but session/plan insert failed). Acceptable in V1; the user sees the error message inline, can resubmit. Slice 4+ revisits durability if real failures appear.
- Session/plan title generation from the brief. The slice_name and plan title default to truncated brief text; LLM-generated titles are a nice-to-have for slice 5+.

## Files to create / edit

Listed in build order. Existing files (`lib/env.ts`, `app/sessions/page.tsx`) are edited where noted.

| # | Path | Notes |
|---|---|---|
| 1 | `components/ui/button.tsx` | shadcn-generated via `pnpm dlx shadcn@latest add button`. |
| 2 | `components/ui/input.tsx` | shadcn-generated. |
| 3 | `components/ui/textarea.tsx` | shadcn-generated. |
| 4 | `lib/env.ts` (edit) | Replace bare dotenv-load with zod-validated export. See §3. |
| 5 | `lib/orchestration/router.ts` | Pure `route(brief): RouterDecision`. See §1. |
| 6 | `lib/orchestration/router.test.ts` | Every rule + boundary case per §6 table. |
| 7 | `lib/orchestration/create-session.ts` | `createSession({ projectId, brief, decision })` → `{ id }`. INSERTs sessions + decisions. Derives `slice_name` per the contract in §4. Bare `if (error) throw error;` after each insert — no swallowing, no remapping. |
| 8 | `lib/orchestration/create-plan.ts` | `createPlan({ projectId, brief, decision })` → `{ id }`. INSERTs plans + decisions. Derives `plan.title` per the contract in §4. Same throw-on-error pattern as createSession. |
| 9 | `app/api/sessions/route.ts` | POST handler over `createSession`. Body zod-validated. |
| 10 | `app/api/start-work/route.ts` | POST handler. Auth → validate → route → branch into createSession/createPlan → return JSON with redirect_url. |
| 11 | `lib/orchestration/start-work.test.ts` | Live-DB integration: one Direct case, one Bilby case. Skips when env missing. |
| 12 | `middleware.ts` | Cookie check; 302 to `/login` on miss. Excludes `/login`, `/_next/*`, `/favicon.ico`. |
| 13 | `app/login/page.tsx` | Server-rendered; reads `?token=`, sets cookie or shows "Invalid token". |
| 14 | `components/sessions/start-work-input.tsx` | Textarea + project Select + Button; submits to /api/start-work; URL nav on success. |
| 15 | `app/sessions/page.tsx` (edit) | Mount StartWorkInput above filter bar; pass `projects` prop. |
| 16 | `lib/types/jsonb.ts` (edit, conditional) | Extend `DecisionPayload` zod union with router-decision metadata if existing `approve` variant doesn't fit. See Open Question 5. |

## Specifics

### §1 — Router

Pure synchronous function. No I/O, no env access, no Date.now. Stateless and deterministic — same input always returns same output. This is the contract that lets the test suite be exhaustive.

**Return shape:**

```ts
export type RouterPipeline = "direct" | "bilby";

export type RouterMatchedRule =
  | "length_under_200"
  | "keyword_fix" | "keyword_typo" | "keyword_copy" | "keyword_style"
  | "question_mark"
  | "default_bilby";

export type RouterDecision = {
  pipeline: RouterPipeline;
  matched_rule: RouterMatchedRule;
  reason: string; // Human-readable. Persisted to decisions.payload, surfaced in dev tools.
};

export function route(brief: string): RouterDecision;
```

**Rules, evaluated in order (first match wins):**

1. **`brief.length < 200`** → `direct`, `length_under_200`. Reason: `"Brief under 200 chars — short enough to execute without planning."`
2. **`/\b(fix|typo|copy|style)\b/i.test(brief)`** → `direct`, `keyword_<match>`. Reason: `"Brief contains keyword '<match>' — routine mechanical change."`
3. **`brief.includes("?")`** → `bilby`, `question_mark`. Reason: `"Brief contains a question — exploratory, route through planning."`
4. **Default** → `bilby`, `default_bilby`. Reason: `"No length, keyword, or question-mark trigger — defaulting to Bilby. Cost of unnecessary planning < cost of executing on a half-formed brief."`

**Rationale for each non-brief-mandated rule:**

- The brief's only prescriptive rule is rule 1 + rule 2 (length OR fix/typo/copy/style → Direct). Rule 3 is a V1 addition catching one obvious Bilby case the brief doesn't enumerate.
- **Question-mark.** Question briefs are research, not execution. "Should we extract this into a hook?" needs a draft before any work happens. Conservative: false positives (routing rhetorical questions to Bilby) cost one wasted planning pass; false negatives (executing on a real research question) cost a derailed worktree session.
- **Default = Bilby.** The user's reasoning, kept verbatim: planning-cost < execution-cost on ambiguous briefs. Wasted plan stage costs an Opus call (~$0.10); wasted Direct execution costs a derailed worktree (~$0.50+ in tokens AND user time to redirect via slice 3). Bilby wins the cost-benefit on ambiguous briefs.

**Why the keyword list stays at the brief's four (not expanded):**

- Adding "rename"/"tweak"/"format"/"lint"/"rewrite" is plausible. None has decisions-log evidence behind it. Each new keyword is a guess that biases the V2 LLM router's training data.
- The decisions log is the empirical basis for V2. Lock in the brief's four; let the operator's redirect patterns dictate additions.

**Why first-match wins, not most-specific:**

- For "fix typo in footer" (15 chars, contains "fix" AND "typo"), length wins over keyword. The matched_rule is `length_under_200`, not `keyword_fix`. This is a deliberate tie-breaker by evaluation order: rule 1 is the cheapest signal and the most general. Tests assert the order.
- Recording both triggers when both apply would complicate the matched_rule type for marginal value. The reason string is the place to capture nuance if needed; matched_rule is a discriminator.

**Conversational redirect (brief §5).** Out of scope for 2b. The router function is one-way; redirect-handling is downstream (Slice 3 affordance on the session/plan detail pages).

### §2 — StartWorkInput UX

**Textarea, not Input.** Multi-line autoresize. Briefs vary from "fix typo in footer" (one line) to multi-clause briefs that wrap to three or four lines. Single-line input would clip the latter and pretend they're trivial.

Implementation: `<Textarea>` with `rows={2}` minimum and `field-sizing: content` (CSS spec; Chrome 123+, Firefox 122+, Safari 17.4+). Fallback for older browsers: `min-h-[3.5rem]` and let it scroll. No `useEffect` listener on input value to manually resize — `field-sizing` is a CSS-native solution.

**Project select.** `<Select>` populated from the `projects` prop (full list, same source as ProjectFilter — the parent RSC passes both). Required field; submit disabled until both project and non-empty trimmed brief are set.

Selection persists to localStorage (`numbat:last_project_id`). On mount, restore if present. Cleared by /login on every cookie-set (so a token rotation doesn't leak project preference across operators — single-operator V1 makes this academic, but the convention costs nothing).

**Submit affordances:**

- Visible "Start work" `<Button>` — primary mint-on-base styling. Disabled when invalid.
- `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows/Linux) submits from inside the textarea. Detected via `e.metaKey || e.ctrlKey` + `e.key === "Enter"`.
- Bare Enter inserts a newline (default textarea behaviour). No submit-on-Enter — too easy to fire accidentally on a multi-line brief.

**Submit flow:**

1. Trim brief; validate locally (project set, brief.length > 0). If invalid, do nothing (button is disabled; this guards against keyboard submit).
2. Disable inputs, swap Button label to "Routing…".
3. POST to `/api/start-work` with `{ projectId, brief }` as JSON.
4. On 2xx: parse `{ pipeline, matched_rule, redirect_url }`. Call `router.push(redirect_url)`. Form unmounts on navigation.
5. On 4xx/5xx: parse error message, show inline below the textarea in coral. Re-enable inputs. No toast — the page is a single-purpose surface and an inline error is more discoverable.
6. Handle the `Promise<Route>` typing for `router.push` — `redirect_url` is a runtime string; cast `as Route` mirrors the existing pattern in `app/page.tsx` and the filter components.

**Layout.** Mounts in `app/sessions/page.tsx` between `<main>` and the existing `<div>` housing the filter bar. Visually separated by `border-b border-border pb-4` to mark it as input chrome distinct from list content.

**375px.** Project Select stacks above the textarea; submit Button full-width below. Same `flex-wrap` pattern as the filter bar.

### §3 — Auth gate

**`middleware.ts`** runs on all paths except `/login`, `/_next/*`, `/favicon.ico`, and `/api/health` (none yet but reserved). Reads cookie `numbat_auth`; constant-time compares against `env.NUMBAT_AUTH_TOKEN`. On mismatch or absence: 302 to `/login` (preserve the original URL as `?next=…` so /login can redirect back after success).

```ts
export const config = {
  matcher: [
    // Run on every request except the explicit exclusions above
    "/((?!login|_next/static|_next/image|favicon.ico|api/health).*)",
  ],
};
```

**`/login`** is a server component that:

- Reads `?token=` from URL searchParams.
- If matches `env.NUMBAT_AUTH_TOKEN`: sets the `numbat_auth` cookie (httpOnly, sameSite=lax, secure in prod, no expiry — single operator), then redirects to `?next=…` (default `/sessions`).
- If mismatch or absent: renders an inline "Invalid token" message. No password form; the operator's only "session" is the bookmark `https://localhost:3000/login?token=<token>`.
- On successful cookie-set, also clears `localStorage["numbat:last_project_id"]` via a small inline client-side script. Honours the "token rotation doesn't leak project preference across operators" invariant called out in §2 — academic in V1 but the convention costs nothing.

**`lib/env.ts` extension.** Current state is `dotenv.config({ path: ".env.local" })`. Replace with a zod schema that validates at module load:

```ts
import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  NUMBAT_AUTH_TOKEN: z.string().min(16),
});

export const env = EnvSchema.parse(process.env);
```

Crash at module load if any required var is missing — better than silently degraded behaviour at request time. Existing imports of `process.env.X` in `lib/supabase/client.ts` and `server.ts` continue to work; the zod parse is the single bottleneck that establishes invariants.

**Threat model.** Single-operator dev machine. The auth gate keeps accidental visitors out (LAN devices, family members, roommates) — not a determined attacker. If `NUMBAT_AUTH_TOKEN` leaks, rotate the env var and restart. No session expiry, no rate limiting, no audit logging in 2b — V2 concerns when there are V2 users.

### §4 — API surface

**`POST /api/start-work`**

Request body, zod-validated:

```ts
const StartWorkRequest = z.object({
  projectId: z.string().uuid(),
  brief: z.string().trim().min(1).max(5000),
});
```

Response (success): `{ pipeline: "direct" | "bilby", matched_rule: RouterMatchedRule, redirect_url: string }`. Status 200.

Response (error): `{ error: string }`. Status 400 (validation), 401 (auth), 500 (DB or downstream).

Flow:

1. Auth check via cookie even though middleware already passed — defence in depth on mutation endpoints. Returns 401 on miss (not 302 — API responses should be machine-readable).
2. zod-validate body. 400 on failure with the parse error message (sanitized).
3. Verify `projectId` exists (single SELECT). 400 on miss.
4. `Router.route(brief)` — pure, sync.
5. Branch:
   - `pipeline === "direct"` → `createSession({ projectId, brief, decision })`. Returns `{ id }`. `redirect_url = "/sessions/${id}"`.
   - `pipeline === "bilby"` → `createPlan({ projectId, brief, decision })`. Returns `{ id }`. `redirect_url = "/plans/${id}"`.
6. Return `{ pipeline, matched_rule, redirect_url }`.

**Error handling.** The route handler wraps step 5 (the create call) in a `try/catch`. createSession and createPlan throw on any insert error per §5. The catch returns `{ error: err.message }` with status 500 — the raw `error.message` from Supabase is included verbatim, with a `// single-operator local-first concession; would be sanitized in a multi-user product` comment marking the trade-off. The operator wants to see the actual constraint violation or FK error during dev, not a generic "something went wrong".

**`POST /api/sessions`**

Lower-level Direct-create endpoint. Body: `{ projectId, brief, sliceName? }`. Calls `createSession` with a synthetic decision payload (`{ matched_rule: "manual", reason: "Created via /api/sessions, no router involvement" }`). Returns `{ id }`. Same error-passthrough pattern in the catch block.

Used by /api/start-work's Direct branch (delegates) and reserved for slice 3+ flows ("retry session", future programmatic creates). Keeping it as a discrete primitive lets slice 3 build retry without re-routing through the router.

**Derivation contracts** (consumed by createSession / createPlan, codified as inline comments in those files):

```ts
// slice_name = slugify(brief.slice(0, 60)) + '-' + 6-char random suffix
// Example: "fix typo in footer" → "fix-typo-in-footer-a3f9k2"
// slugify: lowercase, replace [^a-z0-9]+ with '-', trim leading/trailing '-'
// Suffix: nanoid-style alphanumeric, 6 chars (~36^6 = 2B collision space)
//
// CONTRACT: slice 4 will consume slice_name as a worktree directory
// segment ('~/numbat-worktrees/<project-slug>/<slice-name>/'). Any
// future format change requires a data migration — existing
// worktrees would be orphaned by a rename. Treat slice_name as a
// stable identifier, not a display string.
const slice_name =
  slugify(brief.slice(0, 60)) + "-" + randomSuffix(6);
```

```ts
// plan.title = brief.slice(0, 80) + (brief.length > 80 ? '…' : '')
// Display string only — not a path component, not a stable ID.
// Plans surface (slice 5) is free to re-derive or LLM-generate later.
const title =
  brief.slice(0, 80) + (brief.length > 80 ? "…" : "");
```

### §5 — Decisions table writes

CLAUDE.md mandate: "Never ship a session that hasn't recorded its triggering decision in the `decisions` table."

`createSession` and `createPlan` each write one decisions row in the same flow as the session/plan insert:

- `decisions.type`: `"approve"` (the operator approved by submitting; the router's role is bookkeeping, not gating).
- `decisions.project_id`: the row's project.
- `decisions.session_id` / `decisions.plan_id`: the new row's id (one is non-null, the other null).
- `decisions.context`: the original brief text.
- `decisions.payload`: validated against the `DecisionPayload` zod schema in `lib/types/jsonb.ts`. Shape:
  ```ts
  { type: "approve", routed_to: "direct" | "bilby", matched_rule: RouterMatchedRule, reason: string }
  ```
  See Open Question 5 for whether this fits the existing `approve` variant or needs a new union member.

**Error pattern.** Both helpers use the bare-throw shape after every Supabase call:

```ts
const { data, error } = await sbAdmin.from("sessions").insert(...).select("id").single();
if (error) throw error;
const { error: decisionError } = await sbAdmin.from("decisions").insert(...);
if (decisionError) throw decisionError;
```

No remapping, no wrapping, no error-class hierarchy. The route handler's try/catch is the single point that translates throws into HTTP 500 responses (§4).

**Atomicity.** Supabase doesn't expose multi-statement transactions through PostgREST. The session/plan insert and the decisions insert are two HTTP calls. Order: session/plan first, decisions second. If decisions fails, the session exists without a triggering decision (CLAUDE.md violation). Acceptable in V1 — orphan sessions are detectable by query (`select s.id from sessions s left join decisions d on d.session_id = s.id where d.id is null`). Slice 2c can address durability via a Postgres function if real failures appear.

### §6 — Tests

**`lib/orchestration/router.test.ts`** — every rule + boundary, asserting both pipeline AND matched_rule. Pure unit tests, no DB.

| brief | pipeline | matched_rule | rationale |
|---|---|---|---|
| `"fix typo in footer"` | direct | length_under_200 | Length<200 wins over keyword (rule 1 first) |
| `"tweak copy on landing page hero"` | direct | length_under_200 | Length<200 dominates even with `copy` keyword |
| 199-char filler with no triggers | direct | length_under_200 | Boundary just under |
| 200-char filler with no triggers | bilby | default_bilby | Boundary at 200 fails length rule |
| 250-char "We need to fix the auth flow before launch…" (length≥200, contains `fix`) | direct | keyword_fix | Keyword wins when length doesn't apply |
| 250-char "Style adjustments to the filter dropdown across both desktop and mobile…" | direct | keyword_style | Keyword `style` |
| ~210-char question brief beginning `"Should we extract the realtime channel logic into a shared hook? It's getting reused across multiple components..."` | bilby | question_mark | Length≥200; no keyword; contains `?` — rule 3 fires in isolation. |
| 250-char ambiguous brief, no triggers | bilby | default_bilby | All rules fail; default fires |
| `"fixed the bug"` | direct | length_under_200 | Length<200 fires before keyword check; `\bfix\b` would NOT match `fixed` due to word boundary |
| 200-char "fixed the bug …" filler | bilby | default_bilby | Length≥200; `\bfix\b` doesn't match `fixed` (word boundary); no other triggers |
| `""` | — | — | `route("")` throws / zod-rejects upstream; router asserts truthy input and throws `Error("brief required")` if empty |
| `"   "` (whitespace only) | — | — | Same; the API layer trims first via zod `.trim().min(1)`, but router stays defensive |

The 12 cases pin every rule's intended behaviour and three boundary conditions (length 199 vs 200, word-boundary on `fix` vs `fixed`, empty input). New rules added in V2 land alongside new test rows.

**`lib/orchestration/start-work.test.ts`** — single live-DB integration test, two cases:

1. Direct-routed brief ("fix typo") → asserts (a) one new session row exists with `status='idle'`, (b) one new decisions row exists with `session_id = session.id`, `payload.routed_to = "direct"`, `payload.matched_rule = "length_under_200"`.
2. Bilby-routed brief (250-char ambiguous) → asserts (a) one new plan row exists with `status='drafting'`, (b) one new decisions row exists with `plan_id = plan.id`, `payload.routed_to = "bilby"`, `payload.matched_rule = "default_bilby"`.

Same `describe.skipIf(!haveCreds)` env gate and project-cascade `afterEach` cleanup as `lib/supabase/queries/sessions.test.ts`. Hits the real Supabase HTTP path — guards against schema drift, embedded zod payload mismatches, and the two-step insert order regressing.

**No Playwright in 2b.** First E2E lands here per slice 2a's E2E deferral, but stays at unit/integration depth. Manual smoke covers the form interaction.

## Open questions

1. **Server Action vs route handler.** Your scope mentions both "Server Action that calls Router.decide()" AND `app/api/start-work/route.ts` — those aren't the same Next.js primitive. The plan above proposes route handlers (POST endpoints) for both endpoints, no Server Actions. Route handlers are simpler to test (no `"use server"` boundary needed), easier to invoke via curl during verification, and don't constrain how the StartWorkInput component is structured. Confirm route-handler-only is fine, or push back if you specifically want a Server Action wrapper.

2. **Bilby-routed Start Work lands on a 404 in 2b** because `/plans/<id>` doesn't exist until slice 5. Same for `/sessions/<id>` (404 until slice 3). Three options: (a) accept the 404 — URL is correct, the row exists, slices 3 and 5 fill the destination; (b) ship one-page placeholder routes in 2b that confirm the row was created and link back to `/sessions`; (c) stay on `/sessions` after submit and render a small "Created NB-1234, plan drafting" inline confirmation rather than navigate. The plan defaults to (a) on YAGNI grounds. (b) is ~30 lines. (c) creates UI that gets thrown away in slice 3.

3. **`/api/plans` endpoint.** Plan above ships `/api/sessions` but folds plan-create inline into `/api/start-work`'s Bilby branch. Asymmetric on purpose — `/api/sessions` has a plausible second consumer (slice 3 retry), `/api/plans` has none in the foreseeable slice list. Push back if you want symmetry now.

4. **Project select persistence.** Plan defaults to `localStorage["numbat:last_project_id"]`, restored on mount. Alternatives: server-side cookie (survives across machines), or no persistence (re-select every time). LocalStorage is the V1 minimum-cost option; the operator's frustration tolerance for re-selecting NB on every brief is the call.

5. **`DecisionPayload` zod schema for the `approve` variant.** The existing union in `lib/types/jsonb.ts` has an `approve` variant whose shape may not include router-decision metadata (`routed_to`, `matched_rule`, `reason`). Three resolutions: (a) extend the existing `approve` variant with optional fields; (b) add a new union member, e.g. `{ type: "approve_via_router", routed_to, matched_rule, reason }`; (c) keep the `decisions.payload` shape generic and validate router-decision payloads as a sub-schema only at the createSession/createPlan layer. The plan defers to your call — confirm during build before file 7/8 lands.

## Acceptance criteria mapping (brief §11 Slice 2 — write-path subset)

| Criterion | Satisfied by |
|---|---|
| Operator can type a brief and submit it | `StartWorkInput` mounted at top of `/sessions`; submits to `/api/start-work` |
| Router decides Direct vs Bilby per brief §5 rules | `lib/orchestration/router.ts` per §1 |
| Direct path creates a session row, navigates to it | `createSession` + redirect to `/sessions/<id>` (404 until slice 3) |
| Bilby path creates a plan stub, navigates to it | `createPlan` + redirect to `/plans/<id>` (404 until slice 5) |
| Every session/plan create writes a decisions row | `createSession`/`createPlan` write decisions in the same flow |
| Auth gate over the entire surface | `middleware.ts` + `/login` + zod-validated `env.NUMBAT_AUTH_TOKEN` |
| Router rules are tested | `lib/orchestration/router.test.ts` per §6 |
| `/api/sessions` exists for non-router-mediated Direct creates | `app/api/sessions/route.ts` |

Out of scope in 2b (covered by later slices): single-session detail page (3), plans surface (5), session execution (4), Bilby stages running (6).

## Verification plan

1. `pnpm install` succeeds (shadcn dlx adds button/input/textarea via plain install; no new top-level deps).
2. `pnpm typecheck` passes.
3. `pnpm lint` passes.
4. `pnpm test` runs all router test cases + the live-DB integration test (when env present); previous 7 tests + new tests all green.
5. `pnpm dev` boots:
   - Without `numbat_auth` cookie set, every route 302s to `/login`.
   - `/login?token=<NUMBAT_AUTH_TOKEN>` sets the cookie and redirects to `/sessions`.
   - `/login?token=wrong` shows "Invalid token", no redirect, no cookie set.
6. On `/sessions`, StartWorkInput renders above the filter bar with a project Select (defaulting to last-used) and an empty Textarea.
7. Submit empty: Button disabled.
8. Pick project NB; type "fix typo in footer"; press Cmd+Enter. URL becomes `/sessions/<uuid>` (404 page, expected). In Supabase: confirm one new session row (`status='idle'`, `slice_name` derived from brief) + one decisions row (`session_id` matches, `payload.matched_rule = "length_under_200"`).
9. Pick project NB; type "Investigate why the cost badge is flaky on first load with stale cache state…" (>200 chars); click Start work. URL becomes `/plans/<uuid>` (404 page, expected). In Supabase: confirm one new plan row (`status='drafting'`) + one decisions row (`plan_id` matches, `payload.matched_rule = "default_bilby"`).
10. `curl -X POST localhost:3000/api/start-work -H 'Content-Type: application/json' -d '{"projectId":"…","brief":"fix typo"}'` without the auth cookie — confirm 401.
11. Same `curl` with cookie — confirm response includes `pipeline`, `matched_rule`, `redirect_url`.
12. `curl` with malformed body (missing `projectId`) — confirm 400 with sanitized error message.
13. 375px verification: StartWorkInput stacks vertically, no horizontal scroll, submit Button full-width, project Select usable.
14. After step 8 succeeds, the new session appears in the (still-2a) Sessions list within ~1s thanks to the realtime channel — without refresh.

## Order of work

Bootstrap → router-pure → DB helpers → API → auth → UI → integrate. Pause gate after step 5.

1. `pnpm dlx shadcn@latest add button input textarea`. Commit primitives only.
2. `lib/env.ts` zod schema (additive — keep dotenv loader; layer validation on top).
3. `lib/orchestration/router.ts` — pure function only.
4. `lib/orchestration/router.test.ts` — every case in §6 router table.
5. **Pause gate: router rules signed off.** Show the test output to the user; confirm rule list, keyword set, default direction, and reason strings are right before any UI work. Cheap fixups here, expensive fixups once StartWorkInput depends on the return shape.
6. Resolve Open Question 5 (decisions payload shape). Update `lib/types/jsonb.ts` if needed.
7. `lib/orchestration/create-session.ts` and `create-plan.ts` — DB writes + decisions write.
8. `app/api/sessions/route.ts` — POST handler over `createSession`.
9. `app/api/start-work/route.ts` — POST handler; routes then delegates.
10. `lib/orchestration/start-work.test.ts` — live-DB integration test.
11a. `middleware.ts` — cookie check; 302 to `/login` on miss. Header comment documents the recovery procedure: "If locked out, delete numbat_auth cookie in devtools OR rotate NUMBAT_AUTH_TOKEN in .env.local and restart pnpm dev."
11b. **Pause gate: middleware redirect verified before /login depends on it.** Fresh browser (DevTools → Application → Cookies → clear `numbat_auth`); reload `/sessions`. Confirm 302 to `/login`. The /login route doesn't exist yet, so the redirect lands on a 404 — that's the expected state at this gate. Reason: middleware is the one piece of this slice where a bug locks the operator out of their own app. Testing 302-on-cookie-miss before /login depends on it being right is cheap insurance.
11c. `app/login/page.tsx` — cookie-set + redirect-to-`?next=` + localStorage cleanup. After this step, the redirect from 11b lands on a working login page.
12. `components/sessions/start-work-input.tsx` — UI.
13. `app/sessions/page.tsx` (edit) — mount StartWorkInput; pass projects prop.
14. Manual verification per the plan above.

Steps 1–5 stand alone — the router is pure and testable without any UI or DB. The pause gate isolates rule-design feedback from implementation drag.

## Considered but rejected

A Grok pass on this plan surfaced six suggestions; three were folded in (slice_name/title derivation contracts, explicit error-throw pattern with single-operator passthrough, /login localStorage cleanup). The other three are recorded here so the dialectic trail stays auditable — same convention as `docs/dialectic-experiments/` for cross-family critiques.

- **Placeholder pages for `/sessions/[id]` and `/plans/[id]`.** Slice 3 builds the real session detail page in the very next slice; the placeholder would be deleted within weeks. Slice 2a explicitly avoided scaffolding-that-gets-deleted. A 404 on the destination is honest; the row is verifiable via Supabase Studio or a `select` query, and the operator's mental model ("brief submitted → row exists → URL is correct") doesn't depend on the destination being styled.
- **Pre-emptive `DecisionPayload` zod resolution.** Deferred to step 6 of the order of work as planned. The existing union shape isn't visible without reading `lib/types/jsonb.ts` in context, and a pre-emptive design pass risks proposing a shape that doesn't fit the existing variants. Resolution is in-flight: read the file, propose minimal change, ask before committing. Open Question 5 captures this explicitly.
- **Vague-verb + question-mark interaction test case.** Moot — the vague-verb rule itself was dropped from §1 (rule 4 → default). The remaining test rows already cover question-mark routing against the default fallback ("Should we extract..." → question_mark vs the 250-char ambiguous brief → default_bilby). No interaction surface remains to test.

## Critical files for the implementer

- `lib/orchestration/router.ts` — the pure rule engine; everything downstream consumes its return shape. Get the type right before anything depends on it.
- `app/api/start-work/route.ts` — the orchestration entry; the only place where router-decide + DB-write + redirect compose. The contract between client and server lives here.
- `lib/orchestration/create-session.ts` and `create-plan.ts` — every Start Work and every future session/plan-create flows through these. Decisions-table writes live here, not in the route handler.
- `middleware.ts` — wraps the entire surface. A bug here locks the operator out and there's no way to recover except editing `.env.local` and restarting `pnpm dev`.
- `components/sessions/start-work-input.tsx` — the only user-facing surface 2b adds; UX choices here set the default for slices 3+ (single-session detail, plans surface).
