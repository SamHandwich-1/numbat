// Unit tests for lib/llm/opus.ts:callOpusObject — the structured-output
// Opus wrapper used by Slice 6's debrief generator and Slice 7's Bilby
// stages. Pure mocking: no real AI SDK calls, no real DB, no real pino
// destination. The shape of the 10 tests mirrors the Slice 6b proposal's
// Gate 3 list.

import { describe, test, expect, vi, beforeEach } from "vitest";
import { generateObject } from "ai";
import { z } from "zod";

import { callOpusObject, OpusCallError } from "@/lib/llm/opus";

// pino mock via vi.hoisted — infoSpy is module-scoped and inspectable
// from every test, and the hoisting ensures the mock factory closes over
// the same spy the tests will assert against.
const { infoSpy } = vi.hoisted(() => ({ infoSpy: vi.fn() }));

// vi.mock calls are hoisted by the vitest transformer above any imports
// in this file, so the static imports above resolve to the mocked
// modules at module-load time. This is the pattern documented at
// https://vitest.dev/api/vi.html#vi-mock — appearance-order in source
// does not match execution order for these calls.
vi.mock("pino", () => ({
  default: () => ({ info: infoSpy }),
}));

// The anthropic() constructor is a no-op in tests — its return value is
// passed to generateObject which is itself mocked, so the model object's
// shape doesn't matter beyond being truthy.
vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: vi.fn((modelId: string) => ({ modelId, __mocked: true })),
}));

// generateObject is the load-bearing mock. Each test sets up its own
// mockResolvedValueOnce / mockRejectedValueOnce queue.
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

const mockedGenerateObject = vi.mocked(generateObject);

// A minimal Zod schema reused across the happy-path and validation tests.
const DebriefShapeSchema = z.object({
  what_we_did: z.string(),
  why_it_matters: z.string(),
});

// Shared usage shape — most tests don't care about token counts, but the
// `result.usage` field is read by the wrapper for the log line.
const fakeUsage = {
  inputTokens: 100,
  outputTokens: 50,
  inputTokenDetails: {
    cacheReadTokens: 10,
    cacheWriteTokens: 20,
  },
};

// Convenience builder for a successful generateObject result. The cast
// at the boundary covers the test-only fields generateObject populates
// (reasoning, warnings, request, response, etc.) that the wrapper never
// reads — only `object`, `usage`, and `finishReason` are consumed.
function okResult(object: unknown): Awaited<ReturnType<typeof generateObject>> {
  return {
    object,
    usage: fakeUsage,
    finishReason: "stop",
  } as unknown as Awaited<ReturnType<typeof generateObject>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // vi.clearAllMocks doesn't reset timers or fake-time state; tests
  // that use vi.useFakeTimers() restore at the end of their own block.
});

