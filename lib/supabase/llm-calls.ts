import type { SupabaseClient } from "@supabase/supabase-js";
import type { LanguageModelUsage } from "ai";
import type { Database, LlmCallInsert, LlmProvider } from "@/lib/types/db";
import type { LlmCallErrorT } from "@/lib/types/jsonb";
import { LlmCallError } from "@/lib/types/jsonb";

// ─────────────────────────────────────────────────────────────────────
// Per-model price table for AI-SDK direct calls (Bilby's Opus + Grok).
//
// The Agent SDK path computes its own `costUSD` per model (see
// insertLlmCallsFromModelUsage below) and Numbat trusts that figure.
// AI SDK's `generateText` does NOT pre-compute cost — the `usage` shape
// is purely token counts — so we multiply locally against this table.
//
// Prices are USD per 1,000,000 tokens. Cached-read input is billed at
// a discount on the input rate (Anthropic: 10% of base; xAI: see source
// below). Cache-write is billed at a premium on Anthropic.
//
// ⚠ PRICES DECAY. Provider list rates change without notice; this table
// is a snapshot, not a contract. Re-verify periodically against:
//
//   - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//   - xAI:       https://docs.x.ai/docs/models  (per-model card)
//
// Snapshot taken: 22 May 2026. If you're reading this >90 days later,
// re-verify before trusting `cost_usd` for any analysis that affects
// budgeting decisions. The audit trail (input_tokens / output_tokens
// / cache_*) is correct regardless — cost is the derived field that
// goes stale.
//
// Anthropic tier note: Opus 4.5/4.6/4.7 share the same lower-tier
// rates ($5 input / $25 output / 1.25x cache write / 0.1x cache read).
// Opus 4.1 and earlier stay at the legacy higher tier ($15/$75) — if
// you add an older model to the table, use 15/75, not 5/25.
//
// xAI caching note: as of 2026-05-22 the public xAI docs page does NOT
// surface a prompt-caching rate for the grok-4 tier. The cacheRead /
// cacheWrite rows below are set to the base input rate as a CONSERVATIVE
// placeholder — if xAI silently caches and reports it via the AI SDK's
// inputTokenDetails, we slightly OVER-bill in our local audit (real cost
// is lower than recorded). If xAI doesn't cache, the rate is unused.
// Update once xAI publishes explicit caching rates.
// ─────────────────────────────────────────────────────────────────────

type PriceRow = {
  /** $ per 1M input tokens (non-cached). */
  input: number;
  /** $ per 1M output tokens. */
  output: number;
  /** $ per 1M cached-read input tokens. */
  cacheRead: number;
  /** $ per 1M cache-write input tokens. */
  cacheWrite: number;
};

const PRICE_PER_MILLION: Record<string, PriceRow> = {
  // Anthropic Opus 4.5+ tier. Confirmed against the platform docs
  // pricing table on 2026-05-22.
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // xAI Grok 4 standard tier. Confirmed against the xAI docs/models
  // page on 2026-05-22 (page surfaced rates for "Grok-4.3 standard
  // tier" = $1.25 input / $2.50 output). cacheRead/cacheWrite are
  // conservative placeholders — see note above. grok-4-latest is an
  // alias and may repoint; verify on bumps.
  "grok-4-latest": { input: 1.25, output: 2.5, cacheRead: 1.25, cacheWrite: 1.25 },
  "grok-4": { input: 1.25, output: 2.5, cacheRead: 1.25, cacheWrite: 1.25 },
};

export function computeCostUsd(model: string, usage: LanguageModelUsage): number {
  const price = PRICE_PER_MILLION[model];
  if (!price) {
    // Not throwing: a missing price row produces a $0 cost row, which
    // is wrong-but-visible (a $0 entry in the dashboard is easier to
    // notice than a thrown call). Add the model to the table when it
    // appears. The audit trail (tokens) is still correct.
    return 0;
  }
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  // Anthropic's `inputTokens` already excludes cache reads/writes (they
  // appear only under inputTokenDetails). xAI's accounting is the same
  // in AI SDK v6. So the formula is straight: non-cached input + cached
  // read + cache write + output, each at its own rate.
  const nonCached = input - cacheRead - cacheWrite;
  return (
    (Math.max(nonCached, 0) * price.input +
      cacheRead * price.cacheRead +
      cacheWrite * price.cacheWrite +
      output * price.output) /
    1_000_000
  );
}

