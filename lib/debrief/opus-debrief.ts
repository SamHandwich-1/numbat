// Slice 6c — Opus debrief generator.
//
// Wires the Slice 6a ContextLoader, the Slice 6b Opus client
// (callOpusObject), and the widened llm_calls writer
// (insertLlmCallFromAiSdkResult) into the four-section debrief that
// lands at the end of every Direct session.
//
// Invoked from two places:
//   - scripts/session-runner.ts (the live worker — wired in Slice 6d,
//     between captureDiff/insertLlmCallsFromModelUsage and
//     transitionToAwaitingReview);
//   - scripts/generate-debrief.ts (CLI replay path, this slice).
//
// Write order on success: llm_calls first (returns { id }), then
// debriefs with llm_call_id set. Failure to write debriefs after a
// successful llm_calls write leaves an orphan llm_calls row — harmless
// per plan 0013 §3.1 ("still an accurate accounting record").
//
// Failure mode is typed-error-return (per CLAUDE.md error rules), not
// throw. Worker callers in 6d treat { ok: false } as a soft fail and
// continue to transitionToAwaitingReview regardless — plan §3.1's
// "fails open."

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { LanguageModelUsage } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ContextLoader, type SessionContext } from "@/lib/orchestration/context";
import { OPUS_MODEL } from "@/lib/llm/models";
import {
  callOpusObject,
  OpusCallError,
  type OpusCallErrorKind,
  type OpusObjectCallResult,
} from "@/lib/llm/opus";
import {
  buildDynamicSuffix,
  buildStablePrefix,
  OPUS_DEBRIEF_PROMPT_VERSION,
} from "@/lib/llm/prompts/opus-debrief";
import { insertLlmCallFromAiSdkResult } from "@/lib/supabase/llm-calls";
import {
  DirectDebriefSchema,
  type DirectDebriefT,
} from "@/lib/types/debrief";
import type { Database, DebriefInsert } from "@/lib/types/db";

// Hard timeout per CLAUDE.md "Resilience" line 75 (aeb55bf, 27 May 2026):
// "Opus debrief 90s". Override of the 60s default; rationale in
// docs/decisions/0013-slice-6-plan.md §3.1 — debrief runs after user-
// visible work is complete, so a few seconds of background patience is
// free and 60s would have produced an avoidable ~1–2% timeout rate.
const DEBRIEF_TIMEOUT_MS = 90_000;

export type GenerateDebriefErrorKind =
  | OpusCallErrorKind
  | "session_not_found"
  | "db_read_failed"
  | "context_load_failed"
  | "db_write_failed";

export type GenerateDebriefResult =
  | { ok: true; debriefId: string; llmCallId: string }
  | {
      ok: false;
      llmCallId: string | null;
      errorKind: GenerateDebriefErrorKind;
      message: string;
    };

