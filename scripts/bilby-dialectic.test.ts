// Unit tests for the proto-Bilby script's pure helpers. The dialectic
// flow itself is verified manually against a real plan row — see the
// commit message and CLAUDE.md "Always" addendum.

import { describe, expect, it } from "vitest";

import {
  assembleDecisionMarkdown,
  deriveSlug,
  nextDecisionNumber,
  parseVerdict,
  type Verdict,
} from "./bilby-dialectic";

describe("deriveSlug", () => {
  it("kebab-cases a normal title", () => {
    expect(deriveSlug("Should Numbat add a pinned sessions feature?")).toBe(
      "should-numbat-add-a-pinned-sessions-feature",
    );
  });

  it("strips leading/trailing punctuation", () => {
    expect(deriveSlug("!!! Hello World !!!")).toBe("hello-world");
  });

  it("collapses multiple non-alphanumeric chars to one hyphen", () => {
    expect(deriveSlug("foo --- bar___baz")).toBe("foo-bar-baz");
  });

  it("lowercases", () => {
    expect(deriveSlug("ALL CAPS TITLE")).toBe("all-caps-title");
  });

  it("truncates at word boundary when over 60 chars", () => {
    const title =
      "An exceptionally lengthy plan title that overflows the sixty character limit easily";
    const slug = deriveSlug(title);
    expect(slug.length).toBeLessThanOrEqual(60);
    // The fix from the Slice 5 carry list: do NOT cut mid-word. The
    // resulting slug must end at a word boundary, i.e. not end with a
    // partial word that was sliced.
    expect(slug.endsWith("-")).toBe(false);
    // Should be derived from the start of the title.
    expect(slug.startsWith("an-exceptionally-lengthy")).toBe(true);
    // Specifically, it must NOT cut "character" to "charact" or "ch".
    expect(slug).not.toMatch(/-cha[a-z]?$/);
  });

  it("handles a title that is exactly the limit", () => {
    // 60 characters of clean kebab-case input.
    const exactlySixty = "a".repeat(60);
    expect(deriveSlug(exactlySixty)).toBe(exactlySixty);
    expect(deriveSlug(exactlySixty).length).toBe(60);
  });

  it("handles a single word longer than the limit (no hyphens to cut at)", () => {
    // No word boundary inside the limit → hard cut accepted (the
    // alternative is an unbounded slug). Documented behaviour.
    const monster = "a".repeat(80);
    const slug = deriveSlug(monster);
    expect(slug.length).toBe(60);
  });

  it("handles unicode by stripping it (a-z0-9 only)", () => {
    // V1 simplification: non-ASCII letters are stripped. If we ever
    // need unicode slugs, that's a separate decision.
    expect(deriveSlug("Café — Über Naïve")).toBe("caf-ber-na-ve");
  });

  it("handles an empty title", () => {
    expect(deriveSlug("")).toBe("");
    expect(deriveSlug("!!!")).toBe("");
  });
});

describe("nextDecisionNumber", () => {
  it("returns 0001 for an empty directory", () => {
    expect(nextDecisionNumber([])).toBe("0001");
  });

  it("returns max+1 for a sequential list", () => {
    expect(
      nextDecisionNumber([
        "0001-foo.md",
        "0002-bar.md",
        "0003-baz.md",
      ]),
    ).toBe("0004");
  });

  it("returns max+1 even when there are gaps", () => {
    // The current decisions log has gaps: 0001, 0003, 0004, 0005, 0006,
    // 0007, 0008 (0002 was reorganised away). Next should be 0009, not
    // a re-use of 0002.
    expect(
      nextDecisionNumber([
        "0001-bootstrap-dialectic.md",
        "0003-v1-project-set-correction.md",
        "0004-decisions-log-convention.md",
        "0005-slice-3-close-out.md",
        "0006-slice-4-close-out.md",
        "0007-completed-at-semantics.md",
        "0008-permission-config.md",
      ]),
    ).toBe("0009");
  });

  it("ignores non-conforming filenames", () => {
    expect(
      nextDecisionNumber([
        "0001-foo.md",
        "README.md",
        "draft.txt",
        "12-too-few-digits.md",
        "0002-bar.md",
        ".DS_Store",
      ]),
    ).toBe("0003");
  });

  it("zero-pads correctly past single/double/triple digits", () => {
    expect(nextDecisionNumber(["0009-foo.md"])).toBe("0010");
    expect(nextDecisionNumber(["0099-foo.md"])).toBe("0100");
    expect(nextDecisionNumber(["0999-foo.md"])).toBe("1000");
  });
});

