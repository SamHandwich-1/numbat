import { afterEach, describe, expect, test, vi } from "vitest";
import type { LanguageModelUsage } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { insertLlmCallFromAiSdkResult } from "@/lib/supabase/llm-calls";
import type { Database } from "@/lib/types/db";

// Live-DB tests. Skip cleanly when env vars are missing so `pnpm test`
// stays green offline and only exercises the round-trip when the user
// has configured `.env.local` against the cloud Supabase project.
const haveCreds =
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!haveCreds)("llm_calls fan-out (live DB)", () => {
  // Track every project this suite inserts so afterEach can wipe them.
  // Deleting a project cascades to its sessions and llm_calls
  // (both have project_id ON DELETE CASCADE), so one delete cleans up
  // the whole tree this test created.
  const insertedProjectIds: string[] = [];

  afterEach(async () => {
    if (insertedProjectIds.length === 0) return;
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { error } = await sbAdmin
      .from("projects")
      .delete()
      .in("id", insertedProjectIds);
    if (error) {
      console.error("llm-calls.test cleanup failed:", error.message);
    }
    insertedProjectIds.length = 0;
  });

  test("one Agent SDK session writes one llm_calls row per model; sums match total_cost_usd", async () => {
    // Dynamic imports so the test file loads even when credentials are absent.
    const { sbAdmin } = await import("@/lib/supabase/server");
    const { insertLlmCallsFromModelUsage } = await import(
      "@/lib/supabase/llm-calls"
    );
    const { insertProjectFixture, insertSessionFixture } = await import(
      "@/lib/supabase/test-fixtures"
    );

    const project_id = await insertProjectFixture(sbAdmin);
    insertedProjectIds.push(project_id);
    const session_id = await insertSessionFixture(sbAdmin, { project_id });

    // Mock SDKResultSuccess.modelUsage shape: Haiku (router) + Opus (response).
    // Values mirror what the spike actually observed.
    const modelUsage = {
      "claude-haiku-4-5-20251001": {
        inputTokens: 353,
        outputTokens: 13,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.000418,
      },
      "claude-opus-4-7[1m]": {
        inputTokens: 6,
        outputTokens: 6,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 12169,
        costUSD: 0.0762362,
      },
    };
    const total_cost_usd = 0.0766542; // SDK-reported (sum of the two costUSD)

    await insertLlmCallsFromModelUsage(sbAdmin, {
      project_id,
      session_id,
      modelUsage,
      duration_ms: 9397,
      prompt_hash: "fixture-hash",
    });

    const { data, error } = await sbAdmin
      .from("llm_calls")
      .select("*")
      .eq("session_id", session_id);

    expect(error).toBeNull();
    expect(data).toHaveLength(2);

    // The load-bearing assertion: sum across rows ≈ SDK total.
    const sum = (data ?? []).reduce((acc, r) => acc + Number(r.cost_usd), 0);
    expect(sum).toBeCloseTo(total_cost_usd, 6);

    // Spot-check that columns landed correctly per model.
    const haiku = (data ?? []).find((r) => r.model.includes("haiku"));
    const opus = (data ?? []).find((r) => r.model.includes("opus"));
    expect(haiku?.input_tokens).toBe(353);
    expect(haiku?.output_tokens).toBe(13);
    expect(haiku?.cache_creation_input_tokens).toBe(0);
    expect(opus?.cache_creation_input_tokens).toBe(12169);
    expect(opus?.provider).toBe("agent_sdk");
    expect(haiku?.provider).toBe("agent_sdk");
  });
});

// ─────────────────────────────────────────────────────────────────────
// insertLlmCallFromAiSdkResult — mocked Supabase client. Exercises the
// Slice 6b Gate 4 widening: session_id alongside plan_stage_id, at-
// least-one-non-null runtime check, return { id } shape, cost
// computation surface against the existing PRICE_PER_MILLION table.
// ─────────────────────────────────────────────────────────────────────