export async function generateDebrief(
  db: SupabaseClient<Database>,
  sessionId: string,
  messages: readonly SDKMessage[],
): Promise<GenerateDebriefResult> {
  // 1. Load the session's project_id, task, diff. Direct read because
  //    these fields don't belong in ContextLoader (per plan §3.1: "task
  //    and diff come from the session row directly, not through the
  //    loader"). project_id is also used to scope the ContextLoader
  //    call below; deriving it from the session row makes a cross-
  //    project read structurally impossible.
  const { data: session, error: sessionErr } = await db
    .from("sessions")
    .select("project_id, task, diff")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionErr) {
    // maybeSingle() returns { error } only on a real DB failure (transient
    // connection, RLS denial, etc.); a no-row hit returns data:null with
    // error:null. So a sessionErr here is a read failure, not a missing
    // row — surface it as the symmetric counterpart of db_write_failed.
    return {
      ok: false,
      llmCallId: null,
      errorKind: "db_read_failed",
      message: `generateDebrief: failed to load session ${sessionId}: ${sessionErr.message}`,
    };
  }
  if (!session) {
    return {
      ok: false,
      llmCallId: null,
      errorKind: "session_not_found",
      message: `generateDebrief: session ${sessionId} not found`,
    };
  }

  // 2. Project bundle + skills + spec + priorDebrief via ContextLoader.
  //    Its internal cross-project assertion runs before any data fan-out;
  //    a wrong projectId would throw ContextLoaderCrossProjectError.
  //    Here we just derived projectId from the session row, so the
  //    assertion is structurally trivial — but we catch any other
  //    loader failure (DB hiccup, fan-out throw) and surface it.
  //
  //    The 'session' overload of buildFor returns Promise<SessionContext>,
  //    but `ReturnType<ContextLoader["buildFor"]>` resolves to the last
  //    declared overload (PlanContext), so we type ctx explicitly.
  let ctx: SessionContext;
  try {
    ctx = await new ContextLoader(db).buildFor(
      session.project_id,
      "session",
      sessionId,
    );
  } catch (err: unknown) {
    return {
      ok: false,
      llmCallId: null,
      errorKind: "context_load_failed",
      message: `generateDebrief: ContextLoader failed for session ${sessionId}: ${describe(err)}`,
    };
  }

  // 3. Compose the two-part prompt. Hash-stable project bundle in the
  //    prefix; per-call session data in the suffix.
  const stablePrefix = buildStablePrefix({
    claudeMd: ctx.claudeMd,
    recentDecisions: ctx.recentDecisions,
    specs: ctx.specs,
    skills: ctx.skills,
  });
  const dynamicSuffix = buildDynamicSuffix({
    task: session.task,
    diff: session.diff,
    messages,
    spec: ctx.spec,
    priorDebrief: ctx.priorDebrief,
  });

  // 4. Opus call. Throws OpusCallError on every failure mode (timeout,
  //    4xx, 5xx after retries, network after retries, validation,
  //    unknown). All retry policy lives inside callOpusObject.
  let opusResult: OpusObjectCallResult<DirectDebriefT>;
  try {
    opusResult = await callOpusObject({
      schema: DirectDebriefSchema,
      stablePrefix,
      dynamicSuffix,
      timeoutMs: DEBRIEF_TIMEOUT_MS,
    });
  } catch (err: unknown) {
    // Failure path: write the llm_calls audit row with error populated,
    // no debriefs row. The OpusCallError carries the classified kind
    // from callOpusObject.classifyError.
    const errorKind: OpusCallErrorKind =
      err instanceof OpusCallError ? err.kind : "unknown";
    const message = err instanceof Error ? err.message : String(err);
    const errorCallId = await writeErrorLlmCall(db, {
      project_id: session.project_id,
      session_id: sessionId,
      errorKind,
      errorMessage: message,
    });
    return { ok: false, llmCallId: errorCallId, errorKind, message };
  }

  // 5. Success path: llm_calls row first. The widened writer (Slice 6b
  //    Gate 4) accepts session_id and returns { id } so we can reference
  //    the row from the debriefs insert below.
  let llmCallId: string;
  try {
    const inserted = await insertLlmCallFromAiSdkResult(db, {
      project_id: session.project_id,
      session_id: sessionId,
      provider: "anthropic",
      model: opusResult.model,
      usage: opusResult.usage,
      duration_ms: opusResult.durationMs,
      prompt_hash: opusResult.promptHash,
    });
    llmCallId = inserted.id;
  } catch (err: unknown) {
    // Opus succeeded but the audit row didn't persist. Don't write
    // debriefs without a billable row referenced from it; surface as
    // db_write_failed. No partial state to clean up.
    return {
      ok: false,
      llmCallId: null,
      errorKind: "db_write_failed",
      message: `generateDebrief: llm_calls insert failed: ${describe(err)}`,
    };
  }

  // 6. Debriefs row referencing the llm_calls row. If this throws, the
  //    llm_calls row becomes an orphan — harmless per plan §3.1.
  const debriefRow: DebriefInsert = {
    project_id: session.project_id,
    session_id: sessionId,
    plan_stage_id: null,
    debrief_type: "direct",
    content: opusResult.object,
    llm_call_id: llmCallId,
    prompt_version: OPUS_DEBRIEF_PROMPT_VERSION,
    duration_ms: opusResult.durationMs,
  };
  const { data: insertedDebrief, error: debriefErr } = await db
    .from("debriefs")
    .insert(debriefRow)
    .select("id")
    .single();
  if (debriefErr || !insertedDebrief) {
    return {
      ok: false,
      llmCallId,
      errorKind: "db_write_failed",
      message: `generateDebrief: debriefs insert failed: ${debriefErr?.message ?? "no row returned"}`,
    };
  }

  return { ok: true, debriefId: insertedDebrief.id, llmCallId };
}

// Zero-usage placeholder for the failure-path llm_calls row. The wrapper
// throws on any failure mode without exposing partial usage info, so we
// audit the call as billable-but-empty. cost_usd then computes to 0,
// which is honest for "the call did not complete."
//
// Fully conforms to LanguageModelUsage (ai/dist/index.d.ts:267-325) so
// no cast is needed — every required field present, every value 0 (not
// undefined) so computeCostUsd's `?? 0` fallbacks never have to fire.
const ZERO_USAGE: LanguageModelUsage = {
  inputTokens: 0,
  inputTokenDetails: {
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 0,
  outputTokenDetails: {
    textTokens: 0,
    reasoningTokens: 0,
  },
  totalTokens: 0,
};

async function writeErrorLlmCall(
  db: SupabaseClient<Database>,
  args: {
    project_id: string;
    session_id: string;
    errorKind: OpusCallErrorKind;
    errorMessage: string;
  },
): Promise<string | null> {
  try {
    const inserted = await insertLlmCallFromAiSdkResult(db, {
      project_id: args.project_id,
      session_id: args.session_id,
      provider: "anthropic",
      model: OPUS_MODEL,
      usage: ZERO_USAGE,
      duration_ms: 0,
      error: { message: args.errorMessage, subtype: args.errorKind },
    });
    return inserted.id;
  } catch {
    // Best-effort. If even the error row write fails, return null and
    // let the caller surface the original Opus failure in `message`.
    return null;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
