// Unit tests for lib/debrief/opus-debrief.ts:generateDebrief.
//
// Pure mocking: no real AI SDK calls, no real DB, no real ContextLoader.
// Every error branch in GenerateDebriefErrorKind has its own test, so a
// 6d worker integration that swallows ok:false silently surfaces in the
// failing branch's diff.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { generateDebrief } from "@/lib/debrief/opus-debrief";
import { callOpusObject, OpusCallError } from "@/lib/llm/opus";
import { ContextLoader } from "@/lib/orchestration/context";
import { insertLlmCallFromAiSdkResult } from "@/lib/supabase/llm-calls";
import type { Database } from "@/lib/types/db";

// Mock the Opus client. Import the real OpusCallError class so tests can
// construct error instances callOpusObject would normally throw.
vi.mock("@/lib/llm/opus", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/llm/opus")>("@/lib/llm/opus");
  return { ...actual, callOpusObject: vi.fn() };
});

// Mock ContextLoader as a class — each test sets a per-test buildFor
// behaviour via mockImplementation.
vi.mock("@/lib/orchestration/context", () => ({
  ContextLoader: vi.fn(),
}));

// Mock the llm_calls writer. The internal implementation (PRICE table,
// computeCostUsd, Zod validation of error) is covered by
// lib/supabase/llm-calls.test.ts; here we only care that generateDebrief
// invokes it with the right shape and uses the returned { id }.
vi.mock("@/lib/supabase/llm-calls", () => ({
  insertLlmCallFromAiSdkResult: vi.fn(),
}));

const mockedCallOpusObject = vi.mocked(callOpusObject);
const mockedContextLoader = vi.mocked(ContextLoader);
const mockedInsertLlmCall = vi.mocked(insertLlmCallFromAiSdkResult);

// Mock Supabase client surface: just the .from(table) shape used by
// generateDebrief — sessions SELECT and debriefs INSERT.
function makeMockDb(opts?: {
  session?: { project_id: string; task: string; diff: unknown } | null;
  sessionError?: string;
  debriefId?: string;
  debriefError?: string;
}) {
  const debriefInsertSpy = vi.fn();

  const sessionChain = {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => {
          if (opts?.sessionError) {
            return { data: null, error: { message: opts.sessionError } };
          }
          return { data: opts?.session ?? null, error: null };
        }),
      })),
    })),
  };

  const debriefChain = {
    insert: vi.fn((row: unknown) => {
      debriefInsertSpy(row);
      return {
        select: vi.fn(() => ({
          single: vi.fn(async () => {
            if (opts?.debriefError) {
              return { data: null, error: { message: opts.debriefError } };
            }
            return {
              data: { id: opts?.debriefId ?? "debrief-uuid" },
              error: null,
            };
          }),
        })),
      };
    }),
  };

  const from = vi.fn((table: string) => {
    if (table === "sessions") return sessionChain;
    if (table === "debriefs") return debriefChain;
    throw new Error(`unexpected table: ${table}`);
  });

  const db = { from } as unknown as SupabaseClient<Database>;
  return { db, debriefInsertSpy };
}

// Canonical success result from callOpusObject. Tests override
// individual fields as needed.
const fakeOpusResult = {
  object: {
    what_we_did: "wrote the debrief generator",
    where_this_fits: "Slice 6c",
    why_it_matters: "closes the Direct pipeline learning loop",
    what_went_wrong_or_next: "wire into the worker in 6d",
  },
  text: "{...}",
  // Fully conforming LanguageModelUsage (ai/dist/index.d.ts:267-325) so
  // mockResolvedValueOnce typechecks against OpusObjectCallResult without
  // an `as` cast.
  usage: {
    inputTokens: 1_000,
    inputTokenDetails: {
      noCacheTokens: 200,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    },
    outputTokens: 200,
    outputTokenDetails: { textTokens: 200, reasoningTokens: 0 },
    totalTokens: 1_200,
  },
  finishReason: "stop",
  durationMs: 12_345,
  model: "claude-opus-4-7",
  promptHash: "abc1234567890def",
  requestId: "req-test",
};

const fakeCtx = {
  projectId: "proj-1",
  claudeMd: "# Project",
  specs: [],
  skills: [],
  recentDecisions: [],
  sessionId: "sess-1",
  spec: null,
  priorDebrief: null,
};

function mockCtxLoaderOk(ctx: unknown = fakeCtx) {
  mockedContextLoader.mockImplementation(
    () =>
      ({
        buildFor: vi.fn(async () => ctx),
      }) as unknown as ContextLoader,
  );
}