// Mirrors @anthropic-ai/claude-agent-sdk's `ModelUsage` shape — only the
// fields Numbat persists. Kept local to this file so Slice 4's session
// runner can pass the SDK's value through unchanged.
export type ModelUsageEntry = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
};
export type ModelUsageMap = Record<string, ModelUsageEntry>;

export type InsertLlmCallsInput = {
  project_id: string;
  session_id: string;
  modelUsage: ModelUsageMap;
  duration_ms?: number | null;
  prompt_hash?: string | null;
  error?: LlmCallErrorT | null;
  plan_stage_id?: string | null;
};

/**
 * Fan out a single Claude Agent SDK session's `modelUsage` into one
 * `llm_calls` row per model. `provider` is hardcoded to `'agent_sdk'`
 * inside this helper — there is no scenario where this code path writes
 * anything else. (Bilby's direct Anthropic / xAI calls go through a
 * different helper that lands in Slice 5.)
 *
 * The sum of `cost_usd` across the inserted rows equals the SDK's
 * `result.total_cost_usd` (modulo numeric(10,6) rounding).
 */
export async function insertLlmCallsFromModelUsage(
  db: SupabaseClient<Database>,
  input: InsertLlmCallsInput,
): Promise<void> {
  const {
    project_id,
    session_id,
    modelUsage,
    duration_ms = null,
    prompt_hash = null,
    error = null,
    plan_stage_id = null,
  } = input;

  // CLAUDE.md "Always": validate jsonb fields with Zod before insert.
  if (error !== null) {
    LlmCallError.parse(error);
  }

  const rows: LlmCallInsert[] = Object.entries(modelUsage).map(
    ([model, usage]) => ({
      project_id,
      plan_stage_id,
      session_id,
      provider: "agent_sdk",
      model,
      prompt_hash,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens,
      duration_ms,
      // numeric(10,6) — string serialization preserves precision exactly.
      cost_usd: usage.costUSD.toFixed(6),
      error,
    }),
  );

  const { error: dbError } = await db.from("llm_calls").insert(rows);
  if (dbError) {
    throw new Error(`insertLlmCallsFromModelUsage: ${dbError.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// AI SDK direct-call path (Bilby's Opus + Grok). One row per call, not
// fan-out — generateText returns one usage object for one model call.
//
// Cost is computed locally via PRICE_PER_MILLION (above), since the AI
// SDK doesn't pre-compute it the way the Agent SDK does.
// ─────────────────────────────────────────────────────────────────────

export type InsertLlmCallFromAiSdkResultInput = {
  project_id: string;
  plan_stage_id: string;
  provider: Extract<LlmProvider, "anthropic" | "xai">;
  model: string;
  usage: LanguageModelUsage;
  duration_ms: number;
  prompt_hash?: string | null;
  error?: LlmCallErrorT | null;
};

export async function insertLlmCallFromAiSdkResult(
  db: SupabaseClient<Database>,
  input: InsertLlmCallFromAiSdkResultInput,
): Promise<void> {
  const {
    project_id,
    plan_stage_id,
    provider,
    model,
    usage,
    duration_ms,
    prompt_hash = null,
    error = null,
  } = input;

  if (error !== null) {
    LlmCallError.parse(error);
  }

  const costUsd = computeCostUsd(model, usage);
  const row: LlmCallInsert = {
    project_id,
    plan_stage_id,
    session_id: null,
    provider,
    model,
    prompt_hash,
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cache_creation_input_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    duration_ms,
    // numeric(10,6) — string serialization preserves precision exactly.
    cost_usd: costUsd.toFixed(6),
    error,
  };

  const { error: dbError } = await db.from("llm_calls").insert(row);
  if (dbError) {
    throw new Error(`insertLlmCallFromAiSdkResult: ${dbError.message}`);
  }
}
