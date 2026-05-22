// scripts/bilby-dialectic.ts — proto-Bilby. Runs the four-stage planning
// dialectic against a single plan row, persisting every stage to
// plan_stages and llm_calls as it goes, and emitting a final
// docs/decisions/<NNNN>-<slug>.md artefact when the validator signs off.
//
// Usage:
//   pnpm tsx scripts/bilby-dialectic.ts <plan-id>
//
// Resume semantics: re-running against the same plan-id picks up at the
// first stage that doesn't yet have a plan_stages row. Stage failures
// land plans.status='abandoned' with content.error populated; the row
// is preserved as forensic evidence (no auto-cleanup).
//
// Permission posture
// ------------------
// This script makes direct Opus and Grok API calls via the AI SDK,
// bypassing lib/feathertail/permissions.ts entirely. The permissions
// config governs Agent SDK sessions only — pure text-in/text-out LLM
// calls don't go through it. No new security surface introduced.
// (docs/decisions/0008-permission-config.md is the entry that does NOT
// apply here; recorded so the chain of reasoning is findable.)
//
// Context bundle
// --------------
// V1 partial bundle per Scope B: projects.claude_md + plans.brief only.
// The full §10 ContextLoader bundle (specs + skills + last 30 decisions)
// lands when ContextLoader gets a 'plan-stage' scope in a future slice.
// See docs/numbat-brief-final.md §10 for the contract this defers.

import "@/lib/env";

import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { callGrok } from "@/lib/llm/grok";
import { callOpus } from "@/lib/llm/opus";
import { OPUS_MODEL, GROK_MODEL } from "@/lib/llm/models";
import { sbAdmin } from "@/lib/supabase/server";
import {
  computeCostUsd,
  insertLlmCallFromAiSdkResult,
} from "@/lib/supabase/llm-calls";
import { PlanStageContent } from "@/lib/types/jsonb";
import type {
  PlanStageContentT,
  LlmCallErrorT,
} from "@/lib/types/jsonb";
import type {
  Plan,
  PlanStage,
  PlanStageInsert,
  PlanStageAction,
  PlanStatus,
} from "@/lib/types/db";

// ─────────────────────────────────────────────────────────────────────
// Timeouts per CLAUDE.md "Resilience". Retries (2x, exponential backoff)
// are handled inside the lib/llm wrappers.
// ─────────────────────────────────────────────────────────────────────

const TIMEOUT_MS = {
  draft: 90_000,
  critique: 60_000,
  consider: 90_000,
  validate: 60_000,
} satisfies Record<DialecticAction, number>;

// ─────────────────────────────────────────────────────────────────────
// Prompts. Top-level, not in lib/llm/prompts/ — Slice 6 question.
// Each takes the shared StageContext and returns the full prompt
// string sent to generateText. Mirror the bootstrap dialectic's tone:
// direct, no preamble, ask for the actual stage output.
// ─────────────────────────────────────────────────────────────────────

type DialecticAction = "draft" | "critique" | "consider" | "validate";

type StageContext = {
  claudeMd: string | null;
  planTitle: string;
  planBrief: string;
  draft?: string;
  critique?: string;
  considered?: string;
};

function draftPrompt(ctx: StageContext): string {
  return `You are drafting the first pass of a plan for a project. You will be critiqued by a different model (Grok) immediately after; treat that as the next reader, not as a judge — write the strongest first draft you can, but flag genuine uncertainty rather than papering over it.

PROJECT CONTEXT (the project's CLAUDE.md, the standing instructions for the codebase):
${ctx.claudeMd ?? "(none — project has no CLAUDE.md yet)"}

PLAN TITLE
${ctx.planTitle}

PLAN BRIEF (what the operator is asking for)
${ctx.planBrief}

Produce a draft that addresses the brief in the project's context. Include:
- a structural outline of what the plan covers (sections, components, data shapes — whatever the brief implies)
- the concrete decisions you're making at this stage, with reasoning
- any self-acknowledged limits — things you're uncertain about, things that need verification, things the brief leaves under-specified

Tone: direct. No preamble, no "I'll help you with…", no closing summary. Markdown.`;
}

