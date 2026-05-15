> File: docs/decisions/0004-decisions-log-convention.md

## Decisions log — storage convention established

> **Date:** 14 May 2026.
> **Type:** process / artifact convention.
> **Subject:** Pinning where the decisions log lives and what counts as an entry, after ambiguity surfaced while filing entries 0002–0003.

**What happened.** The brief established the decisions log as a first-class artifact and named `numbat-bootstrap-dialectic.md` as its first entry, but never specified the storage convention for subsequent entries. In practice, dialectic stage files were being kept in `docs/dialectic/`, and it was unclear whether decisions-log entries belonged there too. They don't — `docs/dialectic/` holds the four *stage files* of a single Bilby run; the decisions log is a separate artifact. Resolution: the decisions log lives at `docs/decisions/`, one file per entry, named `NNNN-slug.md`. The bootstrap dialectic moved to `docs/decisions/0001-bootstrap-dialectic.md` as entry 1. An entry is either a full Bilby dialectic (four labelled stages + Final Verdict) or a single-decision record (a meaningful call, its reasoning, its outcome). Both `numbat-brief-final.md` §14 and `CLAUDE.md` updated to reference the new path and state the convention.

**Why it matters.** The log is described in the brief as "the seed of every future improvement" and the eventual training data for the V2 LLM-based router. An artifact that important needs an unambiguous home and a clear definition of what goes in it, or entries get filed inconsistently and the signal degrades. Naming the two entry *kinds* — dialectic vs. single-decision record — closes the specific gap that made entries 0002 and 0003 hard to place.

**Calibration takeaway.** When an artifact is declared "first-class," its storage convention belongs in the brief from the start, not discovered on the third entry. Minor process debt, caught early and cheaply. The `NNNN-slug.md` sequence mirrors the existing `docs/dialectic/` numbering, so the two artifacts now share a consistent shape.