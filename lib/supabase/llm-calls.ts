import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, LlmCallInsert } from "@/lib/types/db";
import type { LlmCallErrorT } from "@/lib/types/jsonb";
import { LlmCallError } from "@/lib/types/jsonb";

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
