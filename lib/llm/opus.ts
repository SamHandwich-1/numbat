// Opus client module for Numbat.
//
// Two functions during the Slice 6 → Slice 7 transition:
//
//   callOpusObject<TSchema>  — the structured-output, prompt-cached,
//                              structured-logged path. Used by Slice 6's
//                              debrief generator (lib/debrief/opus-debrief.ts)
//                              and by the four Bilby stages in Slice 7.
//
//   callOpus                 — DEPRECATED. Plain text-in / text-out wrapper
//                              retained only for scripts/bilby-dialectic.ts
//                              (the proto-Bilby spike). Slice 7's real Bilby
//                              implementation migrates off this and the
//                              function is then deletable.
//
// Resilience contract per CLAUDE.md "Resilience":
//   - Caller supplies timeoutMs. Wrapper enforces via AbortController.
//   - Max 2 retries on 5xx / network / unknown with exponential backoff (1s, 2s).
//   - No retry on 4xx (caller bugs), validation (bad model output), timeout
//     (the caller chose the budget; another attempt just burns it again).

import { createHash, randomUUID } from "node:crypto";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, type LanguageModelUsage } from "ai";
import pino from "pino";
import type { z } from "zod";
import { OPUS_MODEL } from "@/lib/llm/models";

// Module-level pino instance. Default destination is process.stdout; one
// JSON line per logger.info call. If a second logger consumer arrives in
// a later slice, extract this to lib/logger.ts — no consumer change needed,
// just an import-path move.
const logger = pino();

// ─────────────────────────────────────────────────────────────────────
// callOpusObject — structured output via AI SDK v6 `generateObject`,
// two-part messages (cache-eligible system prefix + per-call user suffix),
// typed errors, structured logging through pino.
// ─────────────────────────────────────────────────────────────────────

export type OpusObjectCallInput<TSchema extends z.ZodTypeAny> = {
  schema: TSchema;
  /** Cache-eligible. System prompt + project bundle. Identical across calls
   *  in the same plan/session so Anthropic caches it for the 5-min TTL. */
  stablePrefix: string;
  /** Per-call dynamic content. promptHash is computed on this only —
   *  identical project bundles must not produce different hashes. */
  dynamicSuffix: string;
  /** Hard timeout in milliseconds. 90s for the debrief site per CLAUDE.md. */
  timeoutMs: number;
  /** Caller-supplied for log correlation; defaults to a fresh uuid. */
  requestId?: string;
};

export type OpusObjectCallResult<T> = {
  object: T;
  /** JSON.stringify of `object` — convenience handle for debugging. */
  text: string;
  usage: LanguageModelUsage;
  finishReason: string;
  durationMs: number;
  model: string;
  /** sha256(dynamicSuffix), first 16 hex chars. */
  promptHash: string;
  requestId: string;
};

export type OpusCallStatus = "success" | OpusCallErrorKind;

export type OpusCallErrorKind =
  | "timeout"
  | "http_4xx"
  | "http_5xx"
  | "network"
  | "validation"
  | "unknown";

export class OpusCallError extends Error {
  constructor(
    readonly kind: OpusCallErrorKind,
    readonly cause: unknown,
    message: string,
  ) {
    super(message);
    this.name = "OpusCallError";
  }
}

const MAX_ATTEMPTS_OBJECT = 3;
const BACKOFF_MS_OBJECT = [1_000, 2_000];

export async function callOpusObject<TSchema extends z.ZodTypeAny>(
  input: OpusObjectCallInput<TSchema>,
): Promise<OpusObjectCallResult<z.infer<TSchema>>> {
  const {
    schema,
    stablePrefix,
    dynamicSuffix,
    timeoutMs,
    requestId: providedRequestId,
  } = input;
  const requestId = providedRequestId ?? randomUUID();
  const promptHash = createHash("sha256")
    .update(dynamicSuffix)
    .digest("hex")
    .slice(0, 16);

  let lastErr: OpusCallError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS_OBJECT; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const result = await generateObject({
        model: anthropic(OPUS_MODEL),
        schema,
        messages: [
          {
            role: "system",
            content: stablePrefix,
            // Note: Opus 4.7 silently no-ops the cache breakpoint if the
            // cached portion is under 4096 tokens (no error, zero cache-
            // creation tokens). If cache fields stay zero across runs
            // within the 5-min TTL, check payload size before debugging
            // header shape.
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral" } },
            },
          },
          { role: "user", content: dynamicSuffix },
        ],
        abortSignal: abort.signal,
      });
      clearTimeout(timer);

      const durationMs = Date.now() - startedAt;
      logOpusCall({
        request_id: requestId,
        model: OPUS_MODEL,
        prompt_hash: promptHash,
        input_tokens: result.usage.inputTokens ?? 0,
        output_tokens: result.usage.outputTokens ?? 0,
        cache_read_tokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cache_creation_tokens:
          result.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        duration_ms: durationMs,
        status: "success",
      });

      return {
        // AI SDK's generateObject infers output<TSchema> from the passed
        // schema; we type the wrapper's return as z.infer<TSchema> so
        // callers get the Zod inference directly. The two are equivalent
        // at runtime (the SDK parses through the same Zod schema) but
        // TypeScript doesn't unify them without this assertion.
        object: result.object as z.infer<TSchema>,
        text: JSON.stringify(result.object),
        usage: result.usage,
        finishReason: String(result.finishReason),
        durationMs,
        model: OPUS_MODEL,
        promptHash,
        requestId,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const kind = classifyError(err, abort.signal.aborted);
      const durationMs = Date.now() - startedAt;
      logOpusCall({
        request_id: requestId,
        model: OPUS_MODEL,
        prompt_hash: promptHash,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        duration_ms: durationMs,
        status: kind,
      });
      lastErr = new OpusCallError(kind, err, `Opus call failed: ${kind}`);

      // No retry on caller bugs, bad model output, or budget exhaustion.
      if (kind === "http_4xx" || kind === "validation" || kind === "timeout") {
        throw lastErr;
      }
      if (attempt === MAX_ATTEMPTS_OBJECT - 1) break;
      await sleep(BACKOFF_MS_OBJECT[attempt] ?? 2_000);
    }
  }
  // Loop fell through after exhausting retries on a retriable error.
  throw lastErr;
}

