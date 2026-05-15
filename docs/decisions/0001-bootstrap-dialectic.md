# Numbat Bootstrap Dialectic

> The first entry in Numbat's decisions log. Preserved as the canonical example of how the Bilby dialectic should produce output: Opus drafts → Grok critiques → Opus considers → Grok validates.
>
> **Subject:** The Numbat brief itself. Numbat being built using Numbat's intended workflow.
> **Date:** 9 May 2026.
> **Final verdict:** READY. Brief shipped to Claude Code as `numbat-brief-final.md`.

---

## Why this artifact exists

Every Bilby plan should preserve all four stages of the dialectic as a single document. This is the worked example. Three reasons:

1. **Audit trail.** Anyone (including future-you) can see what was caught, what was rejected with reasoning, what was added late, and what the validator confirmed. The brief makes more sense when you can see why each piece is shaped the way it is.
2. **Training signal.** Patterns in what Grok consistently catches that Opus misses (or vice versa) become visible over time. This data eventually trains the LLM-based router (V2). The first dialectic establishes the format.
3. **Quality calibration.** If a plan ships and ends up being wrong in production, you can walk back through the dialectic to see whether the gap was missed at draft, missed in critique, missed in consideration, or missed in validation. Each failure mode points to a different fix.

Future plans should mirror this structure: four labelled sections plus a Final Verdict block.

---

## Stage 1 — Opus draft

The original brief, drafted in a single Opus pass with no critique input.

**Outline of structure:**
- Vision · Naming · Architecture (5 layers) · V1 scope (in/out/non-goals) · Tech stack · Data model (7 tables) · Project structure · CLAUDE.md · First three slices · Open questions · How to use.

**Decisions made at this stage:**
- Local-first orchestration assumed — but inadvertently mixed with Vercel deployment in the tech stack. (Caught in Stage 2.)
- Five-layer architecture: Interface · Orchestration · Pipelines · Feathertail · Persistence.
- Three orchestration components: Router, State Custodian, Escalation Handler. (ContextLoader added in Stage 4 follow-through.)
- Four projects seeded: Departed Spirits (DS), Men's Health (MH), Aluna (AL), Numbat (NB).
- Slice ordering: schema → mock Sessions → mock review flow → real SDK → Plans + Direct → Bilby. (Slice 0 SDK spike added in Stage 3.)
- Skills table per project, read for quick-move chips.
- Decisions log as first-class artifact from V1.

**Self-acknowledged limit at draft:** the Claude Code SDK package shape needed verification (flagged as Open Question 1).

**Length:** ~500 lines markdown. Full document preserved at `docs/dialectic/01-opus-draft.md`.

---

## Stage 2 — Grok critique

Cold cross-family critique. Grok received the full draft with the instruction: *"Critique this. Where are the gaps? What's missing? What will break? Where am I overconfident?"*

**Headline catches:**

- **Architecture-invalidating:** the hosting model was inconsistent with the execution model. Vercel + cloud Trigger.dev + a local-FS-bound Agent SDK do not coexist. The orchestrator running on Vercel cannot drive a process that needs filesystem, shell, and git access on the developer's machine. *Single biggest risk in the entire brief.*
- **Package rename:** `@anthropic-ai/claude-code` → `@anthropic-ai/claude-agent-sdk`. Verified post-critique.
- **SDK shape unverified.** Days of slice 4 work risked if assumed primitives don't exist. Spike before committing.

**Data model gaps:**
- No `llm_calls` table (mentioned in CLAUDE.md, omitted from schema).
- Sessions missing `last_error`, `completed_at`.
- No `version` on specs.
- No `llm_provider` / `model` columns on `plan_stages`.

**V1 scope gaps:**
- Skills usage in slice 3 ambiguous.
- Creating new sessions/plans from UI not explicit.
- No kill-in-progress mechanism.
- Mobile review screen at 375px will cramp without explicit acceptance.

