// Prompt module for the Opus debrief generator (Slice 6c).
//
// Two-part structure to match callOpusObject's cache architecture
// (lib/llm/opus.ts, established in Slice 6b):
//
//   buildStablePrefix(...)  — system instruction + project bundle.
//     Project-scoped only. Identical across every Opus call within the
//     project so Anthropic caches it for the 5-min TTL window. Hash-
//     stable: no timestamps, no per-call data, no session-scoped fields.
//     Slice 7's four Bilby stages share the same prefix shape, so the
//     cache hit pays off across both pipelines.
//
//   buildDynamicSuffix(...) — session-scoped data + closing instruction.
//     Varies per call. The promptHash recorded on the llm_calls row is
//     computed over this only (callOpusObject's behaviour, asserted by
//     lib/llm/opus.test.ts test 4) — identical project bundles must not
//     produce different hashes.
//
// Field-name reconciliation: the optional new_concept block uses
// { title, body } per DebriefContent in lib/types/jsonb.ts:211-214 and
// the production page render at app/sessions/[sessionId]/page.tsx:152-156.
// Plan 0013 §3.1 sketched { name, definition }; resolved per 0015 §2's
// "existing convention wins" — DirectDebriefSchema is re-exported from
// lib/types/debrief.ts, and the instruction text below uses the live
// field names.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Debrief, Decision, Skill, Spec } from "@/lib/types/db";
import type { WorktreeDiffT } from "@/lib/types/jsonb";

export const OPUS_DEBRIEF_PROMPT_VERSION = "v1" as const;

const SYSTEM_INSTRUCTION = `You are Opus, generating a Numbat session debrief.

A Numbat session is one run of the Claude Agent SDK against a project worktree, driven by a single task. Your job: produce a four-section structured debrief that the operator (James) reads in the Diff & Review surface.

Output schema (strict — validated by Zod at the SDK boundary):

  what_we_did              — single non-empty string. What the session actually did, grounded in the captured diff and message transcript. Past tense.
  where_this_fits          — single non-empty string. How this work relates to the project's current slice, decisions, or specs. Cross-reference the project bundle.
  why_it_matters           — single non-empty string. The honest "why" — what does this unblock, prevent, or clarify?
  what_went_wrong_or_next  — single non-empty string. Anything that didn't go to plan, or the natural next step. Be specific.
  new_concept (optional)   — { title, body }. Only include when this session genuinely introduced a new abstraction, term, or convention worth capturing for the project glossary. If nothing fits, omit the field entirely (do not include a placeholder).

Rules:
- Each of the four required strings is a single coherent paragraph (not a list, not a heading + body).
- Ground every claim in the diff or the message transcript — do not invent.
- Use the project bundle for context, not for content. The debrief is about this session, not the project at large.
- If new_concept genuinely applies, the title is a short noun phrase (1–5 words); the body is 1–3 sentences defining it.`;

export type StablePrefixInput = {
  claudeMd: string | null;
  recentDecisions: readonly Decision[];
  specs: readonly Spec[];
  skills: readonly Skill[];
};

export function buildStablePrefix(input: StablePrefixInput): string {
  const sections: string[] = [SYSTEM_INSTRUCTION, ""];

  sections.push("## Project context (CLAUDE.md)");
  sections.push(input.claudeMd ?? "(no CLAUDE.md on file for this project)");
  sections.push("");

  sections.push("## Active specs");
  if (input.specs.length === 0) {
    sections.push("(no active specs)");
  } else {
    for (const spec of input.specs) {
      sections.push(`- ${spec.id} — ${spec.goal}`);
    }
  }
  sections.push("");

  sections.push("## Skills");
  if (input.skills.length === 0) {
    sections.push("(no skills registered for this project)");
  } else {
    for (const skill of input.skills) {
      const desc = skill.description ? ` — ${skill.description}` : "";
      sections.push(`- ${skill.name}${desc}`);
    }
  }
  sections.push("");

  sections.push("## Recent decisions (last 30)");
  if (input.recentDecisions.length === 0) {
    sections.push("(no decisions on record for this project)");
  } else {
    for (const d of input.recentDecisions) {
      // Compact one-line summary. payload.note / payload.reason are not
      // stable enough to render here — created_at + type + id is the
      // cache-stable summary across decision shapes.
      sections.push(`- ${d.created_at} · ${d.type} (${d.id})`);
    }
  }

  return sections.join("\n");
}