describe("insertLlmCallFromAiSdkResult (mocked client)", () => {
  // Mock the .from(table).insert(row).select("id").single() chain. The
  // chain shape mirrors what the helper invokes; everything else on the
  // SupabaseClient type is unreachable from this helper so the cast is
  // a typed-runtime-guaranteed boundary, same shape as the test-only
  // casts in lib/llm/opus.test.ts.
  function makeMockClient(opts?: { returnId?: string; dbError?: string }) {
    const insertSpy = vi.fn();
    const single = vi.fn(async () =>
      opts?.dbError
        ? { data: null, error: { message: opts.dbError } }
        : { data: { id: opts?.returnId ?? "mock-id" }, error: null },
    );
    const select = vi.fn(() => ({ single }));
    const insert = vi.fn((row: unknown) => {
      insertSpy(row);
      return { select };
    });
    const from = vi.fn(() => ({ insert }));
    const client = { from } as unknown as SupabaseClient<Database>;
    return { client, insertSpy };
  }

  // Shared input shape; tests override individual fields as needed.
  const baseInput = {
    project_id: "proj-1",
    provider: "anthropic" as const,
    model: "claude-opus-4-7",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as LanguageModelUsage,
    duration_ms: 1_500,
  };

  test("(1) session_id alone → row has session_id set, plan_stage_id null", async () => {
    const { client, insertSpy } = makeMockClient();
    await insertLlmCallFromAiSdkResult(client, {
      ...baseInput,
      session_id: "sess-1",
    });
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const row = insertSpy.mock.calls[0]?.[0] as {
      session_id: string | null;
      plan_stage_id: string | null;
    };
    expect(row.session_id).toBe("sess-1");
    expect(row.plan_stage_id).toBeNull();
  });

  test("(2) plan_stage_id alone → row has plan_stage_id set, session_id null", async () => {
    const { client, insertSpy } = makeMockClient();
    await insertLlmCallFromAiSdkResult(client, {
      ...baseInput,
      plan_stage_id: "stage-1",
    });
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const row = insertSpy.mock.calls[0]?.[0] as {
      session_id: string | null;
      plan_stage_id: string | null;
    };
    expect(row.plan_stage_id).toBe("stage-1");
    expect(row.session_id).toBeNull();
  });

  test("(3) both set → both fields present on the row", async () => {
    const { client, insertSpy } = makeMockClient();
    await insertLlmCallFromAiSdkResult(client, {
      ...baseInput,
      session_id: "sess-2",
      plan_stage_id: "stage-2",
    });
    const row = insertSpy.mock.calls[0]?.[0] as {
      session_id: string | null;
      plan_stage_id: string | null;
    };
    expect(row.session_id).toBe("sess-2");
    expect(row.plan_stage_id).toBe("stage-2");
  });

  test("(4) both null/undefined throws with the named-fields error; no insert attempted", async () => {
    const { client, insertSpy } = makeMockClient();
    // both undefined (defaulted via destructure)
    const r1 = await insertLlmCallFromAiSdkResult(client, {
      ...baseInput,
    }).catch((e: unknown) => e);
    expect(r1).toBeInstanceOf(Error);
    expect((r1 as Error).message).toBe(
      "insertLlmCallFromAiSdkResult: at least one of plan_stage_id or session_id must be non-null",
    );
    // both explicitly null
    const r2 = await insertLlmCallFromAiSdkResult(client, {
      ...baseInput,
      plan_stage_id: null,
      session_id: null,
    }).catch((e: unknown) => e);
    expect(r2).toBeInstanceOf(Error);
    expect((r2 as Error).message).toContain(
      "at least one of plan_stage_id or session_id must be non-null",
    );
    expect(insertSpy).not.toHaveBeenCalled();
  });

  test("(5) returns { id } from the insert", async () => {
    const { client } = makeMockClient({ returnId: "row-uuid-42" });
    const result = await insertLlmCallFromAiSdkResult(client, {
      ...baseInput,
      session_id: "sess-3",
    });
    expect(result).toEqual({ id: "row-uuid-42" });
  });

  test("(6) cost computation: claude-opus-4-7 input + output, no cache", async () => {
    const { client, insertSpy } = makeMockClient();
    await insertLlmCallFromAiSdkResult(client, {
      ...baseInput, // 100 in, 50 out, no cache
      session_id: "sess-6",
    });
    const row = insertSpy.mock.calls[0]?.[0] as { cost_usd: string };
    // (100 * $5 + 50 * $25) / 1M = (500 + 1250) / 1M = $0.001750.
    expect(row.cost_usd).toBe("0.001750");
  });

  test("(7) cost computation: cache-read 10% + cache-creation 125% multipliers", async () => {
    const { client, insertSpy } = makeMockClient();
    await insertLlmCallFromAiSdkResult(client, {
      ...baseInput,
      session_id: "sess-7",
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        inputTokenDetails: { cacheReadTokens: 500, cacheWriteTokens: 100 },
      } as LanguageModelUsage,
    });
    const row = insertSpy.mock.calls[0]?.[0] as {
      cost_usd: string;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
    // nonCached = 1000 - 500 - 100 = 400.
    // (400 * $5 + 500 * $0.5 + 100 * $6.25 + 200 * $25) / 1M
    //   = (2000 + 250 + 625 + 5000) / 1M
    //   = 7875 / 1M
    //   = $0.007875.
    // 10% on cacheRead ($0.5 vs $5 input) and 125% on cacheWrite ($6.25
    // vs $5 input) are the load-bearing multipliers; both verified by
    // the arithmetic above.
    expect(row.cost_usd).toBe("0.007875");
    expect(row.cache_read_input_tokens).toBe(500);
    expect(row.cache_creation_input_tokens).toBe(100);
  });

  // TODO(post-6b): unknown model should surface louder than silent
  // zero — current behaviour documented here, not endorsed.
  test("(8) unknown model → cost_usd '0.000000' (silent zero)", async () => {
    const { client, insertSpy } = makeMockClient();
    await insertLlmCallFromAiSdkResult(client, {
      ...baseInput,
      session_id: "sess-8",
      model: "claude-future-model-not-in-table",
    });
    const row = insertSpy.mock.calls[0]?.[0] as {
      cost_usd: string;
      model: string;
    };
    expect(row.cost_usd).toBe("0.000000");
    expect(row.model).toBe("claude-future-model-not-in-table");
  });
});
