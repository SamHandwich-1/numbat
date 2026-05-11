import { afterEach, describe, expect, test } from "vitest";

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