export type DynamicSuffixInput = {
  task: string;
  diff: WorktreeDiffT | null;
  messages: readonly SDKMessage[];
  spec: Spec | null;
  priorDebrief: Debrief | null;
};

export function buildDynamicSuffix(input: DynamicSuffixInput): string {
  const sections: string[] = [];

  sections.push("## Session task");
  sections.push(input.task);
  sections.push("");

  if (input.spec !== null) {
    sections.push("## Session spec");
    sections.push(`Goal: ${input.spec.goal}`);
    if (input.spec.out_of_scope !== null) {
      sections.push(`Out of scope: ${input.spec.out_of_scope}`);
    }
    sections.push("");
  }

  if (input.priorDebrief !== null) {
    sections.push("## Prior debrief (most recent for this session)");
    sections.push(JSON.stringify(input.priorDebrief.content, null, 2));
    sections.push("");
  }

  sections.push("## Captured diff");
  sections.push(renderDiff(input.diff));
  sections.push("");

  sections.push("## Agent SDK message transcript");
  sections.push(renderMessageTranscript(input.messages));
  sections.push("");

  sections.push(
    "Now produce the debrief object. Strict schema; no commentary outside the object.",
  );

  return sections.join("\n");
}

function renderDiff(diff: WorktreeDiffT | null): string {
  if (!diff || diff.files.length === 0) {
    return "(no diff captured)";
  }
  const lines: string[] = [];
  const { files_changed, additions, deletions } = diff.totals;
  lines.push(
    `${files_changed} file${files_changed === 1 ? "" : "s"} changed, +${additions} / -${deletions}`,
  );
  lines.push("");
  for (const f of diff.files) {
    lines.push(
      `### ${f.status} — ${f.path}  (+${f.additions} / -${f.deletions})`,
    );
    if (f.patch !== null) {
      lines.push("```diff");
      lines.push(f.patch);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderMessageTranscript(messages: readonly SDKMessage[]): string {
  if (messages.length === 0) {
    return "(no messages captured)";
  }
  const lines: string[] = [];
  for (const m of messages) {
    if (m.type === "assistant") {
      const message: unknown = (m as { message?: unknown }).message;
      if (!isObject(message)) continue;
      const content: unknown = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isObject(block)) continue;
        const blockType = (block as { type?: string }).type;
        if (blockType === "text") {
          const text = (block as { text?: string }).text;
          if (typeof text === "string" && text.length > 0) {
            lines.push(`[assistant] ${text}`);
          }
        } else if (blockType === "tool_use") {
          const name = (block as { name?: string }).name ?? "?";
          const inputSummary = summariseToolInput(
            (block as { input?: unknown }).input,
          );
          lines.push(
            inputSummary
              ? `[tool_use: ${name}] ${inputSummary}`
              : `[tool_use: ${name}]`,
          );
        }
      }
    } else if (m.type === "user") {
      // Operator redirects (and pre-prompt context) land as user messages.
      const message: unknown = (m as { message?: unknown }).message;
      if (!isObject(message)) continue;
      const content: unknown = (message as { content?: unknown }).content;
      if (typeof content === "string") {
        lines.push(`[user] ${content}`);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!isObject(block)) continue;
          if ((block as { type?: string }).type === "text") {
            const text = (block as { text?: string }).text;
            if (typeof text === "string") lines.push(`[user] ${text}`);
          }
        }
      }
    }
    // result / system messages — skipped. Diff + llm_calls already capture
    // the result; system/init is verbose and not useful to the debriefer.
  }
  return lines.length === 0 ? "(no renderable messages)" : lines.join("\n");
}

function summariseToolInput(input: unknown): string {
  if (!isObject(input)) return "";
  // Pick the highest-signal field for the common tools (file_path /
  // command / pattern cover Edit/Write/MultiEdit/Bash/Grep).
  const filePath = (input as { file_path?: unknown }).file_path;
  if (typeof filePath === "string") return filePath;
  const command = (input as { command?: unknown }).command;
  if (typeof command === "string") return command.slice(0, 200);
  const pattern = (input as { pattern?: unknown }).pattern;
  if (typeof pattern === "string") return pattern;
  return "";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