function mockCtxLoaderThrows(err: Error) {
  mockedContextLoader.mockImplementation(
    () =>
      ({
        buildFor: vi.fn(async () => {
          throw err;
        }),
      }) as unknown as ContextLoader,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateDebrief", () => {
  test("(1) happy path: llm_calls insert precedes debriefs insert; debriefs row carries llm_call_id", async () => {
    const { db, debriefInsertSpy } = makeMockDb({
      session: { project_id: "proj-1", task: "do the thing", diff: null },
      debriefId: "debrief-uuid-1",
    });
    mockCtxLoaderOk();
    mockedCallOpusObject.mockResolvedValueOnce(fakeOpusResult);
    mockedInsertLlmCall.mockResolvedValueOnce({ id: "call-uuid-1" });

    const result = await generateDebrief(db, "sess-1", []);

    expect(result).toEqual({
      ok: true,
      debriefId: "debrief-uuid-1",
      llmCallId: "call-uuid-1",
    });
    expect(mockedInsertLlmCall).toHaveBeenCalledTimes(1);
    expect(debriefInsertSpy).toHaveBeenCalledTimes(1);
    // Vitest's invocationCallOrder gives a strict order across spies —
    // load-bearing assertion for plan §3.1's "llm_calls first" contract.
    const llmOrder = mockedInsertLlmCall.mock.invocationCallOrder[0]!;
    const debriefOrder = debriefInsertSpy.mock.invocationCallOrder[0]!;
    expect(llmOrder).toBeLessThan(debriefOrder);
    const debriefRow = debriefInsertSpy.mock.calls[0]?.[0] as {
      llm_call_id: string;
    };
    expect(debriefRow.llm_call_id).toBe("call-uuid-1");
  });

  test("(2) DB row shape: debriefs insert matches migration 0009 column set", async () => {
    const { db, debriefInsertSpy } = makeMockDb({
      session: { project_id: "proj-2", task: "task text", diff: null },
    });
    mockCtxLoaderOk();
    mockedCallOpusObject.mockResolvedValueOnce(fakeOpusResult);
    mockedInsertLlmCall.mockResolvedValueOnce({ id: "call-uuid-2" });

    await generateDebrief(db, "sess-2", []);

    const row = debriefInsertSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.project_id).toBe("proj-2");
    expect(row.session_id).toBe("sess-2");
    expect(row.plan_stage_id).toBeNull();
    expect(row.debrief_type).toBe("direct");
    expect(row.content).toEqual(fakeOpusResult.object);
    expect(row.llm_call_id).toBe("call-uuid-2");
    expect(row.prompt_version).toBe("v1");
    expect(row.duration_ms).toBe(12_345);
  });

  test("(3) Zod validation failure: writes llm_calls with error subtype 'validation', no debriefs row", async () => {
    const { db, debriefInsertSpy } = makeMockDb({
      session: { project_id: "proj-3", task: "t", diff: null },
    });
    mockCtxLoaderOk();
    const validationErr = new OpusCallError(
      "validation",
      new Error("schema mismatch"),
      "Opus call failed: validation",
    );
    mockedCallOpusObject.mockRejectedValueOnce(validationErr);
    mockedInsertLlmCall.mockResolvedValueOnce({ id: "error-call-1" });

    const result = await generateDebrief(db, "sess-3", []);

    expect(result).toEqual({
      ok: false,
      llmCallId: "error-call-1",
      errorKind: "validation",
      message: "Opus call failed: validation",
    });
    // mock.calls[0][0] is the db arg; the input object is [0][1].
    const errInput = mockedInsertLlmCall.mock.calls[0]?.[1] as {
      error?: { message: string; subtype?: string };
    };
    expect(errInput.error?.subtype).toBe("validation");
    expect(errInput.error?.message).toBe("Opus call failed: validation");
    expect(debriefInsertSpy).not.toHaveBeenCalled();
  });

  test("(4) transport failure (http_5xx after retries): error row written, no debriefs row", async () => {
    const { db, debriefInsertSpy } = makeMockDb({
      session: { project_id: "proj-4", task: "t", diff: null },
    });
    mockCtxLoaderOk();
    const httpErr = new OpusCallError(
      "http_5xx",
      new Error("Service Unavailable"),
      "Opus call failed: http_5xx",
    );
    mockedCallOpusObject.mockRejectedValueOnce(httpErr);
    mockedInsertLlmCall.mockResolvedValueOnce({ id: "error-call-2" });

    const result = await generateDebrief(db, "sess-4", []);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errorKind).toBe("http_5xx");
      expect(result.llmCallId).toBe("error-call-2");
    }
    expect(debriefInsertSpy).not.toHaveBeenCalled();
  });

  test("(5) session not found: errorKind 'session_not_found', no Opus call, no writes", async () => {
    const { db, debriefInsertSpy } = makeMockDb({ session: null });
    // ContextLoader / callOpusObject must NOT be reached.
    mockCtxLoaderThrows(new Error("should not be called"));

    const result = await generateDebrief(db, "sess-missing", []);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errorKind).toBe("session_not_found");
      expect(result.llmCallId).toBeNull();
      expect(result.message).toContain("not found");
    }
    expect(mockedCallOpusObject).not.toHaveBeenCalled();
    expect(mockedInsertLlmCall).not.toHaveBeenCalled();
    expect(debriefInsertSpy).not.toHaveBeenCalled();
  });

  test("(6) both writes carry the same duration_ms", async () => {
    const { db, debriefInsertSpy } = makeMockDb({
      session: { project_id: "proj-6", task: "t", diff: null },
    });
    mockCtxLoaderOk();
    mockedCallOpusObject.mockResolvedValueOnce({
      ...fakeOpusResult,
      durationMs: 7_777,
    });
    mockedInsertLlmCall.mockResolvedValueOnce({ id: "call-uuid-6" });

    await generateDebrief(db, "sess-6", []);

    const llmInput = mockedInsertLlmCall.mock.calls[0]?.[1] as {
      duration_ms: number;
    };
    const debriefRow = debriefInsertSpy.mock.calls[0]?.[0] as {
      duration_ms: number;
    };
    expect(llmInput.duration_ms).toBe(7_777);
    expect(debriefRow.duration_ms).toBe(7_777);
  });

  test("(7) ContextLoader failure: errorKind 'context_load_failed', no Opus call, no writes", async () => {
    const { db, debriefInsertSpy } = makeMockDb({
      session: { project_id: "proj-7", task: "t", diff: null },
    });
    mockCtxLoaderThrows(new Error("ContextLoader: failed to load decisions"));

    const result = await generateDebrief(db, "sess-7", []);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errorKind).toBe("context_load_failed");
      expect(result.llmCallId).toBeNull();
      expect(result.message).toContain("ContextLoader");
    }
    expect(mockedCallOpusObject).not.toHaveBeenCalled();
    expect(mockedInsertLlmCall).not.toHaveBeenCalled();
    expect(debriefInsertSpy).not.toHaveBeenCalled();
  });

  test("(9) sessions SELECT DB error: errorKind 'db_read_failed', no writes (distinct from session_not_found, which is the no-row case)", async () => {
    const { db, debriefInsertSpy } = makeMockDb({
      sessionError: "connection terminated unexpectedly",
    });
    // ContextLoader / callOpusObject must NOT be reached.
    mockCtxLoaderThrows(new Error("should not be called"));

    const result = await generateDebrief(db, "sess-db-err", []);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errorKind).toBe("db_read_failed");
      expect(result.llmCallId).toBeNull();
      expect(result.message).toContain("connection terminated unexpectedly");
    }
    expect(mockedCallOpusObject).not.toHaveBeenCalled();
    expect(mockedInsertLlmCall).not.toHaveBeenCalled();
    expect(debriefInsertSpy).not.toHaveBeenCalled();
  });

  test("(8) debriefs insert fails after llm_calls succeeds: errorKind 'db_write_failed', llmCallId set, orphan acceptable per §3.1", async () => {
    const { db, debriefInsertSpy } = makeMockDb({
      session: { project_id: "proj-8", task: "t", diff: null },
      debriefError: "duplicate key value",
    });
    mockCtxLoaderOk();
    mockedCallOpusObject.mockResolvedValueOnce(fakeOpusResult);
    mockedInsertLlmCall.mockResolvedValueOnce({ id: "orphan-call-1" });

    const result = await generateDebrief(db, "sess-8", []);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.errorKind).toBe("db_write_failed");
      expect(result.llmCallId).toBe("orphan-call-1");
      expect(result.message).toContain("duplicate key value");
    }
    // llm_calls insert DID happen — orphan is acceptable per plan §3.1.
    expect(mockedInsertLlmCall).toHaveBeenCalledTimes(1);
    expect(debriefInsertSpy).toHaveBeenCalledTimes(1);
  });
});
