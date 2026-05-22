// Model-name constants. CLAUDE.md "Never": never hardcode model names —
// reference via this module. Two providers wired today:
//
//   - Anthropic (Opus) for draft + consider stages of the Bilby dialectic
//     and any other AI SDK call that needs strongest-reasoning.
//   - xAI (Grok) for critique + validate stages — chosen for cross-family
//     critique per the bootstrap dialectic's calibration finding.
//
// Add a constant here; reference it from prompt/call sites. Never inline
// a literal model string anywhere else in the repo.
//
// Bumping a model ID is a deliberate decision — log it in
// `docs/decisions/` with the calibration evidence that motivated the bump
// (cost, latency, output quality on a representative sample).

// Note: @ai-sdk/anthropic and @ai-sdk/xai don't export their model-ID
// union types in v6 — they're declared `type` inside the package but
// not re-exported. We use literal string types here. Bumping a model
// also requires updating PRICE_PER_MILLION in lib/supabase/llm-calls.ts.

/** Current top-of-line Anthropic model. Used for Opus draft + consider. */
export const OPUS_MODEL = "claude-opus-4-7" as const;

/** Current top-of-line xAI model. Used for Grok critique + validate. */
export const GROK_MODEL = "grok-4-latest" as const;