type OpusLogPayload = {
  request_id: string;
  model: string;
  prompt_hash: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  duration_ms: number;
  status: OpusCallStatus;
};

function logOpusCall(payload: OpusLogPayload): void {
  logger.info(payload);
}

function classifyError(err: unknown, aborted: boolean): OpusCallErrorKind {
  // Order matters: aborted-signal wins over any other classification because
  // a timeout-induced abort can surface as a generic fetch error otherwise.
  if (aborted) return "timeout";
  if (typeof err !== "object" || err === null) return "unknown";

  const name = (err as { name?: string }).name ?? "";
  // generateObject's Zod-validation failures surface as errors whose name
  // includes "NoObjectGenerated" or "TypeValidation" in AI SDK v6. The SDK
  // doesn't re-export the class shape stably across patch releases; name-
  // based detection is the contract. Gate 3 tests pin the behaviour.
  if (name.includes("NoObjectGenerated") || name.includes("TypeValidation")) {
    return "validation";
  }

  const status =
    (err as { statusCode?: number; status?: number }).statusCode ??
    (err as { statusCode?: number; status?: number }).status;
  if (typeof status === "number") {
    if (status >= 400 && status < 500) return "http_4xx";
    if (status >= 500 && status < 600) return "http_5xx";
  }

  if (name === "AbortError") return "timeout";
  if (name === "TypeError" || name === "FetchError") return "network";
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────
// DEPRECATED for new call sites (Slice 6b+): use callOpusObject above
// for the schema + prefix/suffix + caching + structured-log path.
// callOpus is retained only for scripts/bilby-dialectic.ts (the proto-
// Bilby spike) and is deletable in Slice 7 once the real Bilby
// implementation migrates to callOpusObject.
// ─────────────────────────────────────────────────────────────────────

export type OpusCallInput = {
  prompt: string;
  /** Hard timeout in milliseconds. Aborts the underlying fetch via AbortController. */
  timeoutMs: number;
};

export type OpusCallResult = {
  text: string;
  usage: LanguageModelUsage;
  finishReason: string;
  durationMs: number;
  model: string;
};

/** Two retries (3 total attempts), exponential backoff. */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 2_000];

export async function callOpus(input: OpusCallInput): Promise<OpusCallResult> {
  const { prompt, timeoutMs } = input;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const result = await generateText({
        model: anthropic(OPUS_MODEL),
        prompt,
        abortSignal: abort.signal,
      });
      clearTimeout(timer);
      return {
        text: result.text,
        usage: result.usage,
        finishReason: String(result.finishReason),
        durationMs: Date.now() - startedAt,
        model: OPUS_MODEL,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      lastErr = err;
      // Don't retry on 4xx — those are caller bugs (auth, payload shape).
      if (is4xx(err)) throw err;
      // Don't retry the final attempt — fall through to throw below.
      if (attempt === MAX_ATTEMPTS - 1) break;
      await sleep(BACKOFF_MS[attempt] ?? 2_000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function is4xx(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { statusCode?: number; status?: number }).statusCode
    ?? (err as { statusCode?: number; status?: number }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}

// ─────────────────────────────────────────────────────────────────────
// Slice 7 (Bilby) call-site stubs — NOT YET WIRED. Documented here to
// confirm callOpusObject's interface generalises across the four stages.
// ─────────────────────────────────────────────────────────────────────

// Slice 7 (Bilby) — draft stage. Opus. NOT YET WIRED.
//
//   const DraftSchema = z.object({
//     plan_markdown: z.string(),
//     open_questions: z.array(z.string()),
//   });
//
//   await callOpusObject({
//     schema: DraftSchema,
//     stablePrefix: renderProjectBundle(ctx) + DRAFT_SYSTEM_PROMPT,
//     dynamicSuffix: renderBrief(brief),
//     timeoutMs: 90_000,
//   });

// Slice 7 (Bilby) — consider stage. Opus. NOT YET WIRED.
//
//   const ConsiderSchema = z.object({
//     plan_markdown: z.string(),
//     accepted_points: z.array(z.string()),
//     rejected_points: z.array(z.object({ point: z.string(), reason: z.string() })),
//   });
//
//   await callOpusObject({
//     schema: ConsiderSchema,
//     stablePrefix: renderProjectBundle(ctx) + CONSIDER_SYSTEM_PROMPT,
//     dynamicSuffix: renderBrief(brief) + renderDraft(draft) + renderCritique(critique),
//     timeoutMs: 90_000,
//   });

// Slice 7 (Bilby) — critique stage runs on Grok (cross-family critique
// per the bootstrap dialectic's calibration). The mirror entry point
// (callGrokObject) lands in lib/llm/grok.ts in Slice 7 with the
// CritiqueSchema sketched there.

// Slice 7 (Bilby) — validate stage also Grok. Same callGrokObject mirror;
// ValidateSchema sketched alongside CritiqueSchema in grok.ts.