**Missing entirely:**
- How user actually starts work — no "Start Work" surface.
- Resilience / timeout / retry behaviour not explicit.
- Testing strategy.
- Cost dashboard.

**Less compelling:**
- Speculative `created_by` columns "just in case."
- Dark mode "obvious but worth calling out" — already solved by the dark design system.

**Verdict:** "90%+ there. Fix the deployment reality and this becomes an extremely high-leverage tool."

**Length:** ~150 lines. Preserved at `docs/dialectic/02-grok-critique.md`.

---

## Stage 3 — Opus considered

Opus's structured response: accept / reject / partial / add for each Grok point, with reasoning, plus a new addition (project loading/unloading) that wasn't in the critique.

### Considered table summary

**ACCEPTED (15 points):**
1. Hosting model — rewrote to local-first. Numbat runs on the dev machine via `pnpm dev`. Supabase stays cloud. Background work via spawned Node workers; no external queue framework in V1.
2. Package name — `@anthropic-ai/claude-agent-sdk`. Verified via npm + Anthropic docs. `settingSources: ['project']` adopted as canonical CLAUDE.md delivery mechanism.
3. SDK spike — added Slice 0 (half-day timebox) before any Feathertail design.
4. `llm_calls` table — added to schema with provider, model, tokens, duration, cost, error.
5. `last_error`, `completed_at` on sessions — added.
6. `version` on specs — added (plans don't need it; `plan_stages` rows are the version history).
7. `llm_provider`, `model` on plan_stages — added.
8. Skills usage in slice 3 — clarified: read-only for chip rendering. Skill creation is V2.
9. Create flows — explicit in slice 2 (sessions) and slice 5 (plans).
10. Kill mechanics — explicit acceptance criteria in slice 3 (mock) and slice 4 (live SDK).
11. Resilience — added subsection to CLAUDE.md (timeouts, retry budget, fail-open vs fail-closed). No circuit breakers / fallback models in V1.
12. Testing strategy — Vitest for unit (router, state custodian, ContextLoader, prompts), Playwright for one E2E happy-path per slice. No coverage threshold.
13. Mobile constraints — slice 3 acceptance enforces 375px without horizontal scroll.
14. Start Work surface — text input at the top of Sessions view, routes to Direct or Bilby via the router. Voice (Whisper) is V2.
15. Cost badge — small chrome-bar element pulling from `llm_calls`. Full dashboard is V2.

**REJECTED (2 points):**
1. **`created_by` columns "just in case"** — speculative future-proofing. V1 is single-user by design. ALTER TABLE is cheap when needed.
2. **Dark mode** — factual error in critique. The design system is dark mode (warm-dark `#0d0c0b` base, mint/amber/coral/violet/yellow tokens). Light mode is not a goal.

**PARTIAL (3 points):**
1. Bilby latency/cost — accepted in spirit; reinforced with hard heuristic (briefs <200 chars or matching simple keywords route to Direct).
2. Search/filter persistence — URL params sufficient for V1; deferred.
3. Decisions log export — `pnpm export:decisions` CLI script in V1; UI export is V2.

**ADDED (3 points beyond Grok's critique):**
1. **Slice 0 — SDK spike.** Half-day, one engineer, no UI, output = 1-page memo.
2. **Worktree lifecycle policy.** `~/numbat-worktrees/<project-slug>/<slice-name>/`. Auto-clean 24h after session done/killed. Branch collision check before creation.
3. **Project loading/unloading as a runtime concept** (the major addition). Three-scope model:
   - *Project context* = bundle (CLAUDE.md, active specs, skills, last 30 decisions). Cached at project level.
   - *Session context* = bundle + slice-specific. Loaded fresh at session start. Never reused.
   - *Plan context* = bundle + brief + dialectic state. Each stage assembles fresh. Other plans never included.
   
   Defenses: structural (`project_id` FK on every relevant table) plus runtime (`ContextLoader` is the only path for context assembly; refuses cross-project reads). UI: project switching is implicit via session selection; no menu mode.

**Length:** ~50 lines table + ~30 lines on project loading/unloading. Preserved at `docs/dialectic/03-opus-considered.md`.

---

## Stage 4 — Grok validate

Grok received the considered response, the project loading/unloading addition, and three specific scrutiny prompts (validate the rejections, validate the new addition, validate the spike timebox).

### Verdict: **READY**

> *The considered response soundly and completely addresses the original critique. Every material gap has been closed with precise, minimal additions to slices, schema, CLAUDE.md, and new runtime sections. The two rejections are justified; the new project-context section and Slice 0 spike are high-value additions that were genuinely missing. The brief is now tighter, more robust, and ready to ship to Claude Code.*

### On the two rejections — both **sound, no escalation**

- **`created_by` columns:** Correct call. V1 is explicitly single-operator; speculative columns add zero runtime value while complicating queries. ALTER TABLE later is trivial.
- **Dark mode:** Accurate factual correction. The design system *is* dark mode. The original critique slightly over-flagged a non-requirement.

### On project loading/unloading — **sound**

The three-scope model cleanly mirrors the data hierarchy. Structural and runtime defenses are sufficient and pragmatic for V1. UI implication (implicit context switching) avoids mode-switching friction. V2 escape hatch for cross-project signals is the right deferral.

**One non-blocking observation:** the brief should name the context-assembly logic explicitly (e.g., `lib/orchestration/context.ts` with a `ContextLoader` class consumed by both Feathertail and Bilby) so the contract is clear before implementation.

### On the Slice 0 spike timebox — **right shape**

Half a day, one engineer, no UI, output = 1-page memo is correct minimal viable spike. Long enough to exercise critical primitives (session start, monitoring, output/diff capture, `settingSources: ['project']`) before Feathertail design is locked. Short enough that it doesn't delay bootstrap.

### Closing line

> *The dialectic has done its job. Ship the revised brief.*

**Length:** ~80 lines. Preserved at `docs/dialectic/04-grok-validate.md`.

---

## Final verdict

**READY** with one non-blocking refinement folded into the final brief: the context-assembly logic is named explicitly as `ContextLoader` in `lib/orchestration/context.ts`, with the contract that it's the only code path for assembling LLM context and refuses cross-project reads.

The final brief is at `numbat-brief-final.md`. Slice 0 begins on user's signal.

---

## Meta-observations (for future Bilby calibration)

What the dialectic produced that a single Opus pass would not have:

1. **One architecture-invalidating catch** (the hosting model). Without Stage 2, this would have surfaced during slice 4 — days of work potentially wasted. ROI of the dialectic round-trip on this catch alone: very high.
2. **Eight smaller-but-real gaps** (llm_calls table, kill mechanics, mobile, start flow, etc.). Individually small, collectively material. A second drafting pass by Opus alone would likely have caught some but not all — these are the kind of gaps that come from a different perspective, not deeper thinking.
3. **One useful new addition that didn't come from critique** (project loading/unloading). Generated by Opus during Stage 3 while considering the cumulative weight of Grok's points — a side-effect of the dialectic, not a direct response to it.
4. **Two false-positive critique items** (created_by, dark mode). The validate stage confirmed these as unsound. The dialectic system would be broken if it forced acceptance of every critique point; the asymmetric structure (different model has first/last critical word) is what makes principled rejection possible.

What this calibrates for future Bilby runs:
- Cross-family critique catches structural inconsistencies that same-family review tends to miss.
- The validate stage is essential for confirming rejections; without it, the drafter has implicit final say.
- The "ADD" category (new material in Stage 3 that wasn't in the critique) is genuinely valuable — Opus considering Grok's points while writing the response surfaces things that neither stage alone would catch.

This dialectic took ~3 minutes of LLM time across the four stages. Latency was acceptable. Cost: under $2 estimated. Worth it for an architecture-invalidating catch on a foundational document. Worth tracking the same metrics for every future Bilby run to calibrate when the dialectic earns its keep vs when Direct is sufficient.