describe("callOpusObject", () => {
  test("(1) returns Zod-validated object on happy path", async () => {
    const happy = { what_we_did: "x", why_it_matters: "y" };
    mockedGenerateObject.mockResolvedValueOnce(okResult(happy));

    const result = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "system + project bundle",
      dynamicSuffix: "task + diff",
      timeoutMs: 90_000,
    });

    expect(result.object).toEqual(happy);
    expect(result.model).toBe("claude-opus-4-7");
    expect(result.usage).toBe(fakeUsage);
    expect(result.finishReason).toBe("stop");
    expect(typeof result.promptHash).toBe("string");
    expect(result.promptHash).toHaveLength(16);
    expect(typeof result.requestId).toBe("string");
    expect(result.requestId.length).toBeGreaterThan(0);
  });

  test("(2) throws OpusCallError(kind: 'validation') when generateObject surfaces a Zod failure", async () => {
    // The AI SDK throws errors whose `name` includes "NoObjectGenerated"
    // or "TypeValidation" when the model output doesn't match the schema.
    // Name-based detection is the contract per the classifyError comment.
    const validationErr = Object.assign(new Error("schema mismatch"), {
      name: "AI_NoObjectGeneratedError",
    });
    mockedGenerateObject.mockRejectedValueOnce(validationErr);

    const caught = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "pfx",
      dynamicSuffix: "sfx",
      timeoutMs: 90_000,
    }).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(OpusCallError);
    expect((caught as OpusCallError).kind).toBe("validation");
    // Validation failures are not retried — single call.
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
  });

  test("(3) promptHash is deterministic over identical dynamicSuffix", async () => {
    mockedGenerateObject.mockResolvedValue(
      okResult({ what_we_did: "a", why_it_matters: "b" }),
    );

    const r1 = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "any-prefix-1",
      dynamicSuffix: "stable suffix content",
      timeoutMs: 1_000,
    });
    const r2 = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "any-prefix-1",
      dynamicSuffix: "stable suffix content",
      timeoutMs: 1_000,
    });

    expect(r1.promptHash).toBe(r2.promptHash);
  });

  test("(4) promptHash is independent of stablePrefix (load-bearing for cache architecture)", async () => {
    mockedGenerateObject.mockResolvedValue(
      okResult({ what_we_did: "a", why_it_matters: "b" }),
    );

    const r1 = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "completely different prefix A",
      dynamicSuffix: "shared suffix",
      timeoutMs: 1_000,
    });
    const r2 = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "different again B",
      dynamicSuffix: "shared suffix",
      timeoutMs: 1_000,
    });

    // The prompt_hash on llm_calls is the cache-dedup key; identical
    // project bundles must not produce different hashes. This assertion
    // is what makes the two-part prompt structure honest.
    expect(r1.promptHash).toBe(r2.promptHash);
  });

  test("(5) stablePrefix is passed as system message with anthropic cache-control marker", async () => {
    mockedGenerateObject.mockResolvedValueOnce(
      okResult({ what_we_did: "a", why_it_matters: "b" }),
    );

    await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "THE STABLE PREFIX",
      dynamicSuffix: "THE DYNAMIC SUFFIX",
      timeoutMs: 1_000,
    });

    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
    const callArgs = mockedGenerateObject.mock.calls[0]?.[0] as {
      messages: Array<{
        role: string;
        content: string;
        providerOptions?: { anthropic?: { cacheControl?: { type: string } } };
      }>;
    };
    expect(callArgs.messages).toHaveLength(2);
    expect(callArgs.messages[0]?.role).toBe("system");
    expect(callArgs.messages[0]?.content).toBe("THE STABLE PREFIX");
    expect(callArgs.messages[0]?.providerOptions?.anthropic?.cacheControl).toEqual({
      type: "ephemeral",
    });
    expect(callArgs.messages[1]?.role).toBe("user");
    expect(callArgs.messages[1]?.content).toBe("THE DYNAMIC SUFFIX");
  });

  test("(6) 4xx error throws OpusCallError(kind: 'http_4xx') without retry", async () => {
    const httpErr = Object.assign(new Error("Bad Request"), {
      name: "APICallError",
      statusCode: 401,
    });
    mockedGenerateObject.mockRejectedValueOnce(httpErr);

    const caught = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "pfx",
      dynamicSuffix: "sfx",
      timeoutMs: 1_000,
    }).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(OpusCallError);
    expect((caught as OpusCallError).kind).toBe("http_4xx");
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
  });

  test("(7) 5xx errors retry twice (3 attempts total) then throw OpusCallError(kind: 'http_5xx')", async () => {
    vi.useFakeTimers();
    try {
      const httpErr = Object.assign(new Error("Service Unavailable"), {
        name: "APICallError",
        statusCode: 503,
      });
      mockedGenerateObject.mockRejectedValue(httpErr);

      const promise = callOpusObject({
        schema: DebriefShapeSchema,
        stablePrefix: "pfx",
        dynamicSuffix: "sfx",
        timeoutMs: 60_000,
      });
      // Catch upfront so the rejection doesn't surface as unhandled
      // while we advance through the backoffs.
      const caughtPromise = promise.catch((e: unknown) => e);

      // Advance through both backoff waits (1s + 2s = 3s total).
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);

      const caught = await caughtPromise;
      expect(caught).toBeInstanceOf(OpusCallError);
      expect((caught as OpusCallError).kind).toBe("http_5xx");
      expect(mockedGenerateObject).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("(8) AbortError surfaces as OpusCallError(kind: 'timeout')", async () => {
    const abortErr = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    mockedGenerateObject.mockRejectedValueOnce(abortErr);

    const caught = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "pfx",
      dynamicSuffix: "sfx",
      timeoutMs: 1_000,
    }).catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(OpusCallError);
    expect((caught as OpusCallError).kind).toBe("timeout");
    // Timeouts are not retried — the caller chose the budget.
    expect(mockedGenerateObject).toHaveBeenCalledTimes(1);
  });

  test("(9) structured log line is emitted per call with all expected fields", async () => {
    mockedGenerateObject.mockResolvedValueOnce(
      okResult({ what_we_did: "a", why_it_matters: "b" }),
    );

    await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "pfx",
      dynamicSuffix: "sfx",
      timeoutMs: 90_000,
      requestId: "fixed-test-id",
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const payload = infoSpy.mock.calls[0]?.[0] as Record<string, unknown>;

    // All nine fields per the Slice 6 plan §2 fold-in.
    expect(payload).toHaveProperty("request_id", "fixed-test-id");
    expect(payload).toHaveProperty("model", "claude-opus-4-7");
    expect(payload).toHaveProperty("prompt_hash");
    expect(typeof payload.prompt_hash).toBe("string");
    expect(payload).toHaveProperty("input_tokens", 100);
    expect(payload).toHaveProperty("output_tokens", 50);
    expect(payload).toHaveProperty("cache_read_tokens", 10);
    expect(payload).toHaveProperty("cache_creation_tokens", 20);
    expect(payload).toHaveProperty("duration_ms");
    expect(typeof payload.duration_ms).toBe("number");
    expect(payload).toHaveProperty("status", "success");
  });

  test("(10) requestId from input is used in the log; falls back to a fresh uuid when omitted", async () => {
    mockedGenerateObject.mockResolvedValue(
      okResult({ what_we_did: "a", why_it_matters: "b" }),
    );

    // Caller-supplied requestId echoes through.
    const r1 = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "pfx",
      dynamicSuffix: "sfx",
      timeoutMs: 1_000,
      requestId: "caller-supplied-id-abc123",
    });
    expect(r1.requestId).toBe("caller-supplied-id-abc123");
    const payload1 = infoSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload1.request_id).toBe("caller-supplied-id-abc123");

    // Omitting requestId yields a fresh uuid each call.
    const r2 = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "pfx",
      dynamicSuffix: "sfx",
      timeoutMs: 1_000,
    });
    const r3 = await callOpusObject({
      schema: DebriefShapeSchema,
      stablePrefix: "pfx",
      dynamicSuffix: "sfx",
      timeoutMs: 1_000,
    });
    // Loose uuid shape check: non-empty string, distinct across calls.
    expect(typeof r2.requestId).toBe("string");
    expect(r2.requestId.length).toBeGreaterThan(0);
    expect(r2.requestId).not.toBe(r3.requestId);
    expect(r2.requestId).not.toBe("caller-supplied-id-abc123");
  });
});