describe("parseVerdict", () => {
  const wrap = (verdictLine: string): string =>
    `Some preamble.\n\n## Verdict\n\n${verdictLine}\n\n## Confirmed dispositions\n...`;

  it("parses READY", () => {
    expect(parseVerdict(wrap("READY. Ship the plan."))).toBe("ready");
  });

  it("parses READY WITH FOLLOW-UPS as the dedicated verdict", () => {
    expect(
      parseVerdict(wrap("READY WITH FOLLOW-UPS. Address the two minor items.")),
    ).toBe("ready_with_followups");
  });

  it("parses NOT READY", () => {
    expect(parseVerdict(wrap("NOT READY. Send back for another round."))).toBe(
      "not_ready",
    );
  });

  it("is case-insensitive on the verdict keyword", () => {
    expect(parseVerdict(wrap("ready. ship it."))).toBe("ready");
  });

  it("strips markdown emphasis around the verdict", () => {
    expect(parseVerdict(wrap("**READY.** Ship."))).toBe("ready");
  });

  it("returns unparseable when the Verdict section is missing", () => {
    expect(parseVerdict("Just some text with no verdict header")).toBe(
      "unparseable",
    );
  });

  it("returns unparseable when the verdict line is gibberish", () => {
    expect(parseVerdict(wrap("Uhhh, looks fine?"))).toBe("unparseable");
  });

  it("ignores blank lines between header and verdict", () => {
    expect(parseVerdict("## Verdict\n\n\n\nREADY. Ship.")).toBe("ready");
  });
});

describe("assembleDecisionMarkdown", () => {
  it("produces a structurally valid skeleton with all stages", () => {
    const md = assembleDecisionMarkdown({
      filename: "0009-test.md",
      planTitle: "Test plan",
      date: "2026-05-22",
      verdict: "ready",
      stages: [
        { stage_num: 1, action: "draft", actor: "opus", response: "DRAFT BODY", model: "claude-opus-4-7" },
        { stage_num: 2, action: "critique", actor: "grok", response: "CRITIQUE BODY", model: "grok-4-latest" },
        { stage_num: 3, action: "consider", actor: "opus", response: "CONSIDER BODY", model: "claude-opus-4-7" },
        { stage_num: 4, action: "validate", actor: "grok", response: "VALIDATE BODY", model: "grok-4-latest" },
      ],
    });
    expect(md).toContain("> File: docs/decisions/0009-test.md");
    expect(md).toContain("# Test plan");
    expect(md).toContain("**Final verdict:** READY");
    expect(md).toContain("## Stage 1 — Opus draft");
    expect(md).toContain("## Stage 2 — Grok critique");
    expect(md).toContain("## Stage 3 — Opus consider");
    expect(md).toContain("## Stage 4 — Grok validate");
    expect(md).toContain("DRAFT BODY");
    expect(md).toContain("CRITIQUE BODY");
    expect(md).toContain("## Meta-observations");
    expect(md).toContain("<!-- add manually");
    // Sanity: the verdict appears in the header blockquote only — there
    // is no separate bottom-of-file "## Final verdict" section (dropped
    // as redundant; reasoning sits in Stage 4's Sign-off).
    expect(md).not.toContain("## Final verdict");
  });

  it("renders verdict variants correctly in the header block", () => {
    const variants: Verdict[] = [
      "ready",
      "ready_with_followups",
      "not_ready",
      "unparseable",
    ];
    for (const v of variants) {
      const md = assembleDecisionMarkdown({
        filename: "0009-test.md",
        planTitle: "Test",
        date: "2026-05-22",
        verdict: v,
        stages: [],
      });
      expect(md).toContain("**Final verdict:**");
    }
  });
});
