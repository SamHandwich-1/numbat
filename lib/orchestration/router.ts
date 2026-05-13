// Rules-based router. Pure synchronous function — no I/O, no env access,
// no Date.now, no imports beyond types. Same input always returns the
// same RouterDecision; this is what lets the test suite be exhaustive
// (plan §6).
//
// Rules are evaluated in order, FIRST MATCH WINS. This is a deliberate
// tie-breaker: rule 1 (length) is the cheapest signal and the most
// general, so it dominates rule 2 (keyword) when both apply. For
// "fix typo in footer" (15 chars, contains both "fix" and "typo"),
// matched_rule is `length_under_200` — not `keyword_fix`. Tests assert
// this ordering. See plan §1 for the full rationale.
//
// V2 (LLM-based router) consumes the decisions log as labelled training
// data — so the matched_rule discriminator and the human-readable reason
// string are both load-bearing. Persist them verbatim to decisions.payload.

export type RouterPipeline = "direct" | "bilby";

export type RouterMatchedRule =
  | "length_under_200"
  | "keyword_fix"
  | "keyword_typo"
  | "keyword_copy"
  | "keyword_style"
  | "question_mark"
  | "default_bilby"
  | "manual"; // Reserved for callers that synthesize a decision
  // without router involvement (e.g., /api/sessions manual creates).
  // The route() function itself never returns this value.

export type RouterDecision = {
  pipeline: RouterPipeline;
  matched_rule: RouterMatchedRule;
  reason: string;
};

// Keyword set is locked to the brief's four (fix/typo/copy/style).
// Expansion is deferred to V2 once the decisions log offers empirical
// evidence — guesses now bias the future LLM router's training data.
const KEYWORD_RE = /\b(fix|typo|copy|style)\b/i;

export function route(brief: string): RouterDecision {
  // Defensive — the API layer trims via zod before calling, but the
  // function stays defensive on its own. Pure functions shouldn't
  // assume their callers.
  if (!brief || !brief.trim()) {
    throw new Error("brief required");
  }

  // Rule 1 — length under 200.
  if (brief.length < 200) {
    return {
      pipeline: "direct",
      matched_rule: "length_under_200",
      reason:
        "Brief under 200 chars — short enough to execute without planning.",
    };
  }

  // Rule 2 — keyword match. Capture group identifies WHICH keyword
  // fired so matched_rule is specific (keyword_fix, not keyword_*).
  const m = KEYWORD_RE.exec(brief);
  if (m) {
    // m[1] is the capture group; guaranteed when m is truthy and the
    // regex has exactly one parenthesized group. ! satisfies strict
    // noUncheckedIndexedAccess.
    const word = m[1]!.toLowerCase() as "fix" | "typo" | "copy" | "style";
    return {
      pipeline: "direct",
      matched_rule: `keyword_${word}`,
      reason: `Brief contains keyword '${word}' — routine mechanical change.`,
    };
  }

  // Rule 3 — question mark anywhere in the brief.
  if (brief.includes("?")) {
    return {
      pipeline: "bilby",
      matched_rule: "question_mark",
      reason:
        "Brief contains a question — exploratory, route through planning.",
    };
  }

  // Rule 4 (default) — Bilby. Planning-cost < execution-cost on
  // ambiguous briefs (plan §1 rationale).
  return {
    pipeline: "bilby",
    matched_rule: "default_bilby",
    reason:
      "No length, keyword, or question-mark trigger — defaulting to Bilby. Cost of unnecessary planning < cost of executing on a half-formed brief.",
  };
}