function critiquePrompt(ctx: StageContext): string {
  return `You are critiquing a plan draft. The draft was written by a different model (Opus). Your job is not to be polite — your job is to catch what the drafter missed. Cross-family critique is the load-bearing value here; agreement is not.

PROJECT CONTEXT (the project's CLAUDE.md):
${ctx.claudeMd ?? "(none)"}

PLAN TITLE
${ctx.planTitle}

PLAN BRIEF
${ctx.planBrief}

OPUS DRAFT
${ctx.draft ?? "(missing — this is a bug in the dialectic runner)"}

Critique sharply. Specifically look for:
- what will break: assumptions the draft makes that won't survive contact with reality (deployment model, library versions, runtime environment, schema migrations, concurrency, etc.) — these are the highest-impact catches; lead with them
- gaps: what the brief asks for that the draft doesn't address
- missing pieces: things the draft should have included but didn't (data shapes, failure modes, edge cases, prerequisites)
- overconfidence: places the draft asserts something as settled that actually isn't
- anything else that's wrong, weak, or under-specified

Structure your critique by category. Lead with the headline catches — the things that, if unfixed, would invalidate the plan. End with a verdict line ("XX% there. Fix Y and Z to get to ready.") so the next stage can act on it.

Tone: cold, specific. Cite the exact text or section you're critiquing where you can. No flattery, no concession framing. Markdown.`;
}

function considerPrompt(ctx: StageContext): string {
  return `You are responding to a critique of your own draft. The critique came from a different model (Grok). Your job is to give each critique point an explicit disposition and revise the plan accordingly.

The critic is sharp but not always right. You are explicitly authorised to REJECT critique points with reasoning. Unsound rejection is a normal stage outcome — the validator (next stage, also Grok) will confirm or push back on any rejection. If you accept everything reflexively the dialectic loses its calibration value.

PROJECT CONTEXT (the project's CLAUDE.md):
${ctx.claudeMd ?? "(none)"}

PLAN TITLE
${ctx.planTitle}

PLAN BRIEF
${ctx.planBrief}

YOUR ORIGINAL DRAFT
${ctx.draft ?? "(missing — runner bug)"}

GROK'S CRITIQUE
${ctx.critique ?? "(missing — runner bug)"}

Produce three sections:

## Dispositions
For each critique point, give one of:
- ACCEPTED — incorporated into the revised plan; describe how
- PARTIAL — accepted in part; describe what's in and what's out
- ALREADY ADDRESSED — point the critique missed in the original draft; cite where
- DEFERRED — agreed but explicitly out of scope for now; describe when it lands
- REJECTED — disagree; explain the reasoning a validator can evaluate

## Additions
New material that emerged from considering the critique cumulatively but wasn't a direct response to any one critique point. The bootstrap dialectic's Stage 3 added "project loading/unloading" as a runtime concern — that's the kind of generative side-effect this section is for. If you have nothing to add, say so explicitly ("No additions beyond the dispositions above") so future readers can tell the absence was deliberate.

## Considered plan
The plan as it now stands, incorporating accepted critiques. Don't repeat the entire draft verbatim — show what's CHANGED, what's NEW, and a brief restatement of what survived unchanged. Keep the structure compatible with the original draft so a reader can diff them mentally.

Tone: direct. No preamble. Markdown.`;
}

function validatePrompt(ctx: StageContext): string {
  return `You are validating a considered plan as the final stage of a four-stage dialectic. You critiqued an earlier draft; the drafter (Opus) has now responded to each critique point with a disposition and revised the plan accordingly.

Two equally important things to check:
1. Are the ACCEPTED critique points actually addressed in the considered plan, not just promised?
2. Are the REJECTED critique points genuinely unsound (drafter was right to reject), or did the drafter dismiss something important? Confirming a sound rejection is as valuable as catching an unsound dismissal — both are signal.

PROJECT CONTEXT (the project's CLAUDE.md):
${ctx.claudeMd ?? "(none)"}

PLAN TITLE
${ctx.planTitle}

PLAN BRIEF
${ctx.planBrief}

CONSIDERED PLAN (includes drafter's dispositions to your critique)
${ctx.considered ?? "(missing — runner bug)"}

Produce:

## Verdict
One of: READY, READY WITH FOLLOW-UPS, NOT READY. One sentence justifying.

## Confirmed dispositions
For each significant disposition in the considered plan: was the disposition sound? Call out specifically:
- accepted critiques that are correctly addressed (briefly)
- rejected critiques that you AGREE were unsound — confirm the rejection (this is load-bearing; sound rejections deserve explicit confirmation, not silence)
- any disposition you disagree with — accepted critiques that aren't actually addressed, or rejected critiques that should have been accepted

## Residual risks
What's still uncertain or under-specified, even after the considered plan. Each one labelled small/medium/large by impact-if-wrong.

## Sign-off
A final paragraph: ship it, ship it after these fixes, or send it back for another round. Be specific about what "these fixes" means.

Tone: direct. The bootstrap dialectic's verdict was "READY. Ship the brief." — that's the register. Markdown.`;
}

