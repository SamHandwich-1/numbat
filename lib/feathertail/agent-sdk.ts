// lib/feathertail/agent-sdk.ts — thin wrapper around `query()` from
// @anthropic-ai/claude-agent-sdk plus event-classification helpers
// consumed by scripts/session-runner.ts.
//
// API surface verified against the installed SDK on 16 May 2026 — see
// docs/sdk-audit-2026-05-16.md for the full audit. Six checkpoints
// passed; the only material drift was on the tool-restriction shape,
// resolved in lib/feathertail/permissions.ts.
//
// Notes from the audit worth keeping next to this file:
// - `Query` extends AsyncGenerator<SDKMessage, void>; iterate with `for await`.
// - `Query.interrupt()` returns Promise<void>; `Query.close()` is synchronous
//   (returns plain `void`, not Promise<void>). The kill flow awaits interrupt,
//   waits up to 5s for a result, then calls close() — no await needed.
// - settingSources: ['project'] makes the SDK read the source repo's CLAUDE.md
//   from the worktree cwd. ContextLoader is the only path for per-project
//   context per CLAUDE.md.

import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { getPermissionConfig } from "@/lib/feathertail/permissions";

export type AgentSessionInput = {
  /** sessions.task verbatim — V1 sends the brief unchanged. */
  prompt: string;
  /** Absolute path to the worktree directory. */
  cwd: string;
  /** Allows the parent worker to abort the underlying subprocess. */
  abortController: AbortController;
};

/**
 * Start a Claude Agent SDK session against a worktree.
 *
 * Returns the Query handle so the worker can iterate the AsyncGenerator
 * and (on operator kill) call interrupt() / close().
 *
 * Options assembly:
 * - cwd + abortController from the caller.
 * - settingSources: ['project'] so the source repo's CLAUDE.md applies.
 * - Permission fields are spread from getPermissionConfig() — frozen by
 *   the §0a-bis decision.
 */
export function startAgentSession(input: AgentSessionInput): Query {
  return query({
    prompt: input.prompt,
    options: {
      cwd: input.cwd,
      settingSources: ["project"],
      abortController: input.abortController,
      ...getPermissionConfig(),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Event classification helpers — type guards used by the worker's
// for-await loop. SDKMessage is a wide union; the worker only acts on
// terminal results and tool-use intent. Unrecognised messages flow
// through unchanged (the memo's "ignore unrecognised types safely" rule).
// ─────────────────────────────────────────────────────────────────────

type ResultMessage = Extract<SDKMessage, { type: "result" }>;
type AssistantMessage = Extract<SDKMessage, { type: "assistant" }>;

/**
 * True on a successful session completion. Worker reacts by capturing
 * the diff, fanning out llm_calls, and transitioning the session to
 * awaiting_review.
 */
export function isResultSuccess(
  m: SDKMessage,
): m is Extract<ResultMessage, { subtype: "success" }> {
  return m.type === "result" && (m as ResultMessage).subtype === "success";
}

/**
 * True on a non-success result (error_during_execution / error_max_turns /
 * error_max_budget_usd / error_max_structured_output_retries). Worker
 * reacts by transitioning the session to `blocked` with a structured
 * last_error.
 *
 * Includes the partial-cost path on operator interrupt — per the spike
 * memo, interrupt() still produces a `result` message with
 * `terminal_reason: 'aborted_streaming'`. That arrives as either a
 * success or an error variant depending on SDK semantics; the worker's
 * status flip is gated by current sessions.status (which is 'killing'
 * by then), so both paths converge on transitionToKilled.
 */
export function isResultError(
  m: SDKMessage,
): m is Exclude<ResultMessage, { subtype: "success" }> {
  return m.type === "result" && (m as ResultMessage).subtype !== "success";
}

type ToolUseBlock = {
  type: "tool_use";
  name: string;
  input?: Record<string, unknown>;
};

/**
 * Extract a file-edit path from an assistant message's tool_use blocks,
 * if present. Used to update sessions.current_step opportunistically
 * during streaming so the Sessions list shows "Editing src/foo.ts…"
 * as the agent works.
 *
 * Returns null if the message is not an assistant message, has no
 * recognisable tool_use blocks, or the tool isn't Edit/Write/MultiEdit.
 * The function walks the structure defensively — BetaMessage is from
 * @anthropic-ai/sdk and we don't want a transitive import dependency
 * for an opportunistic UI signal.
 */
export function extractToolUsePath(m: SDKMessage): string | null {
  if (m.type !== "assistant") return null;
  // SDKAssistantMessage.message is a BetaMessage from @anthropic-ai/sdk
  // with `content: ContentBlock[]`. Walk it defensively — if the shape
  // ever shifts, this returns null and the worker continues without
  // the step-indicator update.
  const message: unknown = (m as AssistantMessage).message;
  if (!isObject(message)) return null;
  const content: unknown = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!isObject(block)) continue;
    if ((block as ToolUseBlock).type !== "tool_use") continue;
    const tool = (block as ToolUseBlock).name;
    if (tool !== "Edit" && tool !== "Write" && tool !== "MultiEdit") {
      continue;
    }
    const input = (block as ToolUseBlock).input;
    if (!isObject(input)) continue;
    const filePath = (input as { file_path?: unknown }).file_path;
    if (typeof filePath === "string" && filePath.length > 0) {
      return filePath;
    }
  }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
