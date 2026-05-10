# 001-grok-on-slice-2a-plan

**Date:** 2026-05-10
**Subject:** Slice 2a plan (Sessions surface, read-only). Plan held at `docs/slice-2a-plan.md` once promoted from `~/.claude/plans/`.
**Critic:** Grok 4.3 via xAI.
**Critic context:** The full slice 2a plan only. NOT included: `docs/numbat-brief-final.md`, the Slice 1 outputs (schema, types, ContextLoader, llm-calls helper, fixtures), `CLAUDE.md`, the bootstrap dialectic doc. This is called out explicitly because the missing context explains the hallucination on item 2.
**Stage shape:** Single-stage critique. NOT a Bilby dialectic — full Bilby is four stages (Opus draft → Grok critique → Opus considered → Grok validate). This was one Grok pass for sanity, not the formal flow.

## Input

The full slice 2a plan as approved at the first review gate: status mapping, file table, specifics §1–§11, acceptance criteria mapping, verification plan, order of work, critical files. Sent to Grok with a generic critique prompt: gaps, missing concerns, things that will break, where the plan is overconfident.

## Output

Grok raised seven items, paraphrased one line each:

1. **Realtime channel cleanup.** `useEffect` opening a Supabase realtime channel must return a cleanup that calls `sb.removeChannel(channel)`. Without it, dev-server HMR will leak channels — known Next.js + Supabase gotcha.
2. **Project short_code mismatch.** Discrepancy flagged between `DS/MH/AL/NB` (referenced "somewhere") and `AO/WT/BB/NB` (used in the plan); claimed the plan needed a verification step to reconcile.
3. **Loading skeleton.** No loading state for the sessions list during cold-start hydration; suggested a skeleton component or shimmer.
4. **Graceful error handling.** Plan doesn't describe what happens when `listSessions` throws or when realtime channel fails to subscribe; suggested toast or inline error UI.
5. **Explicit ordering on `listSessions`.** Verification mentions "ordered by `updated_at` desc" but the query stub didn't show the `.order('updated_at', { ascending: false })` call. Without it, Postgres row order is unspecified.
6. **Cost badge UPDATE subscription.** Cost badge subscribes to INSERT only. What if a row's `cost_usd` is updated retroactively?
7. **Tailwind v4 + shadcn pinning reminder.** Tailwind v4 is new; shadcn's v4 support varies; suggested explicit version pinning notes in the plan.

## Verdict

1. **Realtime cleanup → VALID.** Real concern. Folded into plan: order-of-work steps 11 (SessionList) and 14 (CostBadge) now explicitly reinforce the cleanup pattern, and §5/§8 code samples show the cleanup explicitly.
2. **Project short_code mismatch → HALLUCINATED.** Grok confused the historical bootstrap dialectic doc (which references `DS/MH/AL/NB` for the original project list before rename) with the current canonical state (`AO/WT/BB/NB`, seeded in Slice 1). The brief was patched and Slice 1 seeded the new short codes; the dialectic doc is preserved as a historical record of the renaming. Current state is consistent. Missing context (brief, Slice 1 outputs, CLAUDE.md) prevented Grok from disambiguating. No action.
3. **Loading skeleton → NICE-TO-HAVE.** Rejected as premature polish. RSC fetches happen server-side and stream to the client; cold-start visible flash is sub-second and not on the critical path. V1 has bigger fish. Revisit if real-world feel calls for it.
4. **Graceful error handling → NICE-TO-HAVE.** Rejected. CLAUDE.md already specifies typed error returns for expected failures and throw for genuine bugs. Toast component doesn't exist until slice 3 (`Dialog`/`Toast` deferred per §10). Adding a custom error UI in 2a is scope creep.
5. **Explicit ordering → VALID.** Real concern. Folded into plan: §6 query sample now shows `.order("updated_at", { ascending: false })` explicitly.
6. **Cost badge UPDATE subscription → REJECTED.** Edge case for a feature that doesn't exist. V1 never updates `cost_usd` retroactively — the column is set on insert by `insertLlmCallsFromModelUsage` (Slice 1 helper at `lib/supabase/llm-calls.ts`) and there is no code path that mutates it. Subscribing to UPDATE adds noise for zero benefit.
7. **Tailwind v4 + shadcn pinning note → REJECTED.** Documentation noise. The plan already specifies version constraints (`tailwindcss@^4`, `next@^15`, `react@^19`). Adding a comment about "watch out, this is new" is rot once the slice ships.

## Signal-to-noise

2 valid / 1 hallucinated / 2 nice-to-haves / 2 rejected / 0 architecture-invalidating — 2/7 actionable on an execution-slice plan.

## Calibration note

The bootstrap dialectic (a brief-level artifact, full four-stage Bilby) caught one architecture-invalidating gap (the Vercel-vs-local-FS hosting model conflict) and ~8 material gaps with 2 false positives. ROI: very high — single-handedly justified the dialectic system's existence.

This run on an execution-slice plan (single-stage Grok critique) caught zero architecture-level issues, two minor real catches (cleanup pattern, explicit ordering — both already implicit in the plan but worth making explicit), and produced one hallucination from missing context. ROI: marginal.

This confirms brief §10's prediction: **cross-family critique earns its keep on strategic/architectural artifacts where premises are still soft, not on execution slices with explicit acceptance criteria where the design space is mostly closed.**

**Default V1 behaviour:** don't run cross-family critique on slice plans. Save dialectic for V2 scope work, architectural pivots, and bootstrap-equivalent moments. Single-pass critique on a slice plan is roughly the same value as a careful self-review — but slower and more expensive. Self-review with a checklist is the right tool at this scope.

**Open hypothesis to test in future entries:** does providing the critic with the supporting context (brief + slice 1 outputs + CLAUDE.md) reduce the hallucination rate enough to make slice-level critique worthwhile? Item 2 here is the canonical example of what missing context produces. Future entry on a slice plan with full context vs without would be the comparison data.
