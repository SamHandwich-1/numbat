// scripts/generate-debrief.ts — CLI replay path for the debrief generator.
//
// Usage:
//   pnpm tsx scripts/generate-debrief.ts <session_id> --messages-file <path.jsonl>
//
// The session's task, diff, and project context are loaded from the DB.
// The Agent SDK message stream is NOT persisted (it's consumed in-memory
// by the worker — plan 0013 §3.1, pre-flight Item 2), so the operator
// must supply a captured JSONL of the original stream.
//
// Slice 6d will land the worker-side discipline of dumping the stream
// to a .messages.jsonl sibling of the worker log so this CLI has
// representative inputs to replay against; until then, the operator
// can hand-craft a JSONL from any prior session for smoke-testing the
// prompt module against a real session row.
//
// Exits 0 on success; 1 on any { ok: false } result so CI / scripting
// can detect failures.

import "@/lib/env";

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { generateDebrief } from "@/lib/debrief/opus-debrief";
import { sbAdmin } from "@/lib/supabase/server";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sessionId = args[0];
  const flagIdx = args.indexOf("--messages-file");
  const messagesPath = flagIdx >= 0 ? args[flagIdx + 1] : undefined;

  if (!sessionId || !messagesPath) {
    process.stderr.write(
      "Usage: pnpm tsx scripts/generate-debrief.ts <session_id> --messages-file <path.jsonl>\n",
    );
    process.exit(1);
  }

  const messages = await readJsonlMessages(messagesPath);
  process.stdout.write(
    `generate-debrief: ${messages.length} message${messages.length === 1 ? "" : "s"} loaded from ${path.resolve(messagesPath)}\n`,
  );

  const result = await generateDebrief(sbAdmin, sessionId, messages);

  if (result.ok) {
    process.stdout.write(
      `generate-debrief: ok — debriefId=${result.debriefId} llmCallId=${result.llmCallId}\n`,
    );
    process.exit(0);
  }
  process.stderr.write(
    `generate-debrief: failed — errorKind=${result.errorKind} llmCallId=${result.llmCallId ?? "<none>"} message=${result.message}\n`,
  );
  process.exit(1);
}

async function readJsonlMessages(filePath: string): Promise<SDKMessage[]> {
  const raw = await readFile(filePath, "utf8");
  const messages: SDKMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    messages.push(JSON.parse(trimmed) as SDKMessage);
  }
  return messages;
}

main().catch((err: unknown) => {
  process.stderr.write(
    `generate-debrief: unexpected failure: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
