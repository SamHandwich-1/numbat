import { describe, expect, test } from "vitest";

import { route } from "./router";

// All 12 cases from docs/slice-2b-plan.md §6. Tests assert pipeline
// AND matched_rule for every case — reason strings are display text,
// not behaviour, and aren't asserted (they live in router.ts as the
// single source of truth and are easy to grep when needed).
//
// The "filler" briefs are constructed from `"x ".repeat(N)` so the
// length is deterministic and obvious from the source. A future
// reader doesn't have to count characters in a string literal.

describe("route", () => {
  describe("rule 1 — length_under_200 (direct)", () => {
    test("fix typo in footer (length wins over keyword)", () => {
      const decision = route("fix typo in footer");
      expect(decision.pipeline).toBe("direct");
      expect(decision.matched_rule).toBe("length_under_200");
    });

    test("tweak copy on landing page hero (length wins over `copy` keyword)", () => {
      const decision = route("tweak copy on landing page hero");
      expect(decision.pipeline).toBe("direct");
      expect(decision.matched_rule).toBe("length_under_200");
    });

    test("199-char filler with no triggers (boundary just under)", () => {
      // "x ".repeat(99) = 198 chars, + "y" = 199 chars. No keyword,
      // no `?` — pure length test.
      const brief = "x ".repeat(99) + "y";
      expect(brief.length).toBe(199);
      const decision = route(brief);
      expect(decision.pipeline).toBe("direct");
      expect(decision.matched_rule).toBe("length_under_200");
    });

    test("'fixed the bug' (\\bfix\\b doesn't match 'fixed', but length<200 fires first anyway)", () => {
      const decision = route("fixed the bug");
      expect(decision.pipeline).toBe("direct");
      expect(decision.matched_rule).toBe("length_under_200");
    });
  });

  describe("rule 2 — keyword_<match> (direct)", () => {
    test("250-char brief containing `fix` (length≥200 so rule 2 evaluates)", () => {
      // 44-char prefix + "x ".repeat(103) = 250 chars.
      const brief =
        "We need to fix the auth flow before launch. " + "x ".repeat(103);
      expect(brief.length).toBe(250);
      const decision = route(brief);
      expect(decision.pipeline).toBe("direct");
      expect(decision.matched_rule).toBe("keyword_fix");
    });

    test("250-char brief containing `style`", () => {
      // 42-char prefix + "x ".repeat(104) = 250 chars.
      const brief =
        "Style adjustments to the filter dropdown. " + "x ".repeat(104);
      expect(brief.length).toBe(250);
      const decision = route(brief);
      expect(decision.pipeline).toBe("direct");
      expect(decision.matched_rule).toBe("keyword_style");
    });
  });

  describe("rule 3 — question_mark (bilby)", () => {
    test("~210-char question brief (length≥200, no keyword, contains '?')", () => {
      const brief =
        "Should we extract the realtime channel logic into a shared hook? It's getting reused across multiple components and the cleanup pattern is starting to drift between consumers. Worth deciding before slice 3 lands.";
      expect(brief.length).toBeGreaterThanOrEqual(200);
      const decision = route(brief);
      expect(decision.pipeline).toBe("bilby");
      expect(decision.matched_rule).toBe("question_mark");
    });
  });

  describe("rule 4 — default_bilby", () => {
    test("200-char filler with no triggers (boundary at 200 fails rule 1)", () => {
      // "x ".repeat(100) = 200 chars exactly.
      const brief = "x ".repeat(100);
      expect(brief.length).toBe(200);
      const decision = route(brief);
      expect(decision.pipeline).toBe("bilby");
      expect(decision.matched_rule).toBe("default_bilby");
    });

    test("250-char ambiguous brief (all rules fail; default fires)", () => {
      // "a ".repeat(125) = 250 chars; no keyword, no '?'.
      const brief = "a ".repeat(125);
      expect(brief.length).toBe(250);
      const decision = route(brief);
      expect(decision.pipeline).toBe("bilby");
      expect(decision.matched_rule).toBe("default_bilby");
    });

    test("200-char 'fixed the bug' filler (\\bfix\\b doesn't match 'fixed')", () => {
      // "fixed the bug " (14) + "y ".repeat(93) (186) = 200 chars.
      const brief = "fixed the bug " + "y ".repeat(93);
      expect(brief.length).toBe(200);
      const decision = route(brief);
      expect(decision.pipeline).toBe("bilby");
      expect(decision.matched_rule).toBe("default_bilby");
    });
  });

  describe("input validation", () => {
    test("empty string throws 'brief required'", () => {
      expect(() => route("")).toThrow("brief required");
    });

    test("whitespace-only string throws 'brief required'", () => {
      expect(() => route("   ")).toThrow("brief required");
    });
  });
});