// ─────────────────────────────────────────────────────────────────────
// Slug + decisions-number helpers. Exported for unit testing —
// scripts/bilby-dialectic.test.ts covers both directly.
// ─────────────────────────────────────────────────────────────────────

const SLUG_MAX_LENGTH = 60;

/**
 * Title → kebab-case slug, max SLUG_MAX_LENGTH chars, truncated at the
 * nearest word boundary (i.e. the last hyphen at or before the limit).
 * Never cuts mid-word — fixes the brief.slice(0,60) defect noted in
 * the Slice 5 carry list before it ships in this script.
 *
 * Examples:
 *   "Should Numbat add a pinned sessions feature?"
 *     → "should-numbat-add-a-pinned-sessions-feature"   (45 chars)
 *   "An exceptionally lengthy plan title that overflows the limit"
 *     → "an-exceptionally-lengthy-plan-title-that-overflows-the-limit" (60)
 *   "Some title ending in an uncertainty about something"
 *     truncated at 32 → cut at last hyphen ≤32, NOT mid-word
 */
export function deriveSlug(title: string): string {
  const lowered = title.toLowerCase();
  // Replace runs of non-alphanumeric chars with a single hyphen.
  const dashed = lowered.replace(/[^a-z0-9]+/g, "-");
  // Strip leading/trailing hyphens.
  const trimmed = dashed.replace(/^-+/, "").replace(/-+$/, "");
  if (trimmed.length <= SLUG_MAX_LENGTH) return trimmed;
  // Truncate at word boundary. Find the last hyphen at or before
  // SLUG_MAX_LENGTH; if there is one, cut there. If there isn't (rare:
  // a single word longer than the limit), accept the hard cut — the
  // alternative is an unbounded slug.
  const window = trimmed.slice(0, SLUG_MAX_LENGTH);
  const lastHyphen = window.lastIndexOf("-");
  if (lastHyphen > 0) return window.slice(0, lastHyphen);
  return window;
}

/**
 * Given a list of existing filenames (or directory entries) in
 * `docs/decisions/`, return the next 4-digit decision number as a
 * zero-padded string. Empty list → "0001".
 *
 * Robust to gaps in numbering: takes max(existing) + 1, not count + 1.
 * Robust to non-conforming filenames: ignores anything that doesn't
 * match /^(\d{4})-.+\.md$/.
 */
export function nextDecisionNumber(existingFilenames: string[]): string {
  let max = 0;
  for (const name of existingFilenames) {
    const m = /^(\d{4})-.+\.md$/.exec(name);
    if (!m) continue;
    const captured = m[1];
    if (!captured) continue;
    const n = parseInt(captured, 10);
    if (n > max) max = n;
  }
  return String(max + 1).padStart(4, "0");
}

// ─────────────────────────────────────────────────────────────────────
// Verdict parsing. Per operator instructions:
//   READY                → plans.status='ready'
//   READY WITH FOLLOW-UPS → plans.status='ready'
//   NOT READY            → plans.status='validating' (stay, allow re-run)
//   unparseable          → plans.status='validating', exit non-zero
// ─────────────────────────────────────────────────────────────────────

export type Verdict = "ready" | "ready_with_followups" | "not_ready" | "unparseable";

