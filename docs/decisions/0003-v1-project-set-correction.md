> File: docs/decisions/0003-v1-project-set-correction.md

## V1 project set — confirmed AO/WT/BB/NB, brief corrected

> **Date:** 14 May 2026.
> **Type:** correction / artifact reconciliation.
> **Subject:** Mismatch between the brief's named project set and the live projects table, surfaced by the Slice 3 §0a pre-flight gate.

**What happened.** The Slice 3 plan included a §0a hard-stop gate: verify `projects.short_code` values against the live DB before writing the skills seed. The gate fired — the table holds AO/WT/BB/NB (Alice OS, Wedgetail, Bowerbird, Numbat), not the DS/MH/AL/NB (Departed Spirits, Men's Health, Aluna, Numbat) named in `numbat-brief-final.md` §5 and §7. Claude Code stopped, wrote no seed code, and surfaced the discrepancy. Resolution: AO/WT/BB/NB is correct. Departed Spirits, Men's Health, and Aluna are brand/product ventures, not codebases Numbat orchestrates; the brief's DS/MH/AL/NB was a pre-finalisation draft artifact that was never the intended set. The DB and `config/projects.json` were right; the brief was stale.

**Why it matters.** The drift had been latent since Slice 1 — invisible because Slices 1–2 only required projects to exist, not to be identified. Slice 3 is the first slice to read project *identity* (attaching skills per-project), so it was the natural surfacing point. Caught by a gate before it could seed wrong data, rather than discovered downstream. The fix: brief corrected in three places (§5 seed line, §5 acceptance criteria, §7 schema comment) plus a dated reconciliation note; `config/projects.json` and the DB left untouched.

**Calibration takeaway.** Validates the §0a-style pre-flight gate as a pattern — a cheap DB-vs-doc check at the top of a plan caught a brief/database mismatch that no test would have flagged (the test suites insert their own fixtures and never read the seeded set). Worth repeating: when a slice's plan depends on seeded reference data matching a spec, verify against the live source before writing, not after. Also a reminder that the brief is a living artifact — early-draft content can survive into the "final" version and outlive its accuracy; the decisions log is where that gets caught and dated.