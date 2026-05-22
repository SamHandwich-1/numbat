// Thin Opus wrapper around AI SDK v6's `generateText`. Returns the four
// fields the Bilby dialectic (and any future Opus caller) needs to write
// a complete plan_stages row + llm_calls row.
//
// Resilience contract per CLAUDE.md "Resilience":
//   - Caller supplies timeoutMs. Wrapper enforces via AbortController.
//   - Max 2 retries on network errors with exponential backoff (1s, 2s).
//   - No retry on 4xx — those are caller bugs (auth, payload shape).
//
// The wrapper is intentionally minimal. Anything richer (streaming,
// tool calls, structured output) gets its own helper when a slice needs
// it; this one is for plain text-in / text-out.

import { anthropic } from "@ai-sdk/anthropic";
import { generateText, type LanguageModelUsage } from "ai";
import { OPUS_MODEL } from "@/lib/llm/models";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
