// Thin Grok wrapper around AI SDK v6's `generateText`. Mirror of
// lib/llm/opus.ts — same shape, different provider. See that file's
// header for the resilience contract.

import { xai } from "@ai-sdk/xai";
import { generateText, type LanguageModelUsage } from "ai";
import { GROK_MODEL } from "@/lib/llm/models";

export type GrokCallInput = {
  prompt: string;
  /** Hard timeout in milliseconds. Aborts the underlying fetch via AbortController. */
  timeoutMs: number;
};

export type GrokCallResult = {
  text: string;
  usage: LanguageModelUsage;
  finishReason: string;
  durationMs: number;
  model: string;
};

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 2_000];

export async function callGrok(input: GrokCallInput): Promise<GrokCallResult> {
  const { prompt, timeoutMs } = input;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const result = await generateText({
        model: xai(GROK_MODEL),
        prompt,
        abortSignal: abort.signal,
      });
      clearTimeout(timer);
      return {
        text: result.text,
        usage: result.usage,
        finishReason: String(result.finishReason),
        durationMs: Date.now() - startedAt,
        model: GROK_MODEL,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      lastErr = err;
      if (is4xx(err)) throw err;
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
