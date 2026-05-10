# Dialectic experiments

Calibration data for V2's LLM-based router.

## Purpose

Numbat's planning dialectic (Bilby) is a four-stage flow: Opus draft → Grok critique → Opus considered → Grok validate. The bootstrap dialectic (`docs/numbat-bootstrap-dialectic.md`) is the canonical worked example, preserved as the seed entry of the decisions log.

This folder is for everything **else** — partial dialectic runs that aren't a full Bilby. Single-stage Grok critiques on a slice plan, ad-hoc Opus pre-mortems on a prompt draft, two-stage critiques on a code-review patch. Anything where a non-Bilby LLM critique is run on a Numbat artifact and the signal-to-noise is worth measuring.

The output: signal-to-noise data on when cross-family critique earns its keep and when it's noise. V2's LLM-based router will train on this data — the rules-based router in `lib/orchestration/router.ts` (Slice 2b) is the V1 placeholder.

## When to add an entry

Any time a non-Bilby LLM critique runs on a Numbat artifact. Specifically:

- Slice plan critiques (single-stage, before formal approval).
- Brief revision sanity checks (single-stage, after a substantive edit).
- Code review of a slice's diff, ad-hoc, by a model not currently coding.
- Prompt template drafts critiqued cold by a different model than the one drafting.
- Anything that would otherwise be lost as ephemeral chat output.

If it **is** a full Bilby dialectic, it belongs in the decisions log via `plan_stages`, not here. This folder is for the partial / ad-hoc runs.

## Append-only

Entries are immutable once written. **Never edit an entry after the fact**, even if the verdict turns out wrong — the wrong verdict is itself signal. Followups go in new files (e.g. `001-followup-2026-08.md`), the original is preserved verbatim.

If you spot a typo: leave it. If you re-evaluate an item later: new file.

## Numbering

Three-digit zero-padded for sort stability through entry 999: `001`, `002`, …, `099`, `100`. Followups append a date or descriptor suffix: `001-followup-2026-08.md`.

## Entry structure

Each entry is a single Markdown file with this shape:

```
# [number]-[short-slug]

**Date:** [YYYY-MM-DD]
**Subject:** [what was critiqued — link to the artifact if it's in the repo]
**Critic:** [model + provider, e.g. "Grok 4.3 via xAI"]
**Critic context:** [exactly what the critic was given access to — be specific, missing context explains hallucinations]
**Stage shape:** [single-stage critique / two-stage / etc — distinguish from full Bilby]

## Input

[Summary of what was sent to the critic, with link to the source artifact.]

## Output

[The critic's response, verbatim or paraphrased one line per item.]

## Verdict

[Per-item triage: VALID / NICE-TO-HAVE / REJECTED / HALLUCINATED, with one-line reasoning each.
- VALID: real concern, action taken or tracked
- NICE-TO-HAVE: real concern, deferred with rationale
- REJECTED: not a real concern, with rationale
- HALLUCINATED: critic invented something not present in the input]

## Signal-to-noise

[One-line summary, e.g. "2 valid / 1 hallucinated / 2 nice-to-haves / 2 rejected / 0 architecture-invalidating — 2/7 actionable on an execution-slice plan".]

## Calibration note

[What this teaches us about when this kind of critique is worth running. Compare to prior runs at similar artifact scope.]
```

## Reading the trail

To see the trend: open the entries in numerical order, scan the **Signal-to-noise** lines. The pattern of valid catches per entry, broken down by artifact type (brief / slice plan / prompt draft / code review), is the calibration the V2 router needs.
