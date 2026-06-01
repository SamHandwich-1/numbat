// Snapshot tests for the Opus debrief prompt module.
//
// The stable-prefix snapshot is CACHE-LOAD-BEARING — any byte change
// invalidates the Anthropic prompt cache for the 5-min TTL window
// across the entire project (and across Slice 7's Bilby stages once
// they share the prefix shape). When the snapshot diff fires in CI,
// review the change deliberately, not by reflexive update.

import { describe, expect, test } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  buildDynamicSuffix,
  buildStablePrefix,
  OPUS_DEBRIEF_PROMPT_VERSION,
} from "@/lib/llm/prompts/opus-debrief";
import type { Debrief, Decision, Skill, Spec } from "@/lib/types/db";
import type { WorktreeDiffT } from "@/lib/types/jsonb";

// Deterministic fixtures. Snapshot stability depends on these inputs
// staying byte-identical run to run — no Date.now(), no Math.random().

const fixedClaudeMd = "# Project\n\nA test project for snapshot stability.";

const fixedSpecs: Spec[] = [
  {
    id: "spec-0001",
    project_id: "proj-fixture",
    plan_id: null,
    goal: "Ship slice 6c",
    out_of_scope: null,
    files_affected: null,
    acceptance_criteria: null,
    open_questions: null,
    version: 1,
    created_at: "2026-05-25T00:00:00.000Z",
  },
];

const fixedSkills: Skill[] = [
  {
    id: "skill-1",
    project_id: "proj-fixture",
    name: "snapshot-skill",
    description: "for tests",
    prompt_template: "...",
    usage_count: 0,
    created_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
  },
];

const fixedDecisions: Decision[] = [
  {
    id: "dec-0001",
    project_id: "proj-fixture",
    session_id: null,
    plan_id: null,
    type: "approve",
    context: null,
    payload: null,
    created_at: "2026-05-26T10:00:00.000Z",
  },
  {
    id: "dec-0002",
    project_id: "proj-fixture",
    session_id: null,
    plan_id: null,
    type: "start_work",
    context: null,
    payload: null,
    created_at: "2026-05-26T11:00:00.000Z",
  },
];

const fixedDiff: WorktreeDiffT = {
  files: [
    {
      path: "lib/debrief/opus-debrief.ts",
      status: "added",
      additions: 120,
      deletions: 0,
      patch: null,
    },
    {
      path: "lib/types/debrief.ts",
      status: "modified",
      additions: 5,
      deletions: 3,
      patch:
        "diff --git a/lib/types/debrief.ts b/lib/types/debrief.ts\n@@ -1,1 +1,1 @@\n-old line\n+new line",
    },
  ],
  totals: { files_changed: 2, additions: 125, deletions: 3 },
};

// SDKMessage is a wide union with private fields we don't need to
// construct precisely for renderer testing — cast at the boundary.
// Same convention as lib/llm/opus.test.ts:63 (typed-runtime-guaranteed
// boundary cast, per 0016 §6 (1)).
const fixedMessages: SDKMessage[] = [
  {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "I'll start by reading the existing files." },
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "lib/orchestration/context.ts" },
        },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Write",
          input: { file_path: "lib/debrief/opus-debrief.ts" },
        },
        { type: "text", text: "Done — generator scaffolded." },
      ],
    },
  },
] as unknown as SDKMessage[];

const fixedSpec: Spec = fixedSpecs[0]!;

const fixedPriorDebrief: Debrief = {
  id: "debrief-prior",
  project_id: "proj-fixture",
  session_id: "sess-fixture",
  plan_stage_id: null,
  debrief_type: "direct",
  content: {
    what_we_did: "drafted the prompt module",
    where_this_fits: "Slice 6c step 1",
    why_it_matters: "stable prefix unlocks Slice 7 cache hits",
    what_went_wrong_or_next: "next: wire the generator",
  },
  llm_call_id: null,
  prompt_version: "v1",
  duration_ms: 9000,
  created_at: "2026-05-30T00:00:00.000Z",
};

describe("opus-debrief prompt module", () => {
  test("(snap-1) stable-prefix snapshot — CACHE-LOAD-BEARING; review diffs deliberately", () => {
    const prefix = buildStablePrefix({
      claudeMd: fixedClaudeMd,
      recentDecisions: fixedDecisions,
      specs: fixedSpecs,
      skills: fixedSkills,
    });
    expect(prefix).toMatchSnapshot();
    // Sanity check: prefix must not embed session-scoped tokens that
    // would break cache stability across calls. (The fixture above
    // contains no such tokens, but assert defensively.)
    expect(prefix).not.toContain("sess-fixture");
    expect(prefix).not.toContain("drafted the prompt module");
    // Version constant is locked at v1 (bumping is a deliberate act
    // tied to a measurable prompt-shape change, recorded in decisions
    // log alongside the bump commit).
    expect(OPUS_DEBRIEF_PROMPT_VERSION).toBe("v1");
  });

  test("(snap-2) dynamic-suffix snapshot — assistant text, tool_use summaries, diff totals, spec, prior debrief", () => {
    const suffix = buildDynamicSuffix({
      task: "Implement the Opus debrief generator at lib/debrief/opus-debrief.ts.",
      diff: fixedDiff,
      messages: fixedMessages,
      spec: fixedSpec,
      priorDebrief: fixedPriorDebrief,
    });
    expect(suffix).toMatchSnapshot();
  });
});