export function parseVerdict(validateResponse: string): Verdict {
  // Find the "## Verdict" header and look at the first non-empty line
  // after it for the verdict keyword. Case-insensitive on the header
  // and on the keyword.
  const lines = validateResponse.split(/\r?\n/);
  let inVerdict = false;
  for (const line of lines) {
    if (/^#{1,6}\s+verdict\s*$/i.test(line.trim())) {
      inVerdict = true;
      continue;
    }
    if (inVerdict) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      // Strip markdown bold/italic markers before matching.
      const stripped = trimmed.replace(/[*_`]/g, "").toUpperCase();
      if (stripped.startsWith("READY WITH")) return "ready_with_followups";
      if (stripped.startsWith("NOT READY")) return "not_ready";
      if (stripped.startsWith("READY")) return "ready";
      return "unparseable";
    }
  }
  return "unparseable";
}

// ─────────────────────────────────────────────────────────────────────
// Markdown assembly — structural skeleton with raw stage output per
// stage. The bootstrap dialectic's editorial gloss is a human curatorial
// layer; the script doesn't try to write that.
// ─────────────────────────────────────────────────────────────────────

type StageRecord = {
  stage_num: number;
  action: DialecticAction;
  actor: "opus" | "grok";
  response: string;
  model: string;
};

const STAGE_HEADINGS: Record<DialecticAction, string> = {
  draft: "Stage 1 — Opus draft",
  critique: "Stage 2 — Grok critique",
  consider: "Stage 3 — Opus consider",
  validate: "Stage 4 — Grok validate",
};

export function assembleDecisionMarkdown(input: {
  filename: string;
  planTitle: string;
  date: string; // YYYY-MM-DD
  verdict: Verdict;
  stages: StageRecord[];
}): string {
  const { filename, planTitle, date, verdict, stages } = input;
  const verdictHuman: Record<Verdict, string> = {
    ready: "READY",
    ready_with_followups: "READY WITH FOLLOW-UPS",
    not_ready: "NOT READY",
    unparseable: "UNPARSEABLE (verdict could not be parsed from validator output)",
  };

  const stageBlocks = stages
    .slice()
    .sort((a, b) => a.stage_num - b.stage_num)
    .map(
      (s) =>
        `## ${STAGE_HEADINGS[s.action]}\n\n` +
        `> Model: \`${s.model}\`\n\n` +
        `${s.response.trim()}\n`,
    )
    .join("\n---\n\n");

  return (
    `> File: docs/decisions/${filename}\n` +
    `\n` +
    `# ${planTitle}\n` +
    `\n` +
    `> **Date:** ${date}.\n` +
    `> **Type:** Bilby dialectic (four-stage, programmatic).\n` +
    `> **Subject:** ${planTitle}\n` +
    `> **Final verdict:** ${verdictHuman[verdict]}\n` +
    `\n` +
    `---\n` +
    `\n` +
    `${stageBlocks}\n` +
    `---\n` +
    `\n` +
    `## Meta-observations\n` +
    `\n` +
    `<!-- add manually if patterns are worth recording. This section is a human\n` +
    `     curatorial layer — the bilby-dialectic.ts script deliberately leaves it\n` +
    `     empty. Add meta-observations only when a particular dialectic earned\n` +
    `     them (cross-family catches worth recording, calibration findings,\n` +
    `     surprising rejections, etc.). -->\n`
  );
}

// ─────────────────────────────────────────────────────────────────────
// Main runner.
// ─────────────────────────────────────────────────────────────────────

const STAGE_ORDER: DialecticAction[] = [
  "draft",
  "critique",
  "consider",
  "validate",
];

const STAGE_NUM: Record<DialecticAction, number> = {
  draft: 1,
  critique: 2,
  consider: 3,
  validate: 4,
};

const STAGE_ACTOR: Record<DialecticAction, "opus" | "grok"> = {
  draft: "opus",
  critique: "grok",
  consider: "opus",
  validate: "grok",
};

// Status to set on plans.status after each stage SUCCEEDS. Stage 4's
// success status is determined by verdict parsing, handled separately.
const STAGE_NEXT_STATUS: Record<DialecticAction, PlanStatus> = {
  draft: "critiquing",
  critique: "considering",
  consider: "validating",
  validate: "ready", // overridden by verdict; placeholder.
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runDialectic(planId: string): Promise<number> {
  // 1. Load the plan.
  const { data: plan, error: planErr } = await sbAdmin
    .from("plans")
    .select("id, project_id, title, brief, status")
    .eq("id", planId)
    .maybeSingle();
  if (planErr) {
    console.error(`plan load failed: ${planErr.message}`);
    return 1;
  }
  if (!plan) {
    console.error(`plan ${planId} not found`);
    return 1;
  }
  const resumableStatuses = ["drafting", "critiquing", "considering", "validating"];
  if (!resumableStatuses.includes(plan.status)) {
    console.log(
      `plan ${planId} is at status='${plan.status}'; dialectic supports resume only from ` +
        `${resumableStatuses.join("/")}. Exiting (not an error).`,
    );
    return 0;
  }

  // 2. Resolve partial context per Scope B.
  const { data: project, error: projectErr } = await sbAdmin
    .from("projects")
    .select("claude_md, slug")
    .eq("id", plan.project_id)
    .maybeSingle();
  if (projectErr || !project) {
    console.error(`project load failed: ${projectErr?.message ?? "not found"}`);
    return 1;
  }
  const ctx: StageContext = {
    claudeMd: project.claude_md,
    planTitle: plan.title,
    planBrief: plan.brief,
  };

  // 3. Load existing stages — supports resume.
  const { data: existing, error: existingErr } = await sbAdmin
    .from("plan_stages")
    .select("stage_num, action, content")
    .eq("plan_id", planId)
    .order("stage_num", { ascending: true });
  if (existingErr) {
    console.error(`existing stages load failed: ${existingErr.message}`);
    return 1;
  }
  const byAction = new Map<DialecticAction, PlanStage["content"]>();
  for (const row of existing ?? []) {
    if (
      row.action === "draft" ||
      row.action === "critique" ||
      row.action === "consider" ||
      row.action === "validate"
    ) {
      byAction.set(row.action, row.content);
    }
  }
  // Populate ctx with whatever's already been completed.
  hydrateContextFromExisting(ctx, byAction);

  // 4. Run each stage that isn't yet present.
  const stageRecords: StageRecord[] = [];
  for (const action of STAGE_ORDER) {
    const existingForAction = byAction.get(action);
    if (existingForAction && "response" in existingForAction) {
      stageRecords.push({
        stage_num: STAGE_NUM[action],
        action,
        actor: STAGE_ACTOR[action],
        response: existingForAction.response,
        model: existingForAction.model,
      });
      console.log(`[stage ${STAGE_NUM[action]}/4 ${STAGE_ACTOR[action]}-${action}] already done — skipping`);
      // Update ctx for downstream stages.
      hydrateContextFromExisting(ctx, byAction);
      continue;
    }
    const result = await runStage(plan, action, ctx);
    if (result === null) return 1; // failure already surfaced
    stageRecords.push(result);
    if (action === "draft") ctx.draft = result.response;
    if (action === "critique") ctx.critique = result.response;
    if (action === "consider") ctx.considered = result.response;
  }

  // 5. After Stage 4: parse the verdict, set plans.status accordingly.
  const validateRecord = stageRecords.find((s) => s.action === "validate");
  if (!validateRecord) {
    console.error("internal error: validate stage missing after main loop");
    return 1;
  }
  const verdict = parseVerdict(validateRecord.response);
  let exitCode = 0;
  let finalStatus: PlanStatus;
  switch (verdict) {
    case "ready":
    case "ready_with_followups":
      finalStatus = "ready";
      break;
    case "not_ready":
      finalStatus = "validating";
      console.warn("validator returned NOT READY — plan stays at validating for re-run");
      break;
    case "unparseable":
    default:
      finalStatus = "validating";
      console.warn("verdict could not be parsed — plan stays at validating; exit non-zero");
      exitCode = 1;
      break;
  }
  const { error: statusErr } = await sbAdmin
    .from("plans")
    .update({ status: finalStatus, updated_at: new Date().toISOString() })
    .eq("id", planId);
  if (statusErr) {
    console.error(`final plans.status update failed: ${statusErr.message}`);
    return 1;
  }

  // 6. Assemble + write the markdown artefact.
  const slug = deriveSlug(plan.title);
  const existingFiles = await readdir(path.join(process.cwd(), "docs", "decisions"));
  const nnnn = nextDecisionNumber(existingFiles);
  const filename = `${nnnn}-${slug}.md`;
  const today = new Date().toISOString().slice(0, 10);
  const markdown = assembleDecisionMarkdown({
    filename,
    planTitle: plan.title,
    date: today,
    verdict,
    stages: stageRecords,
  });
  const filepath = path.join(process.cwd(), "docs", "decisions", filename);
  await writeFile(filepath, markdown, "utf8");

  console.log(`\nwrote ${filepath}`);
  return exitCode;
}

function hydrateContextFromExisting(
  ctx: StageContext,
  byAction: Map<DialecticAction, PlanStage["content"]>,
): void {
  const draft = byAction.get("draft");
  if (draft && "response" in draft) ctx.draft = draft.response;
  const critique = byAction.get("critique");
  if (critique && "response" in critique) ctx.critique = critique.response;
  const consider = byAction.get("consider");
  if (consider && "response" in consider) ctx.considered = consider.response;
}

async function runStage(
  plan: Pick<Plan, "id" | "project_id">,
  action: DialecticAction,
  ctx: StageContext,
): Promise<StageRecord | null> {
  const actor = STAGE_ACTOR[action];
  const stageNum = STAGE_NUM[action];
  const label = `[stage ${stageNum}/4 ${actor}-${action}]`;
  const timeoutMs = TIMEOUT_MS[action];

  const prompt =
    action === "draft"
      ? draftPrompt(ctx)
      : action === "critique"
        ? critiquePrompt(ctx)
        : action === "consider"
          ? considerPrompt(ctx)
          : validatePrompt(ctx);
  const promptHash = sha256Hex(prompt);

  let result;
  try {
    result =
      actor === "opus"
        ? await callOpus({ prompt, timeoutMs })
        : await callGrok({ prompt, timeoutMs });
  } catch (err: unknown) {
    const errMsg = describeError(err);
    console.error(`${label} FAILED: ${errMsg}`);
    const lastError: LlmCallErrorT = { message: errMsg };
    // Best-effort: write a forensic plan_stages row with the error,
    // mark the plan abandoned, exit non-zero.
    const failureContent: PlanStageContentT = {
      action,
      prompt,
      response: "",
      model: actor === "opus" ? OPUS_MODEL : GROK_MODEL,
      finish_reason: "error",
      error: lastError,
    };
    PlanStageContent.parse(failureContent);
    const failureRow: PlanStageInsert = {
      plan_id: plan.id,
      stage_num: stageNum,
      actor,
      action: action as PlanStageAction,
      llm_provider: actor === "opus" ? "anthropic" : "xai",
      model: actor === "opus" ? OPUS_MODEL : GROK_MODEL,
      content: failureContent,
      duration_ms: null,
    };
    const stageInsert = await sbAdmin.from("plan_stages").insert(failureRow);
    if (stageInsert.error) {
      console.error(`  forensic plan_stages insert failed: ${stageInsert.error.message}`);
    }
    const statusUpdate = await sbAdmin
      .from("plans")
      .update({ status: "abandoned", updated_at: new Date().toISOString() })
      .eq("id", plan.id);
    if (statusUpdate.error) {
      console.error(`  plans.status='abandoned' update failed: ${statusUpdate.error.message}`);
    }
    return null;
  }

  const cost = computeCostUsd(result.model, result.usage);
  console.log(
    `${label} done — ${(result.durationMs / 1000).toFixed(1)}s, $${cost.toFixed(4)}`,
  );

  // Persist plan_stages row (Zod-validate first).
  const content: PlanStageContentT = {
    action,
    prompt,
    response: result.text,
    model: result.model,
    finish_reason: result.finishReason,
  };
  PlanStageContent.parse(content);
  const stageRow: PlanStageInsert = {
    plan_id: plan.id,
    stage_num: stageNum,
    actor,
    action: action as PlanStageAction,
    llm_provider: actor === "opus" ? "anthropic" : "xai",
    model: result.model,
    content,
    duration_ms: result.durationMs,
  };
  const stageInsert = await sbAdmin
    .from("plan_stages")
    .insert(stageRow)
    .select("id")
    .single();
  if (stageInsert.error || !stageInsert.data) {
    console.error(
      `${label} plan_stages insert failed: ${stageInsert.error?.message ?? "no row"}`,
    );
    return null;
  }

  // Persist llm_calls row.
  await insertLlmCallFromAiSdkResult(sbAdmin, {
    project_id: plan.project_id,
    plan_stage_id: stageInsert.data.id,
    provider: actor === "opus" ? "anthropic" : "xai",
    model: result.model,
    usage: result.usage,
    duration_ms: result.durationMs,
    prompt_hash: promptHash,
  });

  // Move plans.status forward for stages 1-3. Stage 4 status comes from
  // verdict parsing in the main loop.
  if (action !== "validate") {
    const { error: statusErr } = await sbAdmin
      .from("plans")
      .update({
        status: STAGE_NEXT_STATUS[action],
        updated_at: new Date().toISOString(),
      })
      .eq("id", plan.id);
    if (statusErr) {
      console.error(`${label} plans.status update failed: ${statusErr.message}`);
      return null;
    }
  }

  return {
    stage_num: stageNum,
    action,
    actor,
    response: result.text,
    model: result.model,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Entry point. Guarded with import.meta check so the test file can
// import helpers without running the dialectic.
// ─────────────────────────────────────────────────────────────────────

const isDirectInvocation =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation) {
  const planId = process.argv[2];
  if (!planId) {
    console.error(
      "Usage: pnpm tsx scripts/bilby-dialectic.ts <plan-id>",
    );
    process.exit(1);
  }
  runDialectic(planId)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("DIALECTIC FAILED (uncaught):", describeError(err));
      process.exit(1);
    });
}
